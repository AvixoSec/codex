import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, stat, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect, test, vi } from "vitest";
import { testConfig } from "./fixtures.js";
import { ConfigService } from "../src/web/services/config-service.js";
import { atomicFileOperations, atomicReplace } from "../src/web/services/atomic-file.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task4-config-"));
  const path = join(root, "config.yaml");
  const config = testConfig();
  config.jev.endpoint = "https://ENDPOINT_SENTINEL.example";
  config.providers.alpha!.headersFromEnv = { HEADER_SENTINEL: "HEADER_ENV_SENTINEL" };
  config.providers.alpha!.extraBody = { value: "PROVIDER_BODY_SENTINEL" };
  config.providers.alpha!.models.fast!.extraBody = { value: "MODEL_BODY_SENTINEL" };
  config.tools.safeCommandPrefixes = ["COMMAND_SENTINEL"];
  config.tools.blockedCommandPatterns = ["BLOCKED_SENTINEL"];
  config.receipts.directory = "RECEIPT_PATH_SENTINEL";
  const bytes = Buffer.from("\ufeff# exact bytes\r\n" + stringify(config));
  await writeFile(path, bytes);
  return { root, path, config, bytes, service: new ConfigService(path) };
}

test("hashes the exact config bytes and returns only the safe editor projection", async () => {
  const f = await fixture();
  const document = await f.service.read();
  expect(document.revision).toBe("sha256:" + createHash("sha256").update(f.bytes).digest("hex"));
  expect(document.config.routing).toEqual(f.config.routing);
  expect(JSON.stringify(document)).not.toContain("SENTINEL");
  expect((await f.service.loadInternal()).config).toEqual(f.config);
});

test("strictly rejects unknown nested editor fields with bounded safe issues", async () => {
  const f = await fixture();
  const editor = (await f.service.read()).config;
  expect(f.service.validate(editor)).toEqual({ valid: true, issues: [] });
  for (const object of [editor, editor.jev, editor.routing, editor.routing.choices, editor.routing.fallback, editor.tools, editor.tools.approvals, editor.providers.alpha!, editor.providers.alpha!.models.fast!, editor.providers.alpha!.models.fast!.temperature]) {
    if (typeof object !== "object") continue;
    const bad = structuredClone(editor);
    // Locate the corresponding object through a separate test fixture traversal.
    const find = (root: any, source: any): any => {
      if (source === object) return root;
      for (const key of Object.keys(source)) if (source[key] && typeof source[key] === "object") { const result = find(root[key], source[key]); if (result) return result; }
    };
    find(bad, editor).UNKNOWN_SECRET_SENTINEL = "VALUE_SENTINEL";
    const validation = f.service.validate(bad);
    expect(validation.valid).toBe(false);
    expect(JSON.stringify(validation)).not.toContain("SENTINEL");
    expect(validation.issues.length).toBeLessThanOrEqual(100);
  }
  editor.routing.fallback.target = "INVALID_VALUE_SENTINEL";
  expect(f.service.validate(editor).valid).toBe(false);
  editor.routing.choices.contextTokens = [1, 1];
  expect(f.service.validate(editor).valid).toBe(false);
});

