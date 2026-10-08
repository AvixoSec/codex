import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createRunDependencySnapshot, referencedEnvironmentNames } from "../src/core/run-snapshot.js";
import { RunManager, type RunFactoryContext } from "../src/web/run-manager.js";
import { HarnessRunner, type RunOptions, type RunResult } from "../src/core/runner.js";
import type { ToolExecutionResult } from "../src/tools/executor.js";
import { testConfig } from "./fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function managerFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "jevh-manager-"));
  const completion = deferred<RunResult>();
  let context!: RunFactoryContext;
  let options!: RunOptions;
  let count = 0;
  const config = testConfig();
  const environment = { TEST_JEV_KEY: "jev-private", ALPHA_KEY: "alpha-private", BETA_KEY: "beta-private", UNRELATED: "unrelated-private" };
  const manager = await RunManager.create({ workspace, loadConfig: async () => config, loadEnvironment: async () => environment,
    createRunId: () => `run_test${++count}`, createRunner: async (value) => {
      context = value;
      return { run: (value) => { options = value; return completion.promise; } };
    } });
  return { manager, workspace, completion, config, environment, context: () => context, options: () => options };
}

test("reserves one canonical workspace before concurrent start awaits", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "jevh-reservation-"));
  const alias = `${workspace}-alias`;
  await symlink(workspace, alias, "dir");
  const config = deferred<ReturnType<typeof testConfig>>();
  const factory = vi.fn(async () => ({ run: async () => { throw new Error("private-diagnostic"); } }));
  const dependencies = { workspace, loadConfig: () => config.promise, loadEnvironment: async () => ({}), createRunner: factory, createRunId: () => "run_same" };
  const first = await RunManager.create(dependencies);
  const second = await RunManager.create({ ...dependencies, workspace: join(alias, ".") });
  const accepted = first.start({ goal: "goal" });
  await expect(second.start({ goal: "loser" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY", status: 409 });
  expect(factory).not.toHaveBeenCalled();
  config.resolve(testConfig());
  await accepted;
  await flush();
  expect(first.get("run_same").error).toEqual({ code: "RUN_FAILED", message: "Run failed." });
});

test("rejects browser workspace substitution and always passes the fixed realpath", async () => {
  const f = await managerFixture();
  for (const value of [{ goal: "x", workspace: "/other" }, { goal: "x", path: "/other" }, { goal: "x", root: "/other" }, { goal: " " }, { goal: "x", maxSteps: 0 }, { goal: "x", shadow: "yes" }]) {
    await expect(f.manager.start(value as never)).rejects.toMatchObject({ code: "INVALID_START", status: 400 });
  }
  const run = await f.manager.start({ goal: "x", maxSteps: 100 });
  expect(f.context().workspace).toBe(f.workspace);
  expect(f.options().maxSteps).toBe(f.config.routing.maxSteps);
  f.completion.reject(new Error("private"));
  await flush();
  expect(f.manager.get(run.runId).status).toBe("failed");
});

test("returns an accepted run before its runner promise settles", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "use alpha-private https://private.example" });
  expect(run.status).toBe("accepted");
  expect(f.options().runId).toBe(run.runId);
  expect(run.goal).toBe("use [REDACTED] [REDACTED]");
  run.goal = "changed";
  expect(f.manager.get(run.runId).goal).not.toBe("changed");
  expect(f.context().config).not.toBe(f.config);
  expect(Object.isFrozen(f.context().config.tools.approvals)).toBe(true);
  expect(f.context().environment).not.toHaveProperty("UNRELATED");
  f.completion.reject(new Error("private"));
  await flush();
});

test("releases a failed preparation safely for a later start", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "jevh-prepare-"));
  let count = 0;
  const loader = vi.fn().mockRejectedValueOnce(new Error("https://private.example key-private header-private")).mockResolvedValue(testConfig());
  const manager = await RunManager.create({ workspace, loadConfig: loader, loadEnvironment: async () => ({}), createRunId: () => `run_prepare${++count}`,
    createRunner: async () => ({ run: async () => { throw new Error("private"); } }) });
  await expect(manager.start({ goal: "x" })).rejects.toMatchObject({ code: "START_FAILED", message: "Run could not be started." });
  await expect(manager.start({ goal: "x" })).resolves.toMatchObject({ runId: "run_prepare2" });
  await flush();
});

