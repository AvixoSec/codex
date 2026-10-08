import { expect, test } from "vitest";
import { EventJournal } from "../src/web/event-journal.js";
import type { WebJournalInput, WebJournalEvent } from "../src/web/contracts.js";

const runId = "run_journal";
const now = () => Date.parse("2026-10-08T12:00:00.000Z");
const started = (goal = "hello"): WebJournalInput => ({ runId, step: 0, type: "run_started", data: { goal, maxSteps: 5, shadow: false } });
const bytes = (event: WebJournalEvent) => new TextEncoder().encode(JSON.stringify(event)).byteLength;

test("assigns sequences 1..n, exact IDs, injected ISO timestamps and exactly eight own fields", () => {
  const journal = new EventJournal({ runId, now });
  for (let sequence = 1; sequence <= 3; sequence++) {
    const event = journal.append(started());
    expect(event).toEqual({ schemaVersion: 1, id: `${runId}:${sequence}`, runId, sequence, timestamp: "2026-10-08T12:00:00.000Z", step: 0, type: "run_started", data: { goal: "hello", maxSteps: 5, shadow: false } });
    expect(Object.keys(event)).toEqual(["schemaVersion", "id", "runId", "sequence", "timestamp", "step", "type", "data"]);
  }
});

test("rejects malformed journal IDs and mismatched append owners with stable safe errors", () => {
  for (const invalid of ["run_", " run_ok", "run_a:b", "run_" + "a".repeat(121)]) expect(() => new EventJournal({ runId: invalid })).toThrow(expect.objectContaining({ code: "INVALID_RUN_ID", status: 400 }));
  const journal = new EventJournal({ runId, now });
  expect(() => journal.append({ ...started(), runId: "run_other" })).toThrow(expect.objectContaining({ code: "INVALID_RUN_ID", status: 400 }));
  expect(journal.append(started()).sequence).toBe(1);
});

test("stores immutable detached events and snapshots despite caller or nested snapshot mutation", () => {
  const journal = new EventJournal({ runId, now });
  const input = started();
  const appended = journal.append(input);
  if (input.type === "run_started") input.data.goal = "changed";
  expect(() => { (appended.data as { goal: string }).goal = "return mutation"; }).toThrow(TypeError);
  const first = journal.snapshot();
  const second = journal.snapshot();
  expect(first.events[0]?.data).toEqual({ goal: "hello", maxSteps: 5, shadow: false });
  expect(first).not.toBe(second);
  expect(first.events).not.toBe(second.events);
  expect(first.events[0]).not.toBe(second.events[0]);
  expect(first.events[0]?.data).not.toBe(appended.data);
  expect(() => { (first.events[0]?.data as { goal: string }).goal = "snapshot mutation"; }).toThrow(TypeError);
  expect(() => { (first.events as WebJournalEvent[]).push(appended); }).toThrow(TypeError);
  expect(journal.snapshot()).toMatchObject({ runId, generation: 0, truncated: false, highWaterId: `${runId}:1`, highWaterSequence: 1, events: [appended] });
});

test("subscribers receive synchronously ordered independent immutable deliveries and unsubscribe idempotently", () => {
  const journal = new EventJournal({ runId, now });
  const first: WebJournalEvent[] = [];
  const second: WebJournalEvent[] = [];
  const unsubscribe = journal.subscribe((event) => { first.push(event); expect(() => { (event.data as { goal: string }).goal = "secret"; }).toThrow(TypeError); });
  journal.subscribe((event) => second.push(event));
  const returned = journal.append(started());
  journal.append(started("next"));
  expect(first.map((event) => event.sequence)).toEqual([1, 2]);
  expect(second).toEqual(first);
  expect(second[0]).not.toBe(first[0]);
  expect(second[0]?.data).not.toBe(first[0]?.data);
  expect(returned).not.toBe(second[0]);
  unsubscribe(); unsubscribe();
  journal.append(started("third"));
  expect(first).toHaveLength(2);
  expect(second.map((event) => event.sequence)).toEqual([1, 2, 3]);
});

test("rejects unsafe or nonpositive journal limits", () => {
  for (const field of ["maxEvents", "maxBytes", "maxEventBytes"] as const) {
    for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => new EventJournal({ runId, [field]: value })).toThrow(RangeError);
  }
});

