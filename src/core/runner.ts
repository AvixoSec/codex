import { randomUUID } from "node:crypto";

import { buildContext } from "../context/budget.js";
import type { WorkerClient, WorkerInput } from "../providers/worker-client.js";
import type { DecisionClient } from "../router/jev-client.js";
import { resolveRoute, type RawRouteDecision, type ResolvedRoute } from "../router/resolve.js";
import type { NextRouteContext, RouteOverride } from "../router/override.js";
import { toolDefinitions } from "../tools/definitions.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../tools/executor.js";
import { isMutatingTool } from "../tools/executor.js";
import type { EffectBarrier } from "./effect-barrier.js";
import { isRunStoppedError, RunGuard } from "./run-guard.js";
import { isValidRunId } from "./run-id.js";
import { projectRouteDecision, publicError, publicText, PUBLIC_CONTENT_BYTES, PUBLIC_SUMMARY_BYTES } from "./public-projector.js";
import { sanitizeKnownSecrets, sanitizeString } from "./sanitize.js";
import { buildRouterSnapshot } from "./snapshot.js";
import type { OnTelemetry, PublicErrorCode, RequestContext, RunnerTelemetryEvent } from "./telemetry.js";
import type { AgentEvent, HarnessConfig, ToolCall, WorkerResult } from "./types.js";