test("retains only the newest 100 terminal in-memory runs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "jevh-retention-"));
  let count = 0;
  const manager = await RunManager.create({ workspace, loadConfig: async () => testConfig(), loadEnvironment: async () => ({}), createRunId: () => `run_retained${++count}`,
    createRunner: async () => ({ run: async () => { throw new Error("private"); } }) });
  for (let i = 0; i < 102; i++) { await manager.start({ goal: "x" }); await flush(); }
  expect(manager.list()).toHaveLength(100);
  expect(manager.list()[0]!.runId).toBe("run_retained102");
  expect(() => manager.get("run_retained1")).toThrow();
});

test("commits lifecycle telemetry into detached authoritative snapshots", async () => {
  const f = await managerFixture();
  const accepted = await f.manager.start({ goal: "alpha-private" });
  await f.options().onTelemetry!({ runId: accepted.runId, step: 0, type: "run_started", data: { goal: "[REDACTED]", maxSteps: 12, shadow: false } });
  await f.options().onTelemetry!({ runId: "run_foreign", step: 1, type: "step_started", data: {} });
  await f.options().onTelemetry!({ runId: accepted.runId, step: 1, type: "step_started", data: {} });
  await f.options().onTelemetry!({ runId: accepted.runId, step: 1, type: "run_finished", data: { status: "completed", finalText: "safe" } });
  expect(f.manager.get(accepted.runId).status).toBe("running");
  expect(f.manager.snapshot(accepted.runId).events.map((event) => event.type)).toEqual(["run_accepted", "run_started", "step_started"]);
  f.completion.resolve({ runId: accepted.runId, status: "completed", finalText: "safe", events: [], steps: 1 });
  await flush();
  const snapshot = f.manager.snapshot(accepted.runId);
  expect(snapshot.run).toMatchObject({ status: "completed", finalText: "safe", step: 1, startedAt: expect.any(String), finishedAt: expect.any(String) });
  expect(snapshot.highWaterId).toBe(`${accepted.runId}:4`);
  expect(snapshot.highWaterSequence).toBe(4);
  expect(snapshot.generation).toBe(0);
  expect(snapshot.truncated).toBe(false);
  snapshot.run.goal = "changed";
  expect(f.manager.get(accepted.runId).goal).toBe("[REDACTED]");
  for (const secret of Object.values(f.environment)) expect(JSON.stringify([f.manager.list(), f.manager.snapshot(accepted.runId)])).not.toContain(secret);
});

test("publishes cancelling immediately but holds terminal and workspace through effects", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  const effect = deferred<void>();
  f.context().effectBarrier.track(effect.promise);
  expect(f.manager.cancel(run.runId).status).toBe("cancelling");
  expect(f.context().signal.aborted).toBe(true);
  f.completion.reject(new Error("https://private.example secret-key stack cause"));
  await flush();
  expect(f.manager.get(run.runId).status).toBe("cancelling");
  expect(f.manager.snapshot(run.runId).events.map((event) => event.type)).toEqual(["run_accepted", "run_cancellation_requested"]);
  await expect(f.manager.start({ goal: "second" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  effect.resolve();
  await flush();
  expect(f.manager.get(run.runId)).toMatchObject({ status: "cancelled", error: { code: "RUN_ABORTED", message: "Run aborted." } });
  expect(f.manager.snapshot(run.runId).events.at(-1)!.type).toBe("run_finished");
  await f.manager.start({ goal: "next" });
  await flush();
});

test("adapts same-ID approval and input waits with generic safe public prompts", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "step_started", data: {} });
  const context = { runId: run.runId, requestId: "approval_same", step: 1 };
  const approval = f.context().promptApproval({ requestId: context.requestId, kind: "shell", summary: "alpha-private", exactAction: "/private/path", command: "https://private.example" }, context);
  expect(f.manager.snapshot(run.runId).pendingApprovals).toMatchObject([{ requestId: "approval_same", summary: "Run command", category: "shell" }]);
  f.manager.resolveApproval(run.runId, "approval_same", true);
  await expect(approval).resolves.toBe(true);
  expect(() => f.manager.resolveApproval(run.runId, "approval_same", false)).toThrow(expect.objectContaining({ code: "REQUEST_ALREADY_RESOLVED" }));
  const input = f.options().askUser!("alpha-private https://private.example", { runId: run.runId, requestId: "input_same", step: 1 });
  expect(f.manager.snapshot(run.runId).pendingInputs).toMatchObject([{ requestId: "input_same", question: "[REDACTED] [REDACTED]" }]);
  f.manager.resolveInput(run.runId, "input_same", "answer");
  await expect(input).resolves.toBe("answer");
  await expect(f.context().promptApproval({ requestId: "approval_bad", kind: "write", summary: "x", exactAction: "x" }, { runId: "run_foreign", requestId: "approval_bad", step: 1 })).rejects.toMatchObject({ code: "CROSS_RUN_RESPONSE" });
  f.completion.reject(new Error("private"));
  await flush();
});

