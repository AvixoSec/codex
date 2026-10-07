import type { AgentEvent, BoundedContext } from "../core/types.js";

const TRUNCATION_MARKER = "[…truncated by Jev Harness…]";

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(Buffer.byteLength(text ?? "", "utf8") / 3));
}

function truncateText(text: string, tokenBudget: number): string {
  if (estimateTokens(text) <= tokenBudget) return text;
  const byteBudget = Math.max(0, tokenBudget * 3);
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (byteBudget <= markerBytes) {
    return Buffer.from(TRUNCATION_MARKER).subarray(0, byteBudget).toString("utf8").replace(/�$/u, "");
  }
  const contentBudget = byteBudget - markerBytes;
  let used = 0;
  let prefix = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > contentBudget) break;
    prefix += character;
    used += size;
  }
  return prefix.trimEnd() + TRUNCATION_MARKER;
}

function truncateEvent(event: AgentEvent, tokenBudget: number): AgentEvent | undefined {
  if (tokenBudget <= 0) return undefined;
  if (event.type === "tool_call") {
    return estimateTokens(event) <= tokenBudget ? event : undefined;
  }
  const fixed = { ...event, content: "" };
  const fixedTokens = estimateTokens(fixed);
  if (fixedTokens >= tokenBudget) return undefined;
  return { ...event, content: truncateText(event.content, tokenBudget - fixedTokens) };
}

function requiredTail(events: readonly AgentEvent[]): AgentEvent[] {
  const latest = events.at(-1);
  if (!latest) return [];
  if (latest.type !== "tool_result") return [latest];
  let matchingIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "tool_call" && event.id === latest.callId) {
      matchingIndex = index;
      break;
    }
  }
  return matchingIndex >= 0 ? [events[matchingIndex]!, latest] : [latest];
}

export function buildContext(goal: string, events: readonly AgentEvent[], tokenBudget: number): BoundedContext {
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    throw new Error("context token budget must be a positive integer");
  }

  const originalGoalTokens = estimateTokens(goal);
  const boundedGoal = truncateText(goal, tokenBudget);
  let used = estimateTokens(boundedGoal);
  let truncated = originalGoalTokens > used;
  if (used >= tokenBudget) {
    return { goal: boundedGoal, events: [], estimatedTokens: Math.min(used, tokenBudget), truncated: true };
  }

  const tail = requiredTail(events);
  const selected: AgentEvent[] = [];
  let remaining = tokenBudget - used;

  for (const event of tail) {
    const cost = estimateTokens(event);
    if (cost <= remaining) {
      selected.push(event);
      remaining -= cost;
      used += cost;
      continue;
    }
    const bounded = truncateEvent(event, remaining);
    if (bounded) {
      const boundedCost = estimateTokens(bounded);
      selected.push(bounded);
      remaining -= boundedCost;
      used += boundedCost;
      truncated = true;
    }
  }

  const tailSet = new Set(tail);
  const older: AgentEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (tailSet.has(event)) continue;
    const cost = estimateTokens(event);
    if (cost > remaining) {
      truncated = true;
      continue;
    }
    older.unshift(event);
    remaining -= cost;
    used += cost;
  }

  const selectedEvents = [...older, ...selected];
  if (selectedEvents.length < events.length) truncated = true;
  return { goal: boundedGoal, events: selectedEvents, estimatedTokens: used, truncated };
}