test("preserves hidden endpoint headers bodies command policy and receipts on update", async () => {
  const f = await fixture(); const old = await f.service.read();
  old.config.jev.model = "edited";
  old.config.providers.alpha!.models.new = structuredClone(old.config.providers.alpha!.models.fast!);
  old.config.providers.new = structuredClone(old.config.providers.alpha!);
  delete old.config.providers.beta;
  const saved = await f.service.update(old.config, old.revision);
  const internal = (await f.service.loadInternal()).config;
  expect(internal.jev.endpoint).toBe(f.config.jev.endpoint);
  expect(internal.jev.model).toBe("edited");
  expect(internal.tools.safeCommandPrefixes).toEqual(f.config.tools.safeCommandPrefixes);
  expect(internal.tools.blockedCommandPatterns).toEqual(f.config.tools.blockedCommandPatterns);
  expect(internal.receipts).toEqual(f.config.receipts);
  expect(internal.providers.alpha!.headersFromEnv).toEqual(f.config.providers.alpha!.headersFromEnv);
  expect(internal.providers.alpha!.extraBody).toEqual(f.config.providers.alpha!.extraBody);
  expect(internal.providers.alpha!.models.fast!.extraBody).toEqual(f.config.providers.alpha!.models.fast!.extraBody);
  expect(internal.providers.alpha!.models.new!.extraBody).toEqual({});
  expect(internal.providers.new!.extraBody).toEqual({}); expect(internal.providers.new!.headersFromEnv).toEqual({});
  expect(internal.providers.beta).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain("SENTINEL");
});

test("serializes equivalent editor updates to deterministic YAML with mode 0600", async () => {
  const f = await fixture(); let doc = await f.service.read();
  doc = await f.service.update(doc.config, doc.revision); const bytes = await readFile(f.path);
  const again = await f.service.update(doc.config, doc.revision);
  expect(await readFile(f.path)).toEqual(bytes); expect(again.revision).toBe(doc.revision);
  expect((await stat(f.path)).mode & 0o777).toBe(0o600); expect(bytes.at(-1)).toBe(10);
});

test("returns only the current revision on stale CAS without changing bytes", async () => {
  const f = await fixture(); const doc = await f.service.read();
  await writeFile(f.path, Buffer.concat([f.bytes, Buffer.from("# external edit\n")]));
  const current = await f.service.read(); const before = await readFile(f.path);
  const error = await f.service.update(doc.config, doc.revision).catch((e) => e);
  expect(error.status).toBe(412); expect(error.toEnvelope()).toEqual({ error: { code: "CONFIG_CONFLICT", message: "Configuration has changed.", details: { currentRevision: current.revision } } });
  expect(await readFile(f.path)).toEqual(before); expect(JSON.stringify(error)).not.toContain("SENTINEL");
});

test("allows exactly one concurrent CAS winner across aliased service instances", async () => {
  const f = await fixture(); const alias = f.root + "-alias"; await symlink(f.root, alias);
  const second = new ConfigService(join(alias, ".", "config.yaml")); const doc = await f.service.read();
  const a = structuredClone(doc.config); const b = structuredClone(doc.config); a.jev.model = "a"; b.jev.model = "b";
  const outcomes = await Promise.allSettled([f.service.update(a, doc.revision), second.update(b, doc.revision)]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  expect((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason.status).toBe(412);
});

test("cleans temporary files and recovers the mutation queue after write fsync and rename failures", async () => {
  for (const phase of ["writeFile", "sync", "rename"] as const) {
    const f = await fixture(); const doc = await f.service.read();
    const originalOpen = atomicFileOperations.open;
    if (phase === "rename") vi.spyOn(atomicFileOperations, "rename").mockRejectedValueOnce(new Error("CAUGHT_STACK_CAUSE_SENTINEL"));
    else vi.spyOn(atomicFileOperations, "open").mockImplementationOnce(async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      vi.spyOn(handle, phase).mockRejectedValueOnce(new Error("CAUGHT_STACK_CAUSE_SENTINEL")); return handle;
    });
    try {
      const error = await f.service.update(doc.config, doc.revision).catch((e) => e);
      expect(error.status).toBe(500); expect(JSON.stringify(error.toEnvelope())).not.toContain("SENTINEL");
      expect(await readFile(f.path)).toEqual(f.bytes); expect(await readdir(f.root)).toEqual(["config.yaml"]);
    } finally { vi.restoreAllMocks(); }
    await expect(f.service.update(doc.config, doc.revision)).resolves.toHaveProperty("revision");
  }
});

test("fsyncs the temporary file before rename and the directory after rename", async () => {
  const f = await fixture(); const order: string[] = []; const open = atomicFileOperations.open; const rename = atomicFileOperations.rename;
  vi.spyOn(atomicFileOperations, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args); const sync = handle.sync.bind(handle); const close = handle.close.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => { order.push(args[1] === "wx" ? "file sync" : "directory sync"); return sync(); });
    vi.spyOn(handle, "close").mockImplementation(async () => { order.push(args[1] === "wx" ? "file close" : "directory close"); return close(); });
    return handle;
  });
  vi.spyOn(atomicFileOperations, "rename").mockImplementation(async (...args: Parameters<typeof rename>) => { order.push("rename"); return rename(...args); });
  try { await atomicReplace(f.path, Buffer.from("saved")); expect(order).toEqual(["file sync", "file close", "rename", "directory sync", "directory close"]); }
  finally { vi.restoreAllMocks(); }
});