test("keeps cancellation idempotent and rejects late replies", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "step_started", data: {} });
  const approval = f.context().promptApproval({ requestId: "approval_late", kind: "write", summary: "x", exactAction: "private" }, { runId: run.runId, requestId: "approval_late", step: 1 });
  const input = f.options().askUser!("x", { runId: run.runId, requestId: "input_late", step: 1 });
  const approvalError = approval.catch((error: unknown) => error);
  const inputError = input.catch((error: unknown) => error);
  f.manager.cancel(run.runId);
  f.manager.cancel(run.runId);
  expect(f.manager.snapshot(run.runId).events.filter((event) => event.type === "run_cancellation_requested")).toHaveLength(1);
  expect(f.manager.snapshot(run.runId).pendingApprovals).toEqual([]);
  expect(f.manager.snapshot(run.runId).pendingInputs).toEqual([]);
  expect(await approvalError).toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(await inputError).toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(() => f.manager.resolveApproval(run.runId, "approval_late", true)).toThrow(expect.objectContaining({ code: "REQUEST_CANCELLED" }));
  expect(() => f.manager.resolveInput(run.runId, "input_late", "late")).toThrow(expect.objectContaining({ code: "REQUEST_CANCELLED" }));
  f.completion.reject(new Error("private"));
  await flush();
  expect(() => f.manager.cancel(run.runId)).toThrow(expect.objectContaining({ code: "RUN_STALE" }));
});

test("reentrant subscriber cancellation returns cancelling twice and commits only one event", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "step_started", data: {} });
  const approval = f.context().promptApproval({ requestId: "approval_reentrant", kind: "write", summary: "x", exactAction: "private" }, { runId: run.runId, requestId: "approval_reentrant", step: 1 }).catch((error: unknown) => error);
  const input = f.options().askUser!("x", { runId: run.runId, requestId: "input_reentrant", step: 1 }).catch((error: unknown) => error);
  const effect = deferred<void>();
  f.context().effectBarrier.track(effect.promise);
  const returned: string[] = [];
  f.manager.journal(run.runId).subscribe((event) => {
    if (event.type === "route_requested") {
      returned.push(f.manager.cancel(run.runId).status);
      returned.push(f.manager.cancel(run.runId).status);
    }
  });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "route_requested", data: {} });
  f.completion.reject(new Error("runner-private"));
  await flush();
  try {
    expect(returned).toEqual(["cancelling", "cancelling"]);
    expect(f.manager.snapshot(run.runId).events.filter((event) => event.type === "run_cancellation_requested")).toHaveLength(1);
    expect(f.context().signal.aborted).toBe(true);
    expect(await approval).toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(await input).toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(f.manager.snapshot(run.runId).pendingApprovals).toEqual([]);
    expect(f.manager.snapshot(run.runId).pendingInputs).toEqual([]);
    expect(f.manager.snapshot(run.runId).events.some((event) => event.type === "run_finished")).toBe(false);
    await expect(f.manager.start({ goal: "busy" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  } finally { effect.resolve(); await flush(); }
  expect(f.manager.get(run.runId).status).toBe("cancelled");
});

test("failed cancellation append rolls back its latch without aborting or exposing diagnostics", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "step_started", data: {} });
  const input = f.options().askUser!("x", { runId: run.runId, requestId: "input_cancel_failure", step: 1 }).catch((error: unknown) => error);
  const journal = f.manager.journal(run.runId);
  const append = journal.append.bind(journal);
  journal.append = (event) => {
    if (event.type === "run_cancellation_requested") throw new Error("https://private.example append-key append-stack");
    return append(event);
  };
  let error: unknown;
  try { f.manager.cancel(run.runId); } catch (caught) { error = caught; }
  try {
    expect(error).toMatchObject({ code: "CANCEL_FAILED", status: 500, message: "Run could not be cancelled." });
    expect((error as { toEnvelope(): unknown }).toEnvelope()).toEqual({ error: { code: "CANCEL_FAILED", message: "Run could not be cancelled." } });
    expect(f.context().signal.aborted).toBe(false);
    expect(f.manager.get(run.runId).status).toBe("accepted");
    expect(f.manager.snapshot(run.runId).pendingInputs).toHaveLength(1);
    expect(f.manager.snapshot(run.runId).events.some((event) => event.type === "run_cancellation_requested")).toBe(false);
    journal.append = append;
    expect(f.manager.cancel(run.runId).status).toBe("cancelling");
    expect(f.manager.snapshot(run.runId).events.filter((event) => event.type === "run_cancellation_requested")).toHaveLength(1);
    expect(await input).toMatchObject({ code: "REQUEST_CANCELLED" });
  } finally { journal.append = append; f.completion.reject(new Error("private")); await flush(); await input; }
});

