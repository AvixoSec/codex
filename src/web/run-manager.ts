import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { EffectBarrier } from "../core/effect-barrier.js";
import { createRunDependencySnapshot } from "../core/run-snapshot.js";
import { isValidRunId } from "../core/run-id.js";
import { publicError, publicText, PUBLIC_CONTENT_BYTES, PUBLIC_SUMMARY_BYTES } from "../core/public-projector.js";
import type { RunOptions, RunResult } from "../core/runner.js";
import type { HarnessConfig } from "../core/types.js";
import type { PublicError, PublicErrorCode, PublicRouteDecision, RequestContext, RunnerTelemetryEvent } from "../core/telemetry.js";
import type { ApprovalRequest } from "../tools/approval.js";
import { validateRouteOverride, type RouteOverride } from "../router/override.js";
import { ApprovalBroker, InputBroker } from "./brokers.js";
import type { WebErrorEnvelope, WebJournalEvent, WebRouteOverride, WebRunSnapshot, WebRunSummary } from "./contracts.js";
import { EventJournal } from "./event-journal.js";
import { WebRuntimeError } from "./errors.js";

export interface StartRunOptions { goal: string; maxSteps?: number; shadow?: boolean }
export interface ManagedRunner { run(options: RunOptions): Promise<RunResult> }
export interface RunFactoryContext {
  readonly runId: string;
  readonly workspace: string;
  readonly config: HarnessConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly effectBarrier: EffectBarrier;
  readonly promptApproval: (request: ApprovalRequest, context?: RequestContext) => Promise<boolean>;
}
export interface RunManagerDependencies {
  workspace: string;
  loadConfig(): Promise<HarnessConfig>;
  loadEnvironment(config: HarnessConfig): Promise<Record<string, string | undefined>>;
  createRunner(context: RunFactoryContext): Promise<ManagedRunner>;
  createRunId?: () => string;
  now?: () => number;
}
const errors = {
  INVALID_START: [400, "Invalid run start."], INVALID_OVERRIDE: [400, "Invalid route override."],
  RUN_NOT_FOUND: [404, "Run was not found."], WORKSPACE_BUSY: [409, "Workspace has an active run."],
  RUN_STALE: [409, "Run no longer accepts this operation."], START_FAILED: [500, "Run could not be started."],
  CANCEL_FAILED: [500, "Run could not be cancelled."]
} as const;
export class RunManagerError extends Error {
  readonly status: 400 | 404 | 409 | 500;
  constructor(readonly code: keyof typeof errors) { super(errors[code][1]); this.name = "RunManagerError"; this.status = errors[code][0]; }
  toEnvelope(): WebErrorEnvelope { return { error: { code: this.code, message: errors[this.code][1] } }; }
}
const reservations = new Map<string, symbol>();
const publicErrorCodes: readonly PublicErrorCode[] = ["RUN_ABORTED", "TIME_LIMIT", "STEP_LIMIT", "ROUTER_FAILED", "PROVIDER_FAILED", "TOOL_FAILED", "APPROVAL_DENIED", "RUN_FAILED"];
function fixedError(error: PublicError): PublicError {
  return publicError(publicErrorCodes.includes(error.code) ? error.code : "RUN_FAILED");
}
function safeTelemetry(input: RunnerTelemetryEvent, secrets: readonly string[]): RunnerTelemetryEvent {
  const event = structuredClone(input);
  const text = (value: string, bytes = PUBLIC_SUMMARY_BYTES) => publicText(value, bytes, secrets);
  if ("error" in event.data && event.data.error) event.data.error = fixedError(event.data.error);
  switch (event.type) {
    case "run_started": event.data.goal = text(event.data.goal); break;
    case "run_finished": event.data.finalText = text(event.data.finalText, PUBLIC_CONTENT_BYTES); break;
    case "route_resolved":
      event.data.target = text(event.data.target);
      event.data.provider = text(event.data.provider);
      event.data.model = text(event.data.model);
      break;
    case "worker_started": case "worker_failed": event.data.target = text(event.data.target); break;
    case "worker_completed": event.data.target = text(event.data.target); event.data.content = text(event.data.content, PUBLIC_CONTENT_BYTES); break;
    case "tool_completed":
      event.data.content = text(event.data.content, PUBLIC_CONTENT_BYTES);
      event.data.callId = text(event.data.callId); event.data.name = text(event.data.name); break;
    case "tool_requested": case "tool_started": case "tool_failed":
      event.data.callId = text(event.data.callId); event.data.name = text(event.data.name); break;
    case "approval_requested": event.data.summary = event.data.category === "shell" ? "Run command" : "Write or edit workspace file"; break;
    case "input_requested": event.data.question = text(event.data.question); break;
    case "input_resolved": if (event.data.outcome === "answered") event.data.answer = text(event.data.answer, PUBLIC_CONTENT_BYTES); break;
  }
  return event;
}
interface ManagedRun {
  token: symbol;
  controller: AbortController;
  journal: EventJournal;
  approvals: ApprovalBroker;
  inputs: InputBroker;
  barrier: EffectBarrier;
  summary?: WebRunSummary;
  terminal?: Extract<RunnerTelemetryEvent, { type: "run_finished" }>;
  latestRoute: PublicRouteDecision | null;
  settled: boolean;
  cancellationRequested: boolean;
  cancellationOwnsOutcome: boolean;
  approvalIds: Set<string>;
  inputIds: Set<string>;
  config?: HarnessConfig;
  override?: RouteOverride;
}

