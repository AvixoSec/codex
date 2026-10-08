import { mkdtemp, writeFile, readFile, symlink, mkdir, rename, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { expect, test, vi } from "vitest";
import { ReceiptService } from "../src/web/services/receipt-service.js";
import { safeReadFile, safeFileOperations } from "../src/web/services/safe-file.js";
import { HarnessRunner } from "../src/core/runner.js";
import { RunManager } from "../src/web/run-manager.js";
import { ReceiptStore } from "../src/receipts/store.js";
import { testConfig } from "./fixtures.js";

const timestamp = "2026-10-08T00:00:00.000Z";
async function receipt(records: Record<string, unknown>[] = []) {
  const root = await mkdtemp(join(tmpdir(), "task4-receipt-")); const path = join(root, "run_test.jsonl");
  await writeFile(path, records.map((record) => JSON.stringify({ timestamp, ...record })).join("\n"));
  return { root, path, service: new ReceiptService(root) };
}
const started = { kind: "run_started", goal: "safe goal", maxSteps: 12, shadow: false, step: 0 };
const finished = { kind: "run_finished", status: "completed", finalText: "safe result", step: 1 };

test("rejects absolute traversal and malformed browser run IDs before filesystem access", async () => {
  const service = new ReceiptService("/missing-private-directory");
  for (const id of ["/etc/passwd", "../run_test", "run_test/other", "run_test\\other", "run_", "run_test\0", "run_test\n", "run_" + "a".repeat(121)]) {
    await expect(service.read(id)).rejects.toMatchObject({ status: 400, code: "INVALID_RECEIPT" });
  }
});

test("rejects a symlinked receipt root and final symlink", async () => {
  const f = await receipt([started, finished]); const alias = f.root + "-link"; await symlink(f.root, alias);
  await expect(safeReadFile(alias, "run_test.jsonl", 4096)).rejects.toHaveProperty("code", "UNSUPPORTED_RECEIPT");
  await symlink(f.path, join(f.root, "run_link.jsonl"));
  await expect(safeReadFile(f.root, "run_link.jsonl", 4096)).rejects.toHaveProperty("code", "UNSUPPORTED_RECEIPT");
  expect(await safeReadFile(f.root, "run_test.jsonl", 4096)).toEqual(await readFile(f.path));
});

test("rejects FIFO socket device and directory entries without blocking the event loop", async () => {
  if (process.platform === "win32") return;
  const f = await receipt(); await mkdir(join(f.root, "directory")); await promisify(execFile)("mkfifo", [join(f.root, "fifo")]);
  const socket = createServer(); await new Promise<void>((resolve) => socket.listen(join(f.root, "socket"), resolve));
  let timerRan = false; const timer = new Promise<void>((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 0));
  try {
    for (const name of ["fifo", "socket", "directory"]) await expect(Promise.race([safeReadFile(f.root, name, 4096), new Promise((_, reject) => setTimeout(() => reject(new Error("HUNG")), 200))])).rejects.toHaveProperty("code", "UNSUPPORTED_RECEIPT");
    await expect(safeReadFile("/dev", "null", 4096)).rejects.toHaveProperty("code", "UNSUPPORTED_RECEIPT");
    await timer; expect(timerRan).toBe(true);
  } finally { await new Promise<void>((resolve) => socket.close(() => resolve())); }
});

test("rejects regular-file replacement with a FIFO between preflight and open", async () => {
  if (process.platform === "win32") return;
  const f = await receipt([started]); const fsOpen = safeFileOperations.open; let closed = false;
  vi.spyOn(safeFileOperations, "open").mockImplementationOnce(async (...args: Parameters<typeof fsOpen>) => {
    await rename(f.path, join(f.root, "original")); await promisify(execFile)("mkfifo", [f.path]);
    const handle = await fsOpen(...args); const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => { closed = true; return close(); }); return handle;
  });
  try { await expect(Promise.race([safeReadFile(f.root, "run_test.jsonl", 4096), new Promise((_, reject) => setTimeout(() => reject(new Error("HUNG")), 200))])).rejects.toHaveProperty("code", "UNSUPPORTED_RECEIPT"); expect(closed).toBe(true); }
  finally { vi.restoreAllMocks(); }
});

