import type { WebApprovalRequest, WebInputRequest, WebPendingRequest } from "./contracts.js";
import { WebRuntimeError } from "./errors.js";
import type { WebRuntimeErrorCode } from "./errors.js";

export interface BrokerOptions {
  timeoutMs?: number;
  tombstoneTtlMs?: number;
  maxTombstones?: number;
  now?: () => number;
}
export type BrokerCloseReason = "cancelled" | "terminal";
export interface ApprovalRequestInput {
  requestId: string;
  runId: string;
  step: number;
  category: "write" | "shell";
  summary: string;
  signal?: AbortSignal;
}
export interface InputRequestInput {
  requestId: string;
  runId: string;
  step: number;
  question: string;
  signal?: AbortSignal;
}

function boundedText(value: string): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const point of value) {
    const size = encoder.encode(point).byteLength;
    if (bytes + size > 2_048) break;
    bytes += size;
    result += point;
  }
  return result;
}

function validateRunId(runId: string): void {
  if (typeof runId !== "string" || !/^run_[A-Za-z0-9_-]{1,120}$/u.test(runId)) throw new WebRuntimeError("INVALID_RUN_ID");
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new WebRuntimeError("INVALID_BROKER_REQUEST");
  return date.toISOString();
}

class Broker<Value, DTO extends WebPendingRequest> {
  private readonly requests = new Map<string, {
    dto: DTO;
    resolve: (value: Value) => void;
    reject: (error: WebRuntimeError) => void;
    timer: ReturnType<typeof setTimeout>;
    cleanup: () => void;
  }>();
  private readonly tombstones = new Map<string, { runId: string; code: WebRuntimeErrorCode; expiresAt: number }>();
  private readonly tombstoneTtlMs: number;
  private readonly maxTombstones: number;
  protected readonly timeoutMs: number;
  protected readonly now: () => number;
  constructor(options: BrokerOptions, private readonly kind: "approval" | "input") {
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.now = options.now ?? Date.now;
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? 300_000;
    this.maxTombstones = options.maxTombstones ?? 4_096;
    for (const value of [this.timeoutMs, this.tombstoneTtlMs, this.maxTombstones]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Broker limits must be positive safe integers.");
    }
  }

  protected validateRequest(input: ApprovalRequestInput | InputRequestInput): void {
    this.prune();
    if (!input || typeof input !== "object") throw new WebRuntimeError("INVALID_BROKER_REQUEST");
    validateRunId(input.runId);
    this.validateRequestId(input.requestId);
    if (!Number.isInteger(input.step) || input.step < 1 || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
      throw new WebRuntimeError("INVALID_BROKER_REQUEST");
    }
    if (this.kind === "approval") {
      const approval = input as ApprovalRequestInput;
      if ((approval.category !== "write" && approval.category !== "shell") || typeof approval.summary !== "string") throw new WebRuntimeError("INVALID_BROKER_REQUEST");
    } else if (typeof (input as InputRequestInput).question !== "string") throw new WebRuntimeError("INVALID_BROKER_REQUEST");
  }