test("accepts exact UTF-8 envelope boundaries and rejects one-byte oversize before committing", () => {
  const probe = new EventJournal({ runId, now });
  const asciiSize = bytes(probe.append(started("aaaa")));
  const unicodeSize = bytes(new EventJournal({ runId, now }).append(started("💫")));
  expect(unicodeSize).toBe(asciiSize);
  for (const options of [{ maxEventBytes: unicodeSize, maxBytes: unicodeSize }, { maxEventBytes: unicodeSize + 100, maxBytes: unicodeSize }]) {
    const journal = new EventJournal({ runId, now, ...options });
    const deliveries: WebJournalEvent[] = [];
    journal.subscribe((event) => deliveries.push(event));
    const exact = journal.append(started("💫"));
    expect(bytes(exact)).toBe(unicodeSize);
    const before = journal.snapshot();
    expect(() => journal.append(started("💫a"))).toThrow(expect.objectContaining({ code: "EVENT_TOO_LARGE", status: 413 }));
    expect(journal.snapshot()).toEqual(before);
    expect(deliveries).toHaveLength(1);
    expect(journal.append(started("💫")).sequence).toBe(2);
  }
  expect(() => new EventJournal({ runId, now, maxBytes: asciiSize, maxEventBytes: asciiSize }).append(started("💫💫"))).toThrow(expect.objectContaining({ code: "EVENT_TOO_LARGE" }));
});

test("evicts exact count overflow in order and keeps truncation true for the generation", () => {
  const journal = new EventJournal({ runId, now, maxEvents: 2 });
  journal.append(started()); journal.append(started());
  expect(journal.snapshot().truncated).toBe(false);
  journal.append(started());
  expect(journal.snapshot().events.map((event) => event.sequence)).toEqual([2, 3]);
  expect(journal.snapshot().truncated).toBe(true);
  journal.append(started());
  expect(journal.snapshot().events.map((event) => event.sequence)).toEqual([3, 4]);
  expect(journal.snapshot().truncated).toBe(true);
});

test("accepts an exact total byte window and evicts multiple oldest events for UTF-8 overflow", () => {
  const probe = new EventJournal({ runId, now });
  const small = bytes(probe.append(started("a")));
  const journal = new EventJournal({ runId, now, maxBytes: small * 3, maxEventBytes: small * 3 });
  for (let i = 0; i < 3; i++) journal.append(started("a"));
  expect(journal.snapshot().events).toHaveLength(3);
  expect(journal.snapshot().truncated).toBe(false);
  const large = journal.append(started("💫".repeat(Math.ceil(small / 4) + 1)));
  expect(bytes(large)).toBeGreaterThan(small * 2);
  expect(journal.snapshot().events.map((event) => event.sequence)).toEqual([4]);
  expect(journal.snapshot().truncated).toBe(true);
});