test("rejects growth or pathname replacement during an incremental read", async () => {
  for (const replacement of [false, true]) {
    const f = await receipt([started]); const fsOpen = safeFileOperations.open; let closed = false;
    vi.spyOn(safeFileOperations, "open").mockImplementationOnce(async (...args: Parameters<typeof fsOpen>) => {
      const handle = await fsOpen(...args); const read = handle.read.bind(handle); const close = handle.close.bind(handle); let changed = false;
      vi.spyOn(handle, "read").mockImplementation(async (...args: any[]) => {
        const result = await (read as any)(...args);
        if (!changed) { changed = true; if (replacement) { await rename(f.path, join(f.root, "original")); await writeFile(f.path, "replacement"); } else await appendFile(f.path, "growth"); }
        return result;
      });
      vi.spyOn(handle, "close").mockImplementation(async () => { closed = true; return close(); }); return handle;
    });
    try { await expect(safeReadFile(f.root, "run_test.jsonl", 4096)).rejects.toHaveProperty("code", "UNSUPPORTED_RECEIPT"); expect(closed).toBe(true); }
    finally { vi.restoreAllMocks(); }
  }
});

test("rejects an oversized file after reading at most cap plus one and closes the handle", async () => {
  const f = await receipt(); await writeFile(f.path, "12345678"); const fsOpen = safeFileOperations.open; let readBytes = 0; let closed = false;
  vi.spyOn(safeFileOperations, "open").mockImplementationOnce(async (...args: Parameters<typeof fsOpen>) => {
    const handle = await fsOpen(...args); const read = handle.read.bind(handle); const close = handle.close.bind(handle); let grew = false;
    vi.spyOn(handle, "read").mockImplementation(async (...args: any[]) => { if (!grew) { grew = true; await appendFile(f.path, "x".repeat(10000)); } const result = await (read as any)(...args); readBytes += result.bytesRead; return result; });
    vi.spyOn(handle, "close").mockImplementation(async () => { closed = true; return close(); }); return handle;
  });
  try { await expect(safeReadFile(f.root, "run_test.jsonl", 8)).rejects.toHaveProperty("code", "UNSUPPORTED_RECEIPT"); expect(readBytes).toBe(9); expect(closed).toBe(true); }
  finally { vi.restoreAllMocks(); }
});

test("returns an empty list for a missing root and safe not found for a missing run", async () => {
  const f = await receipt(); const service = new ReceiptService(join(f.root, "missing"));
  expect(await service.list()).toEqual([]); await expect(service.read("run_absent")).rejects.toMatchObject({ code: "RECEIPT_NOT_FOUND", status: 404 });
});

test("projects only per-kind public receipt fields and fixed safe failures", async () => {
  const secret = "PRIVATE_SENTINEL";
  const f = await receipt([
    { ...started, config: { endpoint: secret }, headers: { Authorization: secret }, extraBody: secret },
    { kind: "worker", step: 1, target: "alpha/fast", result: { text: "safe text", usage: secret, toolCalls: [{ arguments: secret }] }, diagnostics: secret },
    { kind: "worker_error", step: 1, target: "alpha/fast", error: secret, stack: secret, cause: secret },
    { kind: "tool_intent", step: 1, call: { id: "call_1", name: "read_file", arguments: { key: secret } } },
    { kind: "tool_result", step: 1, callId: "call_1", name: "read_file", result: { ok: false, content: secret, metadata: secret } },
    { kind: "user_input", answer: secret, question: secret }, { kind: "unknown", nested: [secret] },
    { ...finished, status: "failed", error: secret, stack: secret }
  ]);
  const result = await f.service.read("run_test");
  expect(result.events.map((event) => event.type)).toEqual(["run_started", "worker_completed", "worker_failed", "tool_requested", "tool_failed", "run_finished"]);
  expect(result.run).toMatchObject({ historical: true, status: "failed", error: { code: "RUN_FAILED", message: "Run failed." }, finalText: "safe result" });
  expect(JSON.stringify(result)).not.toContain(secret);
  for (const event of result.events) expect(Object.keys(event).sort()).toEqual(["schemaVersion", "id", "runId", "sequence", "timestamp", "step", "type", "data"].sort());
});

