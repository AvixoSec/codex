import { randomUUID } from "node:crypto";

import { buildContext } from "../context/budget.js";
import type { WorkerClient, WorkerInput } from "../providers/worker-client.js";
import type { DecisionClient } from "../router/jev-client.js";
import { resolveRoute, type RawRouteDecision, type ResolvedRoute } from "../router/resolve.js";
import { toolDefinitions } from "../tools/definitions.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../tools/executor.js";
import { isRunStoppedError, RunGuard } from "./run-guard.js";
import { sanitizeKnownSecrets, sanitizeString } from "./sanitize.js";
import { buildRouterSnapshot } from "./snapshot.js";
import type { AgentEvent, HarnessConfig, ToolCall, WorkerResult } from "./types.js";

export interface ToolExecutorLike {
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ReceiptSink {
  append(runId: string, record: Record<string, unknown>): Promise<void>;
}

export interface RunnerLifecycleEvent {
  kind: "status" | "route" | "worker" | "tool";
  step: number;
  message: string;
  route?: ResolvedRoute;
  toolCall?: ToolCall;
  toolResult?: ToolExecutionResult;
}

export interface RunnerDependencies {
  decisionClient: DecisionClient;
  workerClient: WorkerClient;
  toolExecutor: ToolExecutorLike;
  receipts?: ReceiptSink;
  createRunId?: () => string;
  now?: () => number;
  secrets?: readonly string[];
}

export interface RunOptions {
  goal: string;
  maxSteps?: number;
  shadow?: boolean;
  signal?: AbortSignal;
  askUser?: (question: string) => Promise<string>;
  onEvent?: (event: RunnerLifecycleEvent) => void | Promise<void>;
}

export type RunStatus = "completed" | "needs_input" | "limit" | "failed";

export interface RunResult {
  runId: string;
  status: RunStatus;
  finalText: string;
  events: AgentEvent[];
  steps: number;
  error?: string;
}

function rawChoice(value: string) {
  return { value, confidence: 1, probabilities: { [value]: 1 } };
}

function fallbackDecision(config: HarnessConfig): RawRouteDecision {
  const fallback = config.routing.fallback;
  return {
    action: rawChoice(fallback.action),
    target: rawChoice(fallback.target),
    effort: rawChoice(fallback.effort),
    contextTokens: rawChoice(String(fallback.contextTokens)),
    maxOutputTokens: rawChoice(String(fallback.maxOutputTokens)),
    temperature: rawChoice(String(fallback.temperature)),
    toolPolicy: rawChoice(fallback.toolPolicy),
    completionProbability: 0,
    errors: {}
  };
}

function latestAssistantText(events: readonly AgentEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "assistant_text") return event.content;
  }
  return "";
}

function workerReceipt(result: WorkerResult): Record<string, unknown> {
  return {
    text: result.text,
    toolCalls: result.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments
    })),
    usage: result.usage,
    finishReason: result.finishReason
  };
}

function targetsCredentialFile(call: ToolCall): boolean {
  if (call.name !== "read_file" && call.name !== "search_text") return false;
  const path = call.arguments.path;
  if (typeof path !== "string") return false;
  return path
    .split(/[\\/]/u)
    .some((part) => /^\.env(?:\..+)?$/iu.test(part) && !/^\.env\.(?:example|sample|template)$/iu.test(part));
}

export class HarnessRunner {
  readonly #config: HarnessConfig;
  readonly #decisionClient: DecisionClient;
  readonly #workerClient: WorkerClient;
  readonly #toolExecutor: ToolExecutorLike;
  readonly #receipts: ReceiptSink | undefined;
  readonly #createRunId: () => string;
  readonly #now: () => number;
  readonly #secrets: readonly string[];

  constructor(config: HarnessConfig, dependencies: RunnerDependencies) {
    this.#config = config;
    this.#decisionClient = dependencies.decisionClient;
    this.#workerClient = dependencies.workerClient;
    this.#toolExecutor = dependencies.toolExecutor;
    this.#receipts = dependencies.receipts;
    this.#createRunId = dependencies.createRunId ?? (() => `run_${randomUUID()}`);
    this.#now = dependencies.now ?? Date.now;
    this.#secrets = dependencies.secrets ?? [];
  }