test("closes brokers and publishes one safe terminal after runner rejection", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "step_started", data: {} });
  const input = f.options().askUser!("x", { runId: run.runId, requestId: "input_closed", step: 1 }).catch((error: unknown) => error);
  const effect = deferred<void>();
  f.context().effectBarrier.track(effect.promise);
  f.completion.reject(Object.assign(new Error("https://private.example key header body"), { cause: "private-cause" }));
  await flush();
  expect(await input).toMatchObject({ code: "RUN_TERMINAL" });
  expect(() => f.manager.resolveInput(run.runId, "input_closed", "late")).toThrow(expect.objectContaining({ code: "RUN_TERMINAL" }));
  expect(f.manager.snapshot(run.runId).events.some((event) => event.type === "run_finished")).toBe(false);
  effect.reject(new Error("effect private"));
  await flush();
  expect(f.manager.snapshot(run.runId).events.filter((event) => event.type === "run_finished")).toHaveLength(1);
  expect(f.manager.get(run.runId).error).toEqual({ code: "RUN_FAILED", message: "Run failed." });
  for (const sentinel of ["https://private.example", "private-cause", "effect private", "stack"]) expect(JSON.stringify(f.manager.snapshot(run.runId))).not.toContain(sentinel);
});

test("does not append run_finished until every tracked effect settles", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  const first = deferred<void>();
  const second = deferred<void>();
  f.context().effectBarrier.track(first.promise);
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "run_finished", data: { status: "limit", finalText: "real" } });
  f.completion.resolve({ runId: run.runId, status: "limit", finalText: "real", events: [], steps: 1 });
  await flush();
  f.context().effectBarrier.track(second.promise);
  first.resolve();
  await flush();
  expect(f.manager.get(run.runId).finishedAt).toBeNull();
  await expect(f.manager.start({ goal: "busy" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  second.resolve();
  await flush();
  expect(f.manager.get(run.runId).status).toBe("limit");
});

test.each(["completed", "limit", "failed"] as const)("cancel while settled effects drain preserves the held real %s outcome", async (status) => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  const effect = deferred<void>();
  f.context().effectBarrier.track(effect.promise);
  const data = { status, finalText: "real final text", ...(status === "failed" ? { error: { code: "PROVIDER_FAILED" as const, message: "Worker provider failed." } } : {}) };
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "run_finished", data });
  f.completion.resolve({ runId: run.runId, status, finalText: data.finalText, events: [], steps: 1 });
  await flush();
  // Runner settlement fenced controls while the exact effect is still pending.
  expect(() => f.manager.setRouteOverride(run.runId, { action: "edit" })).toThrow(expect.objectContaining({ code: "RUN_STALE" }));
  expect(f.manager.cancel(run.runId).status).toBe("cancelling");
  expect(f.context().signal.aborted).toBe(true);
  expect(f.manager.snapshot(run.runId).events.some((event) => event.type === "run_finished")).toBe(false);
  await expect(f.manager.start({ goal: "busy" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  effect.resolve();
  await flush();
  expect(f.manager.get(run.runId)).toMatchObject({ status, finalText: data.finalText, error: data.error ?? null });
  const terminal = f.manager.snapshot(run.runId).events.filter((event) => event.type === "run_finished");
  expect(terminal).toHaveLength(1);
  expect(terminal[0]!.data).toEqual(data);
  expect(JSON.stringify(f.manager.snapshot(run.runId))).not.toContain("RUN_ABORTED");
});

test("post-settlement cancellation preserves the brokers' first terminal close reason", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "step_started", data: {} });
  const input = f.options().askUser!("x", { runId: run.runId, requestId: "input_settled_cancel", step: 1 }).catch((error: unknown) => error);
  const effect = deferred<void>();
  f.context().effectBarrier.track(effect.promise);
  f.completion.reject(new Error("runner-private"));
  await flush();
  expect(await input).toMatchObject({ code: "RUN_TERMINAL" });
  f.manager.cancel(run.runId);
  try {
    expect(() => f.manager.resolveInput(run.runId, "input_settled_cancel", "late")).toThrow(expect.objectContaining({ code: "RUN_TERMINAL" }));
  } finally { effect.resolve(); await flush(); }
  expect(f.manager.get(run.runId)).toMatchObject({ status: "failed", error: { code: "RUN_FAILED", message: "Run failed." } });
});