function route(overrides: Record<string, unknown> = {}) {
  return { kind: "route", step: 1, resolved: { action: "analyze", target: "alpha/fast", baseUrl: "ENDPOINT_SENTINEL", model: "WIRE_MODEL_SENTINEL", effort: "low", contextTokens: 8000, maxOutputTokens: 1000, temperature: 0.2, toolPolicy: "read" }, confidences: { action: 0, target: 0.9, effort: "bad", contextTokens: -1, maxOutputTokens: 2, temperature: null }, completionProbability: 0, adjustments: [{ field: "target", reason: "low_confidence", from: "RAW_SENTINEL", to: "RAW_SENTINEL" }], proposed: "RAW_SENTINEL", ...overrides };
}

test("preserves real zero scores and maps unavailable or router-fallback scores to null", async () => {
  for (const shadow of [false, true]) {
    const f = await receipt([{ ...started, shadow }, route(), finished]); const result = await f.service.read("run_test");
    expect(result.latestRoute).toMatchObject({ target: "alpha/fast", provider: "alpha", model: "fast", provenance: shadow ? "fallback" : "jev", scores: { action: 0, completion: 0, target: 0.9, effort: null, contextTokens: null, maxOutputTokens: null } });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  }
  const f = await receipt([started, { kind: "router_error", step: 1, error: "ERROR_SENTINEL" }, route(), finished]);
  const projected = (await f.service.read("run_test")).latestRoute!;
  expect(projected.provenance).toBe("fallback"); expect(Object.values(projected.scores)).toEqual(Array(8).fill(null));
  const override = await receipt([started, route({ provenance: "user_override" }), finished]); expect((await override.service.read("run_test")).latestRoute!.provenance).toBe("user_override");
});

test("reconstructs complete historical state after a fresh service instance", async () => {
  const f = await receipt([started, route(), { kind: "worker", target: "alpha/fast", step: 1, result: { text: "result" } }, finished]);
  const first = await f.service.read("run_test"); const fresh = await new ReceiptService(f.root).read("run_test");
  expect(fresh).toEqual(first); expect(fresh.run).toMatchObject({ historical: true, status: "completed", finishedAt: timestamp, startedAt: timestamp, finalText: "safe result" });
});

test("marks a receipt without run_finished interrupted with the fixed safe message", async () => {
  const f = await receipt([started, route(), { kind: "worker_error", target: "alpha/fast", step: 1, timestamp: "2026-10-08T01:00:00.000Z", error: "RAW_ERROR_SENTINEL" }]);
  const result = await new ReceiptService(f.root).read("run_test");
  expect(result.run).toMatchObject({ status: "interrupted", finishedAt: "2026-10-08T01:00:00.000Z", error: { code: "RUN_FAILED", message: "Run history is incomplete." } });
  expect(JSON.stringify(result)).not.toContain("SENTINEL");
});

test("assigns deterministic snapshot-local order without claiming live cursor continuity", async () => {
  const f = await receipt([{ ...started, sequence: 100, timestamp: "bad" }, { ...route(), sequence: 400 }, { ...finished, sequence: 900, timestamp: "bad" }]);
  const result = await f.service.read("run_test");
  expect(result.events.map((event) => [event.id, event.sequence, event.timestamp])).toEqual([["run_test:1", 1, timestamp], ["run_test:2", 2, timestamp], ["run_test:3", 3, timestamp]]);
  expect(result.highWaterSequence).toBe(3); expect(result.highWaterId).toBe("run_test:3"); expect(result.run.historical).toBe(true);
});

test("bounds events strings and adjustments while retaining the terminal summary", async () => {
  const many = Array.from({ length: 20 }, () => ({ kind: "worker", target: "alpha/fast", step: 1, result: { text: "ü".repeat(1000) } }));
  const f = await receipt([started, ...many, route({ adjustments: Array.from({ length: 1000 }, () => ({ field: "target", reason: "low_confidence" })) }), { ...finished, finalText: "ü".repeat(1000) }]);
  const result = await new ReceiptService(f.root, { maxRecords: 3, maxStringBytes: 11 }).read("run_test");
  expect(result.events).toHaveLength(3); expect(result.truncated).toBe(true); expect(result.run.status).toBe("completed");
  expect(Buffer.byteLength(result.run.finalText)).toBeLessThanOrEqual(11); expect(result.latestRoute!.adjustments.length).toBeLessThanOrEqual(100);
  expect(result.events.at(-1)!.type).toBe("run_finished"); expect(result.highWaterSequence).toBe(23);
});

