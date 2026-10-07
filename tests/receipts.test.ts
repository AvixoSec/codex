import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

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
