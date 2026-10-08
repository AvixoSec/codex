import type { WebJournalEvent, WebJournalInput } from "./contracts.js";
import type { PublicError } from "../core/telemetry.js";
import { WebRuntimeError } from "./errors.js";

export interface EventJournalOptions {
  runId: string;
  maxEvents?: number;
  maxBytes?: number;
  maxEventBytes?: number;
  now?: () => number;
}

export interface JournalSnapshot {
  runId: string;
  generation: number;
  events: readonly WebJournalEvent[];
  truncated: boolean;
  highWaterId: string;
  highWaterSequence: number;
}

export type ReplayResetReason = "malformed_cursor" | "foreign_run" | "future_cursor" | "history_unavailable" | "generation_reset";
export type ReplayResult =
  | { kind: "replay"; snapshot: JournalSnapshot; events: readonly WebJournalEvent[] }
  | { kind: "reset"; reason: ReplayResetReason; snapshot: JournalSnapshot };

function immutableCopy<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const stack: unknown[] = [copy];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) stack.push(child);
      Object.freeze(item);
    }
  }
  return copy;
}

function publicError(error: PublicError): PublicError {
  return { code: error.code, message: error.message };
}

// Inputs are Task 1 public DTOs. Select each public field again so runtime
// extras cannot cross the browser boundary, including nested route data.
function publicData(input: WebJournalInput): WebJournalInput["data"] {
  switch (input.type) {
    case "run_accepted": case "run_started":
      return { goal: input.data.goal, maxSteps: input.data.maxSteps, shadow: input.data.shadow };
    case "run_cancellation_requested": case "step_started": case "route_requested": return {};
    case "run_finished":
      return { status: input.data.status, finalText: input.data.finalText, ...(input.data.error ? { error: publicError(input.data.error) } : {}) };
    case "step_completed": return { status: input.data.status };
    case "route_resolved": {
      const data = input.data;
      return {
        action: data.action,
        target: data.target,
        provider: data.provider,
        model: data.model,
        effort: data.effort,
        contextTokens: data.contextTokens,
        maxOutputTokens: data.maxOutputTokens,
        temperature: data.temperature,
        toolPolicy: data.toolPolicy,
        provenance: data.provenance,
        scores: {
          action: data.scores.action,
          target: data.scores.target,
          effort: data.scores.effort,
          contextTokens: data.scores.contextTokens,
          maxOutputTokens: data.scores.maxOutputTokens,
          temperature: data.scores.temperature,
          toolPolicy: data.scores.toolPolicy,
          completion: data.scores.completion
        },
        adjustments: data.adjustments.map((adjustment) => ({ field: adjustment.field, reason: adjustment.reason }))
      };
    }
    case "worker_started": return { target: input.data.target };
    case "worker_completed": return { target: input.data.target, content: input.data.content };
    case "worker_failed": return { target: input.data.target, error: publicError(input.data.error) };
    case "tool_requested": case "tool_started": return { callId: input.data.callId, name: input.data.name };
    case "tool_completed": return { callId: input.data.callId, name: input.data.name, content: input.data.content };
    case "tool_failed": return { callId: input.data.callId, name: input.data.name, error: publicError(input.data.error) };
    case "approval_requested": return { requestId: input.data.requestId, category: input.data.category, summary: input.data.summary };
    case "approval_resolved": return { requestId: input.data.requestId, allowed: input.data.allowed };
    case "input_requested": return { requestId: input.data.requestId, question: input.data.question };
    case "input_resolved":
      return input.data.outcome === "answered"
        ? { requestId: input.data.requestId, outcome: "answered", answer: input.data.answer }
        : { requestId: input.data.requestId, outcome: input.data.outcome, error: publicError(input.data.error) };
    default: {
      const exhaustive: never = input;
      void exhaustive;
      throw new TypeError("Invalid journal event type.");
    }
  }
}