test("handles a 100000-element flat and nested array without recursion or argument-spread overflow", async () => {
  const array = Array.from({ length: 100000 }, () => ({ field: "target", reason: "low_confidence", secret: "LARGE_SENTINEL" }));
  const f = await receipt([started, route({ adjustments: array, diagnostics: { nested: [array] }, raw: array }), finished]);
  const result = await new ReceiptService(f.root, { maxFileBytes: 32 * 1024 * 1024, maxRecords: 2 }).read("run_test");
  expect(result.events).toHaveLength(2); expect(result.latestRoute!.adjustments).toHaveLength(100); expect(result.run.status).toBe("completed"); expect(JSON.stringify(result)).not.toContain("SENTINEL");
});

test("paginates detached historical summaries by accepted time and exclusive run cursor", async () => {
  const f = await receipt([started, finished]);
  for (const [id, time] of [["run_a", "2026-10-08T02:00:00.000Z"], ["run_b", "2026-10-08T02:00:00.000Z"], ["run_c", "2026-10-08T01:00:00.000Z"]]) await writeFile(join(f.root, id + ".jsonl"), [{ ...started, timestamp: time }, { ...finished, timestamp: time }].map((record) => JSON.stringify(record)).join("\n"));
  const first = await f.service.list({ limit: 2 }); expect(first.map((run) => run.runId)).toEqual(["run_a", "run_b"]);
  first[0]!.goal = "mutated";
  expect((await f.service.list({ limit: 2, beforeRunId: "run_b" })).map((run) => run.runId)).toEqual(["run_c", "run_test"]);
  expect((await f.service.list())[0]!.goal).toBe("safe goal");
  await expect(f.service.list({ limit: 0 })).rejects.toHaveProperty("code", "INVALID_RECEIPT");
  await expect(f.service.list({ beforeRunId: "../bad" })).rejects.toHaveProperty("code", "INVALID_RECEIPT");
});

test("skips an unsupported file during list but reports a fixed error on direct read", async () => {
  const f = await receipt([started, finished]);
  for (const [id, source] of [["run_invalid", '{"secret":"JSON_SENTINEL"\n'], ["run_array", "[]"], ["run_empty", ""], ["run_unusable", '{"kind":"unknown","value":"SECRET_SENTINEL"}']]) {
    await writeFile(join(f.root, id + ".jsonl"), source);
    const error = await f.service.read(id!).catch((e) => e); expect(error.toEnvelope()).toEqual({ error: { code: "UNSUPPORTED_RECEIPT", message: "Run history is unsupported." } }); expect(JSON.stringify(error)).not.toContain("SENTINEL");
  }
  expect((await f.service.list()).map((run) => run.runId)).toEqual(["run_test"]);
});

test("skips lifecycle records with missing or invalid public step coordinates", async () => {
  const f = await receipt([started, { ...route(), step: -1 }, { kind: "worker", target: "alpha/fast", result: { text: "must not publish" } }, finished]);
  const result = await f.service.read("run_test");
  expect(result.events.map((event) => event.type)).toEqual(["run_started", "run_finished"]); expect(result.latestRoute).toBeNull(); expect(result.truncated).toBe(true);
});

test("recognizes public cancelled terminal history without exposing stored abort diagnostics", async () => {
  const f = await receipt([started, { ...finished, status: "cancelled", error: "ABORT_STACK_SENTINEL" }]);
  const result = await f.service.read("run_test");
  expect(result.run).toMatchObject({ status: "cancelled", error: { code: "RUN_ABORTED", message: "Run aborted." } });
  expect(result.events.at(-1)!.data).toMatchObject({ status: "failed", error: { code: "RUN_ABORTED", message: "Run aborted." } });
  expect(JSON.stringify(result)).not.toContain("SENTINEL");
});

