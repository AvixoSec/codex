import type { Effort, HarnessConfig, RouteAction, ToolPolicy } from "../core/types.js";
import { listTargets } from "../config/schema.js";

export interface RouteOverride {
  readonly action?: RouteAction;
  readonly target?: string;
  readonly effort?: Effort;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly toolPolicy?: ToolPolicy;
}
export interface NextRouteContext { runId: string; step: number }

export function validateRouteOverride(value: unknown, config: HarnessConfig): RouteOverride {
  const invalid = () => { throw new Error("Invalid route override."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const choices: Record<string, readonly unknown[]> = {
    action: config.routing.choices.actions, target: listTargets(config).map((target) => target.id), effort: config.routing.choices.efforts,
    contextTokens: config.routing.choices.contextTokens, maxOutputTokens: config.routing.choices.maxOutputTokens,
    temperature: config.routing.choices.temperatures, toolPolicy: config.routing.choices.toolPolicies
  };
  const copy: Record<string, unknown> = {};
  for (const [key, coordinate] of Object.entries(value)) {
    if (!Object.hasOwn(choices, key)) return invalid();
    if (coordinate === undefined) continue;
    const numeric = key === "contextTokens" || key === "maxOutputTokens" || key === "temperature";
    if (typeof coordinate !== (numeric ? "number" : "string") ||
      (numeric && (!Number.isFinite(coordinate) || (key !== "temperature" && (!Number.isSafeInteger(coordinate) || (coordinate as number) <= 0)))) ||
      !choices[key]!.includes(coordinate)) return invalid();
    copy[key] = coordinate;
  }
  if (Object.keys(copy).length === 0) return invalid();
  return Object.freeze(copy) as RouteOverride;
}