test("requires every editor field instead of applying internal defaults", async () => {
  const f = await fixture(); const editor = (await f.service.read()).config;
  for (const path of [["jev", "model"], ["jev", "timeoutMs"], ["jev", "apiKeyEnv"], ["routing", "shadow"], ["providers", "alpha", "timeoutMs"], ["providers", "alpha", "retries"], ["providers", "alpha", "models", "fast", "effortMap"]]) {
    const bad: any = structuredClone(editor); let object = bad; for (const key of path.slice(0, -1)) object = object[key]; delete object[path.at(-1)!];
    expect(f.service.validate(bad).valid).toBe(false);
  }
});

test("bounds editor text and collections and sanitizes invalid revision errors", async () => {
  const f = await fixture(); const doc = await f.service.read();
  const invalid = structuredClone(doc.config); invalid.providers.alpha!.models.fast!.description = "INVALID_VALUE_SENTINEL".repeat(1000);
  expect(f.service.validate(invalid).valid).toBe(false); expect(JSON.stringify(f.service.validate(invalid))).not.toContain("SENTINEL");
  const choices = structuredClone(doc.config); choices.routing.choices.contextTokens = Array.from({ length: 256 }, (_, i) => i + 1);
  expect(f.service.validate(choices).valid).toBe(false);
  for (const revision of ["INVALID_REVISION_SENTINEL", doc.revision + "\n", doc.revision.toUpperCase()]) {
    const error = await f.service.update(doc.config, revision).catch((e) => e);
    expect(error.toEnvelope()).toEqual({ error: { code: "INVALID_REVISION", message: "Invalid configuration revision." } });
  }
});

test("keeps the renamed destination on directory fsync failure and never deletes a colliding temp", async () => {
  const f = await fixture(); const doc = await f.service.read(); const fsOpen = atomicFileOperations.open;
  vi.spyOn(atomicFileOperations, "open").mockImplementation(async (...args: Parameters<typeof fsOpen>) => {
    const handle = await fsOpen(...args); if (args[1] === "r") vi.spyOn(handle, "sync").mockRejectedValueOnce(Object.assign(new Error("IO_SENTINEL"), { code: "EIO" })); return handle;
  });
  try {
    await expect(f.service.update(doc.config, doc.revision)).rejects.toHaveProperty("code", "CONFIG_IO");
    expect((await f.service.read()).config).toEqual(doc.config); expect(await readdir(f.root)).toEqual(["config.yaml"]);
  } finally { vi.restoreAllMocks(); }
  const current = await f.service.read(); await expect(f.service.update(current.config, current.revision)).resolves.toHaveProperty("revision");
  const colliding = join(f.root, ".jevh-fixed.tmp"); await writeFile(colliding, "UNRELATED"); vi.spyOn(atomicFileOperations, "randomUUID").mockReturnValue("fixed" as any);
  try { await expect(atomicReplace(f.path, Buffer.from("replacement"))).rejects.toHaveProperty("code", "EEXIST"); expect((await readFile(colliding)).toString()).toBe("UNRELATED"); }
  finally { vi.restoreAllMocks(); }
});