export class EventJournal {
  private sequence = 0;
  private generation = 0;
  private resetThrough = -1;
  private truncated = false;
  private readonly events: { event: WebJournalEvent; bytes: number }[] = [];
  private retainedBytes = 0;
  private readonly listeners = new Set<(event: WebJournalEvent) => void>();
  private readonly deliveries: { event: WebJournalEvent; listeners: ((event: WebJournalEvent) => void)[] }[] = [];
  private delivering = false;
  private readonly runId: string;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxEventBytes: number;

  constructor(options: EventJournalOptions) {
    if (typeof options.runId !== "string" || !/^run_[A-Za-z0-9_-]{1,120}$/u.test(options.runId)) throw new WebRuntimeError("INVALID_RUN_ID");
    this.runId = options.runId;
    this.now = options.now ?? Date.now;
    this.maxEvents = options.maxEvents ?? 2_000;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.maxEventBytes = options.maxEventBytes ?? 64 * 1024;
    for (const value of [this.maxEvents, this.maxBytes, this.maxEventBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Journal limits must be positive safe integers.");
    }
  }

  append(input: WebJournalInput): WebJournalEvent {
    if (input.runId !== this.runId) throw new WebRuntimeError("INVALID_RUN_ID");
    const sequence = this.sequence + 1;
    const event = immutableCopy({
      schemaVersion: 1,
      id: `${this.runId}:${sequence}`,
      runId: this.runId,
      sequence,
      timestamp: new Date(this.now()).toISOString(),
      step: input.step,
      type: input.type,
      data: publicData(input)
    } as WebJournalEvent);
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (size > this.maxEventBytes || size > this.maxBytes) throw new WebRuntimeError("EVENT_TOO_LARGE");
    this.sequence = sequence;
    this.events.push({ event, bytes: size });
    this.retainedBytes += size;
    while (this.events.length > this.maxEvents || this.retainedBytes > this.maxBytes) {
      this.retainedBytes -= this.events.shift()!.bytes;
      this.truncated = true;
    }
    this.deliveries.push({ event, listeners: Array.from(this.listeners) });
    if (!this.delivering) {
      this.delivering = true;
      try {
        while (this.deliveries.length > 0) {
          const delivery = this.deliveries.shift()!;
          for (const listener of delivery.listeners) {
            try { listener(immutableCopy(delivery.event)); } catch { /* A consumer cannot undo a committed append or stop other consumers. */ }
          }
        }
      } finally { this.delivering = false; }
    }
    return immutableCopy(event);
  }

  snapshot(): JournalSnapshot {
    return immutableCopy({ runId: this.runId, generation: this.generation, events: this.events.map((entry) => entry.event), truncated: this.truncated, highWaterId: `${this.runId}:${this.sequence}`, highWaterSequence: this.sequence });
  }

  replay(afterId?: string): ReplayResult {
    const snapshot = this.snapshot();
    let sequence = -1;
    if (afterId !== undefined) {
      const match = /^(run_[A-Za-z0-9_-]{1,120}):(0|[1-9][0-9]*)$/u.exec(afterId);
      if (!match || match[0] !== afterId || !Number.isSafeInteger(Number(match[2]))) return immutableCopy({ kind: "reset", reason: "malformed_cursor", snapshot });
      if (match[1] !== this.runId) return immutableCopy({ kind: "reset", reason: "foreign_run", snapshot });
      sequence = Number(match[2]);
      if (sequence > snapshot.highWaterSequence) return immutableCopy({ kind: "reset", reason: "future_cursor", snapshot });
      if (sequence <= this.resetThrough) return immutableCopy({ kind: "reset", reason: "generation_reset", snapshot });
      if (snapshot.truncated && sequence < (snapshot.events[0]?.sequence ?? snapshot.highWaterSequence)) return immutableCopy({ kind: "reset", reason: "history_unavailable", snapshot });
    }
    return immutableCopy({ kind: "replay", snapshot, events: snapshot.events.filter((event) => event.sequence > sequence) });
  }

  subscribe(listener: (event: WebJournalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  reset(): JournalSnapshot {
    this.events.length = 0;
    this.retainedBytes = 0;
    this.generation += 1;
    this.resetThrough = this.sequence;
    this.truncated = this.sequence > 0;
    return this.snapshot();
  }
}