// Durable receipt codes: append only; ReceiptService mirrors these mappings.
const RECEIPT_KINDS = ["run_started", "router_error", "route", "worker_error", "worker", "tool_intent", "tool_result", "user_input", "run_finished"] as const;
const RECEIPT_STATUSES = ["completed", "needs_input", "limit", "failed"] as const;

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
  runId?: string;
  maxSteps?: number;
  shadow?: boolean;
  signal?: AbortSignal;
  askUser?: (question: string, context?: RequestContext) => Promise<string>;
  onEvent?: (event: RunnerLifecycleEvent) => void | Promise<void>;
  onTelemetry?: OnTelemetry;
  takeRouteOverride?: (context: NextRouteContext) => RouteOverride | undefined;
  effectBarrier?: EffectBarrier;
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
    if (options.runId !== undefined && !isValidRunId(options.runId)) throw new Error("Invalid run ID");
    const runId = options.runId ?? this.#createRunId();
    if (options.onTelemetry && !isValidRunId(runId)) throw new Error("Invalid run ID");
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
    let activeStep: number | undefined;
    let activeWorker: string | undefined;
    let activeTool: { callId: string; name: string } | undefined;
    let telemetryTail = Promise.resolve();
    let telemetryClosed = false;
    const pendingApprovals = new Map<string, number>();
    const pendingInputs = new Map<string, number>();

    // The guard can race an executor that is awaiting an approval callback.
    // Queue every source through one sink, and fence late executor resolutions.
    const sendTelemetry: OnTelemetry = (event) => {
      if (telemetryClosed) return telemetryTail;
      if (event.type === "approval_requested") pendingApprovals.set(event.data.requestId, event.step);
      if (event.type === "approval_resolved") {
        if (!pendingApprovals.delete(event.data.requestId)) return telemetryTail;
      }
      if (event.type === "input_requested") pendingInputs.set(event.data.requestId, event.step);
      if (event.type === "input_resolved") {
        if (!pendingInputs.delete(event.data.requestId)) return telemetryTail;
      }
      if (event.type === "run_finished") telemetryClosed = true;
      telemetryTail = telemetryTail.then(() => options.onTelemetry?.(event));
      return telemetryTail;
    };

    const text = (value: string, limit = PUBLIC_CONTENT_BYTES) => publicText(value, limit, this.#secrets);
    const telemetry = async <Type extends RunnerTelemetryEvent["type"]>(type: Type, step: number, data: Extract<RunnerTelemetryEvent, { type: Type }>["data"]) => {
      await sendTelemetry({ runId, type, step, data } as RunnerTelemetryEvent);
    };
    const completeStep = async (status: "completed" | "failed" | "stopped") => {
      if (activeStep === undefined) return;
      const step = activeStep;
      activeStep = undefined;
      await telemetry("step_completed", step, { status });
    };

    const emit = async (event: RunnerLifecycleEvent) => {
      await options.onEvent?.(sanitizeKnownSecrets(event, this.#secrets));
    };
    const record = async (kind: typeof RECEIPT_KINDS[number], step: number, data: Record<string, unknown> = {}, aborted = false) => {
      if (!this.#config.receipts.enabled || !this.#receipts) return;
      sequence += 1;
      // Top-level keys are hardcoded at trusted call sites. Sanitize each value
      // independently, retaining full value/key redaction inside nested payloads.
      const sanitized = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, sanitizeKnownSecrets(value, this.#secrets)]));
      const timestampMs = this.#now();
      await this.#receipts.append(runId, {
        ...sanitized,
        schemaVersion: 1,
        runId,
        sequence,
        timestamp: new Date(timestampMs).toISOString(),
        timestampMs,
        kind,
        kindCode: RECEIPT_KINDS.indexOf(kind) + 1,
        step,
        // ReceiptStore still redacts all strings, including enum literals.
        ...(kind === "run_finished" ? { statusCode: RECEIPT_STATUSES.indexOf(data.status as RunStatus) + 1 } : {}),
        ...(kind === "run_finished" && data.status === "failed" && aborted ? { aborted: true } : {})
      });
    };
    const finish = async (status: RunStatus, error?: string, code?: PublicErrorCode): Promise<RunResult> => {
      const finalText = latestAssistantText(events);
      for (const [requestId, step] of pendingApprovals) {
        await telemetry("approval_resolved", step, { requestId, allowed: false });
      }
      if (status !== "needs_input") {
        for (const [requestId, step] of pendingInputs) {
          await telemetry("input_resolved", step, {
            requestId,
            outcome: code === "RUN_ABORTED" || code === "TIME_LIMIT" ? "cancelled" : "failed",
            error: publicError(code ?? "RUN_FAILED")
          });
        }
      }
      if (activeWorker !== undefined) {
        await telemetry("worker_failed", activeStep ?? workerSteps, { target: activeWorker, error: publicError(code ?? "RUN_FAILED") });
        activeWorker = undefined;
      }
      if (activeTool !== undefined) {
        await telemetry("tool_failed", activeStep ?? workerSteps, { callId: activeTool.callId, name: activeTool.name, error: publicError(code ?? "TOOL_FAILED") });
        activeTool = undefined;
      }
      await completeStep(code === "RUN_ABORTED" || code === "TIME_LIMIT" ? "stopped" : status === "failed" ? "failed" : "completed");
      await record("run_finished", workerSteps, { status, finalText, error }, code === "RUN_ABORTED");
      await emit({ kind: "status", step: workerSteps, message: error ? `${status}: ${error}` : status });
      await telemetry("run_finished", workerSteps, { status, finalText: text(finalText), ...(code ? { error: publicError(code) } : {}) });
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
      ? finish("limit", `Elapsed-time limit reached after ${guard.elapsedMs()}ms`, "TIME_LIMIT")
      : finish("failed", "Run aborted", "RUN_ABORTED");

    try {
      guard.checkpoint();
      await record("run_started", 0, { goal, maxSteps, shadow: options.shadow ?? this.#config.routing.shadow });
      await emit({ kind: "status", step: 0, message: `run ${runId} started` });
      await telemetry("run_started", 0, { goal: text(goal, PUBLIC_SUMMARY_BYTES), maxSteps, shadow: options.shadow ?? this.#config.routing.shadow });

      while (workerSteps < maxSteps) {
        guard.checkpoint();
        const elapsed = guard.elapsedMs();
        const step = workerSteps + 1;
        activeStep = step;
        await telemetry("step_started", step, {});
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
        let proposal: RawRouteDecision | undefined;
        await telemetry("route_requested", step, {});
        try {
          raw = sanitizeKnownSecrets(
            await guard.run(() => this.#decisionClient.decide(snapshot, guard.signal)),
            this.#secrets
          );
          proposal = raw;
          routerFailures = 0;
        } catch (error) {
          if (isRunStoppedError(error)) throw error;
          routerFailures += 1;
          const message = sanitizeString(error instanceof Error ? error.message : String(error), this.#secrets);
          await record("router_error", step, { error: message, consecutiveFailures: routerFailures });
          if (routerFailures >= this.#config.routing.maxConsecutiveRouterFailures) {
            return finish("failed", `Router failed ${routerFailures} consecutive times: ${message}`, "ROUTER_FAILED");
          }
          raw = fallbackDecision(this.#config);
        }

        guard.checkpoint();
        const override = options.takeRouteOverride?.({ runId, step });
        const route = resolveRoute(raw, this.#config, options.shadow ?? this.#config.routing.shadow, override);
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
        await telemetry("route_resolved", step, projectRouteDecision(route, proposal, override ? "user_override" : route.shadow || proposal === undefined ? "fallback" : "jev", this.#secrets));
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
        activeWorker = text(route.target.id, PUBLIC_SUMMARY_BYTES);
        await telemetry("worker_started", step, { target: activeWorker });
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
          await telemetry("worker_failed", step, { target: activeWorker, error: publicError("PROVIDER_FAILED") });
          activeWorker = undefined;
          if (providerFailures >= this.#config.routing.maxProviderFailures) {
            return finish("failed", `Provider failed ${providerFailures} consecutive times: ${message}`, "PROVIDER_FAILED");
          }
          await completeStep("failed");
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
        await telemetry("worker_completed", step, { target: activeWorker, content: text(worker.text) });
        activeWorker = undefined;
        guard.checkpoint();

        const offeredToolNames = new Set(availableTools.map((tool) => tool.name));
        for (const call of worker.toolCalls) {
          const publicCall = { callId: text(call.id, PUBLIC_SUMMARY_BYTES), name: text(call.name, PUBLIC_SUMMARY_BYTES) };
          await telemetry("tool_requested", step, publicCall);
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
              activeTool = publicCall;
              await telemetry("tool_started", step, publicCall);
              try {
                toolResult = sanitizeKnownSecrets(await guard.run(() => {
                  const execution = this.#toolExecutor.execute(call, {
                    policy: route.toolPolicy,
                    signal: guard.signal,
                    runId,
                    step,
                    onTelemetry: sendTelemetry,
                    publicText: text
                  });
                  if (isMutatingTool(call.name)) options.effectBarrier?.track(execution);
                  return execution;
                }), this.#secrets);
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
          if (toolResult.ok) await telemetry("tool_completed", step, { callId: publicCall.callId, name: publicCall.name, content: text(toolResult.content) });
          else await telemetry("tool_failed", step, { callId: publicCall.callId, name: publicCall.name, error: publicError(toolResult.code === "APPROVAL_DENIED" ? "APPROVAL_DENIED" : "TOOL_FAILED") });
          activeTool = undefined;
          guard.checkpoint();
        }

        if (route.action === "ask_user") {
          const question = worker.text || "The agent requires additional input.";
          const requestId = `input_${randomUUID()}`;
          await telemetry("input_requested", step, { requestId, question: text(question, PUBLIC_SUMMARY_BYTES) });
          if (!options.askUser) return finish("needs_input");
          let answer: string;
          try {
            answer = sanitizeString(await guard.run(() => options.askUser!(question, { requestId, runId, step, signal: guard.signal })), this.#secrets);
          } catch (error) {
            if (isRunStoppedError(error)) throw error;
            await telemetry("input_resolved", step, { requestId, outcome: "failed", error: publicError("RUN_FAILED") });
            await finish("failed", "Run failed.", "RUN_FAILED");
            throw error;
          }
          events.push({ type: "user_text", content: answer, step });
          await record("user_input", step, { question, answer });
          guard.checkpoint();
          await telemetry("input_resolved", step, { requestId, outcome: "answered", answer: text(answer) });
        }
        await completeStep("completed");
      }

      return finish("limit", `Maximum semantic steps reached: ${maxSteps}`, "STEP_LIMIT");
    } catch (error) {
      if (isRunStoppedError(error)) return finishStopped();
      throw error;
    } finally {
      guard.dispose();
    }
  }
}
