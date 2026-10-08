import { resolve } from "node:path";
import { isValidRunId } from "../../core/run-id.js";
import { publicError, publicText } from "../../core/public-projector.js";
import { EFFORTS, ROUTE_ACTIONS, TOOL_NAMES, TOOL_POLICIES } from "../../core/types.js";
import type { PublicRouteDecision } from "../../core/telemetry.js";
import type { WebJournalEvent, WebJournalInput, WebReceipt, WebReceiptListQuery, WebReceiptSummary } from "../contracts.js";
import { ServiceError } from "./config-service.js";
import { safeListFiles, safeReadFile } from "./safe-file.js";

function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function integer(value: unknown, positive = false): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0); }
function target(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._-]{1,80}$/u.test(value); }
function time(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null;
}
// Append-only schemaVersion 1 mappings, mirrored by the trusted runner writer.
const receiptKinds = ["run_started", "router_error", "route", "worker_error", "worker", "tool_intent", "tool_result", "user_input", "run_finished"] as const;
const receiptStatuses = ["completed", "needs_input", "limit", "failed"] as const;
const legacyStatuses = [...receiptStatuses, "cancelled", "interrupted"] as const;
function control<T extends string>(record: Record<string, unknown>, key: string, codeKey: string, mapping: readonly T[], legacy: readonly string[] = mapping): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  if (!Object.hasOwn(record, codeKey)) return value;
  const code = record[codeKey];
  if (record.schemaVersion !== 1 || !integer(code, true) || code > mapping.length) return null;
  const decoded = mapping[code - 1];
  if (decoded === undefined) return null;
  // Known contradictory literals are malformed, not credential redaction.
  if (legacy.includes(value)) return value === decoded ? decoded : null;
  return value.includes("[REDACTED]") ? decoded : null;
}
function recordTime(record: Record<string, unknown>): string | null {
  if (!Object.hasOwn(record, "timestampMs")) return time(record.timestamp);
  const value = record.timestampMs;
  if (record.schemaVersion !== 1 || typeof value !== "number" || !Number.isSafeInteger(value) || value < -62167219200000 || value > 253402300799999) return null;
  return time(new Date(value).toISOString());
}
function* records(source: string): Generator<Record<string, unknown>> {
  let start = 0;
  while (start < source.length) {
    let end = source.indexOf("\n", start); if (end === -1) end = source.length;
    const line = source.slice(start, end).trim(); start = end + 1; if (!line) continue;
    let record: Record<string, unknown> | null;
    try { record = object(JSON.parse(line)); } catch { throw new ServiceError("UNSUPPORTED_RECEIPT"); }
    if (!record) throw new ServiceError("UNSUPPORTED_RECEIPT"); yield record;
  }
}
const fields = ["action", "target", "effort", "contextTokens", "maxOutputTokens", "temperature", "toolPolicy"] as const;
const reasons = ["missing_or_malformed", "low_confidence", "not_offered", "shadow_fallback", "unsupported_by_model", "model_limit", "context_safety_margin", "global_tool_ceiling"] as const;
function projectRoute(record: Record<string, unknown>, shadow: boolean, routerFailed: boolean, markTruncated: () => void): PublicRouteDecision | null {
  const resolved = object(record.resolved);
  if (!resolved || !target(resolved.target) || !ROUTE_ACTIONS.includes(resolved.action as never) || !EFFORTS.includes(resolved.effort as never) || !TOOL_POLICIES.includes(resolved.toolPolicy as never) || !integer(resolved.contextTokens, true) || !integer(resolved.maxOutputTokens, true) || !(resolved.temperature === undefined || resolved.temperature === null || typeof resolved.temperature === "number" && Number.isFinite(resolved.temperature) && resolved.temperature >= 0 && resolved.temperature <= 2)) return null;
  const confidences = object(record.confidences);
  const score = (value: unknown) => !routerFailed && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  const adjustments: PublicRouteDecision["adjustments"] = [];
  if (Array.isArray(record.adjustments)) for (let i = 0; i < record.adjustments.length; i++) {
    if (i >= 100) { markTruncated(); break; }
    const adjustment = object(record.adjustments[i]);
    if (adjustment && fields.includes(adjustment.field as never) && reasons.includes(adjustment.reason as never)) adjustments.push({ field: adjustment.field as typeof fields[number], reason: adjustment.reason as typeof reasons[number] });
    else markTruncated();
  }
  const slash = resolved.target.indexOf("/");
  const provenance = record.provenance === "jev" || record.provenance === "fallback" || record.provenance === "user_override" ? record.provenance : shadow || routerFailed ? "fallback" : "jev";
  return { action: resolved.action as PublicRouteDecision["action"], target: resolved.target, provider: resolved.target.slice(0, slash), model: resolved.target.slice(slash + 1), effort: resolved.effort as PublicRouteDecision["effort"], contextTokens: resolved.contextTokens, maxOutputTokens: resolved.maxOutputTokens, temperature: typeof resolved.temperature === "number" ? resolved.temperature : null, toolPolicy: resolved.toolPolicy as PublicRouteDecision["toolPolicy"], provenance,
    scores: { action: score(confidences?.action), target: score(confidences?.target), effort: score(confidences?.effort), contextTokens: score(confidences?.contextTokens), maxOutputTokens: score(confidences?.maxOutputTokens), temperature: score(confidences?.temperature), toolPolicy: score(confidences?.toolPolicy), completion: score(record.completionProbability) }, adjustments };
}

