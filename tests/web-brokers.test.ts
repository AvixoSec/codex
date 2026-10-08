import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApprovalBroker, InputBroker } from "../src/web/brokers.js";
import { WebRuntimeError } from "../src/web/errors.js";
import type { BrokerOptions } from "../src/web/brokers.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-10-08T12:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test("runtime error envelopes keep fixed safe messages, codes and statuses without diagnostics", () => {
  const statuses = { INVALID_RUN_ID: 400, INVALID_REQUEST_ID: 400, INVALID_BROKER_REQUEST: 400, DUPLICATE_REQUEST_ID: 409, EVENT_TOO_LARGE: 413, REQUEST_NOT_FOUND: 404, CROSS_RUN_RESPONSE: 409, REQUEST_ALREADY_RESOLVED: 409, REQUEST_EXPIRED: 409, REQUEST_CANCELLED: 409, RUN_TERMINAL: 409 } as const;
  for (const code of Object.keys(statuses) as Array<keyof typeof statuses>) {
    const error = new WebRuntimeError(code);
    const message = error.message;
    error.message = "secret-message";
    error.stack = "secret-stack";
    error.cause = { apiKey: "secret-key", answer: "secret-answer" };
    expect(error.status).toBe(statuses[code]);
    expect(error.toEnvelope()).toEqual({ error: { code, message } });
    expect(JSON.stringify(error.toEnvelope())).not.toContain("secret-");
    const envelope = error.toEnvelope(); envelope.error.message = "mutation";
    expect(error.toEnvelope().error.message).toBe(message);
  }
});

test("approval resolves once using the original trusted request ID and detached insertion-ordered pending DTOs", async () => {
  const broker = new ApprovalBroker();
  const input = { runId: "run_owner", requestId: "approval_first", step: 1, category: "write" as const, summary: "Write a file" };
  const first = broker.request(input);
  const second = broker.request({ ...input, requestId: "approval_second", category: "shell" });
  input.summary = "changed";
  const pending = broker.pending("run_owner");
  expect(pending.map((request) => request.requestId)).toEqual(["approval_first", "approval_second"]);
  expect(pending[0]).toEqual({ requestId: "approval_first", runId: "run_owner", step: 1, category: "write", summary: "Write a file", createdAt: "2026-10-08T12:00:00.000Z", expiresAt: "2026-10-08T12:05:00.000Z" });
  expect(pending).not.toBe(broker.pending("run_owner"));
  expect(pending[0]).not.toBe(broker.pending("run_owner")[0]);
  expect(() => { pending[0]!.summary = "mutation"; }).toThrow(TypeError);
  expect(() => { (pending as unknown[]).pop(); }).toThrow(TypeError);
  broker.resolve("run_owner", "approval_first", true);
  broker.resolve("run_owner", "approval_second", false);
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(false);
  expect(broker.pending("run_owner")).toEqual([]);
});

test("input resolves with the original trusted request ID and detached insertion-ordered pending DTOs", async () => {
  const broker = new InputBroker();
  const input = { runId: "run_owner", requestId: "input_first", step: 1, question: "Which file?" };
  const first = broker.request(input);
  const second = broker.request({ ...input, requestId: "input_second" });
  input.question = "changed";
  const pending = broker.pending("run_owner");
  expect(pending.map((request) => request.requestId)).toEqual(["input_first", "input_second"]);
  expect(pending[0]).toEqual({ requestId: "input_first", runId: "run_owner", step: 1, question: "Which file?", createdAt: "2026-10-08T12:00:00.000Z", expiresAt: "2026-10-08T12:05:00.000Z" });
  expect(pending).not.toBe(broker.pending("run_owner"));
  expect(pending[0]).not.toBe(broker.pending("run_owner")[0]);
  expect(() => { pending[0]!.question = "mutation"; }).toThrow(TypeError);
  broker.resolve("run_owner", "input_first", "a.txt");
  broker.resolve("run_owner", "input_second", "b.txt");
  await expect(first).resolves.toBe("a.txt");
  await expect(second).resolves.toBe("b.txt");
  expect(broker.pending("run_owner")).toEqual([]);
});

