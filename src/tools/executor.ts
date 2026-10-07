import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import { spawn } from "node:child_process";

import { TOOL_POLICIES, type HarnessConfig, type ToolCall, type ToolPolicy } from "../core/types.js";
import { type ApprovalOptions, PolicyApprovalHandler } from "./approval.js";
import { toolDefinition } from "./definitions.js";
import { PathPolicy } from "./path-policy.js";

export interface ToolExecutionContext {
  policy: ToolPolicy;
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  code?: string;
  metadata?: Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function integerArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncateOutput(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "\n[…output truncated…]";
  const prefix = Buffer.from(value).subarray(0, Math.max(0, maxBytes - Buffer.byteLength(marker))).toString("utf8").replace(/�$/u, "");
  return prefix + marker;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const names = ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "SystemRoot", "ComSpec", "PATHEXT"];
  return Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
}

export class ToolExecutor {
  readonly #config: HarnessConfig;
  readonly #paths: PathPolicy;
  readonly #approval: PolicyApprovalHandler;

  private constructor(config: HarnessConfig, paths: PathPolicy, approval: PolicyApprovalHandler) {
    this.#config = config;
    this.#paths = paths;
    this.#approval = approval;
  }

  static async create(config: HarnessConfig, workspace: string, approvalOptions: ApprovalOptions): Promise<ToolExecutor> {
    const paths = await PathPolicy.create(workspace, config.tools.maxFileBytes);
    return new ToolExecutor(config, paths, new PolicyApprovalHandler(config.tools, approvalOptions));
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const definition = toolDefinition(call.name);
      if (!definition || !this.#config.tools.enabled.includes(call.name as never)) {
        return { ok: false, code: "UNKNOWN_TOOL", content: `Unknown or disabled tool: ${call.name}` };
      }
      if (TOOL_POLICIES.indexOf(definition.minimumPolicy) > TOOL_POLICIES.indexOf(context.policy)) {
        return { ok: false, code: "TOOL_POLICY_DENIED", content: `${call.name} requires ${definition.minimumPolicy} policy` };
      }
      switch (call.name) {
        case "list_files":
          return this.#listFiles(call.arguments);
        case "read_file":
          return this.#readFile(call.arguments);
        case "search_text":
          return this.#searchText(call.arguments);
        case "write_file":
          return this.#writeFile(call.arguments);
        case "replace_in_file":
          return this.#replaceInFile(call.arguments);
        case "run_command":
          return this.#runCommand(call.arguments, context.signal);
        default:
          return { ok: false, code: "UNKNOWN_TOOL", content: `Unknown tool: ${call.name}` };
      }
    } catch (error) {
      return {
        ok: false,
        code: "TOOL_ERROR",
        content: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async #walk(root: string, maxDepth: number): Promise<string[]> {
    const output: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > maxDepth || output.length >= 2_000) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue;
        const full = `${directory}/${entry.name}`;
        output.push(relative(this.#paths.root, full).replace(/\\/gu, "/") + (entry.isDirectory() ? "/" : ""));
        if (entry.isDirectory()) await visit(full, depth + 1);
        if (output.length >= 2_000) break;
      }
    };
    await visit(root, 0);
    return output;
  }