  private validateRequestId(requestId: string): void {
    const pattern = this.kind === "approval" ? /^approval_[A-Za-z0-9_-]{1,160}$/u : /^input_[A-Za-z0-9_-]{1,160}$/u;
    if (typeof requestId !== "string" || !pattern.test(requestId)) throw new WebRuntimeError("INVALID_REQUEST_ID");
  }
  protected enqueue(dto: DTO, signal?: AbortSignal): Promise<Value> {
    this.prune();
    if (this.requests.has(dto.requestId) || this.tombstones.has(dto.requestId)) throw new WebRuntimeError("DUPLICATE_REQUEST_ID");
    const closed = this.tombstones.get(`run:${dto.runId}`);
    if (closed) throw new WebRuntimeError(closed.code);
    if (signal?.aborted) {
      this.remember(dto.requestId, dto.runId, "REQUEST_CANCELLED");
      throw new WebRuntimeError("REQUEST_CANCELLED");
    }
    return new Promise((resolve, reject) => {
      // Host timers clamp delays above a signed 32-bit integer to 1 ms.
      // Chunk long configured waits while retaining only one active timer.
      let remaining = this.timeoutMs;
      let delay = Math.min(remaining, 2_147_483_647);
      const expire = () => {
        const request = this.requests.get(dto.requestId);
        if (!request) return;
        remaining -= delay;
        if (remaining <= 0) this.settle(dto.requestId, "REQUEST_EXPIRED");
        else {
          delay = Math.min(remaining, 2_147_483_647);
          request.timer = setTimeout(expire, delay);
        }
      };
      const timer = setTimeout(expire, delay);
      const onAbort = () => { this.settle(dto.requestId, "REQUEST_CANCELLED"); };
      this.requests.set(dto.requestId, { dto, resolve, reject, timer, cleanup: () => { signal?.removeEventListener("abort", onAbort); } });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  resolve(runId: string, requestId: string, value: Value): void {
    this.prune();
    validateRunId(runId);
    this.validateRequestId(requestId);
    if (typeof value !== (this.kind === "approval" ? "boolean" : "string")) throw new WebRuntimeError("INVALID_BROKER_REQUEST");
    const request = this.requests.get(requestId);
    if (!request) {
      const tombstone = this.tombstones.get(requestId);
      if (!tombstone) throw new WebRuntimeError("REQUEST_NOT_FOUND");
      if (tombstone.runId !== runId) throw new WebRuntimeError("CROSS_RUN_RESPONSE");
      throw new WebRuntimeError(tombstone.code);
    }
    if (request.dto.runId !== runId) throw new WebRuntimeError("CROSS_RUN_RESPONSE");
    this.settle(requestId, "REQUEST_ALREADY_RESOLVED", value);
  }

  private settle(requestId: string, code: WebRuntimeErrorCode, value?: Value): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    clearTimeout(request.timer);
    request.cleanup();
    this.remember(requestId, request.dto.runId, code);
    if (code === "REQUEST_ALREADY_RESOLVED") request.resolve(value as Value);
    else request.reject(new WebRuntimeError(code));
  }
  pending(runId: string): readonly DTO[] {
    this.prune();
    validateRunId(runId);
    return Object.freeze(Array.from(this.requests.values()).filter((request) => request.dto.runId === runId).map((request) => {
      const copy: DTO = { ...request.dto };
      Object.freeze(copy);
      return copy;
    }));
  }

  closeRun(runId: string, reason: BrokerCloseReason): void {
    this.prune();
    validateRunId(runId);
    if (reason !== "cancelled" && reason !== "terminal") throw new WebRuntimeError("INVALID_BROKER_REQUEST");
    const key = `run:${runId}`;
    if (this.tombstones.has(key)) return;
    const code = reason === "cancelled" ? "REQUEST_CANCELLED" : "RUN_TERMINAL";
    this.remember(key, runId, code);
    for (const [id, request] of this.requests) {
      if (request.dto.runId === runId) this.settle(id, code);
    }
  }

  private remember(key: string, runId: string, code: WebRuntimeErrorCode): void {
    this.prune();
    this.tombstones.set(key, { runId, code, expiresAt: this.now() + this.tombstoneTtlMs });
    while (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(key);
    }
  }
}

export class ApprovalBroker extends Broker<boolean, WebApprovalRequest> {
  constructor(options: BrokerOptions = {}) { super(options, "approval"); }

  async request(input: ApprovalRequestInput): Promise<boolean> {
    this.validateRequest(input);
    const timestamp = this.now();
    const dto: WebApprovalRequest = {
      requestId: input.requestId,
      runId: input.runId,
      step: input.step,
      category: input.category,
      summary: boundedText(input.summary),
      createdAt: formatTimestamp(timestamp),
      expiresAt: formatTimestamp(timestamp + this.timeoutMs)
    };
    return this.enqueue(dto, input.signal);
  }
}

export class InputBroker extends Broker<string, WebInputRequest> {
  constructor(options: BrokerOptions = {}) { super(options, "input"); }

  async request(input: InputRequestInput): Promise<string> {
    this.validateRequest(input);
    const timestamp = this.now();
    const dto: WebInputRequest = {
      requestId: input.requestId,
      runId: input.runId,
      step: input.step,
      question: boundedText(input.question),
      createdAt: formatTimestamp(timestamp),
      expiresAt: formatTimestamp(timestamp + this.timeoutMs)
    };
    return this.enqueue(dto, input.signal);
  }
}