describe.each(["approval", "input"] as const)("%s ownership and lifecycle", (kind) => {
  const requestId = `${kind}_one`;
  const runId = "run_owner";
  function create(options?: BrokerOptions) {
    const broker = kind === "approval" ? new ApprovalBroker(options) : new InputBroker(options);
    return {
      broker,
      request(overrides: Record<string, unknown> = {}) {
        return kind === "approval"
          ? (broker as ApprovalBroker).request({ runId, requestId, step: 1, category: "write", summary: "Write file", ...overrides } as Parameters<ApprovalBroker["request"]>[0])
          : (broker as InputBroker).request({ runId, requestId, step: 1, question: "Which file?", ...overrides } as Parameters<InputBroker["request"]>[0]);
      },
      resolve(owner = runId, id = requestId, value: unknown = kind === "approval" ? true : "a.txt") {
        if (kind === "approval") (broker as ApprovalBroker).resolve(owner, id, value as boolean);
        else (broker as InputBroker).resolve(owner, id, value as string);
      }
    };
  }

  test("wrong-run reply is a stable conflict and leaves the owning request settleable", async () => {
    const fixture = create();
    const promise = fixture.request();
    expect(() => fixture.resolve("run_foreign")).toThrow(expect.objectContaining({ code: "CROSS_RUN_RESPONSE", status: 409 }));
    expect(fixture.broker.pending(runId)).toHaveLength(1);
    fixture.resolve();
    await expect(promise).resolves.toBe(kind === "approval" ? true : "a.txt");
  });

  test("unknown valid request IDs return stable synchronous not-found errors", () => {
    const fixture = create();
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code: "REQUEST_NOT_FOUND", status: 404 }));
  });

  test("a pending request ID is globally single-use and duplicates reject without replacing the owner", async () => {
    const fixture = create();
    const promise = fixture.request();
    let rejected: unknown;
    void fixture.request({ runId: "run_foreign" }).catch((error: unknown) => { rejected = error; });
    await Promise.resolve(); await Promise.resolve();
    expect(rejected).toMatchObject({ code: "DUPLICATE_REQUEST_ID", status: 409 });
    expect(fixture.broker.pending(runId)).toHaveLength(1);
    expect(fixture.broker.pending("run_foreign")).toEqual([]);
    fixture.resolve();
    await expect(promise).resolves.toBe(kind === "approval" ? true : "a.txt");
  });

  test("resolved request IDs reject duplicates and all matching late replies with a stable tombstone", async () => {
    const fixture = create();
    const promise = fixture.request();
    fixture.resolve();
    await promise;
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code: "REQUEST_ALREADY_RESOLVED", status: 409 }));
    expect(() => fixture.resolve("run_foreign")).toThrow(expect.objectContaining({ code: "CROSS_RUN_RESPONSE", status: 409 }));
    await expect(fixture.request()).rejects.toMatchObject({ code: "DUPLICATE_REQUEST_ID", status: 409 });
    expect(fixture.broker.pending(runId)).toEqual([]);
  });

  test("timeout expires once and a late response cannot change the rejected promise", async () => {
    const fixture = create({ timeoutMs: 10 });
    const outcome = fixture.request().catch((error: unknown) => error);
    vi.advanceTimersByTime(10);
    expect(fixture.broker.pending(runId)).toEqual([]);
    expect(await outcome).toMatchObject({ code: "REQUEST_EXPIRED", status: 409 });
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code: "REQUEST_EXPIRED", status: 409 }));
    expect(vi.getTimerCount()).toBe(0);
  });

  test("signal abort cancels once, cleans up and prevents a late authorization continuation", async () => {
    const fixture = create();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let authorized = false;
    const outcome = fixture.request({ signal: controller.signal }).then(() => { authorized = true; }, (error: unknown) => error);
    controller.abort(new Error("secret-abort-reason"));
    expect(fixture.broker.pending(runId)).toEqual([]);
    const error = await outcome;
    expect(error).toMatchObject({ code: "REQUEST_CANCELLED", status: 409 });
    expect(JSON.stringify((error as WebRuntimeError).toEnvelope())).not.toContain("secret-");
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code: "REQUEST_CANCELLED", status: 409 }));
    expect(authorized).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("already-aborted requests reject asynchronously and leave no timers/listeners/pending entry", async () => {
    const fixture = create();
    const controller = new AbortController();
    controller.abort("secret-abort-reason");
    const add = vi.spyOn(controller.signal, "addEventListener");
    let error: unknown;
    const promise = fixture.request({ signal: controller.signal });
    expect(promise).toBeInstanceOf(Promise);
    void promise.catch((caught: unknown) => { error = caught; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(error).toMatchObject({ code: "REQUEST_CANCELLED", status: 409 });
    expect(fixture.broker.pending(runId)).toEqual([]);
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code: "REQUEST_CANCELLED" }));
  });

  test.each(["cancelled", "terminal"] as const)("closeRun %s rejects every owned request, is idempotent and blocks reopening", async (reason) => {
    const fixture = create();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const first = fixture.request({ signal: controller.signal }).catch((error: unknown) => error);
    const second = fixture.request({ requestId: `${kind}_two` }).catch((error: unknown) => error);
    const foreign = fixture.request({ runId: "run_foreign", requestId: `${kind}_foreign` });
    fixture.broker.closeRun(runId, reason);
    fixture.broker.closeRun(runId, "terminal");
    const code = reason === "cancelled" ? "REQUEST_CANCELLED" : "RUN_TERMINAL";
    expect(fixture.broker.pending(runId)).toEqual([]);
    expect(await first).toMatchObject({ code, status: 409 });
    expect(await second).toMatchObject({ code, status: 409 });
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code, status: 409 }));
    await expect(fixture.request({ requestId: `${kind}_new` })).rejects.toMatchObject({ code, status: 409 });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(fixture.broker.pending("run_foreign")).toHaveLength(1);
    fixture.resolve("run_foreign", `${kind}_foreign`);
    await foreign;
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["resolve", "abort", "timeout", "cancelled", "terminal"] as const)("first winner %s alone settles and removes all timers/abort listeners", async (winner) => {
    const fixture = create({ timeoutMs: 10 });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let transitions = 0;
    const outcome = fixture.request({ signal: controller.signal }).then((value) => { transitions++; return value; }, (error: unknown) => { transitions++; return error; });
    if (winner === "resolve") fixture.resolve();
    else if (winner === "abort") controller.abort("secret-abort");
    else if (winner === "timeout") vi.advanceTimersByTime(10);
    else fixture.broker.closeRun(runId, winner);
    controller.abort("secret-late-abort");
    vi.advanceTimersByTime(20);
    fixture.broker.closeRun(runId, "cancelled");
    fixture.broker.closeRun(runId, "terminal");
    const expected = winner === "resolve" ? "REQUEST_ALREADY_RESOLVED" : winner === "timeout" ? "REQUEST_EXPIRED" : winner === "terminal" ? "RUN_TERMINAL" : "REQUEST_CANCELLED";
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code: expected, status: 409 }));
    const result = await outcome;
    if (winner === "resolve") expect(result).toBe(kind === "approval" ? true : "a.txt");
    else expect(result).toMatchObject({ code: expected });
    expect(transitions).toBe(1);
    expect(fixture.broker.pending(runId)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
  });

  test("request and closed-run tombstones expire at the exact TTL without renewing on stale operations", async () => {
    let now = Date.now();
    const fixture = create({ tombstoneTtlMs: 20, now: () => now });
    const promise = fixture.request(); fixture.resolve(); await promise;
    fixture.broker.closeRun("run_closed", "cancelled");
    now += 19;
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code: "REQUEST_ALREADY_RESOLVED" }));
    await expect(fixture.request({ runId: "run_closed", requestId: `${kind}_closed` })).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    now += 1;
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code: "REQUEST_NOT_FOUND", status: 404 }));
    const reopened = fixture.request({ runId: "run_closed", requestId: `${kind}_closed` });
    fixture.resolve("run_closed", `${kind}_closed`); await reopened;
    const reused = fixture.request(); fixture.resolve(); await reused;
    expect(fixture.broker.pending(runId)).toEqual([]);
  });

  test("tombstone capacity evicts oldest request and closed-run markers from one bounded store", async () => {
    const fixture = create({ maxTombstones: 2 });
    const first = fixture.request(); fixture.resolve(); await first;
    fixture.broker.closeRun("run_closed", "cancelled");
    const second = fixture.request({ requestId: `${kind}_two` }); fixture.resolve(runId, `${kind}_two`); await second;
    expect(() => fixture.resolve()).toThrow(expect.objectContaining({ code: "REQUEST_NOT_FOUND" }));
    await expect(fixture.request({ runId: "run_closed", requestId: `${kind}_closed` })).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    const third = fixture.request({ requestId: `${kind}_three` }); fixture.resolve(runId, `${kind}_three`); await third;
    const reopened = fixture.request({ runId: "run_closed", requestId: `${kind}_closed` }); fixture.resolve("run_closed", `${kind}_closed`); await reopened;
    expect(() => fixture.resolve(runId, `${kind}_two`)).toThrow(expect.objectContaining({ code: "REQUEST_NOT_FOUND" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  test("pending text is allowlisted and bounded to 2048 UTF-8 bytes without splitting a code point", async () => {
    const fixture = create();
    const text = "a".repeat(2045) + "💫" + "secret-tail";
    const field = kind === "approval" ? "summary" : "question";
    const promise = fixture.request({ [field]: text, command: "secret-command", exactAction: "secret-action", arguments: { value: "secret-args" }, headers: { Authorization: "secret-header" }, endpoint: "secret-endpoint", apiKey: "secret-key", nested: { secret: "secret-nested" } });
    const pending = fixture.broker.pending(runId);
    expect(pending[0]?.[field as "summary"]).toBe("a".repeat(2045));
    expect(new TextEncoder().encode(String(pending[0]?.[field as "summary"])).byteLength).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(pending)).not.toContain("secret-");
    expect(Object.keys(pending[0]!)).toEqual(kind === "approval" ? ["requestId", "runId", "step", "category", "summary", "createdAt", "expiresAt"] : ["requestId", "runId", "step", "question", "createdAt", "expiresAt"]);
    fixture.resolve(); await promise;
    const exact = fixture.request({ requestId: `${kind}_exact`, [field]: "a".repeat(2044) + "💫" });
    expect(new TextEncoder().encode(String(fixture.broker.pending(runId)[0]?.[field as "summary"])).byteLength).toBe(2048);
    fixture.resolve(runId, `${kind}_exact`); await exact;
  });

  test("validates request fields by rejecting the returned promise without allocating state", async () => {
    const fixture = create();
    const invalid: Array<[Record<string, unknown>, string]> = [
      [{ runId: "run_" }, "INVALID_RUN_ID"], [{ runId: "run_a\n" }, "INVALID_RUN_ID"], [{ runId: "run_" + "a".repeat(121) }, "INVALID_RUN_ID"],
      [{ requestId: `${kind}_` }, "INVALID_REQUEST_ID"], [{ requestId: `${kind}_a\n` }, "INVALID_REQUEST_ID"], [{ requestId: `${kind}_` + "a".repeat(161) }, "INVALID_REQUEST_ID"], [{ requestId: kind === "approval" ? "input_wrong" : "approval_wrong" }, "INVALID_REQUEST_ID"],
      [{ step: 0 }, "INVALID_BROKER_REQUEST"], [{ step: 1.5 }, "INVALID_BROKER_REQUEST"], [{ step: "1" }, "INVALID_BROKER_REQUEST"],
      [{ signal: { aborted: false } }, "INVALID_BROKER_REQUEST"],
      [kind === "approval" ? { category: "read" } : { question: 10 }, "INVALID_BROKER_REQUEST"],
      [kind === "approval" ? { summary: 10 } : { question: null }, "INVALID_BROKER_REQUEST"]
    ];
    for (const [overrides, code] of invalid) {
      let error: unknown;
      let promise: Promise<unknown> | undefined;
      expect(() => { promise = fixture.request(overrides); }).not.toThrow();
      expect(promise).toBeInstanceOf(Promise);
      void promise!.catch((caught: unknown) => { error = caught; });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(error).toMatchObject({ code, status: 400 });
    }
    expect(fixture.broker.pending(runId)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("resolve, pending and closeRun reject malformed runtime inputs synchronously without consuming an owner", async () => {
    const fixture = create();
    const promise = fixture.request();
    expect(() => fixture.resolve("run_")).toThrow(expect.objectContaining({ code: "INVALID_RUN_ID", status: 400 }));
    expect(() => fixture.resolve(runId, `${kind}_`)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST_ID", status: 400 }));
    expect(() => fixture.resolve(runId, requestId, kind === "approval" ? "yes" : true)).toThrow(expect.objectContaining({ code: "INVALID_BROKER_REQUEST", status: 400 }));
    expect(() => fixture.broker.pending("run_")).toThrow(expect.objectContaining({ code: "INVALID_RUN_ID", status: 400 }));
    expect(() => fixture.broker.closeRun("run_", "terminal")).toThrow(expect.objectContaining({ code: "INVALID_RUN_ID", status: 400 }));
    expect(() => fixture.broker.closeRun(runId, "other" as "terminal")).toThrow(expect.objectContaining({ code: "INVALID_BROKER_REQUEST", status: 400 }));
    expect(fixture.broker.pending(runId)).toHaveLength(1);
    fixture.resolve(); await promise;
  });

  test("rejects nonpositive/unsafe broker limits before accepting requests", () => {
    for (const field of ["timeoutMs", "tombstoneTtlMs", "maxTombstones"] as const) {
      for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => create({ [field]: value })).toThrow(RangeError);
    }
  });

  test("long valid waits preserve the requested deadline beyond the host timer integer limit", async () => {
    const duration = 2_147_483_648;
    const fixture = create({ timeoutMs: duration });
    const outcome = fixture.request().catch((error: unknown) => error);
    vi.advanceTimersByTime(1);
    expect(fixture.broker.pending(runId)).toHaveLength(1);
    vi.advanceTimersByTime(duration - 2);
    expect(fixture.broker.pending(runId)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(fixture.broker.pending(runId)).toEqual([]);
    expect(await outcome).toMatchObject({ code: "REQUEST_EXPIRED" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    { boundary: "expiry beyond Date range with a positive safe timeout", timeoutMs: Number.MAX_SAFE_INTEGER, timestamp: 0 },
    { boundary: "creation above Date range", timeoutMs: 1, timestamp: 8_640_000_000_000_001 },
    { boundary: "creation below Date range", timeoutMs: 1, timestamp: -8_640_000_000_000_001 },
    { boundary: "expiry one millisecond above Date range", timeoutMs: 1, timestamp: 8_640_000_000_000_000 },
    { boundary: "non-finite creation NaN", timeoutMs: 1, timestamp: NaN },
    { boundary: "non-finite creation Infinity", timeoutMs: 1, timestamp: Infinity },
    { boundary: "non-finite creation -Infinity", timeoutMs: 1, timestamp: -Infinity }
  ])("$boundary rejects the request promise safely before allocating a wait", async ({ timeoutMs, timestamp }) => {
    const fixture = create({ timeoutMs, now: () => timestamp });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const timer = vi.spyOn(globalThis, "setTimeout");
    let promise: Promise<unknown> | undefined;
    expect(() => { promise = fixture.request({ signal: controller.signal }); }).not.toThrow();
    expect(promise).toBeInstanceOf(Promise);
    const error = await promise!.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebRuntimeError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({ code: "INVALID_BROKER_REQUEST", status: 400, message: "Invalid broker request." });
    expect((error as WebRuntimeError).toEnvelope()).toEqual({ error: { code: "INVALID_BROKER_REQUEST", message: "Invalid broker request." } });
    expect(fixture.broker.pending(runId)).toEqual([]);
    expect(timer).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
