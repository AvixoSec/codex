import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { replayReceipts } from "../src/commands/replay.js";
import { redact } from "../src/receipts/redact.js";
import { ReceiptStore } from "../src/receipts/store.js";

describe("receipt redaction", () => {
  test("redacts sensitive keys and known secret substrings recursively", () => {
    const value = {
      authorization: "Bearer abc",
      nested: {
        apiKey: "abc",
        harmless: "prefix-super-secret-suffix",
        rows: [{ password: "pw" }, "super-secret"]
      }
    };

    const result = redact(value, ["super-secret", "abc"]);

    expect(result).toEqual({
      authorization: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
        harmless: "prefix-[REDACTED]-suffix",
        rows: [{ password: "[REDACTED]" }, "[REDACTED]"]
      }
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("abc");
  });
});

describe("receipt store", () => {
  test("appends redacted JSONL in order with private permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-receipts-"));
    const store = new ReceiptStore(directory, ["secret-value"]);

    await Promise.all([
      store.append("run-1", { sequence: 1, kind: "route", token: "secret-value" }),
      store.append("run-1", { sequence: 2, kind: "worker", text: "contains secret-value" }),
      store.append("run-1", { sequence: 3, kind: "done" })
    ]);
    const records = await store.read("run-1");
    const file = store.resolveRun("run-1");
    const mode = (await stat(file)).mode & 0o777;

    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(JSON.stringify(records)).not.toContain("secret-value");
    expect(mode).toBe(0o600);
  });

  test("preserves numeric token metrics through storage and replay while redacting credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-receipts-"));
    const store = new ReceiptStore(directory, ["fixture-known-value"]);

    await store.append("run-metrics", {
      kind: "route",
      step: 1,
      resolved: {
        action: "inspect",
        target: "local/code",
        effort: "high",
        contextTokens: 16_000,
        maxOutputTokens: 4_000,
        toolPolicy: "read"
      },
      usage: { inputTokens: 321, outputTokens: 22 },
      token: "fixture-token-value",
      note: "contains fixture-known-value"
    });
    await store.append("run-metrics", {
      kind: "worker",
      step: 1,
      contextEstimatedTokens: 1_337,
      result: { usage: { inputTokens: 456, outputTokens: 78 } },
      apiKey: "fixture-key-value"
    });

    const replay = await replayReceipts(store.resolveRun("run-metrics"));
    const routeRecord = replay.records[0];
    const workerRecord = replay.records[1];

    expect(replay.routes).toEqual([{
      step: 1,
      target: "local/code",
      action: "inspect",
      effort: "high",
      contextTokens: 16_000,
      maxOutputTokens: 4_000,
      toolPolicy: "read"
    }]);
    expect(routeRecord?.usage).toEqual({ inputTokens: 321, outputTokens: 22 });
    expect(workerRecord).toMatchObject({
      contextEstimatedTokens: 1_337,
      result: { usage: { inputTokens: 456, outputTokens: 78 } }
    });
    expect(routeRecord).toMatchObject({
      token: "[REDACTED]",
      note: "contains [REDACTED]"
    });
    expect(workerRecord).toMatchObject({ apiKey: "[REDACTED]" });
  });

  test("resolves an explicit receipt path without re-executing anything", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-receipts-"));
    const store = new ReceiptStore(directory);
    await store.append("run_a", { kind: "status", status: "complete" });
    const explicitPath = store.resolveRun("run_a");

    expect(store.resolveRun(explicitPath)).toBe(explicitPath);
    await expect(store.read(explicitPath)).resolves.toEqual([
      { kind: "status", status: "complete" }
    ]);
  });

  test("rejects unsafe run IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-receipts-"));
    const store = new ReceiptStore(directory);

    expect(() => store.resolveRun("../outside")).toThrow(/run id/i);
  });
});