  async run(options: RunOptions): Promise<RunResult> {
    const runId = this.#createRunId();
    const startedAt = this.#now();
    const guard = new RunGuard({
      startedAt,
      maxElapsedMs: this.#config.routing.maxElapsedMs,
      now: this.#now,
      ...(options.signal ? { signal: options.signal } : {})
    });
    const goal = sanitizeString(options.goal, this.#secrets);
    const events: AgentEvent[] = [];
    const usedToolCallIds = new Set<string>();
    const maxSteps = Math.min(options.maxSteps ?? this.#config.routing.maxSteps, this.#config.routing.maxSteps);
    let sequence = 0;
    let workerSteps = 0;
    let routerFailures = 0;
    let providerFailures = 0;

    const emit = async (event: RunnerLifecycleEvent) => {
      await options.onEvent?.(sanitizeKnownSecrets(event, this.#secrets));
    };
    const record = async (kind: string, step: number, data: Record<string, unknown> = {}) => {
      if (!this.#config.receipts.enabled || !this.#receipts) return;
      sequence += 1;
      await this.#receipts.append(runId, sanitizeKnownSecrets({
        schemaVersion: 1,
        runId,
        sequence,
        timestamp: new Date(this.#now()).toISOString(),
        kind,
        step,
        ...data
      }, this.#secrets));
    };
    const finish = async (status: RunStatus, error?: string): Promise<RunResult> => {
      const finalText = latestAssistantText(events);
      await record("run_finished", workerSteps, { status, finalText, error });
      await emit({ kind: "status", step: workerSteps, message: error ? `${status}: ${error}` : status });
      return {
        runId,
        status,
        finalText,
        events,
        steps: workerSteps,
        ...(error ? { error } : {})
      };
    };

    const finishStopped = () => guard.kind === "deadline"
      ? finish("limit", `Elapsed-time limit reached after ${guard.elapsedMs()}ms`)
      : finish("failed", "Run aborted");

    try {
      guard.checkpoint();
      await record("run_started", 0, { goal, maxSteps, shadow: options.shadow ?? this.#config.routing.shadow });
      await emit({ kind: "status", step: 0, message: `run ${runId} started` });

      while (workerSteps < maxSteps) {
        guard.checkpoint();
        const elapsed = guard.elapsedMs();
        const step = workerSteps + 1;
        const snapshot = buildRouterSnapshot({
          goal,
          events,
          step,
          maxSteps,
          elapsedMs: elapsed,
          providerFailures,
          routerFailures,
          secrets: this.#secrets
        });

        let raw: RawRouteDecision;
        try {
          raw = sanitizeKnownSecrets(
            await guard.run(() => this.#decisionClient.decide(snapshot, guard.signal)),
            this.#secrets
          );
          routerFailures = 0;
        } catch (error) {
          if (isRunStoppedError(error)) throw error;
          routerFailures += 1;
          const message = sanitizeString(error instanceof Error ? error.message : String(error), this.#secrets);
          await record("router_error", step, { error: message, consecutiveFailures: routerFailures });
          if (routerFailures >= this.#config.routing.maxConsecutiveRouterFailures) {
            return finish("failed", `Router failed ${routerFailures} consecutive times: ${message}`);
          }
          raw = fallbackDecision(this.#config);
        }

        guard.checkpoint();
        const route = resolveRoute(raw, this.#config, options.shadow ?? this.#config.routing.shadow);
        await record("route", step, {
          proposed: route.proposed,
          resolved: {
            action: route.action,
            target: route.target.id,
            baseUrl: route.target.baseUrl,
            model: route.target.apiModel,
            effort: route.effort,
            contextTokens: route.contextTokens,
            maxOutputTokens: route.maxOutputTokens,
            temperature: route.temperature,
            toolPolicy: route.toolPolicy,
            complete: route.complete
          },
          confidences: route.confidences,
          completionProbability: route.completionProbability,
          adjustments: route.adjustments,
          jevModel: raw.model,
          usage: raw.usage,
          errors: raw.errors
        });
        await emit({ kind: "route", step, message: `${route.action} → ${route.target.id} · ${route.effort}`, route });
        guard.checkpoint();

        if (route.complete && workerSteps > 0) return finish("completed");

        const context = buildContext(goal, events, route.contextTokens);
        const availableTools = toolDefinitions(this.#config, route.toolPolicy);
        const input: WorkerInput = {
          goal,
          context,
          route,
          tools: availableTools,
          signal: guard.signal
        };

        let worker: WorkerResult;
        workerSteps += 1;
        try {
          worker = sanitizeKnownSecrets(
            await guard.run(() => this.#workerClient.execute(input)),
            this.#secrets
          );
          providerFailures = 0;
        } catch (error) {
          if (isRunStoppedError(error)) throw error;
          providerFailures += 1;
          const message = sanitizeString(error instanceof Error ? error.message : String(error), this.#secrets);
          events.push({ type: "error", content: `Provider ${route.target.id} failed: ${message}`, step });
          await record("worker_error", step, { target: route.target.id, error: message, consecutiveFailures: providerFailures });
          await emit({ kind: "worker", step, message: `worker error: ${message}`, route });
          if (providerFailures >= this.#config.routing.maxProviderFailures) {
            return finish("failed", `Provider failed ${providerFailures} consecutive times: ${message}`);
          }
          continue;
        }

        guard.checkpoint();
        if (worker.text) events.push({ type: "assistant_text", content: worker.text, step });
        await record("worker", step, {
          target: route.target.id,
          api: route.target.api,
          contextEstimatedTokens: context.estimatedTokens,
          contextTruncated: context.truncated,
          result: workerReceipt(worker)
        });
        await emit({ kind: "worker", step, message: worker.text || `${worker.toolCalls.length} tool call(s)`, route });
        guard.checkpoint();

        const offeredToolNames = new Set(availableTools.map((tool) => tool.name));
        for (const call of worker.toolCalls) {
          events.push({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments, step });
          let toolResult: ToolExecutionResult;
          if (usedToolCallIds.has(call.id)) {
            toolResult = { ok: false, code: "DUPLICATE_TOOL_CALL", content: `Duplicate tool call ID: ${call.id}` };
          } else {
            usedToolCallIds.add(call.id);
            if (!offeredToolNames.has(call.name)) {
              toolResult = { ok: false, code: "UNKNOWN_TOOL", content: `Unknown or unavailable tool: ${call.name}` };
            } else if (targetsCredentialFile(call)) {
              toolResult = {
                ok: false,
                code: "CREDENTIAL_FILE_DENIED",
                content: "Reading dotenv credential files is denied"
              };
            } else {
              await record("tool_intent", step, {
                call: { id: call.id, name: call.name, arguments: call.arguments },
                policy: route.toolPolicy
              });
              guard.checkpoint();
              try {
                toolResult = sanitizeKnownSecrets(await guard.run(() => this.#toolExecutor.execute(call, {
                  policy: route.toolPolicy,
                  signal: guard.signal
                })), this.#secrets);
              } catch (error) {
                if (isRunStoppedError(error)) throw error;
                toolResult = {
                  ok: false,
                  code: "TOOL_ERROR",
                  content: sanitizeString(error instanceof Error ? error.message : String(error), this.#secrets)
                };
              }
            }
          }
          events.push({
            type: "tool_result",
            callId: call.id,
            name: call.name,
            content: toolResult.content,
            ok: toolResult.ok,
            step
          });
          await record("tool_result", step, {
            callId: call.id,
            name: call.name,
            result: toolResult
          });
          await emit({ kind: "tool", step, message: `${call.name}: ${toolResult.ok ? "ok" : toolResult.code ?? "failed"}`, route, toolCall: call, toolResult });
          guard.checkpoint();
        }

        if (route.action === "ask_user") {
          const question = worker.text || "The agent requires additional input.";
          if (!options.askUser) return finish("needs_input");
          const answer = sanitizeString(await guard.run(() => options.askUser!(question)), this.#secrets);
          events.push({ type: "user_text", content: answer, step });
          await record("user_input", step, { question, answer });
          guard.checkpoint();
        }
      }

      return finish("limit", `Maximum semantic steps reached: ${maxSteps}`);
    } catch (error) {
      if (isRunStoppedError(error)) return finishStopped();
      throw error;
    } finally {
      guard.dispose();
    }
  }
}
