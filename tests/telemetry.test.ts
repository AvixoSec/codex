import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { HarnessRunner } from "../src/core/runner.js";
import { isValidRunId } from "../src/core/run-id.js";
import type { RunnerTelemetryEvent } from "../src/core/telemetry.js";
import type { RawRouteDecision } from "../src/router/resolve.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { testConfig } from "./fixtures.js";

function route(action = "analyze", tools = "read"): RawRouteDecision {
  const choice = (value: string) => ({ value, confidence: 0.9, probabilities: { [value]: 1 } });
  return { action: choice(action), toolPolicy: choice(tools), completionProbability: action === "finish" ? 0.9 : 0, errors: {} };
}

describe("public telemetry", () => {
  test.each(["run_a", "run_A-1_", "run_" + "a".repeat(120)])("accepts exact run ID grammar %s", (value) => expect(isValidRunId(value)).toBe(true));
  test.each(["run_", "run-test", "run_" + "a".repeat(121), "run_../x", "run_x\n", "run_é", "RUN_x"])("rejects invalid run ID grammar %s", (value) => expect(isValidRunId(value)).toBe(false));

  test("emits ordered run step route worker tool approval input and terminal boundaries with one correlation ID", async () => {
    const config = testConfig();
    const root = await mkdtemp(join(tmpdir(), "jevh-telemetry-"));
    const events: RunnerTelemetryEvent[] = [];
    let approvalId: string | undefined;
    let inputId: string | undefined;
    const executor = await ToolExecutor.create(config, root, { interactive: true, prompt: async (request, context) => {
      approvalId = request.requestId;
      expect(context).toMatchObject({ requestId: approvalId, runId: "run_ordered", step: 1 });
      expect(events.at(-1)?.type).toBe("approval_requested");
      return true;
    } });
    let decisions = 0;
    const runner = new HarnessRunner(config, {
      decisionClient: { decide: async () => route(decisions++ ? "finish" : "ask_user", "write") },
      workerClient: { execute: async () => ({ text: "Which branch?", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "hello.txt", content: "body-secret" } }] }) },
      toolExecutor: executor
    });
    await runner.run({ goal: "Write", runId: "run_ordered", onTelemetry: async (event) => { events.push(event); }, askUser: async (_question, context) => {
      inputId = context?.requestId;
      expect(events.at(-1)?.type).toBe("input_requested");
      return "main";
    } });
    expect(events.map((event) => event.type)).toEqual(["run_started", "step_started", "route_requested", "route_resolved", "worker_started", "worker_completed", "tool_requested", "tool_started", "approval_requested", "approval_resolved", "tool_completed", "input_requested", "input_resolved", "step_completed", "step_started", "route_requested", "route_resolved", "step_completed", "run_finished"]);
    expect(events.every((event) => event.runId === "run_ordered")).toBe(true);
    expect(events.filter((event) => event.type.startsWith("approval_")).map((event) => (event.data as { requestId: string }).requestId)).toEqual([approvalId, approvalId]);
    expect(events.filter((event) => event.type.startsWith("input_")).map((event) => (event.data as { requestId: string }).requestId)).toEqual([inputId, inputId]);
    expect(approvalId).toMatch(/^approval_/);
    expect(inputId).toMatch(/^input_/);
    expect(JSON.stringify(events)).not.toContain("body-secret");
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("body-secret");
  });

  test.each([false, true])("marks route provenance truthfully for shadow %s", async (shadow) => {
    const events: RunnerTelemetryEvent[] = [];
    const runner = new HarnessRunner(testConfig(), { decisionClient: { decide: async () => route() }, workerClient: { execute: async () => ({ text: "done", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    await runner.run({ goal: "Test", shadow, maxSteps: 1, onTelemetry: (event) => { events.push(event); } });
    const resolved = events.find((event) => event.type === "route_resolved")!;
    expect(resolved.data).toMatchObject({ provenance: shadow ? "fallback" : "jev", scores: { action: 0.9, completion: 0 } });
    expect(events.at(-1)?.data).toMatchObject({ status: "limit", error: { code: "STEP_LIMIT", message: "Maximum semantic steps reached." } });
  });

  test("router failure is fallback with unavailable scores and no diagnostic text", async () => {
    const events: RunnerTelemetryEvent[] = [];
    const runner = new HarnessRunner(testConfig(), { decisionClient: { decide: async () => { throw new Error("https://jev-private.invalid sk-router-secret"); } }, workerClient: { execute: async () => ({ text: "fallback", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    await runner.run({ goal: "Test", maxSteps: 1, onTelemetry: (event) => { events.push(event); } });
    expect(events.find((event) => event.type === "route_resolved")?.data).toMatchObject({ provenance: "fallback", scores: { action: null, completion: null } });
    expect(JSON.stringify(events)).not.toMatch(/jev-private|sk-router-secret/);
  });

  test("provider failures emit safe terminal and balanced step boundaries", async () => {
    const config = testConfig();
    config.routing.maxProviderFailures = 1;
    const events: RunnerTelemetryEvent[] = [];
    const runner = new HarnessRunner(config, { decisionClient: { decide: async () => route() }, workerClient: { execute: async () => { throw new Error("https://private.invalid authorization body-secret nested-diagnostics stack-secret", { cause: "cause-secret" }); } }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    await runner.run({ goal: "Test", onTelemetry: (event) => { events.push(event); } });
    expect(events.slice(-3).map((event) => event.type)).toEqual(["worker_failed", "step_completed", "run_finished"]);
    expect(events.at(-1)?.data).toMatchObject({ status: "failed", error: { code: "PROVIDER_FAILED", message: "Worker provider failed." } });
    expect(JSON.stringify(events)).not.toMatch(/private.invalid|authorization|body-secret|nested-diagnostics|stack-secret|cause-secret/);
  });

  test("abort emits a stable terminal event without internal text", async () => {
    const controller = new AbortController();
    const events: RunnerTelemetryEvent[] = [];
    const runner = new HarnessRunner(testConfig(), { decisionClient: { decide: async () => route() }, workerClient: { execute: async () => ({ text: "", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    await runner.run({ goal: "Test", signal: controller.signal, onTelemetry: (event) => { events.push(event); if (event.type === "worker_started") controller.abort(new Error("private-abort")); } });
    expect(events.slice(-3).map((event) => event.type)).toEqual(["worker_failed", "step_completed", "run_finished"]);
    expect(events.at(-1)?.data).toMatchObject({ error: { code: "RUN_ABORTED", message: "Run aborted." } });
    expect(JSON.stringify(events)).not.toContain("private-abort");
  });

  test("serializes telemetry through a pending approval callback during cancellation and ends with terminal", async () => {
    const controller = new AbortController();
    const config = testConfig();
    const root = await mkdtemp(join(tmpdir(), "jevh-telemetry-abort-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: RunnerTelemetryEvent[] = [];
    let active = 0;
    let concurrent = false;
    const executor = await ToolExecutor.create(config, root, { interactive: true, prompt: async () => new Promise<boolean>(() => {}) });
    const runner = new HarnessRunner(config, { decisionClient: { decide: async () => route("edit", "write") }, workerClient: { execute: async () => ({ text: "", toolCalls: [{ id: "c", name: "write_file", arguments: { path: "x.txt", content: "test" } }] }) }, toolExecutor: executor });
    const running = runner.run({ goal: "Test", signal: controller.signal, onTelemetry: async (event) => {
      active += 1;
      if (active > 1) concurrent = true;
      events.push(event);
      if (event.type === "approval_requested") {
        controller.abort();
        await gate;
      }
      active -= 1;
    } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.at(-1)?.type).toBe("approval_requested");
    release();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(concurrent).toBe(false);
    expect(events.at(-1)?.type).toBe("run_finished");
    expect(events.filter((event) => event.type === "approval_resolved")).toHaveLength(1);
  });

  test("bounds all public free text before the telemetry sink", async () => {
    const events: RunnerTelemetryEvent[] = [];
    const long = "💫".repeat(6000);
    const runner = new HarnessRunner(testConfig(), { decisionClient: { decide: async () => route("ask_user") }, workerClient: { execute: async () => ({ text: long, toolCalls: [{ id: "c", name: "read_file", arguments: { path: "x" } }] }) }, toolExecutor: { execute: async () => ({ ok: true, content: long, metadata: { authorization: "private-header", requestBody: "private-body" } }) } });
    await runner.run({ goal: long, maxSteps: 1, onTelemetry: (event) => { events.push(event); }, askUser: async () => long });
    for (const event of events) {
      for (const [field, value] of Object.entries(event.data)) {
        if (typeof value === "string" && ["goal", "question", "content", "answer", "finalText"].includes(field)) {
          expect(Buffer.byteLength(value)).toBeLessThanOrEqual(field === "goal" || field === "question" ? 2048 : 16 * 1024);
          expect(value).not.toContain("�");
        }
      }
    }
    expect(JSON.stringify(events)).not.toMatch(/private-header|private-body|authorization|requestBody/);
  });

  test("deadline and repeated router failure use safe terminal codes", async () => {
    for (const mode of ["deadline", "router"] as const) {
      const config = testConfig();
      config.routing.maxConsecutiveRouterFailures = 1;
      let now = 0;
      const events: RunnerTelemetryEvent[] = [];
      const runner = new HarnessRunner(config, { now: () => now, decisionClient: { decide: async () => {
        if (mode === "router") throw new Error("private-router-diagnostic");
        now = config.routing.maxElapsedMs + 1;
        return route();
      } }, workerClient: { execute: async () => ({ text: "", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
      await runner.run({ goal: "Test", onTelemetry: (event) => { events.push(event); } });
      expect(events.slice(-2).map((event) => event.type)).toEqual(["step_completed", "run_finished"]);
      expect(events.at(-1)?.data).toMatchObject({ error: { code: mode === "router" ? "ROUTER_FAILED" : "TIME_LIMIT" } });
      expect(JSON.stringify(events)).not.toContain("private-router-diagnostic");
    }
  });

  test("tool rejection never serializes arbitrary internal error text", async () => {
    const events: RunnerTelemetryEvent[] = [];
    const runner = new HarnessRunner(testConfig(), { decisionClient: { decide: async () => route() }, workerClient: { execute: async () => ({ text: "", toolCalls: [{ id: "c", name: "read_file", arguments: { path: "x", headers: { Authorization: "private-header" } } }] }) }, toolExecutor: { execute: async () => { throw new Error("private-tool-diagnostic https://private.invalid"); } } });
    await runner.run({ goal: "Test", maxSteps: 1, onTelemetry: (event) => { events.push(event); } });
    expect(events.find((event) => event.type === "tool_failed")?.data).toMatchObject({ callId: "c", name: "read_file", error: { code: "TOOL_FAILED", message: "Tool execution failed." } });
    expect(JSON.stringify(events)).not.toMatch(/private-tool-diagnostic|https:\/\/|private-header|Authorization/);
  });

  test("awaits failed input resolution and terminal telemetry before rethrowing an adversarial ask-user error", async () => {
    const events: RunnerTelemetryEvent[] = [];
    const error = new Error("private-input-error https://jev-private.invalid Authorization: Bearer private-key", { cause: { secret: "private-cause", headers: { Authorization: "private-header" } } });
    error.stack = "private-stack";
    let requestId: string | undefined;
    let terminalSettled = false;
    const runner = new HarnessRunner(testConfig(), { decisionClient: { decide: async () => route("ask_user") }, workerClient: { execute: async () => ({ text: "Which branch?", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    const rejected = await runner.run({ goal: "Test", onTelemetry: async (event) => {
      events.push(event);
      if (event.type === "run_finished") {
        await new Promise((resolve) => setTimeout(resolve, 0));
        terminalSettled = true;
      }
    }, askUser: async (_question, context) => { requestId = context?.requestId; throw error; } }).then(() => undefined, (caught: unknown) => caught);
    expect(rejected).toBe(error);
    expect(terminalSettled).toBe(true);
    expect(events.slice(-4).map((event) => event.type)).toEqual(["input_requested", "input_resolved", "step_completed", "run_finished"]);
    expect(events.at(-3)?.data).toEqual({ requestId, outcome: "failed", error: { code: "RUN_FAILED", message: "Run failed." } });
    expect(events.at(-2)?.data).toEqual({ status: "failed" });
    expect(events.at(-1)?.data).toEqual({ status: "failed", finalText: "Which branch?", error: { code: "RUN_FAILED", message: "Run failed." } });
    expect(JSON.stringify(events)).not.toMatch(/private-input-error|https:\/\/|Authorization|private-key|private-cause|private-header|private-stack/);
  });

  test("resolves a pending input as cancelled before abort terminal and ignores a late answer", async () => {
    const controller = new AbortController();
    const events: RunnerTelemetryEvent[] = [];
    let entered!: () => void;
    const hooked = new Promise<void>((resolve) => { entered = resolve; });
    let answerLate!: (answer: string) => void;
    const answer = new Promise<string>((resolve) => { answerLate = resolve; });
    let requestId: string | undefined;
    const runner = new HarnessRunner(testConfig(), { decisionClient: { decide: async () => route("ask_user") }, workerClient: { execute: async () => ({ text: "Which branch?", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    const running = runner.run({ goal: "Test", signal: controller.signal, onTelemetry: (event) => { events.push(event); }, askUser: async (_question, context) => {
      requestId = context?.requestId;
      entered();
      return answer;
    } });
    await hooked;
    controller.abort(new Error("private-abort"));
    const run = await running;
    expect(run.status).toBe("failed");
    expect(events.slice(-4).map((event) => event.type)).toEqual(["input_requested", "input_resolved", "step_completed", "run_finished"]);
    expect(events.at(-3)?.data).toEqual({ requestId, outcome: "cancelled", error: { code: "RUN_ABORTED", message: "Run aborted." } });
    expect(events.at(-2)?.data).toEqual({ status: "stopped" });
    expect(events.at(-1)?.data).toMatchObject({ error: { code: "RUN_ABORTED" } });
    const count = events.length;
    answerLate("private-late-answer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(count);
    expect(events.filter((event) => event.type === "input_resolved")).toHaveLength(1);
    expect(run.events.some((event) => event.type === "user_text")).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/private-abort|private-late-answer/);
  });

  test("resolves a pending input as cancelled before deadline terminal and ignores a late rejection", async () => {
    const config = testConfig();
    config.routing.maxElapsedMs = 100;
    const events: RunnerTelemetryEvent[] = [];
    let entered!: () => void;
    const hooked = new Promise<void>((resolve) => { entered = resolve; });
    let rejectLate!: (error: Error) => void;
    const answer = new Promise<string>((_resolve, reject) => { rejectLate = reject; });
    let requestId: string | undefined;
    const runner = new HarnessRunner(config, { decisionClient: { decide: async () => route("ask_user") }, workerClient: { execute: async () => ({ text: "Which branch?", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    const running = runner.run({ goal: "Test", onTelemetry: (event) => { events.push(event); }, askUser: async (_question, context) => {
      requestId = context?.requestId;
      entered();
      return answer;
    } });
    await hooked;
    const run = await running;
    expect(run.status).toBe("limit");
    expect(events.slice(-4).map((event) => event.type)).toEqual(["input_requested", "input_resolved", "step_completed", "run_finished"]);
    expect(events.at(-3)?.data).toEqual({ requestId, outcome: "cancelled", error: { code: "TIME_LIMIT", message: "Elapsed-time limit reached." } });
    expect(events.at(-2)?.data).toEqual({ status: "stopped" });
    expect(events.at(-1)?.data).toMatchObject({ error: { code: "TIME_LIMIT" } });
    const count = events.length;
    rejectLate(new Error("private-late-rejection"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(count);
    expect(events.filter((event) => event.type === "input_resolved")).toHaveLength(1);
    expect(run.events.some((event) => event.type === "user_text")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private-late-rejection");
  });

  test.each(["abort", "deadline"])("resolves input once without fabricating an answer when %s occurs at the post-answer checkpoint", async (mode) => {
    const config = testConfig();
    const controller = new AbortController();
    const events: RunnerTelemetryEvent[] = [];
    let requestId: string | undefined;
    let now = 0;
    const runner = new HarnessRunner(config, { now: () => now, receipts: { append: async (_runId, record) => {
      if (record.kind !== "user_input") return;
      if (mode === "abort") controller.abort();
      else now = config.routing.maxElapsedMs + 1;
    } }, decisionClient: { decide: async () => route("ask_user") }, workerClient: { execute: async () => ({ text: "Which branch?", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    await runner.run({ goal: "Test", signal: controller.signal, onTelemetry: (event) => { events.push(event); }, askUser: async (_question, context) => { requestId = context?.requestId; return "private-unaccepted-answer"; } });
    const resolutions = events.filter((event) => event.type === "input_resolved");
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.data).toEqual({ requestId, outcome: "cancelled", error: { code: mode === "abort" ? "RUN_ABORTED" : "TIME_LIMIT", message: mode === "abort" ? "Run aborted." : "Elapsed-time limit reached." } });
    expect(events.slice(-3).map((event) => event.type)).toEqual(["input_resolved", "step_completed", "run_finished"]);
    expect(JSON.stringify(events)).not.toContain("private-unaccepted-answer");
  });

  test("leaves input authoritative in needs_input when no hook is installed", async () => {
    const events: RunnerTelemetryEvent[] = [];
    const runner = new HarnessRunner(testConfig(), { decisionClient: { decide: async () => route("ask_user") }, workerClient: { execute: async () => ({ text: "Which branch?", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    const run = await runner.run({ goal: "Test", onTelemetry: (event) => { events.push(event); } });
    expect(run.status).toBe("needs_input");
    expect(events.slice(-3).map((event) => event.type)).toEqual(["input_requested", "step_completed", "run_finished"]);
    expect(events.filter((event) => event.type === "input_resolved")).toEqual([]);
    expect(events.at(-1)?.data).toEqual({ status: "needs_input", finalText: "Which branch?" });
  });

  test("an answered input uses its explicit outcome and does not resolve again on later cancellation", async () => {
    const controller = new AbortController();
    const events: RunnerTelemetryEvent[] = [];
    const runner = new HarnessRunner(testConfig(), { decisionClient: { decide: async () => route("ask_user") }, workerClient: { execute: async () => ({ text: "Which branch?", toolCalls: [] }) }, toolExecutor: { execute: async () => ({ ok: true, content: "" }) } });
    await runner.run({ goal: "Test", signal: controller.signal, onTelemetry: (event) => { events.push(event); if (event.type === "input_resolved") controller.abort(); }, askUser: async () => "main" });
    const resolutions = events.filter((event) => event.type === "input_resolved");
    expect(resolutions).toHaveLength(1);
    const requested = events.find((event) => event.type === "input_requested");
    expect(resolutions[0]?.data).toEqual({ requestId: requested?.data.requestId, outcome: "answered", answer: "main" });
    expect(events.at(-1)?.data).toMatchObject({ error: { code: "RUN_ABORTED" } });
  });
});
