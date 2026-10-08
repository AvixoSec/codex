import { randomUUID } from "node:crypto";

import type { ToolsConfig } from "../core/types.js";
import type { RequestContext } from "../core/telemetry.js";

export interface ApprovalRequest {
  requestId?: string;
  kind: "write" | "shell";
  summary: string;
  exactAction: string;
  command?: string;
}

export interface ApprovalDecision {
  allowed: boolean;
  reason: string;
  approvalId?: string;
}

export interface ApprovalOptions {
  interactive: boolean;
  assumeYes?: boolean;
  prompt?: (request: ApprovalRequest, context?: RequestContext) => Promise<boolean>;
}

export interface ApprovalHandler {
  authorize(request: ApprovalRequest, context?: RequestContext): Promise<ApprovalDecision>;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u001b\u202a-\u202e\u2066-\u2069]/u;

function hasShellControlSyntax(command: string): boolean {
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      continue;
    }
    if (character === "\"" && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (quote === "single") continue;
    if (character === "`" || (character === "$" && command[index + 1] === "(")) return true;
    if (!quote && character !== undefined && ";&|<>".includes(character)) return true;
  }
  return escaped || quote !== undefined;
}

function approved(reason: string): ApprovalDecision {
  return { allowed: true, reason, approvalId: randomUUID() };
}

export class PolicyApprovalHandler implements ApprovalHandler {
  readonly #config: ToolsConfig;
  readonly #options: ApprovalOptions;

  constructor(config: ToolsConfig, options: ApprovalOptions) {
    this.#config = config;
    this.#options = options;
  }

  async authorize(request: ApprovalRequest, context?: RequestContext): Promise<ApprovalDecision> {
    if (request.kind === "shell") return this.#authorizeShell(request, context);
    const mode = this.#config.approvals.write;
    if (mode === "deny") return { allowed: false, reason: "policy_denied" };
    if (mode === "allow" || this.#options.assumeYes) return approved("policy_allowed");
    return this.#ask(request, context);
  }

  async #authorizeShell(request: ApprovalRequest, context?: RequestContext): Promise<ApprovalDecision> {
    const command = request.command ?? "";
    if (CONTROL_CHARACTERS.test(command)) return { allowed: false, reason: "control_characters" };
    if (this.#config.blockedCommandPatterns.some((pattern) => new RegExp(pattern, "u").test(command))) {
      return { allowed: false, reason: "blocked_command" };
    }
    const safePrefix = !hasShellControlSyntax(command) && this.#config.safeCommandPrefixes.some(
      (prefix) => command === prefix || command.startsWith(`${prefix} `)
    );
    const mode = this.#config.approvals.shell;
    if (mode === "deny") return { allowed: false, reason: "policy_denied" };
    if (safePrefix && (mode === "allow" || this.#options.assumeYes)) {
      return approved("safe_prefix");
    }
    if (mode === "allow" && !safePrefix) {
      return { allowed: false, reason: "not_allowlisted" };
    }
    return this.#ask(request, context);
  }

  async #ask(request: ApprovalRequest, context?: RequestContext): Promise<ApprovalDecision> {
    if (!this.#options.interactive || !this.#options.prompt) {
      return { allowed: false, reason: "approval_required" };
    }
    return (await this.#options.prompt(request, context))
      ? approved("user_approved")
      : { allowed: false, reason: "user_denied" };
  }
}
