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
  if (fixedTokens > tokenBudget) return undefined;
  return { ...event, content: truncateText(event.content, tokenBudget - fixedTokens) };
}

interface EventUnit {
  events: AgentEvent[];
  order: number;
  recency: number;
}

function completeEventUnits(events: readonly AgentEvent[]): EventUnit[] {
  const pairedIndexes = new Set<number>();
  const units: EventUnit[] = [];

  for (let callIndex = 0; callIndex < events.length; callIndex += 1) {
    const call = events[callIndex]!;
    if (call.type !== "tool_call" || pairedIndexes.has(callIndex)) continue;
    const resultIndex = events.findIndex((candidate, index) =>
      index > callIndex &&
      !pairedIndexes.has(index) &&
      candidate.type === "tool_result" &&
      candidate.callId === call.id
    );
    if (resultIndex < 0) continue;
    pairedIndexes.add(callIndex);
    pairedIndexes.add(resultIndex);
    units.push({ events: [call, events[resultIndex]!], order: callIndex, recency: resultIndex });
  }

  events.forEach((event, index) => {
    if (event.type === "assistant_text" || event.type === "user_text" || event.type === "error") {
      units.push({ events: [event], order: index, recency: index });
    }
  });
  return units;
}

function truncateUnit(unit: EventUnit, tokenBudget: number): EventUnit | undefined {
  if (unit.events.length === 1) {
    const bounded = truncateEvent(unit.events[0]!, tokenBudget);
    return bounded ? { ...unit, events: [bounded] } : undefined;
  }
  const [call, result] = unit.events;
  if (!call || call.type !== "tool_call" || !result || result.type !== "tool_result") return undefined;
  const callTokens = estimateTokens(call);
  const boundedResult = truncateEvent(result, tokenBudget - callTokens);
  if (!boundedResult) return undefined;
  return { ...unit, events: [call, boundedResult] };
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

  const units = completeEventUnits(events);
  const selected: EventUnit[] = [];
  let remaining = tokenBudget - used;

  const newestFirst = [...units].sort((left, right) => right.recency - left.recency);
  newestFirst.forEach((unit, index) => {
    const cost = unit.events.reduce((total, event) => total + estimateTokens(event), 0);
    let selectedUnit: EventUnit | undefined;
    if (cost <= remaining) selectedUnit = unit;
    else if (index === 0) selectedUnit = truncateUnit(unit, remaining);

    if (!selectedUnit) {
      truncated = true;
      return;
    }
    const selectedCost = selectedUnit.events.reduce((total, event) => total + estimateTokens(event), 0);
    selected.push(selectedUnit);
    remaining -= selectedCost;
    used += selectedCost;
    if (selectedCost < cost) truncated = true;
  });

  const selectedEvents = selected
    .sort((left, right) => left.order - right.order)
    .flatMap((unit) => unit.events);
  if (selectedEvents.length < events.length) truncated = true;
  return { goal: boundedGoal, events: selectedEvents, estimatedTokens: used, truncated };
}

export function fitContextToSerializedBudget<T>(
  context: BoundedContext,
  tokenBudget: number,
  serialize: (bounded: BoundedContext) => T
): BoundedContext {
  if (estimateTokens(serialize(context)) <= tokenBudget) return context;

  let lower = 1;
  let upper = Math.min(tokenBudget, context.estimatedTokens);
  let best: BoundedContext | undefined;
  while (lower <= upper) {
    const candidateBudget = Math.floor((lower + upper) / 2);
    const candidate = buildContext(context.goal, context.events, candidateBudget);
    if (estimateTokens(serialize(candidate)) <= tokenBudget) {
      best = candidate;
      lower = candidateBudget + 1;
    } else {
      upper = candidateBudget - 1;
    }
  }

  if (!best) {
    throw new Error(`Selected context budget ${tokenBudget} cannot fit the fixed worker request`);
  }
  return { ...best, truncated: true };
}
