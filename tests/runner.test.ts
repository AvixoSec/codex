import { describe, expect, test, vi } from "vitest";

import type { ToolCall, WorkerResult } from "../src/core/types.js";
import { HarnessRunner, type ReceiptSink, type ToolExecutorLike } from "../src/core/runner.js";
import type { WorkerInput, WorkerClient } from "../src/providers/worker-client.js";
import type { DecisionClient } from "../src/router/jev-client.js";
import type { RawRouteDecision } from "../src/router/resolve.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../src/tools/executor.js";
import { testConfig } from "./fixtures.js";

function choice(value: string, confidence = 0.99) {
  return { value, confidence, probabilities: { [value]: 1 } };
}

function decision(values: Partial<{
  action: string;
  target: string;
  effort: string;
  context: number;
  output: number;
  temperature: number;
  tools: string;
  complete: number;
}> = {}): RawRouteDecision {
  return {
    action: choice(values.action ?? "analyze"),
    target: choice(values.target ?? "alpha/fast"),
    effort: choice(values.effort ?? "low"),
    contextTokens: choice(String(values.context ?? 8_000)),
    maxOutputTokens: choice(String(values.output ?? 1_000)),
    temperature: choice(String(values.temperature ?? 0.2)),
    toolPolicy: choice(values.tools ?? "read"),
    completionProbability: values.complete ?? 0,
    model: "jev-test",
    usage: { inputTokens: 10, outputTokens: 2 },
    errors: {}
  };
}

class QueueDecisionClient implements DecisionClient {
  readonly snapshots: unknown[] = [];
  readonly #items: Array<RawRouteDecision | Error>;

  constructor(items: Array<RawRouteDecision | Error>) {
    this.#items = [...items];
  }

  async decide(snapshot: unknown): Promise<RawRouteDecision> {
    this.snapshots.push(snapshot);
    const item = this.#items.shift();
    if (!item) throw new Error("No queued decision");
    if (item instanceof Error) throw item;
    return item;
  }
}

class QueueWorkerClient implements WorkerClient {
  readonly inputs: WorkerInput[] = [];
  readonly #items: Array<WorkerResult | Error>;

  constructor(items: Array<WorkerResult | Error>) {
    this.#items = [...items];
  }

  async execute(input: WorkerInput): Promise<WorkerResult> {
    this.inputs.push(input);
    const item = this.#items.shift();
    if (!item) throw new Error("No queued worker result");
    if (item instanceof Error) throw item;
    return item;
  }
}

class FakeTools implements ToolExecutorLike {
  readonly calls: Array<{ call: ToolCall; context: ToolExecutionContext }> = [];

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.calls.push({ call, context });
    return { ok: true, content: call.name === "read_file" ? "export const value = 1;" : "ok" };
  }
}

class MemoryReceipts implements ReceiptSink {
  readonly records: Record<string, unknown>[] = [];

  async append(_runId: string, record: Record<string, unknown>): Promise<void> {
    this.records.push(record);
  }
}

function result(text = "", toolCalls: ToolCall[] = []): WorkerResult {
  return { text, toolCalls, usage: { inputTokens: 20, outputTokens: 5 }, finishReason: toolCalls.length ? "tool_calls" : "stop" };
}

function makeRunner(decisions: Array<RawRouteDecision | Error>, workers: Array<WorkerResult | Error>) {
  const decisionClient = new QueueDecisionClient(decisions);
  const workerClient = new QueueWorkerClient(workers);
  const tools = new FakeTools();
  const receipts = new MemoryReceipts();
  const runner = new HarnessRunner(testConfig(), {
    decisionClient,
    workerClient,
    toolExecutor: tools,
    receipts,
    createRunId: () => "run-test",
    now: (() => {
      let time = 1_000;
      return () => time += 10;
    })()
  });
  return { runner, decisionClient, workerClient, tools, receipts };
}

