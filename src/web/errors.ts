import type { WebErrorEnvelope } from "./contracts.js";

const errors = {
  INVALID_RUN_ID: [400, "Invalid run ID."],
  INVALID_REQUEST_ID: [400, "Invalid request ID."],
  INVALID_BROKER_REQUEST: [400, "Invalid broker request."],
  DUPLICATE_REQUEST_ID: [409, "Request ID has already been used."],
  EVENT_TOO_LARGE: [413, "Event exceeds the journal byte limit."],
  REQUEST_NOT_FOUND: [404, "Request was not found."],
  CROSS_RUN_RESPONSE: [409, "Request belongs to another run."],
  REQUEST_ALREADY_RESOLVED: [409, "Request has already been resolved."],
  REQUEST_EXPIRED: [409, "Request has expired."],
  REQUEST_CANCELLED: [409, "Request was cancelled."],
  RUN_TERMINAL: [409, "Run is terminal."]
} as const;
export type WebRuntimeErrorCode = keyof typeof errors;

export class WebRuntimeError extends Error {
  readonly code: WebRuntimeErrorCode;
  readonly status: 400 | 404 | 409 | 413;
  constructor(code: WebRuntimeErrorCode) {
    super(errors[code][1]);
    this.name = "WebRuntimeError";
    this.code = code;
    this.status = errors[code][0];
  }
  toEnvelope(): WebErrorEnvelope {
    return { error: { code: this.code, message: errors[this.code][1] } };
  }
}
