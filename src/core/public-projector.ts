import type { RawRouteDecision, ResolvedRoute, RouteAdjustment, RouteField } from "../router/resolve.js";
import { sanitizeString } from "./sanitize.js";
import type { PublicError, PublicErrorCode, PublicRouteDecision, RouteProvenance } from "./telemetry.js";

export const PUBLIC_SUMMARY_BYTES = 2_048;
export const PUBLIC_CONTENT_BYTES = 16 * 1_024;
export const PUBLIC_ERROR_BYTES = 512;

/** Redact known values and endpoint/credential syntax before enforcing UTF-8 limits. */
export function publicText(value: string, maxBytes: number, secrets: readonly string[] = []): string {
  const safe = sanitizeString(value, secrets)
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/giu, "[REDACTED]")
    .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/giu, "[REDACTED]");
  const bytes = Buffer.from(safe, "utf8");
  if (bytes.length <= maxBytes) return safe;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

const PUBLIC_MESSAGES: Record<PublicErrorCode, string> = {
  RUN_ABORTED: "Run aborted.",
  TIME_LIMIT: "Elapsed-time limit reached.",
  STEP_LIMIT: "Maximum semantic steps reached.",
  ROUTER_FAILED: "Route decision failed.",
  PROVIDER_FAILED: "Worker provider failed.",
  TOOL_FAILED: "Tool execution failed.",
  APPROVAL_DENIED: "Tool approval denied.",
  RUN_FAILED: "Run failed."
};

export function publicError(code: PublicErrorCode): PublicError {
  return { code, message: publicText(PUBLIC_MESSAGES[code], PUBLIC_ERROR_BYTES) };
}

const FIELDS: readonly RouteField[] = ["action", "target", "effort", "contextTokens", "maxOutputTokens", "temperature", "toolPolicy"];
const REASONS: readonly RouteAdjustment["reason"][] = ["missing_or_malformed", "low_confidence", "not_offered", "shadow_fallback", "unsupported_by_model", "model_limit", "context_safety_margin", "global_tool_ceiling"];
function score(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function projectRouteDecision(route: ResolvedRoute, raw: RawRouteDecision | undefined, provenance: RouteProvenance, secrets: readonly string[] = []): PublicRouteDecision {
  return {
    action: route.action,
    target: publicText(route.target.id, PUBLIC_SUMMARY_BYTES, secrets),
    provider: publicText(route.target.providerId, PUBLIC_SUMMARY_BYTES, secrets),
    model: publicText(route.target.modelId, PUBLIC_SUMMARY_BYTES, secrets),
    effort: route.effort,
    contextTokens: route.contextTokens,
    maxOutputTokens: route.maxOutputTokens,
    temperature: route.temperature ?? null,
    toolPolicy: route.toolPolicy,
    provenance,
    scores: {
      action: score(raw?.action?.confidence),
      target: score(raw?.target?.confidence),
      effort: score(raw?.effort?.confidence),
      contextTokens: score(raw?.contextTokens?.confidence),
      maxOutputTokens: score(raw?.maxOutputTokens?.confidence),
      temperature: score(raw?.temperature?.confidence),
      toolPolicy: score(raw?.toolPolicy?.confidence),
      completion: score(raw?.completionProbability)
    },
    adjustments: route.adjustments.filter((adjustment) => FIELDS.includes(adjustment.field) && REASONS.includes(adjustment.reason)).map((adjustment) => ({ field: adjustment.field, reason: adjustment.reason }))
  };
}
