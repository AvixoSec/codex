import { mkdir, mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { testConfig } from "./fixtures.js";
import { encodeManagedCredential, decodeManagedCredential, MANAGED_CREDENTIAL_PREFIX, parseDotenv, editDotenv } from "../src/config/dotenv.js";
import { ConfigService } from "../src/web/services/config-service.js";
import { CredentialService } from "../src/web/services/credential-service.js";
import { loadProjectEnvironment } from "../src/config/environment.js";
import { RunManager, type RunFactoryContext } from "../src/web/run-manager.js";

async function project() {
  const root = await mkdtemp(join(tmpdir(), "task4-env-")); const path = join(root, "config.yaml");
  const config = testConfig(); config.providers.alpha!.headersFromEnv = { PRIVATE_HEADER_SENTINEL: "HEADER_KEY", another: "HEADER_KEY" };
  await writeFile(path, stringify(config));
  return { root, path, config, service: new ConfigService(path) };
}

test("round trips empty unicode quotes equals hashes NUL and every line separator through the exact managed marker", () => {
  for (const value of ["", "ü🌍", "'\"=#\0", "a\nb\r\nc\rd\u2028e\u2029f"]) {
    expect(encodeManagedCredential(value)).toBe("JEVH_MANAGED_B64_V1:" + Buffer.from(value).toString("base64"));
    expect(decodeManagedCredential(encodeManagedCredential(value))).toBe(value);
  }
});

test("leaves invalid padded noncanonical embedded and trailing marker text literal", () => {
  for (const suffix of ["Zg", "Zh==", "Zg===", "Zg==tail", "Zg==\n", "_w==", "/w==", " Zg=="]) {
    const literal = MANAGED_CREDENTIAL_PREFIX + suffix; expect(decodeManagedCredential(literal)).toBe(literal);
  }
  const embedded = "literal" + encodeManagedCredential("v"); expect(decodeManagedCredential(embedded)).toBe(embedded);
});

test("parses LF CRLF CR U+2028 and U+2029 plus quoted multiline assignments", () => {
  for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
    const input = Buffer.from("\ufeff# comment" + separator + "export A = plain # comment" + separator + "B='one" + separator + "two'" + separator + 'C="quote\\\"here\\nline"' + separator + "A=last");
    expect(parseDotenv(input).values).toEqual({ A: "last", B: "one" + separator + "two", C: 'quote\\"here\nline' });
  }
});

test("preserves BOM comments order mixed separators unrelated bytes and final newline state", () => {
  const before = Buffer.from("\ufeff# header\r\nUNCHANGED='first\u2028second'\r");
  const after = Buffer.from("\u2029TAIL = plain # preserved\n# final");
  const original = Buffer.concat([before, Buffer.from('export TARGET = "old\nmultiline\\\"quote" # old comment'), after]);
  expect(editDotenv(original, "TARGET", "new\0\r\n")).toEqual(Buffer.concat([before, Buffer.from("TARGET=" + encodeManagedCredential("new\0\r\n")), after]));
});

test("rejects duplicate target assignments without changing the dotenv bytes", () => {
  const bytes = Buffer.from("TARGET=one\rTARGET='two\nlines'\u2028TAIL=ok"); const original = Buffer.from(bytes);
  expect(() => editDotenv(bytes, "TARGET", "secret")).toThrow("ambiguous"); expect(bytes).toEqual(original);
});

test("uses the dominant separator and preserves final newline state when appending", () => {
  for (const ending of [false, true]) {
    const source = "#a\r\n#b\r\n#c\nTAIL=ok" + (ending ? "\r\n" : "");
    expect(editDotenv(Buffer.from(source), "NEW", "value").toString()).toBe(source + (ending ? "" : "\r\n") + "NEW=" + encodeManagedCredential("value") + (ending ? "\r\n" : ""));
  }
  expect(editDotenv(Buffer.from(""), "A", "").toString()).toBe("A=" + MANAGED_CREDENTIAL_PREFIX);
  expect(editDotenv(Buffer.from("#a\u2029#b\n"), "A", "").toString()).toBe("#a\u2029#b\nA=" + MANAGED_CREDENTIAL_PREFIX + "\u2029");
});

