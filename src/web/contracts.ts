import type { PublicError, PublicRouteDecision, RunnerTelemetryEvent } from "../core/telemetry.js";
import type { Effort, HarnessConfig, ToolName, ToolPolicy } from "../core/types.js";

export interface WebConfigEditor {
  version: 1;
  jev: { apiKeyEnv: string; model: string; timeoutMs: number; retries: number };
  routing: HarnessConfig["routing"];
  providers: Record<string, {
    baseUrl: string; api: "chat-completions" | "responses"; apiKeyEnv?: string;
    timeoutMs: number; retries: number;
    models: Record<string, {
      model?: string; description: string; contextWindow: number; maxOutputTokens: number;
      efforts: Effort[]; effortMap: Partial<Record<Effort, string>>; supportsTools: boolean;
      temperature: false | { min: number; max: number };
    }>;
  }>;
  tools: {
    enabled: ToolName[]; maxPolicy: ToolPolicy; approvals: HarnessConfig["tools"]["approvals"];
    maxFileBytes: number; maxOutputBytes: number; maxCommandTimeoutMs: number;
  };
}
export interface WebConfigDocument { revision: string; config: WebConfigEditor }
export interface WebConfigIssue { path: readonly (string | number)[]; code: string; message: string }
export type WebConfigValidation = { valid: true; issues: readonly [] } | { valid: false; issues: readonly WebConfigIssue[] };
export type WebCredentialRequirement = { kind: "jev" } | { kind: "provider"; providerId: string; usage: "api_key" | "header" };
export interface WebCredentialStatus { name: string; requiredBy: readonly WebCredentialRequirement[]; present: boolean }
export type WebReceiptSummary = WebRunSummary & { historical: true };
export interface WebReceipt {
  run: WebReceiptSummary; latestRoute: PublicRouteDecision | null; events: readonly WebJournalEvent[];
  truncated: boolean; highWaterId: string; highWaterSequence: number;
}
export interface WebReceiptListQuery { limit?: number; beforeRunId?: string }

export type WebManagerEventInput =
  | { runId: string; step: 0; type: "run_accepted"; data: { goal: string; maxSteps: number; shadow: boolean } }
  | { runId: string; step: number; type: "run_cancellation_requested"; data: Record<string, never> };
export type WebJournalInput = RunnerTelemetryEvent | WebManagerEventInput;

type Envelope = { schemaVersion: 1; id: string; runId: string; sequence: number; timestamp: string; step: number };
export type WebJournalEvent = {
  [Type in WebJournalInput["type"]]: Envelope & { type: Type; data: Extract<WebJournalInput, { type: Type }>["data"] }
}[WebJournalInput["type"]];
export type StreamResetEvent = Envelope & { type: "stream.reset"; data: { snapshot: WebRunSnapshot } };
export type WebRunEvent = WebJournalEvent | StreamResetEvent;
export type WebRunEventType = WebRunEvent["type"];
export type WebRunEventData = WebRunEvent["data"];

export type WebRunStatus = "accepted" | "running" | "cancelling" | "completed" | "needs_input" | "limit" | "failed" | "cancelled" | "interrupted";
export interface WebRunSummary {
  runId: string;
  status: WebRunStatus;
  goal: string;
  maxSteps: number;
  shadow: boolean;
  step: number;
  acceptedAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  finalText: string;
  error: PublicError | null;
  historical: boolean;
}
export interface WebApprovalRequest {
  requestId: string;
  runId: string;
  step: number;
  category: "write" | "shell";
  summary: string;
  createdAt: string;
  expiresAt: string;
}
export interface WebInputRequest {
  requestId: string;
  runId: string;
  step: number;
  question: string;
  createdAt: string;
  expiresAt: string;
}
export type WebPendingRequest = WebApprovalRequest | WebInputRequest;
export interface WebRouteOverride {
  action?: PublicRouteDecision["action"];
  target?: string;
  effort?: PublicRouteDecision["effort"];
  contextTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  toolPolicy?: PublicRouteDecision["toolPolicy"];
}
export interface WebRunSnapshot {
  run: WebRunSummary;
  latestRoute: PublicRouteDecision | null;
  events: readonly WebJournalEvent[];
  truncated: boolean;
  pendingApprovals: readonly WebApprovalRequest[];
  pendingInputs: readonly WebInputRequest[];
  generation: number;
  highWaterId: string;
  highWaterSequence: number;
}
export interface WebErrorEnvelope<Details extends object = never> {
  error: { code: string; message: string; details?: Details };
}
