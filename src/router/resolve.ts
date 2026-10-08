import { EFFORTS, TOOL_POLICIES, type Effort, type HarnessConfig, type RouteAction, type TargetDescriptor, type ToolPolicy } from "../core/types.js";
import { listTargets } from "../config/schema.js";
import type { RouteOverride } from "./override.js";

export interface RawChoiceDecision {
  value: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface RawRouteDecision {
  action?: RawChoiceDecision;
  target?: RawChoiceDecision;
  effort?: RawChoiceDecision;
  contextTokens?: RawChoiceDecision;
  maxOutputTokens?: RawChoiceDecision;
  temperature?: RawChoiceDecision;
  toolPolicy?: RawChoiceDecision;
  completionProbability?: number;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  errors: Partial<Record<RouteField | "completion", string>>;
}

export type RouteField =
  | "action"
  | "target"
  | "effort"
  | "contextTokens"
  | "maxOutputTokens"
  | "temperature"
  | "toolPolicy";

export interface RouteAdjustment {
  field: RouteField;
  from: unknown;
  to: unknown;
  reason:
    | "missing_or_malformed"
    | "low_confidence"
    | "not_offered"
    | "shadow_fallback"
    | "unsupported_by_model"
    | "model_limit"
    | "context_safety_margin"
    | "global_tool_ceiling";
}

export interface ProposedRoute {
  action: string | undefined;
  target: string | undefined;
  effort: string | undefined;
  contextTokens: number | undefined;
  maxOutputTokens: number | undefined;
  temperature: number | undefined;
  toolPolicy: string | undefined;
}

export interface ResolvedRoute {
  action: RouteAction;
  target: TargetDescriptor;
  effort: Effort;
  wireEffort: string | undefined;
  contextTokens: number;
  maxOutputTokens: number;
  temperature: number | undefined;
  toolPolicy: ToolPolicy;
  complete: boolean;
  completionProbability: number;
  shadow: boolean;
  proposed: ProposedRoute;
  confidences: Partial<Record<RouteField, number>>;
  adjustments: RouteAdjustment[];
}

interface SelectOptions {
  field: RouteField;
  raw: RawChoiceDecision | undefined;
  offered: readonly string[];
  fallback: string;
  threshold: number;
  shadow: boolean;
  adjustments: RouteAdjustment[];
}

function selectValue(options: SelectOptions): string {
  const { field, raw, offered, fallback, threshold, shadow, adjustments } = options;
  if (shadow) {
    if (raw?.value !== fallback) {
      adjustments.push({ field, from: raw?.value, to: fallback, reason: "shadow_fallback" });
    }
    return fallback;
  }
  if (!raw) {
    adjustments.push({ field, from: undefined, to: fallback, reason: "missing_or_malformed" });
    return fallback;
  }
  if (raw.confidence < threshold) {
    adjustments.push({ field, from: raw.value, to: fallback, reason: "low_confidence" });
    return fallback;
  }
  if (!offered.includes(raw.value)) {
    adjustments.push({ field, from: raw.value, to: fallback, reason: "not_offered" });
    return fallback;
  }
  return raw.value;
}

function numericProposal(raw: RawChoiceDecision | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw.value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nearestEffort(requested: Effort, supported: readonly Effort[]): Effort {
  if (supported.includes(requested)) return requested;
  const requestedIndex = EFFORTS.indexOf(requested);
  const candidates = supported
    .filter((value) => EFFORTS.indexOf(value) <= requestedIndex)
    .sort((a, b) => EFFORTS.indexOf(b) - EFFORTS.indexOf(a));
  return candidates[0] ?? supported[0] ?? "none";
}

function cappedToolPolicy(requested: ToolPolicy, ceiling: ToolPolicy): ToolPolicy {
  const requestedIndex = TOOL_POLICIES.indexOf(requested);
  const ceilingIndex = TOOL_POLICIES.indexOf(ceiling);
  return TOOL_POLICIES[Math.min(requestedIndex, ceilingIndex)] ?? "none";
}

export function resolveRoute(raw: RawRouteDecision, config: HarnessConfig, shadow = config.routing.shadow, override?: RouteOverride): ResolvedRoute {
  const adjustments: RouteAdjustment[] = [];
  const threshold = config.routing.confidenceThreshold;
  const fallback = config.routing.fallback;
  const targets = listTargets(config);
  const targetIds = targets.map((target) => target.id);
  const select = (options: SelectOptions): string => {
    const coordinate = override?.[options.field];
    return coordinate !== undefined ? String(coordinate) : selectValue(options);
  };

  const proposed: ProposedRoute = {
    action: raw.action?.value,
    target: raw.target?.value,
    effort: raw.effort?.value,
    contextTokens: numericProposal(raw.contextTokens),
    maxOutputTokens: numericProposal(raw.maxOutputTokens),
    temperature: numericProposal(raw.temperature),
    toolPolicy: raw.toolPolicy?.value
  };

  const selectedAction = select({
    field: "action",
    raw: raw.action,
    offered: config.routing.choices.actions,
    fallback: fallback.action,
    threshold,
    shadow,
    adjustments
  }) as RouteAction;
  const selectedTargetId = select({
    field: "target",
    raw: raw.target,
    offered: targetIds,
    fallback: fallback.target,
    threshold,
    shadow,
    adjustments
  });
  const target = targets.find((candidate) => candidate.id === selectedTargetId);
  if (!target) {
    throw new Error(`Configured fallback target not found: ${selectedTargetId}`);
  }

  const requestedEffort = select({
    field: "effort",
    raw: raw.effort,
    offered: config.routing.choices.efforts,
    fallback: fallback.effort,
    threshold,
    shadow,
    adjustments
  }) as Effort;
  const effort = nearestEffort(requestedEffort, target.model.efforts);
  if (effort !== requestedEffort) {
    adjustments.push({
      field: "effort",
      from: requestedEffort,
      to: effort,
      reason: "unsupported_by_model"
    });
  }

  const selectedOutput = Number(select({
    field: "maxOutputTokens",
    raw: raw.maxOutputTokens,
    offered: config.routing.choices.maxOutputTokens.map(String),
    fallback: String(fallback.maxOutputTokens),
    threshold,
    shadow,
    adjustments
  }));
  const contextBoundOutput = Math.max(1, target.model.contextWindow - config.routing.safetyMarginTokens - 1);
  const outputLimit = Math.min(target.model.maxOutputTokens, contextBoundOutput);
  const maxOutputTokens = Math.min(selectedOutput, outputLimit);
  if (maxOutputTokens !== selectedOutput) {
    adjustments.push({
      field: "maxOutputTokens",
      from: selectedOutput,
      to: maxOutputTokens,
      reason: "model_limit"
    });
  }

  const selectedContext = Number(select({
    field: "contextTokens",
    raw: raw.contextTokens,
    offered: config.routing.choices.contextTokens.map(String),
    fallback: String(fallback.contextTokens),
    threshold,
    shadow,
    adjustments
  }));
  const contextLimit = Math.max(1, target.model.contextWindow - maxOutputTokens - config.routing.safetyMarginTokens);
  const contextTokens = Math.min(selectedContext, contextLimit);
  if (contextTokens !== selectedContext) {
    adjustments.push({
      field: "contextTokens",
      from: selectedContext,
      to: contextTokens,
      reason: "context_safety_margin"
    });
  }

  const selectedTemperature = Number(select({
    field: "temperature",
    raw: raw.temperature,
    offered: config.routing.choices.temperatures.map(String),
    fallback: String(fallback.temperature),
    threshold,
    shadow,
    adjustments
  }));
  let temperature: number | undefined;
  if (target.model.temperature === false) {
    temperature = undefined;
    adjustments.push({
      field: "temperature",
      from: selectedTemperature,
      to: undefined,
      reason: "unsupported_by_model"
    });
  } else {
    temperature = Math.max(target.model.temperature.min, Math.min(selectedTemperature, target.model.temperature.max));
    if (temperature !== selectedTemperature) {
      adjustments.push({
        field: "temperature",
        from: selectedTemperature,
        to: temperature,
        reason: "model_limit"
      });
    }
  }

  const selectedPolicy = select({
    field: "toolPolicy",
    raw: raw.toolPolicy,
    offered: config.routing.choices.toolPolicies,
    fallback: fallback.toolPolicy,
    threshold,
    shadow,
    adjustments
  }) as ToolPolicy;
  let toolPolicy = target.model.supportsTools
    ? cappedToolPolicy(selectedPolicy, config.tools.maxPolicy)
    : "none";
  if (!target.model.supportsTools && selectedPolicy !== "none") {
    adjustments.push({
      field: "toolPolicy",
      from: selectedPolicy,
      to: "none",
      reason: "unsupported_by_model"
    });
  } else if (toolPolicy !== selectedPolicy) {
    adjustments.push({
      field: "toolPolicy",
      from: selectedPolicy,
      to: toolPolicy,
      reason: "global_tool_ceiling"
    });
  }

  const hasCompletionProbability =
    typeof raw.completionProbability === "number" &&
    Number.isFinite(raw.completionProbability) &&
    raw.completionProbability >= 0 &&
    raw.completionProbability <= 1;
  const completionProbability = hasCompletionProbability ? raw.completionProbability! : 0;

  return {
    action: selectedAction,
    target,
    effort,
    wireEffort: effort === "none" && !target.model.effortMap.none
      ? undefined
      : target.model.effortMap[effort] ?? effort,
    contextTokens,
    maxOutputTokens,
    temperature,
    toolPolicy,
    complete: selectedAction === "finish" && hasCompletionProbability && completionProbability >= config.routing.completionThreshold,
    completionProbability,
    shadow,
    proposed,
    confidences: {
      ...(raw.action ? { action: raw.action.confidence } : {}),
      ...(raw.target ? { target: raw.target.confidence } : {}),
      ...(raw.effort ? { effort: raw.effort.confidence } : {}),
      ...(raw.contextTokens ? { contextTokens: raw.contextTokens.confidence } : {}),
      ...(raw.maxOutputTokens ? { maxOutputTokens: raw.maxOutputTokens.confidence } : {}),
      ...(raw.temperature ? { temperature: raw.temperature.confidence } : {}),
      ...(raw.toolPolicy ? { toolPolicy: raw.toolPolicy.confidence } : {})
    },
    adjustments
  };
}