test("serializes different credential-name updates through one canonical dotenv queue", async () => {
  const p = await project(); const alias = p.root + "-alias"; await symlink(p.root, alias);
  await writeFile(join(p.root, ".env"), "# untouched\r\n");
  const a = new CredentialService(p.service, {}); const b = new CredentialService(new ConfigService(join(alias, "config.yaml")), {});
  await Promise.all([a.update("TEST_JEV_KEY", "arbitrary\n\0"), b.update("ALPHA_KEY", "second")]);
  const bytes = await readFile(join(p.root, ".env"));
  expect(bytes.subarray(0, 13).toString()).toBe("# untouched\r\n");
  const values = parseDotenv(bytes).values;
  expect(decodeManagedCredential(values.TEST_JEV_KEY!)).toBe("arbitrary\n\0"); expect(decodeManagedCredential(values.ALPHA_KEY!)).toBe("second");
});

test("returns referenced credential status without values hashes lengths prefixes or header names", async () => {
  const p = await project(); await writeFile(join(p.root, ".env"), "TEST_JEV_KEY=" + encodeManagedCredential("") + "\nHEADER_KEY=" + encodeManagedCredential("PLAINTEXT_SENTINEL"));
  const supplied = { ALPHA_KEY: "INHERITED_SENTINEL" }; const service = new CredentialService(p.service, supplied);
  const status = await service.status();
  expect(status).toEqual([
    { name: "ALPHA_KEY", requiredBy: [{ kind: "provider", providerId: "alpha", usage: "api_key" }], present: true },
    { name: "BETA_KEY", requiredBy: [{ kind: "provider", providerId: "beta", usage: "api_key" }], present: false },
    { name: "HEADER_KEY", requiredBy: [{ kind: "provider", providerId: "alpha", usage: "header" }], present: true },
    { name: "TEST_JEV_KEY", requiredBy: [{ kind: "jev" }], present: true }
  ]);
  expect(JSON.stringify(status)).not.toContain("SENTINEL"); expect(supplied).toEqual({ ALPHA_KEY: "INHERITED_SENTINEL" });
  expect(Object.isFrozen(status[0]!.requiredBy)).toBe(true);
  expect(Object.isFrozen(status)).toBe(true); expect(Object.isFrozen(status[0])).toBe(true);
  await service.update("BETA_KEY", "new"); expect((await service.status())[1]!.present).toBe(true);
});

test("rejects every unreferenced credential name before writing", async () => {
  const p = await project(); const path = join(p.root, ".env"); await writeFile(path, "# original");
  const service = new CredentialService(p.service, {});
  for (const name of ["UNREFERENCED", "PATH", "../escape", "", "__proto__"]) {
    await expect(service.update(name, "VALUE_SENTINEL")).rejects.toMatchObject({ code: "INVALID_CREDENTIAL", status: 400 });
    expect((await readFile(path)).toString()).toBe("# original");
  }
});

test("keeps inherited literal and empty values ahead of file-originated managed values", async () => {
  const p = await project(); await writeFile(join(p.root, ".env"), "A=" + encodeManagedCredential("decoded\0\n") + "\rB=" + encodeManagedCredential("file") + "\u2028C=plain\u2029D=earlier\nD=" + encodeManagedCredential("last"));
  const env = { B: encodeManagedCredential("inherited"), C: "", MISSING: undefined };
  const result = await loadProjectEnvironment(p.path, env);
  expect(result).toBe(env);
  expect(result).toEqual({ A: "decoded\0\n", B: encodeManagedCredential("inherited"), C: "", D: "last", MISSING: undefined });
});