test("allowlists every lifecycle payload including nested public routes, errors and input outcomes", () => {
  const error = { code: "RUN_ABORTED", message: "Run aborted." } as const;
  const route = { action: "inspect", target: "target", provider: "provider", model: "model", effort: "low", contextTokens: 100, maxOutputTokens: 50, temperature: null, toolPolicy: "read", provenance: "jev", scores: { action: 0, target: null, effort: null, contextTokens: null, maxOutputTokens: null, temperature: null, toolPolicy: null, completion: null }, adjustments: [{ field: "target", reason: "not_offered" }] } as const;
  const payloads: Array<[WebJournalInput["type"], object]> = [
    ["run_accepted", { goal: "hello", maxSteps: 5, shadow: false }], ["run_started", { goal: "hello", maxSteps: 5, shadow: false }], ["run_cancellation_requested", {}],
    ["run_finished", { status: "failed", finalText: "done", error }], ["run_finished", { status: "completed", finalText: "done" }],
    ["step_started", {}], ["step_completed", { status: "stopped" }], ["route_requested", {}], ["route_resolved", route],
    ["worker_started", { target: "target" }], ["worker_completed", { target: "target", content: "done" }], ["worker_failed", { target: "target", error }],
    ["tool_requested", { callId: "call", name: "read_file" }], ["tool_started", { callId: "call", name: "read_file" }], ["tool_completed", { callId: "call", name: "read_file", content: "done" }], ["tool_failed", { callId: "call", name: "read_file", error }],
    ["approval_requested", { requestId: "approval_one", category: "write", summary: "Write file" }], ["approval_resolved", { requestId: "approval_one", allowed: true }],
    ["input_requested", { requestId: "input_one", question: "Which?" }], ["input_resolved", { requestId: "input_one", outcome: "answered", answer: "one" }], ["input_resolved", { requestId: "input_one", outcome: "cancelled", error }], ["input_resolved", { requestId: "input_one", outcome: "failed", error }]
  ];
  const journal = new EventJournal({ runId, now });
  for (const [type, data] of payloads) {
    const contaminated = JSON.parse(JSON.stringify(data));
    contaminated.headers = { Authorization: "secret-sentinel" };
    contaminated.command = "secret-command";
    if (contaminated.error) contaminated.error.cause = "secret-cause";
    if (type === "route_resolved") {
      contaminated.scores.endpoint = "secret-endpoint";
      contaminated.adjustments[0].from = { apiKey: "secret-key" };
      contaminated.adjustments[0].to = "secret-target";
    }
    const result = journal.append({ runId, step: type === "run_accepted" ? 0 : 1, type, data: contaminated, sequence: 999, timestamp: "forged", secret: "secret-top" } as WebJournalInput);
    expect(result.data).toEqual(data);
    expect(JSON.stringify(result)).not.toContain("secret-");
    expect(Object.keys(result)).toHaveLength(8);
  }
});

test("replays strictly after a retained cursor from one immutable detached atomic snapshot", () => {
  const journal = new EventJournal({ runId, now });
  expect(journal.snapshot()).toMatchObject({ events: [], highWaterId: `${runId}:0`, highWaterSequence: 0 });
  expect(journal.replay(`${runId}:0`)).toMatchObject({ kind: "replay", events: [] });
  for (let i = 0; i < 3; i++) journal.append(started());
  const result = journal.replay(`${runId}:1`);
  expect(result.kind).toBe("replay");
  if (result.kind !== "replay") throw new Error("expected replay");
  expect(result.events.map((event) => event.sequence)).toEqual([2, 3]);
  expect(result.snapshot.highWaterSequence).toBe(3);
  expect(result.events[0]).not.toBe(result.snapshot.events[1]);
  expect(() => { (result.events[0]?.data as { goal: string }).goal = "mutation"; }).toThrow(TypeError);
  journal.append(started());
  expect(result.snapshot.highWaterSequence).toBe(3);
  expect(journal.replay()).toMatchObject({ kind: "replay", events: journal.snapshot().events });
  expect(journal.replay(`${runId}:0`)).toMatchObject({ kind: "replay", events: journal.snapshot().events });
  expect(journal.replay(`${runId}:4`)).toMatchObject({ kind: "replay", events: [] });
});

test("returns explicit replay resets for exact malformed, unsafe, foreign, future and evicted cursors", () => {
  const journal = new EventJournal({ runId, now, maxEvents: 2 });
  for (let i = 0; i < 3; i++) journal.append(started());
  for (const cursor of ["", `${runId}:01`, `${runId}:+1`, `${runId}:-1`, `${runId}:1:2`, `${runId}:1 `, ` ${runId}:1`, `${runId}:1\n`, `${runId}:1.0`, `${runId}:9007199254740992`, "run_:1"]) {
    expect(journal.replay(cursor)).toEqual({ kind: "reset", reason: "malformed_cursor", snapshot: journal.snapshot() });
  }
  expect(journal.replay("run_foreign:1")).toMatchObject({ kind: "reset", reason: "foreign_run" });
  expect(journal.replay(`${runId}:4`)).toMatchObject({ kind: "reset", reason: "future_cursor" });
  for (const cursor of [`${runId}:0`, `${runId}:1`]) expect(journal.replay(cursor)).toMatchObject({ kind: "reset", reason: "history_unavailable" });
  expect(journal.replay(`${runId}:2`)).toMatchObject({ kind: "replay", events: [journal.snapshot().events[1]] });
});