test("loads fresh dependencies for later runs without exposing private values", async () => {
  const f = await managerFixture();
  const first = await f.manager.start({ goal: "x" });
  const captured = f.context();
  f.environment.ALPHA_KEY = "fresh-secret";
  f.config.routing.fallback.effort = "medium";
  expect(captured.config.routing.fallback.effort).toBe("low");
  expect(captured.environment.ALPHA_KEY).toBe("alpha-private");
  f.completion.reject(new Error("private"));
  await flush();
  const next = await f.manager.start({ goal: "fresh-secret" });
  expect(f.context().environment.ALPHA_KEY).toBe("fresh-secret");
  expect(f.context().config.routing.fallback.effort).toBe("medium");
  expect(next.goal).toBe("[REDACTED]");
  await flush();
  for (const secret of ["alpha-private", "fresh-secret", "unrelated-private"]) expect(JSON.stringify([f.manager.get(first.runId), f.manager.list(), f.manager.snapshot(next.runId)])).not.toContain(secret);
});

test("preserves cross-run broker conflicts for IDs owned by another managed run", async () => {
  const f = await managerFixture();
  const first = await f.manager.start({ goal: "x" });
  await f.options().onTelemetry!({ runId: first.runId, step: 1, type: "step_started", data: {} });
  const answer = f.options().askUser!("x", { runId: first.runId, requestId: "input_owner", step: 1 });
  f.manager.resolveInput(first.runId, "input_owner", "done");
  await answer;
  f.completion.reject(new Error("private"));
  await flush();
  const next = await f.manager.start({ goal: "x" });
  expect(() => f.manager.resolveInput(next.runId, "input_owner", "wrong")).toThrow(expect.objectContaining({ code: "CROSS_RUN_RESPONSE" }));
  await flush();
});

test("validates and replaces a pending one-shot override without merging requests", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  expect(() => f.manager.setRouteOverride(run.runId, {})).toThrow(expect.objectContaining({ code: "INVALID_OVERRIDE" }));
  const override = { action: "edit" as const };
  f.manager.setRouteOverride(run.runId, override);
  f.manager.setRouteOverride(run.runId, { effort: "medium" });
  override.action = "finish" as never;
  expect(f.options().takeRouteOverride!({ runId: "run_foreign", step: 1 })).toBeUndefined();
  expect(f.options().takeRouteOverride!({ runId: run.runId, step: 1 })).toEqual({ effort: "medium" });
  expect(f.options().takeRouteOverride!({ runId: run.runId, step: 2 })).toBeUndefined();
  f.completion.reject(new Error("private"));
  await flush();
  expect(() => f.manager.setRouteOverride(run.runId, { action: "finish" })).toThrow(expect.objectContaining({ code: "RUN_STALE" }));
});

