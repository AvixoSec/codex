import type { PublicError, PublicRouteDecision, RunnerTelemetryEvent } from "../core/telemetry.js";

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