test("rejects parent-directory replacement during a read and validates before any file access", async () => {
  const statSpy = vi.spyOn(safeFileOperations, "lstat");
  const f = await receipt([started, finished]);
  for (const name of ["../escape", "/absolute", "bad\\name", "name\0", ".", ".."]) await expect(safeReadFile(f.root, name, 1024)).rejects.toHaveProperty("code", "INVALID_RECEIPT");
  expect(statSpy).not.toHaveBeenCalled(); vi.restoreAllMocks();
  const fsOpen = safeFileOperations.open; let closed = false;
  vi.spyOn(safeFileOperations, "open").mockImplementationOnce(async (...args: Parameters<typeof fsOpen>) => {
    const handle = await fsOpen(...args); const read = handle.read.bind(handle); const close = handle.close.bind(handle); let changed = false;
    vi.spyOn(handle, "read").mockImplementation(async (...args: any[]) => {
      const result = await (read as any)(...args);
      if (!changed) { changed = true; await rename(f.root, f.root + "-old"); await mkdir(f.root); await writeFile(f.path, "replacement"); } return result;
    });
    vi.spyOn(handle, "close").mockImplementation(async () => { closed = true; return close(); }); return handle;
  });
  try { await expect(safeReadFile(f.root, "run_test.jsonl", 4096)).rejects.toHaveProperty("code", "UNSUPPORTED_RECEIPT"); expect(closed).toBe(true); }
  finally { vi.restoreAllMocks(); }
});

test("rejects receipt-root metadata changes during a read", async () => {
  const f = await receipt([started, finished]); const fsOpen = safeFileOperations.open;
  vi.spyOn(safeFileOperations, "open").mockImplementationOnce(async (...args: Parameters<typeof fsOpen>) => {
    const handle = await fsOpen(...args); const read = handle.read.bind(handle); let changed = false;
    vi.spyOn(handle, "read").mockImplementation(async (...args: any[]) => {
      const result = await (read as any)(...args); if (!changed) { changed = true; await writeFile(join(f.root, "new-entry"), "safe"); } return result;
    }); return handle;
  });
  try { await expect(safeReadFile(f.root, "run_test.jsonl", 4096)).rejects.toHaveProperty("code", "UNSUPPORTED_RECEIPT"); }
  finally { vi.restoreAllMocks(); }
});

test("bounds variable historical identifiers as well as free text", async () => {
  const f = await receipt([started, route(), { kind: "worker", step: 1, target: "alpha/fast", result: { text: "safe" } }, { kind: "tool_intent", step: 1, call: { id: "long_call_identifier", name: "read_file" } }, finished]);
  const result = await new ReceiptService(f.root, { maxStringBytes: 4 }).read("run_test");
  expect(result.latestRoute).toBeNull();
  expect(result.events.find((e) => e.type === "worker_completed")!.data).toMatchObject({ target: "alph" });
  expect(result.events.find((e) => e.type === "tool_requested")!.data).toEqual({ callId: "long", name: "read" });
});