test("journal subscribers see summary state committed with the envelope", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  const statuses: string[] = [];
  f.manager.journal(run.runId).subscribe((event) => {
    if (event.type === "run_started" || event.type === "run_cancellation_requested" || event.type === "run_finished") statuses.push(f.manager.snapshot(run.runId).run.status);
  });
  await f.options().onTelemetry!({ runId: run.runId, step: 0, type: "run_started", data: { goal: "x", maxSteps: 12, shadow: false } });
  f.manager.cancel(run.runId);
  f.completion.reject(new Error("private"));
  await flush();
  expect(statuses).toEqual(["running", "cancelling", "cancelled"]);
});

test("terminal projection redacts credentials and ignores supplied diagnostic error messages", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "run_finished", data: { status: "failed", finalText: "alpha-private https://private.example", error: { code: "RUN_FAILED", message: "header-private stack-private cause-private" } } });
  f.completion.reject(new Error("private"));
  await flush();
  expect(f.manager.get(run.runId)).toMatchObject({ finalText: "[REDACTED] [REDACTED]", error: { code: "RUN_FAILED", message: "Run failed." } });
  for (const secret of ["alpha-private", "https://private.example", "header-private", "stack-private", "cause-private"]) expect(JSON.stringify(f.manager.snapshot(run.runId))).not.toContain(secret);
});

test("manager journal boundary redacts referenced credentials in every free-text lifecycle payload", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "worker_completed", data: { target: "alpha/fast", content: "alpha-private https://private.example" } });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "tool_failed", data: { callId: "safe", name: "write_file", error: { code: "TOOL_FAILED", message: "stack-private" } } });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "approval_requested", data: { requestId: "approval_safe", category: "write", summary: "/private/path alpha-private" } });
  await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "input_resolved", data: { requestId: "input_safe", outcome: "answered", answer: "beta-private" } });
  const serialized = JSON.stringify(f.manager.snapshot(run.runId));
  for (const sentinel of ["alpha-private", "beta-private", "https://private.example", "stack-private", "/private/path"]) expect(serialized).not.toContain(sentinel);
  expect(serialized).toContain("Write or edit workspace file");
  f.completion.reject(new Error("private"));
  await flush();
});