  async #listFiles(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const path = typeof args.path === "string" ? args.path : ".";
    const maxDepth = Math.min(10, integerArg(args, "maxDepth", 3));
    const root = await this.#paths.existingPath(path);
    if (!(await stat(root)).isDirectory()) throw new Error("list_files path must be a directory");
    const files = await this.#walk(root, maxDepth);
    return { ok: true, content: truncateOutput(files.join("\n"), this.#config.tools.maxOutputBytes), metadata: { count: files.length } };
  }

  async #readFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const path = await this.#paths.readPath(stringArg(args, "path"));
    const content = await readFile(path, "utf8");
    const start = integerArg(args, "startLine", 1);
    const end = integerArg(args, "endLine", Number.MAX_SAFE_INTEGER);
    if (end < start) throw new Error("endLine must be >= startLine");
    const lines = content.split(/\r?\n/u);
    const selected = lines.slice(start - 1, end).join("\n");
    return { ok: true, content: truncateOutput(selected, this.#config.tools.maxOutputBytes), metadata: { path: relative(this.#paths.root, path), startLine: start, endLine: Math.min(end, lines.length) } };
  }

  async #searchText(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const query = stringArg(args, "query");
    if (!query) throw new Error("query must not be empty");
    const path = typeof args.path === "string" ? args.path : ".";
    const maxResults = Math.min(500, integerArg(args, "maxResults", 100));
    const root = await this.#paths.existingPath(path);
    const candidates = (await stat(root)).isDirectory() ? await this.#walk(root, 20) : [relative(this.#paths.root, root)];
    const matches: string[] = [];
    for (const candidate of candidates) {
      if (candidate.endsWith("/") || matches.length >= maxResults) continue;
      try {
        const full = await this.#paths.readPath(candidate);
        const content = await readFile(full, "utf8");
        if (content.includes("\0")) continue;
        content.split(/\r?\n/u).forEach((line, index) => {
          if (matches.length < maxResults && line.includes(query)) matches.push(`${candidate}:${index + 1}:${line}`);
        });
      } catch {
        // Unreadable and oversized files are intentionally skipped.
      }
    }
    return { ok: true, content: truncateOutput(matches.join("\n"), this.#config.tools.maxOutputBytes), metadata: { count: matches.length } };
  }

  async #writeFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const relativePath = stringArg(args, "path");
    const content = stringArg(args, "content");
    if (Buffer.byteLength(content, "utf8") > this.#config.tools.maxFileBytes) throw new Error("Content exceeds file byte limit");
    const target = await this.#paths.writePath(relativePath);
    const approval = await this.#approval.authorize({
      kind: "write",
      summary: `Write ${relativePath}`,
      exactAction: `write_file:${relativePath}:sha256:${hash(content)}`
    });
    if (!approval.allowed) return { ok: false, code: "APPROVAL_DENIED", content: approval.reason };
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.jevh-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    return { ok: true, content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${relativePath}`, metadata: { approvalId: approval.approvalId } };
  }

  async #replaceInFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const relativePath = stringArg(args, "path");
    const oldText = stringArg(args, "oldText");
    const newText = stringArg(args, "newText");
    if (!oldText) throw new Error("oldText must not be empty");
    const path = await this.#paths.readPath(relativePath);
    const content = await readFile(path, "utf8");
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) throw new Error("oldText was not found");
    const replaceAll = args.replaceAll === true;
    if (occurrences > 1 && !replaceAll) throw new Error("oldText occurs more than once; set replaceAll explicitly");
    const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    if (Buffer.byteLength(next, "utf8") > this.#config.tools.maxFileBytes) throw new Error("Result exceeds file byte limit");
    const approval = await this.#approval.authorize({
      kind: "write",
      summary: `Edit ${relativePath}`,
      exactAction: `replace_in_file:${relativePath}:${hash(oldText)}:${hash(newText)}:${replaceAll}`
    });
    if (!approval.allowed) return { ok: false, code: "APPROVAL_DENIED", content: approval.reason };
    const temporary = `${path}.jevh-${process.pid}-${Date.now()}`;
    await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    return { ok: true, content: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${relativePath}`, metadata: { approvalId: approval.approvalId } };
  }

  async #runCommand(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const command = stringArg(args, "command");
    const requestedTimeout = integerArg(args, "timeoutMs", this.#config.tools.maxCommandTimeoutMs);
    const timeoutMs = Math.min(requestedTimeout, this.#config.tools.maxCommandTimeoutMs);
    const approval = await this.#approval.authorize({
      kind: "shell",
      summary: `Run command: ${command.replace(/[\u0000-\u001f\u007f]/gu, "?")}`,
      exactAction: command,
      command
    });
    if (!approval.allowed) return { ok: false, code: "APPROVAL_DENIED", content: approval.reason };

    return new Promise<ToolExecutionResult>((resolveResult) => {
      const child = spawn(command, {
        cwd: this.#paths.root,
        env: safeEnvironment(),
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      let timedOut = false;
      let settled = false;
      const add = (chunk: Buffer) => {
        if (Buffer.byteLength(output, "utf8") <= this.#config.tools.maxOutputBytes * 2) output += chunk.toString("utf8");
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const kill = () => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const abort = () => kill();
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolveResult({ ok: false, code: "COMMAND_ERROR", content: error.message });
      });
      child.once("close", (code, childSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const content = truncateOutput(output, this.#config.tools.maxOutputBytes);
        if (timedOut) {
          resolveResult({ ok: false, code: "COMMAND_TIMEOUT", content: content || `Command timed out after ${timeoutMs}ms` });
        } else if (signal?.aborted) {
          resolveResult({ ok: false, code: "ABORTED", content: content || "Command aborted" });
        } else {
          resolveResult({
            ok: code === 0,
            ...(code === 0 ? {} : { code: "COMMAND_FAILED" }),
            content,
            metadata: { exitCode: code, signal: childSignal, approvalId: approval.approvalId }
          });
        }
      });
    });
  }
}