test.each(["Run aborted", "aborted", "failed", "status", "run_finished", "kind", "step", "run_started", "goal", "finalText", "timestamp", "2026", "kindCode", "statusCode"])("reconstructs real cancellation when a credential collides with %s", async (secret) => {
  const root = await mkdtemp(join(tmpdir(), "task4-real-cancel-")); const directory = join(root, "runs");
  const secrets = [secret, "Run aborted", "aborted"];
  const config = testConfig(); const store = new ReceiptStore(directory, secrets);
  let began!: () => void; const deciding = new Promise<void>((resolve) => { began = resolve; });
  const manager = await RunManager.create({ workspace: root, loadConfig: async () => config,
    loadEnvironment: async () => ({ TEST_JEV_KEY: secret, ALPHA_KEY: "aborted", BETA_KEY: "Run aborted" }), createRunId: () => "run_real_cancel",
    createRunner: async (context) => new HarnessRunner(context.config, {
      receipts: store, secrets, now: () => Date.parse(timestamp),
      decisionClient: { decide: async () => { began(); return new Promise(() => {}); } },
      workerClient: { execute: async () => { throw new Error("UNEXPECTED_WORKER_SENTINEL"); } },
      toolExecutor: { execute: async () => { throw new Error("UNEXPECTED_TOOL_SENTINEL"); } }
    })
  });
  const accepted = await manager.start({ goal: `safe task ${secret}` }); await deciding;
  const terminal = new Promise<void>((resolve) => manager.journal(accepted.runId).subscribe((event) => { if (event.type === "run_finished") resolve(); }));
  manager.cancel(accepted.runId); await terminal;
  expect(manager.get(accepted.runId)).toMatchObject({ status: "cancelled", error: { code: "RUN_ABORTED", message: "Run aborted." } });
  const producerRecords = await store.read(accepted.runId);
  expect(producerRecords.at(-1)).toMatchObject({ error: "[REDACTED]" });
  expect.soft(producerRecords.at(-1)).toHaveProperty("step", 0);
  expect.soft(producerRecords.at(-1)).toHaveProperty("aborted", true);
  expect(producerRecords[0]).toMatchObject({ schemaVersion: 1, kindCode: 1, step: 0, timestampMs: Date.parse(timestamp) });
  expect(producerRecords.at(-1)).toMatchObject({ schemaVersion: 1, kindCode: 9, statusCode: 4, timestampMs: Date.parse(timestamp) });
  expect(producerRecords.filter((record) => record.aborted === true)).toHaveLength(1);
  expect(producerRecords[0]).toHaveProperty("goal", "safe task [REDACTED]");
  await store.append(accepted.runId, { kind: "unknown", step: 0, timestamp, error: "ERROR_SENTINEL", stack: "STACK_SENTINEL", cause: "CAUSE_SENTINEL", config: { endpoint: "ENDPOINT_SENTINEL" } });
  const fresh = new ReceiptService(directory); const read = await fresh.read(accepted.runId); const list = await new ReceiptService(directory).list();
  expect.soft(read.run).toMatchObject({ historical: true, status: "cancelled", error: { code: "RUN_ABORTED", message: "Run aborted." } });
  expect.soft(read.run.startedAt).toBe(timestamp);
  expect.soft(list).toMatchObject([{ status: "cancelled", error: { code: "RUN_ABORTED", message: "Run aborted." } }]);
  expect(list).toEqual([read.run]);
  expect(read.events.at(-1)!.data).toMatchObject({ status: "failed", error: { code: "RUN_ABORTED", message: "Run aborted." } });
  expect(JSON.stringify([read, list])).not.toContain("SENTINEL");
  expect(read.run.goal).toBe("safe task [REDACTED]");
  expect(read.run).not.toHaveProperty("aborted");
  expect(read.events.at(-1)!.data).not.toHaveProperty("aborted");
  for (const field of ["aborted", "kindCode", "statusCode", "timestampMs"]) expect(JSON.stringify([read, list])).not.toContain(`"${field}":`);
  // Fixed DTO keys, enum literals and public messages can coincide with a
  // credential. Inspect payload text separately from those trusted contracts.
  const payloadText = JSON.stringify([manager.get(accepted.runId).goal, read.run.goal, read.run.finalText, list.map((run) => [run.goal, run.finalText])]);
  for (const value of secrets) expect(payloadText).not.toContain(value);
});

test("accepts only a true abort boolean on compatible failed terminal records", async () => {
  for (const aborted of [false, "true", 1, null, { value: true }, [true]]) {
    const f = await receipt([started, { ...finished, status: "failed", error: "ERROR_SENTINEL", aborted }]);
    const result = await f.service.read("run_test");
    expect(result.run).toMatchObject({ status: "failed", error: { code: "RUN_FAILED", message: "Run failed." } });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  }
  for (const status of ["completed", "needs_input", "limit", "interrupted"]) {
    const f = await receipt([started, { ...finished, status, aborted: true, error: "ERROR_SENTINEL" }]);
    const result = await f.service.read("run_test");
    expect(result.run.status).toBe(status);
    expect(result.run.error?.code).not.toBe("RUN_ABORTED");
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  }
  const malformed = await receipt([started, { ...finished, status: "failed", aborted: true, finalText: null }]);
  expect((await malformed.service.read("run_test")).run.status).toBe("interrupted");
});

test("rejects forged coded terminals with unrelated or contradictory control literals", async () => {
  for (const fields of [{ kind: "bogus" }, { status: "bogus" }, { kind: "route" }, { status: "completed" }]) {
    const f = await receipt([started, { ...finished, schemaVersion: 1, kindCode: 9, statusCode: 4, status: "failed", aborted: true, ...fields }]);
    const result = await f.service.read("run_test");
    expect.soft(result.run).toMatchObject({ status: "interrupted", error: { code: "RUN_FAILED", message: "Run history is incomplete." } });
  }
});

