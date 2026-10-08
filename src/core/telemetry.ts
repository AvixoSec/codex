import type { RouteAdjustment, RouteField } from "../router/resolve.js";
import type { Effort, RouteAction, ToolPolicy } from "./types.js";

export type RouteProvenance = "jev" | "fallback" | "user_override";
export type RouteScores = Record<RouteField | "completion", number | null>;

export interface PublicRouteDecision {
  action: RouteAction;
  target: string;
  provider: string;
  model: string;
  effort: Effort;
  contextTokens: number;
  maxOutputTokens: number;
  temperature: number | null;
  toolPolicy: ToolPolicy;
  provenance: RouteProvenance;
  scores: RouteScores;
  adjustments: Array<Pick<RouteAdjustment, "field" | "reason">>;
}

export type PublicErrorCode = "RUN_ABORTED" | "TIME_LIMIT" | "STEP_LIMIT" | "ROUTER_FAILED" | "PROVIDER_FAILED" | "TOOL_FAILED" | "APPROVAL_DENIED" | "RUN_FAILED";
export interface PublicError { code: PublicErrorCode; message: string }
export interface RequestContext { requestId: string; runId: string; step: number; signal?: AbortSignal }

export type PublicInputResolution =
  | { requestId: string; outcome: "answered"; answer: string }
  | { requestId: string; outcome: "cancelled"; error: PublicError }
  | { requestId: string; outcome: "failed"; error: PublicError };

interface TelemetryData {
  run_started: { goal: string; maxSteps: number; shadow: boolean };
  run_finished: { status: "completed" | "needs_input" | "limit" | "failed"; finalText: string; error?: PublicError };
  step_started: Record<string, never>;
  step_completed: { status: "completed" | "failed" | "stopped" };
  route_requested: Record<string, never>;
  route_resolved: PublicRouteDecision;
  worker_started: { target: string };
  worker_completed: { target: string; content: string };
  worker_failed: { target: string; error: PublicError };
  tool_requested: { callId: string; name: string };
  tool_started: { callId: string; name: string };
  tool_completed: { callId: string; name: string; content: string };
  tool_failed: { callId: string; name: string; error: PublicError };
  approval_requested: { requestId: string; category: "write" | "shell"; summary: string };
  approval_resolved: { requestId: string; allowed: boolean };
  input_requested: { requestId: string; question: string };
  input_resolved: PublicInputResolution;
}

export type RunnerTelemetryEvent = { [Type in keyof TelemetryData]: { runId: string; type: Type; step: number; data: TelemetryData[Type] } }[keyof TelemetryData];
export type OnTelemetry = (event: RunnerTelemetryEvent) => void | Promise<void>;