export class RunManager {
  private readonly runs = new Map<string, ManagedRun>();
  private constructor(private readonly dependencies: RunManagerDependencies, private readonly workspace: string) {}
  static async create(dependencies: RunManagerDependencies): Promise<RunManager> {
    try {
      const workspace = await realpath(resolve(dependencies.workspace));
      if (!(await stat(workspace)).isDirectory()) throw new Error();
      return new RunManager(dependencies, workspace);
    } catch { throw new RunManagerError("START_FAILED"); }
  }
  async start(options: StartRunOptions): Promise<WebRunSummary> {
    if (!options || typeof options !== "object" || Object.keys(options).some((key) => !["goal", "maxSteps", "shadow"].includes(key)) ||
      typeof options.goal !== "string" || !options.goal.trim() ||
      (options.maxSteps !== undefined && (!Number.isSafeInteger(options.maxSteps) || options.maxSteps <= 0)) ||
      (options.shadow !== undefined && typeof options.shadow !== "boolean")) throw new RunManagerError("INVALID_START");
    const requested = { goal: options.goal, maxSteps: options.maxSteps, shadow: options.shadow };
    let runId: string;
    try { runId = (this.dependencies.createRunId ?? (() => `run_${randomUUID()}`))(); } catch { throw new RunManagerError("INVALID_START"); }
    if (!isValidRunId(runId) || this.runs.has(runId)) throw new RunManagerError("INVALID_START");
    if (reservations.has(this.workspace)) throw new RunManagerError("WORKSPACE_BUSY");
    const token = Symbol();
    reservations.set(this.workspace, token);
    const run: ManagedRun = { token, controller: new AbortController(), journal: new EventJournal({ runId, ...(this.dependencies.now ? { now: this.dependencies.now } : {}) }),
      approvals: new ApprovalBroker(), inputs: new InputBroker(), barrier: new EffectBarrier(), latestRoute: null, settled: false, cancellationRequested: false, cancellationOwnsOutcome: false, approvalIds: new Set(), inputIds: new Set() };
    this.runs.set(runId, run);
    // This listener precedes every transport subscriber, so committed envelopes
    // and the summary used for reset snapshots are observable atomically.
    run.journal.subscribe((event) => { if (run.summary) this.update(run, event); });
    try {
      const config = createRunDependencySnapshot(await this.dependencies.loadConfig(), {}).config;
      const snapshot = createRunDependencySnapshot(config, await this.dependencies.loadEnvironment(config));
      run.config = snapshot.config;
      const secrets = Object.values(snapshot.environment).filter((value): value is string => typeof value === "string" && value.length > 0);
      const maxSteps = Math.min(requested.maxSteps ?? config.routing.maxSteps, config.routing.maxSteps);
      const shadow = requested.shadow ?? config.routing.shadow;
      const runner = await this.dependencies.createRunner({ runId, workspace: this.workspace, ...snapshot, signal: run.controller.signal, effectBarrier: run.barrier,
        promptApproval: async (request, context) => {
          this.requestContext(runId, run, context);
          if (request.requestId !== context!.requestId) throw new WebRuntimeError("INVALID_REQUEST_ID");
          run.approvalIds.add(context!.requestId);
          return run.approvals.request({ requestId: context!.requestId, runId, step: context!.step, category: request.kind,
            summary: request.kind === "shell" ? "Run command" : "Write or edit workspace file", signal: run.controller.signal });
        } });
      const goal = publicText(requested.goal, PUBLIC_SUMMARY_BYTES, secrets);
      const event = run.journal.append({ runId, step: 0, type: "run_accepted", data: { goal, maxSteps, shadow } });
      run.summary = { runId, status: "accepted", goal, maxSteps, shadow, step: 0, acceptedAt: event.timestamp, startedAt: null, updatedAt: event.timestamp, finishedAt: null, finalText: "", error: null, historical: false };
      void Promise.resolve().then(() => runner.run({ runId, goal: requested.goal, maxSteps, shadow, signal: run.controller.signal, effectBarrier: run.barrier,
        takeRouteOverride: (context) => {
          if (context.runId !== runId || context.step !== Math.max(1, run.summary!.step) || run.settled || run.controller.signal.aborted) return undefined;
          const override = run.override;
          delete run.override;
          return override;
        },
        askUser: async (question, context) => {
          this.requestContext(runId, run, context);
          run.inputIds.add(context!.requestId);
          return run.inputs.request({ requestId: context!.requestId, runId, step: context!.step, question: publicText(question, PUBLIC_SUMMARY_BYTES, secrets), signal: run.controller.signal });
        }, onTelemetry: (input) => {
        if (input.runId !== runId || run.settled) return;
        const event = safeTelemetry(input, secrets);
        if (event.type === "run_finished") {
          run.terminal ??= { runId, step: event.step, type: "run_finished", data: {
            status: event.data.status, finalText: publicText(event.data.finalText, PUBLIC_CONTENT_BYTES, secrets),
            ...(event.data.error ? { error: fixedError(event.data.error) } : {})
          } };
          return;
        }
        if (run.terminal) return;
        run.journal.append(event);
      } })).then(() => this.finish(runId, run), () => this.finish(runId, run));
      return structuredClone(run.summary);
    } catch {
      run.approvals.closeRun(runId, "terminal");
      run.inputs.closeRun(runId, "terminal");
      await run.barrier.settle();
      this.runs.delete(runId);
      this.release(run);
      throw new RunManagerError("START_FAILED");
    }
  }
  get(runId: string): WebRunSummary {
    const summary = this.runs.get(runId)?.summary;
    if (!summary) throw new RunManagerError("RUN_NOT_FOUND");
    return structuredClone(summary);
  }
  list(): WebRunSummary[] {
    return Array.from(this.runs.values()).flatMap((run) => run.summary ? [structuredClone(run.summary)] : []).reverse();
  }
  snapshot(runId: string): WebRunSnapshot {
    const run = this.owned(runId);
    const journal = run.journal.snapshot();
    return { run: this.get(runId), latestRoute: structuredClone(run.latestRoute), events: journal.events, truncated: journal.truncated,
      pendingApprovals: run.approvals.pending(runId), pendingInputs: run.inputs.pending(runId), generation: journal.generation,
      highWaterId: journal.highWaterId, highWaterSequence: journal.highWaterSequence };
  }
  journal(runId: string): EventJournal { return this.owned(runId).journal; }
  cancel(runId: string): WebRunSummary {
    const run = this.owned(runId);
    if (run.summary!.finishedAt !== null) throw new RunManagerError("RUN_STALE");
    if (run.cancellationRequested) return this.get(runId);
    const ownsOutcome = !run.settled;
    run.cancellationRequested = true;
    let event: WebJournalEvent;
    try { event = run.journal.append({ runId, step: run.summary!.step, type: "run_cancellation_requested", data: {} }); }
    catch {
      run.cancellationRequested = false;
      throw new RunManagerError("CANCEL_FAILED");
    }
    // Reentrant append commits immediately but queues subscriber delivery.
    // Reconcile from its committed envelope before returning to the caller.
    this.update(run, event);
    run.cancellationOwnsOutcome = ownsOutcome;
    run.controller.abort();
    run.approvals.closeRun(runId, "cancelled");
    run.inputs.closeRun(runId, "cancelled");
    return this.get(runId);
  }
  resolveApproval(runId: string, requestId: string, allowed: boolean): void {
    const run = this.active(runId);
    const owner = Array.from(this.runs.values()).find((candidate) => candidate.approvalIds.has(requestId)) ?? run;
    owner.approvals.resolve(runId, requestId, allowed);
  }
  resolveInput(runId: string, requestId: string, answer: string): void {
    const run = this.active(runId);
    const owner = Array.from(this.runs.values()).find((candidate) => candidate.inputIds.has(requestId)) ?? run;
    owner.inputs.resolve(runId, requestId, answer);
  }
  /** A newer pending request replaces the previous one in full, before consumption. */
  setRouteOverride(runId: string, override: WebRouteOverride): void {
    const run = this.owned(runId);
    if (run.settled || run.controller.signal.aborted || run.summary!.finishedAt !== null) throw new RunManagerError("RUN_STALE");
    try { run.override = validateRouteOverride(override, run.config!); }
    catch { throw new RunManagerError("INVALID_OVERRIDE"); }
  }
  private active(runId: string): ManagedRun {
    const run = this.owned(runId);
    if (run.cancellationOwnsOutcome) throw new WebRuntimeError("REQUEST_CANCELLED");
    if (run.settled || run.summary!.finishedAt !== null) throw new WebRuntimeError("RUN_TERMINAL");
    return run;
  }
  private requestContext(runId: string, run: ManagedRun, context?: RequestContext): void {
    this.active(runId);
    if (!context || context.runId !== runId) throw new WebRuntimeError("CROSS_RUN_RESPONSE");
    if (context.step !== run.summary!.step || !Number.isSafeInteger(context.step) || context.step < 1) throw new WebRuntimeError("INVALID_BROKER_REQUEST");
  }
  private owned(runId: string): ManagedRun {
    const run = this.runs.get(runId);
    if (!run?.summary) throw new RunManagerError("RUN_NOT_FOUND");
    return run;
  }
  private update(run: ManagedRun, event: WebJournalEvent): void {
    const summary = run.summary!;
    summary.step = event.step;
    summary.updatedAt = event.timestamp;
    if (event.type === "run_cancellation_requested") summary.status = "cancelling";
    if (event.type === "run_started") { summary.startedAt = event.timestamp; if (summary.status !== "cancelling") summary.status = "running"; }
    if (event.type === "route_resolved") run.latestRoute = structuredClone(event.data);
    if (event.type === "run_finished") {
      summary.status = run.cancellationOwnsOutcome ? "cancelled" : event.data.status;
      summary.finalText = event.data.finalText;
      summary.error = event.data.error ?? null;
      summary.finishedAt = event.timestamp;
    }
  }
  private async finish(runId: string, run: ManagedRun): Promise<void> {
    run.settled = true;
    run.approvals.closeRun(runId, "terminal");
    run.inputs.closeRun(runId, "terminal");
    await run.barrier.settle();
    try {
      const terminal: Extract<RunnerTelemetryEvent, { type: "run_finished" }> = run.cancellationOwnsOutcome
        ? { runId, step: run.summary!.step, type: "run_finished", data: { status: "failed", finalText: "", error: publicError("RUN_ABORTED") } }
        : run.terminal ?? { runId, step: run.summary!.step, type: "run_finished", data: { status: "failed", finalText: "", error: publicError("RUN_FAILED") } };
      run.journal.append(terminal);
    } catch {
      // Publication failures cannot leak diagnostics or leave an accepted run
      // alive after its effects drained. Preserve a terminal already committed.
      if (run.summary!.finishedAt === null) {
        Object.assign(run.summary!, { status: run.cancellationOwnsOutcome ? "cancelled" : "failed", finalText: "", error: publicError(run.cancellationOwnsOutcome ? "RUN_ABORTED" : "RUN_FAILED"), finishedAt: run.summary!.updatedAt });
      }
    } finally {
      const terminalRuns = Array.from(this.runs.entries()).filter(([, value]) => value.summary?.finishedAt !== null && value.summary?.finishedAt !== undefined);
      for (const [id] of terminalRuns.slice(0, Math.max(0, terminalRuns.length - 100))) this.runs.delete(id);
      this.release(run);
    }
  }
  private release(run: ManagedRun): void {
    if (reservations.get(this.workspace) === run.token) reservations.delete(this.workspace);
  }
}