test("rejects unknown primitive and out-of-range codes without falling back to legacy strings", async () => {
  for (const value of [0, -1, 1.5, 10, "9", true, null, {}, [9]]) {
    for (const key of ["kindCode", "statusCode"]) {
      const f = await receipt([started, { ...finished, schemaVersion: 1, status: "failed", aborted: true, [key]: value }]);
      const result = await f.service.read("run_test");
      expect(result.run.status).toBe("interrupted");
      expect(result.truncated).toBe(true);
    }
  }
  for (const fields of [{ schemaVersion: 2 }, { step: "1" }, { kind: null }, { status: null }, { finalText: null }]) {
    const f = await receipt([started, { ...finished, schemaVersion: 1, kindCode: 9, statusCode: 4, status: "failed", aborted: true, ...fields }]);
    expect((await f.service.read("run_test")).run.status).toBe("interrupted");
  }
});

test("maps all exact terminal codes while keeping nonfailed flags and incomplete history safe", async () => {
  const codedStart = { ...started, schemaVersion: 1, kind: "[REDACTED]", kindCode: 1 };
  for (const [index, status] of ["completed", "needs_input", "limit", "failed"].entries()) {
    const f = await receipt([codedStart, { ...finished, schemaVersion: 1, kind: "[REDACTED]", kindCode: 9, status: "[REDACTED]", statusCode: index + 1, ...(status !== "failed" ? { aborted: true } : {}), error: "ERROR_SENTINEL" }]);
    const result = await f.service.read("run_test");
    expect(result.run.status).toBe(status);
    expect(result.run.error?.code).not.toBe("RUN_ABORTED");
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    for (const field of ["aborted", "kindCode", "statusCode", "timestampMs"]) expect(JSON.stringify(result)).not.toContain(`"${field}":`);
  }
  const incomplete = await receipt([codedStart]);
  expect((await incomplete.service.read("run_test")).run).toMatchObject({ status: "interrupted", error: { code: "RUN_FAILED", message: "Run history is incomplete." } });
});

test("maps every durable record kind through its unchanged per-kind allowlist", async () => {
  const kinds = [started, { kind: "router_error", step: 1, error: "ERROR_SENTINEL" }, route(),
    { kind: "worker_error", step: 1, target: "alpha/fast", error: "ERROR_SENTINEL" },
    { kind: "worker", step: 1, target: "alpha/fast", result: { text: "safe text", diagnostics: "PRIVATE_SENTINEL" } },
    { kind: "tool_intent", step: 1, call: { id: "call_test", name: "read_file", arguments: "PRIVATE_SENTINEL" } },
    { kind: "tool_result", step: 1, callId: "call_test", name: "read_file", result: { ok: false, content: "PRIVATE_SENTINEL" } },
    { kind: "user_input", step: 1, answer: "PRIVATE_SENTINEL" }, finished];
  const f = await receipt(kinds.map((record, index) => ({ ...record, schemaVersion: 1, kind: "[REDACTED]", kindCode: index + 1 })));
  const result = await f.service.read("run_test");
  expect(result.events.map((event) => event.type)).toEqual(["run_started", "route_resolved", "worker_failed", "worker_completed", "tool_requested", "tool_failed", "run_finished"]);
  expect(result.latestRoute!.scores.action).toBeNull();
  expect(result.run.status).toBe("completed");
  expect(JSON.stringify(result)).not.toContain("SENTINEL");
  for (const field of ["aborted", "kindCode", "statusCode", "timestampMs"]) expect(JSON.stringify(result)).not.toContain(`"${field}":`);
});

test("bounds and type-checks durable timestamps without copying forged metadata", async () => {
  for (const value of ["0", true, null, {}, [], 0.5, -62167219200001, 253402300800000]) {
    const f = await receipt([{ ...started, schemaVersion: 1, timestampMs: Date.parse(timestamp) }, { ...finished, schemaVersion: 1, timestampMs: value }]);
    const result = await f.service.read("run_test");
    expect(result.run).toMatchObject({ status: "completed", finishedAt: timestamp });
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('"timestampMs":');
  }
});

