import { lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import type { ToolCall } from "../src/core/types.js";
import { PolicyApprovalHandler } from "../src/tools/approval.js";
import { toolDefinitions } from "../src/tools/definitions.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { PathPolicy } from "../src/tools/path-policy.js";
import { testConfig } from "./fixtures.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "jevh-workspace-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const answer = 42;\n", "utf8");
  return root;
}

function call(name: string, args: Record<string, unknown>, id = "call-1"): ToolCall {
  return { id, name, arguments: args };
}

describe("tool definitions", () => {
  test("exposes tools only up to the independently selected policy", () => {
    const config = testConfig();
    expect(toolDefinitions(config, "none")).toEqual([]);
    expect(toolDefinitions(config, "read").map((tool) => tool.name)).toEqual([
      "list_files", "read_file", "search_text"
    ]);
    expect(toolDefinitions(config, "write").map((tool) => tool.name)).toContain("replace_in_file");
    expect(toolDefinitions(config, "write").map((tool) => tool.name)).not.toContain("run_command");
  });
});

describe("workspace path policy", () => {
  test("accepts nested workspace files and missing write parents", async () => {
    const root = await workspace();
    const policy = await PathPolicy.create(root, 1_000);

    await expect(policy.readPath("src/index.ts")).resolves.toBe(join(root, "src", "index.ts"));
    await expect(policy.writePath("new/nested/file.ts")).resolves.toBe(join(root, "new", "nested", "file.ts"));
  });

  test.each(["../escape.txt", "/tmp/escape.txt", "src/../../escape.txt", "bad\0name"])(
    "rejects traversal or absolute path %s",
    async (path) => {
      const policy = await PathPolicy.create(await workspace(), 1_000);
      await expect(policy.writePath(path)).rejects.toThrow(/workspace|path/i);
    }
  );

  test("rejects workspace-prefix collisions and symlink escapes", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "jevh-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(root, "linked"), "dir");
    const policy = await PathPolicy.create(root, 1_000);

    await expect(policy.readPath("../" + root.split("/").at(-1) + "-evil/file")).rejects.toThrow();
    await expect(policy.readPath("linked/secret.txt")).rejects.toThrow(/outside|workspace/i);
    await expect(policy.writePath("linked/new.txt")).rejects.toThrow(/outside|workspace/i);
  });

  test("enforces the configured file byte limit", async () => {
    const root = await workspace();
    await writeFile(join(root, "large.txt"), "x".repeat(101), "utf8");
    const policy = await PathPolicy.create(root, 100);

    await expect(policy.readPath("large.txt")).rejects.toThrow(/byte limit/i);
  });

  test("denies environment credential files but permits the example template", async () => {
    const root = await workspace();
    await writeFile(join(root, ".env"), "SUPER_SECRET=live\n", "utf8");
    await writeFile(join(root, ".env.local"), "SUPER_SECRET=local\n", "utf8");
    await writeFile(join(root, ".env.example"), "SUPER_SECRET=replace-me\n", "utf8");
    const policy = await PathPolicy.create(root, 1_000);

    await expect(policy.readPath(".env")).rejects.toThrow(/credential|sensitive/i);
    await expect(policy.readPath(".env.local")).rejects.toThrow(/credential|sensitive/i);
    await expect(policy.readPath(".env.example")).resolves.toBe(join(root, ".env.example"));

    const executor = await ToolExecutor.create(testConfig(), root, { interactive: false });
    const listed = await executor.execute(call("list_files", {}), { policy: "read" });
    const searched = await executor.execute(call("search_text", { query: "SUPER_SECRET=live" }), { policy: "read" });
    expect(listed.content.split("\n")).not.toContain(".env");
    expect(listed.content.split("\n")).not.toContain(".env.local");
    expect(listed.content.split("\n")).toContain(".env.example");
    expect(searched).toMatchObject({ ok: true, content: "" });
  });
});