test("reset clears bytes/history, advances generation without sequence reuse or synthetic notifications", () => {
  const journal = new EventJournal({ runId, now, maxBytes: 400, maxEventBytes: 400 });
  const deliveries: WebJournalEvent[] = [];
  journal.subscribe((event) => deliveries.push(event));
  journal.append(started()); journal.append(started());
  expect(journal.reset()).toEqual({ runId, generation: 1, events: [], truncated: true, highWaterId: `${runId}:2`, highWaterSequence: 2 });
  expect(deliveries).toHaveLength(2);
  expect(journal.replay(`${runId}:2`)).toMatchObject({ kind: "reset", reason: "generation_reset" });
  expect(journal.append(started()).sequence).toBe(3);
  expect(journal.snapshot().events.map((event) => event.sequence)).toEqual([3]);
  for (const sequence of [0, 1, 2]) expect(journal.replay(`${runId}:${sequence}`)).toMatchObject({ kind: "reset", reason: "generation_reset" });
  expect(journal.replay(`${runId}:3`)).toMatchObject({ kind: "replay", events: [] });
  const empty = new EventJournal({ runId, now });
  expect(empty.reset()).toMatchObject({ generation: 1, truncated: false, highWaterId: `${runId}:0`, highWaterSequence: 0 });
  expect(empty.replay(`${runId}:0`)).toMatchObject({ kind: "reset", reason: "generation_reset" });
  expect(empty.append(started()).sequence).toBe(1);
});

test("subscribe-before-snapshot buffering deduplicates high water with an append in the critical interval", () => {
  const journal = new EventJournal({ runId, now });
  journal.append(started());
  const buffered: WebJournalEvent[] = [];
  const unsubscribe = journal.subscribe((event) => buffered.push(event));
  journal.append(started("between subscription and snapshot"));
  const snapshot = journal.snapshot();
  journal.append(started("after snapshot"));
  const delivered = [...snapshot.events, ...buffered.filter((event) => event.sequence > snapshot.highWaterSequence)];
  expect(delivered.map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(snapshot.highWaterId).toBe(`${runId}:2`);
  unsubscribe();
});

test("default event limit accepts exactly 64 KiB and rejects the next byte", () => {
  const base = bytes(new EventJournal({ runId, now }).append(started("")));
  const journal = new EventJournal({ runId, now });
  expect(bytes(journal.append(started("a".repeat(64 * 1024 - base))))).toBe(64 * 1024);
  expect(() => journal.append(started("a".repeat(64 * 1024 - base + 1)))).toThrow(expect.objectContaining({ code: "EVENT_TOO_LARGE" }));
});

test("subscriber failures cannot stop committed delivery to another subscriber", () => {
  const journal = new EventJournal({ runId, now });
  const received: number[] = [];
  journal.subscribe((event) => { (event.data as { goal: string }).goal = "mutation"; });
  journal.subscribe((event) => received.push(event.sequence));
  expect(() => journal.append(started())).not.toThrow();
  expect(received).toEqual([1]);
  expect(journal.snapshot().events[0]?.data).toEqual(started().data);
});

test("reentrant subscriber append preserves committed order for every subscriber", () => {
  const journal = new EventJournal({ runId, now });
  const received: number[] = [];
  journal.subscribe((event) => { if (event.sequence === 1) journal.append(started("reentrant")); });
  journal.subscribe((event) => received.push(event.sequence));
  journal.append(started());
  expect(received).toEqual([1, 2]);
});

test("transport reset controls cannot be appended or consume a journal sequence", () => {
  const journal = new EventJournal({ runId, now });
  const delivered: WebJournalEvent[] = [];
  journal.subscribe((event) => delivered.push(event));
  expect(() => journal.append({ runId, step: 0, type: "stream.reset", data: { snapshot: {} } } as unknown as WebJournalInput)).toThrow(TypeError);
  expect(journal.snapshot()).toMatchObject({ events: [], highWaterId: `${runId}:0`, highWaterSequence: 0 });
  expect(delivered).toEqual([]);
  expect(journal.append(started()).sequence).toBe(1);
});