test.each(["failed", "deadline", "limit", "completed", "needs_input"] as const)("real durable %s outcomes retain privacy and never gain the abort flag", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "task4-real-outcomes-"));
  const secrets = ["CREDENTIAL_SENTINEL", "failed", "completed", "limit", "needs_input", "status", "kind", "step", "run_started", "run_finished", "2026", "kindCode", "statusCode", "timestampMs"];
  const store = new ReceiptStore(root, secrets); const config = testConfig(); config.routing.maxConsecutiveRouterFailures = 1;
  let now = Date.parse(timestamp); let decisions = 0;
  const runner = new HarnessRunner(config, { receipts: store, secrets, now: () => now,
    decisionClient: { decide: async () => {
      decisions++;
      if (mode === "failed") throw new Error("private error CREDENTIAL_SENTINEL");
      if (mode === "deadline") now += config.routing.maxElapsedMs + 1;
      const action = mode === "needs_input" ? "ask_user" : mode === "completed" && decisions > 1 ? "finish" : "analyze";
      return { action: { value: action, confidence: 1, probabilities: { [action]: 1 } }, completionProbability: action === "finish" ? 1 : 0, errors: {} };
    } },
    workerClient: { execute: async () => ({ text: "safe result CREDENTIAL_SENTINEL", toolCalls: [{ id: "read_test", name: "read_file", arguments: { path: "safe-file", CREDENTIAL_SENTINEL: "CREDENTIAL_SENTINEL" } }] }) },
    toolExecutor: { execute: async () => ({ ok: true, content: "safe tool CREDENTIAL_SENTINEL", metadata: { CREDENTIAL_SENTINEL: "CREDENTIAL_SENTINEL" } }) }
  });
  const runId = `run_outcome_${mode}`; const outcome = await runner.run({ runId, goal: "safe task CREDENTIAL_SENTINEL", maxSteps: mode === "limit" ? 1 : 2 });
  const expected = mode === "deadline" ? "limit" : mode;
  expect(outcome.status).toBe(expected);
  const raw = await store.read(runId); const last = raw.at(-1)!;
  expect(last).toMatchObject({ kindCode: 9, statusCode: ["completed", "needs_input", "limit", "failed"].indexOf(expected) + 1, status: "[REDACTED]" });
  expect(raw.some((record) => Object.hasOwn(record, "aborted"))).toBe(false);
  const result = await new ReceiptService(root).read(runId);
  expect(result.run.status).toBe(expected);
  expect(await new ReceiptService(root).list()).toEqual([result.run]);
  expect(result.run.goal).toBe("safe task [REDACTED]");
  expect(result.run.finalText).toBe(mode === "deadline" || mode === "failed" ? "" : "safe result [REDACTED]");
  expect(result.run.error?.code).not.toBe("RUN_ABORTED");
  expect(JSON.stringify([raw, result])).not.toContain("CREDENTIAL_SENTINEL");
  expect(JSON.stringify(result)).not.toContain("private error");
  for (const field of ["aborted", "kindCode", "statusCode", "timestampMs"]) expect(JSON.stringify(result)).not.toContain(`"${field}":`);
  if (mode !== "deadline" && mode !== "failed") {
    const worker = raw.find((record) => record.kindCode === 5)!;
    expect((worker.result as any).toolCalls[0].arguments).toEqual({ path: "safe-file", "[REDACTED]": "[REDACTED]" });
    const tool = raw.find((record) => record.kindCode === 7)!;
    expect((tool.result as any).metadata).toEqual({ "[REDACTED]": "[REDACTED]" });
  }
});

test("retains exact legacy abort-string compatibility without projecting diagnostics", async () => {
  const f = await receipt([started, { ...finished, status: "failed", error: "Run aborted", cause: "CAUSE_SENTINEL" }]);
  const result = await f.service.read("run_test");
  expect(result.run).toMatchObject({ status: "cancelled", error: { code: "RUN_ABORTED", message: "Run aborted." } });
  expect(await new ReceiptService(f.root).list()).toEqual([result.run]);
  expect(JSON.stringify(result)).not.toContain("SENTINEL");
});

test("keeps near-match abort diagnostics as ordinary safe failures", async () => {
  for (const error of ["Run aborted ERROR_SENTINEL", "Run aborted\n", "run aborted", { message: "Run aborted", cause: "CAUSE_SENTINEL" }]) {
    const f = await receipt([started, { ...finished, status: "failed", error }]); const result = await f.service.read("run_test");
    expect(result.run).toMatchObject({ status: "failed", error: { code: "RUN_FAILED", message: "Run failed." } });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  }
});