test("mutates the caller environment compatibly while decoding only file-originated markers", async () => {
  const p = await project(); const env = { TEST_JEV_KEY: encodeManagedCredential("literal") };
  await writeFile(join(p.root, ".env"), "TEST_JEV_KEY=" + encodeManagedCredential("file") + "\nALPHA_KEY=" + encodeManagedCredential("decoded"));
  expect(await loadProjectEnvironment(p.path, env)).toBe(env);
  expect(env).toEqual({ TEST_JEV_KEY: encodeManagedCredential("literal"), ALPHA_KEY: "decoded" });
});

test("captures one fresh referenced-only environment snapshot per accepted web run", async () => {
  const p = await project(); const credentials = new CredentialService(p.service, {}); await credentials.update("TEST_JEV_KEY", "FIRST_SENTINEL");
  const contexts: RunFactoryContext[] = []; let finish!: () => void; let id = 0;
  const manager = await RunManager.create({ workspace: p.root, loadConfig: async () => (await p.service.loadInternal()).config,
    loadEnvironment: () => loadProjectEnvironment(p.path, { UNREFERENCED: "UNREFERENCED_SENTINEL" }), createRunId: () => "run_fresh" + ++id,
    createRunner: async (context) => { contexts.push(context); return { run: async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { runId: context.runId, status: "failed", finalText: "", events: [], steps: 0 }; } }; }
  });
  const a = await manager.start({ goal: "safe" }); await new Promise((resolve) => setTimeout(resolve, 0));
  await credentials.update("TEST_JEV_KEY", "SECOND_SENTINEL");
  expect(contexts[0]!.environment.TEST_JEV_KEY).toBe("FIRST_SENTINEL"); expect(contexts[0]!.environment).not.toHaveProperty("UNREFERENCED"); expect(Object.isFrozen(contexts[0]!.environment)).toBe(true);
  await expect(manager.start({ goal: "busy" })).rejects.toHaveProperty("code", "WORKSPACE_BUSY");
  finish(); for (let i = 0; i < 20 && !manager.get(a.runId).finishedAt; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const b = await manager.start({ goal: "safe" }); await new Promise((resolve) => setTimeout(resolve, 0));
  expect(contexts[1]!.environment.TEST_JEV_KEY).toBe("SECOND_SENTINEL");
  expect(JSON.stringify([manager.snapshot(a.runId), manager.snapshot(b.runId)])).not.toContain("SENTINEL"); finish();
});

test("rejects an ambiguous credential service update without writing or poisoning later edits", async () => {
  const p = await project(); const path = join(p.root, ".env"); const bytes = Buffer.from("\ufeffTEST_JEV_KEY=first\u2028TEST_JEV_KEY='second\r\nline'\rALPHA_KEY=old"); await writeFile(path, bytes);
  const service = new CredentialService(p.service, {});
  await expect(service.update("TEST_JEV_KEY", "VALUE_SENTINEL")).rejects.toMatchObject({ code: "AMBIGUOUS_CREDENTIAL", status: 409 }); expect(await readFile(path)).toEqual(bytes);
  await service.update("ALPHA_KEY", "new\0"); expect((await readFile(path)).subarray(0, bytes.indexOf("ALPHA_KEY"))).toEqual(bytes.subarray(0, bytes.indexOf("ALPHA_KEY")));
});

test("keeps shared loader and credential service read failures strict outside CLI", async () => {
  const p = await project(); await mkdir(join(p.root, ".env"));
  const supplied = { TEST_JEV_KEY: "SECRET_SENTINEL" };
  await expect(loadProjectEnvironment(p.path, supplied)).rejects.toHaveProperty("message", "Project environment could not be loaded.");
  const error = await new CredentialService(p.service, supplied).status().catch((e) => e);
  expect(error.toEnvelope()).toEqual({ error: { code: "CREDENTIAL_IO", message: "Credential could not be accessed." } });
  expect(JSON.stringify(error.toEnvelope())).not.toMatch(/EISDIR|SENTINEL|\.env/u);
});
