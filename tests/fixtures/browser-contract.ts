import type { WebRunEvent, WebRunEventType, WebRunEventData, WebJournalEvent, WebJournalInput, WebManagerEventInput, StreamResetEvent, WebRunStatus, WebRunSummary, WebApprovalRequest, WebInputRequest, WebPendingRequest, WebRouteOverride, WebRunSnapshot, WebErrorEnvelope } from "../../src/web/contracts.js";

export function inspect(event: WebRunEvent): string {
  const common: [1, string, string, number, string, number, WebRunEventType, WebRunEventData] = [event.schemaVersion, event.id, event.runId, event.sequence, event.timestamp, event.step, event.type, event.data];
  void common;
  switch (event.type) {
    case "run_accepted": case "run_started": return event.data.goal;
    case "run_cancellation_requested": case "step_started": case "route_requested": return event.runId;
    case "run_finished": return event.data.finalText;
    case "step_completed": return event.data.status;
    case "route_resolved": return event.data.model;
    case "worker_started": return event.data.target;
    case "worker_completed": return event.data.content;
    case "worker_failed": return event.data.error.code;
    case "tool_requested": case "tool_started": return event.data.callId;
    case "tool_completed": return event.data.content;
    case "tool_failed": return event.data.error.message;
    case "approval_requested": return event.data.summary;
    case "approval_resolved": return String(event.data.allowed);
    case "input_requested": return event.data.question;
    case "input_resolved": {
      if (event.data.outcome === "answered") return event.data.answer;
      return event.data.error.code;
    }
    case "stream.reset": return event.data.snapshot.highWaterId;
    default: { const exhaustive: never = event; return exhaustive; }
  }
}

const status: WebRunStatus = "interrupted";
const run: WebRunSummary = { runId: "run_browser", status, goal: "goal", maxSteps: 5, shadow: false, step: 0, acceptedAt: "now", startedAt: null, updatedAt: "now", finishedAt: null, finalText: "", error: null, historical: true };
const approval: WebApprovalRequest = { requestId: "approval_one", runId: run.runId, step: 1, category: "write", summary: "Write file", createdAt: "now", expiresAt: "later" };
const input: WebInputRequest = { requestId: "input_one", runId: run.runId, step: 1, question: "Which file?", createdAt: "now", expiresAt: "later" };
const pending: WebPendingRequest[] = [approval, input];
const manager: WebManagerEventInput = { runId: run.runId, step: 0, type: "run_accepted", data: { goal: "goal", maxSteps: 5, shadow: false } };
const journalInput: WebJournalInput = manager;
const event: WebJournalEvent = { schemaVersion: 1, id: "run_browser:1", runId: run.runId, sequence: 1, timestamp: "now", step: 0, type: "run_accepted", data: manager.data };
const snapshot: WebRunSnapshot = { run, latestRoute: null, events: [event], truncated: false, pendingApprovals: [approval], pendingInputs: [input], generation: 0, highWaterId: event.id, highWaterSequence: 1 };
const reset: StreamResetEvent = { schemaVersion: 1, id: snapshot.highWaterId, runId: run.runId, sequence: snapshot.highWaterSequence, timestamp: "now", step: run.step, type: "stream.reset", data: { snapshot } };
const override: WebRouteOverride = { action: "inspect", target: "public_model", effort: "low", contextTokens: 100, maxOutputTokens: 50, temperature: 0, toolPolicy: "read" };
const error: WebErrorEnvelope = { error: { code: "RUN_TERMINAL", message: "Run is terminal." } };
const detailed: WebErrorEnvelope<{ field: string }> = { error: { code: "INVALID", message: "Invalid request.", details: { field: "goal" } } };
// Payloads must remain tied to the discriminant.
// @ts-expect-error an approval payload cannot belong to an input event
const invalid: WebRunEvent = { ...event, type: "input_requested", data: { requestId: "input_one", allowed: true } };
// @ts-expect-error stream.reset is a transport control, never a journal input
const invalidInput: WebJournalInput = reset;
void [pending, journalInput, reset, override, error, detailed, invalid, invalidInput];