export class ReceiptService {
  private readonly directory: string;
  private readonly maxFileBytes: number;
  private readonly maxRecords: number;
  private readonly maxStringBytes: number;
  constructor(directory: string, options: { maxFileBytes?: number; maxRecords?: number; maxStringBytes?: number } = {}) {
    this.directory = resolve(directory); this.maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
    this.maxRecords = options.maxRecords ?? 2000; this.maxStringBytes = options.maxStringBytes ?? 16 * 1024;
    for (const value of [this.maxFileBytes, this.maxRecords, this.maxStringBytes]) if (!Number.isSafeInteger(value) || value <= 0) throw new ServiceError("INVALID_RECEIPT");
  }
  async read(runId: string): Promise<WebReceipt> {
    if (typeof runId !== "string" || !isValidRunId(runId)) throw new ServiceError("INVALID_RECEIPT");
    const bytes = await safeReadFile(this.directory, runId + ".jsonl", this.maxFileBytes);
    const source = bytes.toString("utf8");
    if (!Buffer.from(source).equals(bytes)) throw new ServiceError("UNSUPPORTED_RECEIPT");
    let firstTime: string | null = null;
    for (const record of records(source)) firstTime ??= recordTime(record);
    let timestamp = firstTime ?? "1970-01-01T00:00:00.000Z";
    let run: WebReceiptSummary | null = null; let terminal = false; let truncated = false;
    let latestRoute: PublicRouteDecision | null = null; const routerFailures = new Set<number>();
    const events: WebJournalEvent[] = []; let sequence = 0;
    const text = (value: string) => { const projected = publicText(value, this.maxStringBytes); if (projected !== value) truncated = true; return projected; };
    const append = (input: WebJournalInput) => {
      sequence += 1;
      events.push({ schemaVersion: 1, id: `${runId}:${sequence}`, runId, sequence, timestamp, step: input.step, type: input.type, data: input.data } as WebJournalEvent);
      while (events.length > this.maxRecords) { events.shift(); truncated = true; }
    };
    for (const record of records(source)) {
      const validTime = recordTime(record); if (validTime) timestamp = validTime; else truncated = true;
      if (!integer(record.step)) { truncated = true; continue; }
      const kind = control(record, "kind", "kindCode", receiptKinds);
      if (kind === null) { truncated = true; continue; }
      const step = record.step;
      if (terminal) { truncated = true; continue; }
      if (kind === "run_started" && !run && typeof record.goal === "string" && integer(record.maxSteps, true) && record.maxSteps <= 1000 && typeof record.shadow === "boolean") {
        const goal = text(record.goal);
        run = { runId, status: "running", goal, maxSteps: record.maxSteps, shadow: record.shadow, step: 0, acceptedAt: timestamp, startedAt: timestamp, updatedAt: timestamp, finishedAt: null, finalText: "", error: null, historical: true };
        append({ runId, step: 0, type: "run_started", data: { goal, maxSteps: run.maxSteps, shadow: run.shadow } });
        continue;
      }
      if (!run) { truncated = true; continue; }
      run.step = step; run.updatedAt = timestamp;
      switch (kind) {
        case "router_error": routerFailures.add(step); break;
        case "route": {
          const route = projectRoute(record, run.shadow, routerFailures.has(step), () => { truncated = true; });
          if (!route || Buffer.byteLength(route.target) > this.maxStringBytes) { truncated = true; break; }
          latestRoute = route; append({ runId, step, type: "route_resolved", data: route }); break;
        }
        case "worker": {
          const result = object(record.result);
          if (!target(record.target) || typeof result?.text !== "string") { truncated = true; break; }
          append({ runId, step, type: "worker_completed", data: { target: text(record.target), content: text(result.text) } }); break;
        }
        case "worker_error":
          if (!target(record.target)) { truncated = true; break; }
          append({ runId, step, type: "worker_failed", data: { target: text(record.target), error: publicError("PROVIDER_FAILED") } }); break;
        case "tool_intent": case "tool_result": {
          const call = object(record.call); const result = object(record.result);
          const id = kind === "tool_intent" ? call?.id : record.callId;
          const name = kind === "tool_intent" ? call?.name : record.name;
          if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(id) || typeof name !== "string" || !TOOL_NAMES.includes(name as never)) { truncated = true; break; }
          const callId = text(id); const publicName = text(name);
          if (kind === "tool_intent") append({ runId, step, type: "tool_requested", data: { callId, name: publicName } });
          else if (typeof result?.ok !== "boolean") truncated = true;
          else if (result.ok) append({ runId, step, type: "tool_completed", data: { callId, name: publicName, content: "" } });
          else append({ runId, step, type: "tool_failed", data: { callId, name: publicName, error: publicError("TOOL_FAILED") } });
          break;
        }
        case "run_finished": {
          const terminalStatus = control(record, "status", "statusCode", receiptStatuses, legacyStatuses);
          if (terminalStatus === null || !legacyStatuses.includes(terminalStatus as never) || typeof record.finalText !== "string") { truncated = true; break; }
          // The durable boolean survives string redaction. Accept it only for
          // failed terminals; retain exact fixed-string legacy compatibility.
          const status = terminalStatus === "failed" && (record.aborted === true || record.error === "Run aborted") ? "cancelled" : terminalStatus as "completed" | "needs_input" | "limit" | "failed" | "cancelled" | "interrupted";
          const finalText = text(record.finalText); const error = status === "cancelled" ? publicError("RUN_ABORTED") : status === "failed" || status === "interrupted" ? publicError("RUN_FAILED") : null;
          run.status = status; run.finishedAt = timestamp; run.finalText = finalText; run.error = error; terminal = true;
          append({ runId, step, type: "run_finished", data: { status: status === "cancelled" || status === "interrupted" ? "failed" : status, finalText, ...(error ? { error } : {}) } }); break;
        }
        default: truncated = true;
      }
    }
    if (!run) throw new ServiceError("UNSUPPORTED_RECEIPT");
    if (!terminal) { run.status = "interrupted"; run.finishedAt = timestamp; run.updatedAt = timestamp; run.error = { code: "RUN_FAILED", message: "Run history is incomplete." }; truncated = true; }
    return { run, latestRoute, events, truncated, highWaterId: `${runId}:${sequence}`, highWaterSequence: sequence };
  }
  async list(query: WebReceiptListQuery = {}): Promise<WebReceiptSummary[]> {
    if (!query || typeof query !== "object" || Array.isArray(query)) throw new ServiceError("INVALID_RECEIPT");
    const limit = query.limit ?? 50;
    if (!integer(limit, true) || limit > 100 || query.beforeRunId !== undefined && (typeof query.beforeRunId !== "string" || !isValidRunId(query.beforeRunId))) throw new ServiceError("INVALID_RECEIPT");
    let files: string[];
    try { files = await safeListFiles(this.directory); }
    catch (error) { if (error instanceof ServiceError && error.code === "RECEIPT_NOT_FOUND") return []; throw error; }
    const summaries: WebReceiptSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const runId = file.slice(0, -6); if (!isValidRunId(runId)) continue;
      try { summaries.push((await this.read(runId)).run); } catch (error) { if (!(error instanceof ServiceError)) throw new ServiceError("RECEIPT_IO"); }
    }
    summaries.sort((a, b) => a.acceptedAt === b.acceptedAt ? a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0 : a.acceptedAt > b.acceptedAt ? -1 : 1);
    const start = query.beforeRunId === undefined ? 0 : summaries.findIndex((summary) => summary.runId === query.beforeRunId) + 1;
    if (query.beforeRunId !== undefined && start === 0) return [];
    return structuredClone(summaries.slice(start, start + limit));
  }
}