describe("HarnessRunner", () => {
  test("routes before every worker, crosses a tool boundary, and switches base/model settings", async () => {
    const setup = makeRunner([
      decision({ action: "inspect", target: "alpha/fast", effort: "low", context: 8_000, tools: "read" }),
      decision({ action: "analyze", target: "beta/deep", effort: "high", context: 4_000, output: 4_000, tools: "none" }),
      decision({ action: "finish", target: "beta/deep", complete: 0.95, tools: "none" })
    ], [
      result("Reading.", [{ id: "c1", name: "read_file", arguments: { path: "src/index.ts" } }]),
      result("The implementation is correct.")
    ]);

    const run = await setup.runner.run({ goal: "Inspect the implementation" });

    expect(run).toMatchObject({ status: "completed", finalText: "The implementation is correct.", steps: 2 });
    expect(setup.decisionClient.snapshots).toHaveLength(3);
    expect(setup.workerClient.inputs.map((input) => input.route.target.id)).toEqual(["alpha/fast", "beta/deep"]);
    expect(setup.workerClient.inputs.map((input) => input.route.effort)).toEqual(["low", "high"]);
    expect(setup.workerClient.inputs[1]!.context.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_result", callId: "c1", content: "export const value = 1;" })
    ]));
    expect(setup.tools.calls).toHaveLength(1);
    const kinds = setup.receipts.records.map((record) => record.kind);
    expect(kinds).toEqual(expect.arrayContaining(["run_started", "route", "worker", "tool_intent", "tool_result", "run_finished"]));
  });

  test("does not finish before at least one worker step", async () => {
    const setup = makeRunner([
      decision({ action: "finish", complete: 0.99 }),
      decision({ action: "finish", complete: 0.99 })
    ], [result("Final answer")]);

    const run = await setup.runner.run({ goal: "Answer" });

    expect(run.status).toBe("completed");
    expect(setup.workerClient.inputs).toHaveLength(1);
  });

  test("returns needs_input in noninteractive mode and can resume with an injected answer", async () => {
    const blocked = makeRunner([
      decision({ action: "ask_user", tools: "none" })
    ], [result("Which branch should I modify?")]);
    await expect(blocked.runner.run({ goal: "Change code" })).resolves.toMatchObject({
      status: "needs_input",
      finalText: "Which branch should I modify?"
    });

    const resumed = makeRunner([
      decision({ action: "ask_user", tools: "none" }),
      decision({ action: "finish", complete: 0.9, tools: "none" })
    ], [result("Which branch?")]);
    const run = await resumed.runner.run({
      goal: "Change code",
      askUser: async () => "main"
    });
    expect(run.status).toBe("completed");
    expect(run.events).toContainEqual(expect.objectContaining({ type: "user_text", content: "main" }));
  });

  test("shadow mode records Jev's proposal but executes fallback coordinates", async () => {
    const setup = makeRunner([
      decision({ action: "edit", target: "beta/deep", effort: "high", context: 4_000, tools: "none" })
    ], [result("Shadow result")]);

    const run = await setup.runner.run({ goal: "Shadow", shadow: true, maxSteps: 1 });

    expect(run.status).toBe("limit");
    expect(setup.workerClient.inputs[0]!.route.target.id).toBe("alpha/fast");
    expect(setup.workerClient.inputs[0]!.route.proposed.target).toBe("beta/deep");
  });

  test("stops at a lowered max-step limit", async () => {
    const setup = makeRunner([
      decision(), decision(), decision()
    ], [result("one"), result("two"), result("three")]);

    const run = await setup.runner.run({ goal: "Loop", maxSteps: 2 });

    expect(run).toMatchObject({ status: "limit", steps: 2 });
    expect(setup.workerClient.inputs).toHaveLength(2);
  });

  test("uses one safe fallback route then stops on repeated router failure", async () => {
    const setup = makeRunner([
      new Error("router down"),
      new Error("router still down")
    ], [result("fallback analysis")]);

    const run = await setup.runner.run({ goal: "Do work" });

    expect(run).toMatchObject({ status: "failed", steps: 1 });
    expect(setup.workerClient.inputs).toHaveLength(1);
    expect(setup.workerClient.inputs[0]!.route.target.id).toBe("alpha/fast");
  });

  test("lets Jev recover with a different provider after a worker failure", async () => {
    const setup = makeRunner([
      decision({ target: "alpha/fast" }),
      decision({ action: "recover", target: "beta/deep", effort: "high", context: 4_000, output: 4_000, tools: "none" }),
      decision({ action: "finish", target: "beta/deep", complete: 0.9, tools: "none" })
    ], [
      new Error("alpha unavailable"),
      result("Recovered result")
    ]);

    const run = await setup.runner.run({ goal: "Recover" });

    expect(run).toMatchObject({ status: "completed", finalText: "Recovered result" });
    expect(setup.workerClient.inputs.map((input) => input.route.target.id)).toEqual(["alpha/fast", "beta/deep"]);
    expect(run.events).toContainEqual(expect.objectContaining({ type: "error", content: expect.stringContaining("alpha unavailable") }));
  });

  test("does not execute unknown or duplicate tool calls", async () => {
    const setup = makeRunner([
      decision({ action: "inspect", tools: "read" }),
      decision({ action: "inspect", tools: "read" }),
      decision({ action: "finish", complete: 0.9 })
    ], [
      result("", [{ id: "same", name: "unknown_tool", arguments: {} }]),
      result("done", [{ id: "same", name: "read_file", arguments: { path: "x" } }])
    ]);

    const run = await setup.runner.run({ goal: "Safe tools" });

    expect(run.status).toBe("completed");
    expect(setup.tools.calls).toHaveLength(0);
    expect(run.events.filter((event) => event.type === "tool_result")).toEqual([
      expect.objectContaining({ ok: false, content: expect.stringMatching(/unknown/i) }),
      expect.objectContaining({ ok: false, content: expect.stringMatching(/duplicate/i) })
    ]);
  });

  test("honors an already-aborted signal before network or tools", async () => {
    const setup = makeRunner([decision()], [result("never")]);
    const controller = new AbortController();
    controller.abort();

    const run = await setup.runner.run({ goal: "Abort", signal: controller.signal });

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/aborted/i);
    expect(setup.decisionClient.snapshots).toHaveLength(0);
  });
});