describe("approvals and execution", () => {
  test("defaults noninteractive ask decisions to deny", async () => {
    const config = testConfig();
    const handler = new PolicyApprovalHandler(config.tools, { interactive: false });

    await expect(handler.authorize({
      kind: "write",
      summary: "write a.txt",
      exactAction: "write_file:a.txt"
    })).resolves.toMatchObject({ allowed: false, reason: "approval_required" });
  });

  test("never allows blocked or control-character commands", async () => {
    const config = testConfig();
    config.tools.approvals.shell = "allow";
    config.tools.safeCommandPrefixes = ["npm test", "echo"];
    const handler = new PolicyApprovalHandler(config.tools, { interactive: true, prompt: vi.fn(async () => true) });

    await expect(handler.authorize({
      kind: "shell",
      summary: "sudo echo x",
      exactAction: "sudo echo x",
      command: "sudo echo x"
    })).resolves.toMatchObject({ allowed: false, reason: "blocked_command" });
    await expect(handler.authorize({
      kind: "shell",
      summary: "echo x",
      exactAction: "echo x\necho y",
      command: "echo x\necho y"
    })).resolves.toMatchObject({ allowed: false, reason: "control_characters" });
  });

  test.each([
    "npm test ; node -e \"process.exit(1)\"",
    "npm test && node -e \"process.exit(1)\"",
    "npm test | node -e \"process.exit(1)\"",
    "npm test > captured.txt",
    "npm test $(node -e \"process.stdout.write('x')\")",
    "npm test `node -e \"process.stdout.write('x')\"`"
  ])("does not auto-authorize shell syntax after a safe prefix: %s", async (command) => {
    const config = testConfig();
    config.tools.approvals.shell = "allow";
    config.tools.safeCommandPrefixes = ["npm test"];
    const handler = new PolicyApprovalHandler(config.tools, { interactive: false });

    await expect(handler.authorize({
      kind: "shell",
      summary: command,
      exactAction: command,
      command
    })).resolves.toMatchObject({ allowed: false, reason: "not_allowlisted" });
  });

  test("still auto-authorizes an argument-only extension of a safe prefix", async () => {
    const config = testConfig();
    config.tools.approvals.shell = "allow";
    config.tools.safeCommandPrefixes = ["npm test"];
    const handler = new PolicyApprovalHandler(config.tools, { interactive: false });

    await expect(handler.authorize({
      kind: "shell",
      summary: "npm test -- --runInBand",
      exactAction: "npm test -- --runInBand",
      command: "npm test -- --runInBand"
    })).resolves.toMatchObject({ allowed: true, reason: "safe_prefix" });
  });

  test("executes reads and approved writes inside the workspace", async () => {
    const root = await workspace();
    const config = testConfig();
    config.tools.approvals.write = "allow";
    const executor = await ToolExecutor.create(config, root, {
      interactive: false
    });

    const read = await executor.execute(call("read_file", { path: "src/index.ts" }), { policy: "read" });
    const write = await executor.execute(call("write_file", { path: "src/new.ts", content: "export {};\n" }), { policy: "write" });

    expect(read).toMatchObject({ ok: true });
    expect(read.content).toContain("answer = 42");
    expect(write).toMatchObject({ ok: true });
    await expect(readFile(join(root, "src", "new.ts"), "utf8")).resolves.toBe("export {};\n");
  });

  test("treats explicit null optional arguments as defaults and rejects other wrong types", async () => {
    const root = await workspace();
    const config = testConfig();
    config.tools.approvals.write = "allow";
    const executor = await ToolExecutor.create(config, root, { interactive: false });

    await expect(executor.execute(call("list_files", { path: null, maxDepth: null }), { policy: "read" }))
      .resolves.toMatchObject({ ok: true });
    await expect(executor.execute(call("list_files", { path: null, maxDepth: 0 }), { policy: "read" }))
      .resolves.toMatchObject({ ok: true });
    await expect(executor.execute(call("read_file", {
      path: "src/index.ts",
      startLine: null,
      endLine: null
    }), { policy: "read" })).resolves.toMatchObject({ ok: true });
    await expect(executor.execute(call("replace_in_file", {
      path: "src/index.ts",
      oldText: "42",
      newText: "43",
      replaceAll: null
    }), { policy: "write" })).resolves.toMatchObject({ ok: true });

    await expect(executor.execute(call("list_files", { path: 7 }), { policy: "read" }))
      .resolves.toMatchObject({ ok: false, code: "TOOL_ERROR" });
    await expect(executor.execute(call("replace_in_file", {
      path: "src/index.ts",
      oldText: "43",
      newText: "44",
      replaceAll: "yes"
    }), { policy: "write" })).resolves.toMatchObject({ ok: false, code: "TOOL_ERROR" });
  });

  test("resolves asynchronous tool failures as TOOL_ERROR", async () => {
    const executor = await ToolExecutor.create(testConfig(), await workspace(), { interactive: false });

    await expect(executor.execute(call("read_file", { path: "missing.txt" }), { policy: "read" }))
      .resolves.toMatchObject({ ok: false, code: "TOOL_ERROR" });
  });

  test("revalidates a missing write target after approval before touching the filesystem", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "jevh-outside-"));
    const config = testConfig();
    const executor = await ToolExecutor.create(config, root, {
      interactive: true,
      prompt: async () => {
        await rename(join(root, "src"), join(root, "src-before-swap"));
        await symlink(outside, join(root, "src"), "dir");
        return true;
      }
    });

    const result = await executor.execute(call("write_file", {
      path: "src/escaped.txt",
      content: "must stay inside\n"
    }), { policy: "write" });

    expect(result).toMatchObject({ ok: false, code: "TOOL_ERROR" });
    await expect(readFile(join(outside, "escaped.txt"), "utf8")).rejects.toThrow();
  });

  test("revalidates a replacement target after approval before touching the filesystem", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "jevh-outside-"));
    await writeFile(join(outside, "index.ts"), "outside sentinel\n", "utf8");
    const config = testConfig();
    const executor = await ToolExecutor.create(config, root, {
      interactive: true,
      prompt: async () => {
        await rename(join(root, "src"), join(root, "src-before-swap"));
        await symlink(outside, join(root, "src"), "dir");
        return true;
      }
    });

    const result = await executor.execute(call("replace_in_file", {
      path: "src/index.ts",
      oldText: "42",
      newText: "99",
      replaceAll: false
    }), { policy: "write" });

    expect(result).toMatchObject({ ok: false, code: "TOOL_ERROR" });
    await expect(readFile(join(outside, "index.ts"), "utf8")).resolves.toBe("outside sentinel\n");
  });

  test("does not reuse a predictable pre-existing temporary path", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "jevh-outside-"));
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "sentinel\n", "utf8");
    const now = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const legacyTemporary = join(root, "src", `new.ts.jevh-${process.pid}-${now}`);
    await symlink(victim, legacyTemporary);
    const config = testConfig();
    config.tools.approvals.write = "allow";
    const executor = await ToolExecutor.create(config, root, { interactive: false });

    try {
      const result = await executor.execute(call("write_file", {
        path: "src/new.ts",
        content: "safe content\n"
      }), { policy: "write" });

      expect(result).toMatchObject({ ok: true });
      await expect(readFile(victim, "utf8")).resolves.toBe("sentinel\n");
      expect((await lstat(join(root, "src", "new.ts"))).isSymbolicLink()).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test("an abort during write approval prevents filesystem effects", async () => {
    const root = await workspace();
    const controller = new AbortController();
    let approve!: (allowed: boolean) => void;
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    const decision = new Promise<boolean>((resolve) => { approve = resolve; });
    const executor = await ToolExecutor.create(testConfig(), root, {
      interactive: true,
      prompt: async () => {
        promptStarted();
        return decision;
      }
    });

    const pending = executor.execute(call("write_file", { path: "src/aborted.ts", content: "bad\n" }), {
      policy: "write",
      signal: controller.signal
    });
    await started;
    controller.abort();
    approve(true);

    await expect(pending).resolves.toMatchObject({ ok: false, code: "ABORTED" });
    await expect(readFile(join(root, "src", "aborted.ts"), "utf8")).rejects.toThrow();
  });

  test("an abort stops waiting for an unresolved approval prompt", async () => {
    const root = await workspace();
    const controller = new AbortController();
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    const executor = await ToolExecutor.create(testConfig(), root, {
      interactive: true,
      prompt: async () => {
        promptStarted();
        return new Promise<boolean>(() => undefined);
      }
    });

    const pending = executor.execute(call("write_file", { path: "src/never-approved.ts", content: "bad\n" }), {
      policy: "write",
      signal: controller.signal
    });
    await started;
    controller.abort();
    const outcome = await Promise.race([
      pending,
      new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), 30))
    ]);

    expect(outcome).toMatchObject({ ok: false, code: "ABORTED" });
    await expect(readFile(join(root, "src", "never-approved.ts"), "utf8")).rejects.toThrow();
  });

  test("an abort during shell approval prevents the command from starting", async () => {
    const root = await workspace();
    const controller = new AbortController();
    let approve!: (allowed: boolean) => void;
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    const decision = new Promise<boolean>((resolve) => { approve = resolve; });
    const config = testConfig();
    config.tools.maxPolicy = "shell";
    const executor = await ToolExecutor.create(config, root, {
      interactive: true,
      prompt: async () => {
        promptStarted();
        return decision;
      }
    });
    const marker = join(root, "command-started.txt");
    const command = `node -e \"require('fs').writeFileSync('${marker}', 'started')\"`;

    const pending = executor.execute(call("run_command", { command }), {
      policy: "shell",
      signal: controller.signal
    });
    await started;
    controller.abort();
    approve(true);

    await expect(pending).resolves.toMatchObject({ ok: false, code: "ABORTED" });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  test("an already-aborted signal prevents a command from starting", async () => {
    const root = await workspace();
    const marker = join(root, "already-aborted.txt");
    const config = testConfig();
    config.tools.maxPolicy = "shell";
    config.tools.approvals.shell = "allow";
    config.tools.safeCommandPrefixes = ["node -e"];
    const executor = await ToolExecutor.create(config, root, { interactive: false });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(call("run_command", {
      command: `node -e \"require('fs').writeFileSync('${marker}', 'started')\"`
    }), { policy: "shell", signal: controller.signal });

    expect(result).toMatchObject({ ok: false, code: "ABORTED" });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  test("denies a tool above the selected policy before approval", async () => {
    const root = await workspace();
    const config = testConfig();
    config.tools.approvals.write = "allow";
    const executor = await ToolExecutor.create(config, root, { interactive: false });

    const result = await executor.execute(call("write_file", { path: "x", content: "x" }), { policy: "read" });

    expect(result).toMatchObject({ ok: false, code: "TOOL_POLICY_DENIED" });
  });

  test("automatically executes only safe-prefix shell commands and truncates output", async () => {
    const root = await workspace();
    const config = testConfig();
    config.tools.maxPolicy = "shell";
    config.tools.approvals.shell = "allow";
    config.tools.safeCommandPrefixes = ["node -e"];
    config.tools.maxOutputBytes = 64;
    const executor = await ToolExecutor.create(config, root, { interactive: false });

    const result = await executor.execute(call("run_command", {
      command: "node -e \"process.stdout.write('x'.repeat(500))\"",
      timeoutMs: 2_000
    }), { policy: "shell" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("[…output truncated…]");
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(120);
  });

  test("kills a command that exceeds the timeout", async () => {
    const root = await workspace();
    const config = testConfig();
    config.tools.maxPolicy = "shell";
    config.tools.approvals.shell = "allow";
    config.tools.safeCommandPrefixes = ["node -e"];
    const executor = await ToolExecutor.create(config, root, { interactive: false });

    const result = await executor.execute(call("run_command", {
      command: "node -e \"setTimeout(() => {}, 10000)\"",
      timeoutMs: 30
    }), { policy: "shell" });

    expect(result).toMatchObject({ ok: false, code: "COMMAND_TIMEOUT" });
  });
});
