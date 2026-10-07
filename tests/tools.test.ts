import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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