test("finalization absorbs internal publication failure after the barrier and releases ownership safely", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  const effect = deferred<void>();
  f.context().effectBarrier.track(effect.promise);
  const append = f.manager.journal(run.runId).append.bind(f.manager.journal(run.runId));
  f.manager.journal(run.runId).append = (event) => {
    if (event.type === "run_finished") throw new Error("append-private-stack");
    return append(event);
  };
  f.completion.reject(new Error("runner-private"));
  await flush();
  await expect(f.manager.start({ goal: "busy" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  effect.resolve();
  await flush();
  expect(f.manager.get(run.runId)).toMatchObject({ status: "failed", error: { code: "RUN_FAILED", message: "Run failed." }, finishedAt: expect.any(String) });
  await f.manager.start({ goal: "next" });
  await flush();
  expect(JSON.stringify(f.manager.list())).not.toContain("private");
});

test.each(["environment", "factory"])("keeps cross-manager reservation while %s preparation is deferred", async (phase) => {
  const workspace = await mkdtemp(join(tmpdir(), "jevh-preparation-race-"));
  const gate = deferred<void>();
  let atGate!: () => void;
  const reached = new Promise<void>((resolve) => { atGate = resolve; });
  const createRunner = vi.fn(async () => {
    if (phase === "factory") { atGate(); await gate.promise; }
    return { run: async () => { throw new Error("private"); } };
  });
  const dependencies = { workspace, createRunId: () => "run_preparation", loadConfig: async () => testConfig(), loadEnvironment: async () => {
    if (phase === "environment") { atGate(); await gate.promise; }
    return {};
  }, createRunner };
  const first = await RunManager.create(dependencies);
  const second = await RunManager.create(dependencies);
  const start = first.start({ goal: "x" });
  await reached;
  await expect(second.start({ goal: "loser" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  expect(createRunner).toHaveBeenCalledTimes(phase === "factory" ? 1 : 0);
  gate.resolve();
  await start;
  await flush();
});

test("preserves validated start values while asynchronous preparation is pending", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "jevh-start-options-"));
  const gate = deferred<ReturnType<typeof testConfig>>();
  let options!: RunOptions;
  const manager = await RunManager.create({ workspace, loadConfig: () => gate.promise, loadEnvironment: async () => ({}), createRunId: () => "run_start_values", createRunner: async () => ({ run: async (value) => { options = value; throw new Error("private"); } }) });
  const input = { goal: "original", maxSteps: 2, shadow: false };
  const starting = manager.start(input);
  input.goal = "changed";
  input.maxSteps = -1;
  input.shadow = true;
  gate.resolve(testConfig());
  expect(await starting).toMatchObject({ goal: "original", maxSteps: 2, shadow: false });
  expect(options).toMatchObject({ goal: "original", maxSteps: 2, shadow: false });
  await flush();
});

test("failed factory preparation drains any registered effect before releasing its token", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "jevh-failed-factory-effect-"));
  const effect = deferred<void>();
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  let count = 0;
  const dependencies = { workspace, loadConfig: async () => testConfig(), loadEnvironment: async () => ({}), createRunId: () => `run_factory_failure${++count}`, createRunner: async (context: RunFactoryContext) => {
    context.effectBarrier.track(effect.promise);
    reached();
    throw new Error("factory-private");
  } };
  const first = await RunManager.create(dependencies);
  const second = await RunManager.create(dependencies);
  const failure = first.start({ goal: "x" }).catch((error: unknown) => error);
  await entered;
  await flush();
  await expect(second.start({ goal: "busy" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  effect.resolve();
  expect(await failure).toMatchObject({ code: "START_FAILED", message: "Run could not be started." });
  expect(first.list()).toEqual([]);
  await expect(second.start({ goal: "next" })).rejects.toMatchObject({ code: "START_FAILED" });
});

test.each(["invalid id", "throwing id"])("rejects %s before loading dependencies", async (scenario) => {
  const workspace = await mkdtemp(join(tmpdir(), "jevh-invalid-id-"));
  const loadConfig = vi.fn(async () => testConfig());
  const createRunner = vi.fn(async () => ({ run: async () => { throw new Error(); } }));
  const manager = await RunManager.create({ workspace, loadConfig, loadEnvironment: async () => ({}), createRunner, createRunId: () => {
    if (scenario === "throwing id") throw new Error("private-id");
    return "invalid";
  } });
  await expect(manager.start({ goal: "x" })).rejects.toMatchObject({ code: "INVALID_START", message: "Invalid run start." });
  expect(loadConfig).not.toHaveBeenCalled();
  expect(createRunner).not.toHaveBeenCalled();
});

test("snapshot copies the journal generation and truncation boundary exactly", async () => {
  const f = await managerFixture();
  const run = await f.manager.start({ goal: "x" });
  const journal = f.manager.journal(run.runId);
  const reset = journal.reset();
  const snapshot = f.manager.snapshot(run.runId);
  expect(snapshot).toMatchObject({ events: [], generation: reset.generation, truncated: reset.truncated, highWaterId: reset.highWaterId, highWaterSequence: reset.highWaterSequence });
  f.completion.reject(new Error("private"));
  await flush();
});

test("manager preserves expired broker codes and permanent terminal authority", async () => {
  const f = await managerFixture();
  vi.useFakeTimers();
  try {
    const run = await f.manager.start({ goal: "x" });
    await f.options().onTelemetry!({ runId: run.runId, step: 1, type: "step_started", data: {} });
    const input = f.options().askUser!("x", { runId: run.runId, requestId: "input_expired", step: 1 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300000);
    expect(await input).toMatchObject({ code: "REQUEST_EXPIRED" });
    expect(() => f.manager.resolveInput(run.runId, "input_expired", "late")).toThrow(expect.objectContaining({ code: "REQUEST_EXPIRED" }));
    f.completion.reject(new Error("private"));
    await flush();
    await vi.advanceTimersByTimeAsync(300000);
    expect(() => f.manager.resolveInput(run.runId, "input_expired", "late")).toThrow(expect.objectContaining({ code: "RUN_TERMINAL" }));
  } finally { vi.useRealTimers(); }
});

test.each(["resolve", "reject"])("registers the exact mutating executor promise before the real guard abort race (%s)", async (outcome) => {
  const workspace = await mkdtemp(join(tmpdir(), "jevh-race-"));
  const effect = deferred<ToolExecutionResult>();
  const started = deferred<void>();
  let context!: RunFactoryContext;
  let runnerSettled = false;
  let registered: Promise<unknown> | undefined;
  let count = 0;
  const manager = await RunManager.create({ workspace, loadConfig: async () => testConfig(), loadEnvironment: async () => ({}), createRunId: () => `run_race${++count}`,
    createRunner: async (value) => {
      context = value;
      const track = context.effectBarrier.track.bind(context.effectBarrier);
      context.effectBarrier.track = (promise) => { registered = promise; return track(promise); };
      const runner = new HarnessRunner(value.config, {
        decisionClient: { decide: async () => ({ errors: {} }) },
        workerClient: { execute: async () => ({ text: "", toolCalls: [{ id: "effect", name: "write_file", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool_calls" }) },
        toolExecutor: { execute: () => { started.resolve(); return effect.promise; } }
      });
      return { run: async (options) => { const result = await runner.run(options); runnerSettled = true; return result; } };
    } });
  const run = await manager.start({ goal: "x" });
  manager.setRouteOverride(run.runId, { toolPolicy: "write" });
  await started.promise;
  expect(registered).toBe(effect.promise);
  manager.cancel(run.runId);
  await flush();
  expect(runnerSettled).toBe(true);
  expect(manager.get(run.runId).status).toBe("cancelling");
  expect(manager.snapshot(run.runId).events.some((event) => event.type === "run_finished")).toBe(false);
  await expect(manager.start({ goal: "busy" })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  if (outcome === "resolve") effect.resolve({ ok: false, content: "aborted" });
  else effect.reject(new Error("mutating-private"));
  await flush();
  expect(manager.get(run.runId).status).toBe("cancelled");
  expect(manager.snapshot(run.runId).events.filter((event) => event.type === "run_finished")).toHaveLength(1);
});

test("captures only referenced environment names in detached deeply frozen dependencies", () => {
  const config = testConfig();
  config.providers.alpha!.headersFromEnv = { Authorization: "HEADER_KEY", Other: "HEADER_KEY", Absent: "ABSENT_KEY" };
  config.providers.alpha!.extraBody = { nested: [{ deep: ["original"] }] };
  const environment = { TEST_JEV_KEY: "jev-secret", ALPHA_KEY: "alpha-secret", BETA_KEY: "beta-secret", HEADER_KEY: "header-secret", UNRELATED: "unrelated-secret" };
  const snapshot = createRunDependencySnapshot(config, environment);
  expect(referencedEnvironmentNames(config)).toEqual(["TEST_JEV_KEY", "ALPHA_KEY", "HEADER_KEY", "ABSENT_KEY", "BETA_KEY"]);
  expect(snapshot.environment).toEqual({ TEST_JEV_KEY: "jev-secret", ALPHA_KEY: "alpha-secret", BETA_KEY: "beta-secret", HEADER_KEY: "header-secret", ABSENT_KEY: undefined });
  expect(Object.hasOwn(snapshot.environment, "ABSENT_KEY")).toBe(true);
  const stack: unknown[] = [snapshot.config, snapshot.environment];
  while (stack.length) {
    const value = stack.pop();
    if (value && typeof value === "object") {
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) stack.push(child);
    }
  }
  expect(snapshot.config.providers.alpha!.extraBody).not.toBe(config.providers.alpha!.extraBody);
  config.providers.alpha!.extraBody.nested = ["changed"];
  environment.ALPHA_KEY = "new-secret";
  expect(snapshot.config.providers.alpha!.extraBody.nested).toEqual([{ deep: ["original"] }]);
  expect(snapshot.environment.ALPHA_KEY).toBe("alpha-secret");
  expect(() => { snapshot.config.routing.choices.actions.push("finish"); }).toThrow();
});
