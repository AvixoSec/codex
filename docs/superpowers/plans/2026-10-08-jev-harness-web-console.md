# Jev Harness Web Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, realtime, fully operational local web console to the existing Jev Harness while preserving CLI compatibility and all routing, workspace, credential, approval, and cancellation boundaries.

**Architecture:** Extend the existing runner with allowlisted public telemetry, then build browser-safe realtime primitives, a snapshotting run manager, persistence services, and a Node `http` server around it. Deliver a separately compiled React/Vite client that consumes only public contracts; keep one npm package and one CLI with `jevh web`.

**Tech Stack:** Node.js 20+, TypeScript/ESM, Zod, YAML, Vitest, React 19, Vite 6, Testing Library, Playwright, Node `http`/`net`.

**Spec:** `docs/superpowers/specs/2026-10-08-jev-harness-web-console-design.md`

## Global Constraints

- Preserve all current CLI commands, configuration version 1, receipts, and the existing 125-test baseline.
- Do not expose resolved credential values, authorization headers, arbitrary provider headers/bodies, Jev endpoints, stack traces, causes, or internal diagnostics through browser DTOs.
- Keep Node runtime compatibility at `>=20`; use Vite 6 and React plugin 4 rather than raising the engine floor.
- Use strict Zod request bodies, a 256 KiB streaming JSON limit, exact Host/Origin checks, and a per-process `x-jev-request-token`.
- Default bind is exactly `127.0.0.1:4317`; every non-loopback bind requires explicit `--allow-remote`.
- Default journal limits are 2,000 events, 4 MiB total encoded bytes, and 64 KiB per encoded event.
- Default SSE client limits are 256 queued events, 1 MiB queued bytes, and a 15-second heartbeat.
- Default shutdown grace is 1,000 ms and must bound incomplete-header, partial-body, keep-alive, SSE, and ordinary sockets.
- Broker waits default to 300,000 ms; resolved/expired tombstones are bounded to 4,096 entries and five minutes.
- The run manager retains at most 100 terminal in-memory run snapshots; durable receipt history remains available through `ReceiptService`.
- Browser SSE reconnect uses exponential delay from 250 ms to 5,000 ms and does not retry HTTP 401/403 until the page is reloaded.
- Public run IDs match `/^run_[A-Za-z0-9_-]{1,120}$/u`; event IDs are `${runId}:${sequence}`.
- Public free-text is bounded before journaling: summary/question 2,048 UTF-8 bytes, event content 16 KiB, and public error messages 512 bytes.
- Every major task uses red-green-refactor, an independent review, fixes and re-review for all Critical/Important findings, then commit and push.
- A task is complete only after focused tests, `npm run typecheck`, and the relevant full suite pass freshly.
- Preserve user files and unrelated working-tree changes; never reset or delete existing work.

## Review Focus

- Adversarial nested internal objects must not leak URLs, credentials, headers, payloads, arguments, or diagnostics; Tasks 1, 4, and 5 contain serialization tests.
- Concurrent starts and concurrent CAS/dotenv updates must have exactly one authoritative winner without lost edits; Tasks 3 and 4 contain race tests.
- Evicted replay cursors, split SSE frames, healthy backpressure, permanently slow clients, and terminal events must remain ordered and recoverable; Tasks 2, 5, and 7 contain transport tests.
- Symlink/FIFO replacement and clients that never finish HTTP headers or bodies must never block the event loop or shutdown; Tasks 4 and 5 contain filesystem/raw-socket tests.
- Stale run replies, stale streams, server restarts, and config revision conflicts must preserve authoritative state and local drafts; Tasks 2, 3, 7, and 9 contain ownership/recovery tests.

## Shared Stage Gate

At the end of every task:

1. Run the task's focused tests and `npm run typecheck`.
2. Run `npm test` unless the task explicitly requires the larger release matrix.
3. Stage only the task's exact intended paths, then dispatch a fresh independent reviewer with the task requirements, base SHA, changed-file list, and complete `git diff --cached --binary`; this includes new files without creating a review-blind commit.
4. Fix every Critical/Important finding using a new failing regression test first, restage the exact task paths, then request re-review of the refreshed cached patch.
5. Run `git diff --check`, verify the cached patch contains only intended paths, and repeat focused/full verification after the final fix.
6. Perform the task's single listed commit-and-push step. If Git smart HTTP is still blocked by proxy 503, publish the exact local tree with GitHub Git Objects using compare-and-swap against the recorded remote SHA, verify the branch file/tree, and record both local and remote commit SHAs.

---

### Task 1: Public Telemetry and Safe DTO Projection

**Files:**
- Create: `src/core/run-id.ts`
- Create: `src/core/telemetry.ts`
- Create: `src/core/public-projector.ts`
- Modify: `src/core/runner.ts`
- Modify: `src/tools/approval.ts`
- Modify: `src/tools/executor.ts`
- Test: `tests/telemetry.test.ts`
- Test: `tests/public-projector.test.ts`
- Modify test: `tests/runner.test.ts`
- Modify test: `tests/tools.test.ts`

**Interfaces:**
- Consumes: `ResolvedRoute`, `RawRouteDecision`, `AgentEvent`, `ToolExecutionResult`, and existing `RunnerLifecycleEvent` without changing legacy semantics.
- Produces: `RouteProvenance`, `PublicRouteDecision`, `RunnerTelemetryEvent`, `OnTelemetry`, `isValidRunId()`, and new optional `RunOptions.runId`/`RunOptions.onTelemetry` used by Tasks 2–3.

```ts
export type RouteProvenance = "jev" | "fallback" | "user_override";
export type RouteScores = Record<RouteField | "completion", number | null>;
export type OnTelemetry = (event: RunnerTelemetryEvent) => void | Promise<void>;
export function isValidRunId(value: string): boolean;

// Add optional requestId to the existing ApprovalRequest interface.
// Existing one-argument callbacks remain assignable.
RunOptions.askUser?: (
  question: string,
  context?: { requestId: string; runId: string; step: number }
) => Promise<string>;
```

- [ ] **Step 1: Write red tests for run IDs and ordered telemetry**

Add tests named `uses a supplied run ID unchanged and rejects invalid IDs before effects`, `awaits telemetry in emission order`, and `keeps legacy lifecycle callbacks compatible`. Assert invalid IDs call neither router, worker, tools, nor receipts.

- [ ] **Step 2: Write red tests for truthful route projection**

Cover a real score of `0`, absent/malformed scores as `null`, router failure as `fallback`, shadow execution as `fallback` with real proposal scores retained, and a normal decision as `jev`.

- [ ] **Step 3: Write red tests for the allowlist and lifecycle coverage**

Use adversarial targets/errors containing endpoints, API keys, headers, request bodies, secrets, stack/cause, and nested diagnostics. Assert serialized public telemetry contains none of them and emits run, step, route, worker, tool, approval, input, and terminal events in order.

- [ ] **Step 4: Run the focused tests and verify red state**

Run: `npx vitest run tests/telemetry.test.ts tests/public-projector.test.ts tests/runner.test.ts tests/tools.test.ts`

Expected: FAIL because telemetry types/projectors and new `RunOptions` fields do not exist.

- [ ] **Step 5: Implement run-ID validation and allowlisted telemetry types/projectors**

Implement the exact grammar and bounds from Global Constraints. Project DTO fields individually; never spread an internal route, target, error, tool arguments, or receipt record.

- [ ] **Step 6: Instrument the runner and approval/tool boundaries**

Use the supplied run ID before any side effect, preserve `onEvent`, await `onTelemetry` in emission order, and preserve actual nullable scores from the raw decision. The executor/runner mint approval/input request IDs once and pass them through the backward-compatible hook context so Task 3 can give those same IDs to the brokers.

- [ ] **Step 7: Verify Task 1 and baseline behavior**

Run: `npx vitest run tests/telemetry.test.ts tests/public-projector.test.ts tests/runner.test.ts tests/tools.test.ts && npm run typecheck && npm test`

Expected: all pass, including the original 125 tests.

- [ ] **Step 8: Complete Shared Stage Gate items 1–5**

Review focus: allowlist completeness, nullable score truthfulness, callback ordering, stable public failures, and unchanged CLI/receipt behavior.

- [ ] **Step 9: Commit and push Task 1**

Commit: `feat: expose safe run telemetry`

---

### Task 2: Browser Contracts, Event Journal, and Brokers

**Files:**
- Create: `src/web/contracts.ts`
- Create: `src/web/errors.ts`
- Create: `src/web/event-journal.ts`
- Create: `src/web/brokers.ts`
- Test: `tests/web-contracts.test.ts`
- Test: `tests/web-event-journal.test.ts`
- Test: `tests/web-brokers.test.ts`
- Test fixture: `tests/fixtures/browser-contract.ts`

**Interfaces:**
- Consumes: Task 1 public telemetry and route DTOs only; `contracts.ts` must compile with DOM/ES libraries and `types: []`.
- Produces: exact eight-field `WebRunEvent`, `WebRunSnapshot`, `StreamResetEvent`, `WebRunSummary`, `WebApprovalRequest`, `WebInputRequest`, `WebRouteOverride`, `WebErrorEnvelope`, `EventJournal`, `ApprovalBroker`, and `InputBroker` for Tasks 3, 5, and 7. Public status includes terminal `interrupted` for a durable receipt that has no terminal record. `StreamResetEvent` has the same eight common fields, uses the snapshot high-water ID/sequence, and is a transport control rather than a journal append. An empty snapshot uses `${runId}:0` and sequence `0` only for that control/cursor; journal events start at `1`.

```ts
new EventJournal({ runId, maxEvents, maxBytes, maxEventBytes, now? });
journal.append(telemetry): WebRunEvent;
journal.snapshot(): JournalSnapshot;
journal.replay(afterId?: string): ReplayResult;
journal.subscribe(listener): () => void;
journal.reset(): JournalSnapshot;

approval.request({ requestId, runId, step, category, summary, signal? }): Promise<boolean>;
approval.resolve(runId, requestId, allowed): void;
input.request({ requestId, runId, step, question, signal? }): Promise<string>;
input.resolve(runId, requestId, answer): void;
broker.pending(runId): readonly WebPendingRequest[];
broker.closeRun(runId, reason): void;
```

- [ ] **Step 1: Write red browser-contract and envelope tests**

Assert `WebRunEvent` has exactly `schemaVersion,id,runId,sequence,timestamp,step,type,data`; compile the browser fixture with no Node types. Define reset with the same eight common fields and authoritative snapshot data, using the current high-water ID/sequence without consuming another journal sequence.

- [ ] **Step 2: Write red journal boundary tests**

Cover monotonic IDs, immutable/detached snapshots, UTF-8 byte accounting, exact count/byte eviction, 64 KiB oversize rejection, replay after retained cursor, reset for malformed/foreign/evicted cursors, generation reset without sequence reuse, and subscribe-before-snapshot buffering without gaps or duplicates.

- [ ] **Step 3: Write red broker ownership tests**

Cover one-use resolution, cross-run replies, unknown/stale/expired/terminal replies, abort cleanup, run closure, pending snapshots, and a late approval that cannot resolve a cancelled promise.

- [ ] **Step 4: Run the focused tests and verify red state**

Run: `npx vitest run tests/web-contracts.test.ts tests/web-event-journal.test.ts tests/web-brokers.test.ts`

Expected: FAIL because contracts, journal, and brokers do not exist.

- [ ] **Step 5: Implement browser-safe contracts and stable public errors**

Use discriminated unions for every `data` payload and stable error codes for stale/cross-run/cancelled/terminal operations. Bound broker summaries and questions before storage.

- [ ] **Step 6: Implement the bounded journal**

Assign immutable sequence/timestamp at append, retain encoded byte counts without variadic spread, return detached snapshots, and preserve monotonic sequence across `reset()`.

- [ ] **Step 7: Implement approval and input brokers**

Validate and preserve the trusted request ID minted once by the Task 1 runner/executor, store one pending promise per request, reject duplicate IDs, require matching run ownership, maintain bounded tombstones long enough to distinguish stale replies, and remove all listeners/entries on abort or run close. Telemetry, pending snapshots, and resolution must use that same ID.

- [ ] **Step 8: Verify Task 2 and complete Shared Stage Gate items 1–5**

Run: `npx vitest run tests/web-contracts.test.ts tests/web-event-journal.test.ts tests/web-brokers.test.ts && npm run typecheck && npm test`

Review focus: reset semantics, aliasing, byte bounds, tombstone cleanup, and absence of Node imports/raw approval arguments.

- [ ] **Step 9: Commit and push Task 2**

Commit: `feat: add realtime web primitives`

---

### Task 3: Run Manager, Snapshots, Overrides, and Effect Barrier

**Files:**
- Create: `src/core/effect-barrier.ts`
- Create: `src/core/run-snapshot.ts`
- Create: `src/router/override.ts`
- Create: `src/web/run-manager.ts`
- Modify: `src/core/runner.ts`
- Modify: `src/router/resolve.ts`
- Modify: `src/tools/executor.ts`
- Test: `tests/effect-barrier.test.ts`
- Test: `tests/route-override.test.ts`
- Test: `tests/web-run-manager.test.ts`
- Modify test: `tests/runner.test.ts`
- Modify test: `tests/router.test.ts`
- Modify test: `tests/tools.test.ts`

**Interfaces:**
- Consumes: Task 2 journal/brokers/snapshots and Task 1 telemetry.
- Produces: `RunManager`, `RunManagerDependencies`, `RunFactoryContext`, `EffectBarrier`, and one-shot route override handling used by Tasks 5–6.

```ts
interface StartRunOptions {
  goal: string;
  maxSteps?: number;
  shadow?: boolean;
}

interface RunManagerDependencies {
  workspace: string; // canonicalized once; browser starts cannot replace it
  loadConfig(): Promise<HarnessConfig>;
  loadEnvironment(config: HarnessConfig): Promise<Record<string, string | undefined>>;
  createRunner(context: RunFactoryContext): Promise<HarnessRunner>;
  createRunId?: () => string;
  now?: () => number;
}

manager.start(options: StartRunOptions): Promise<WebRunSummary>;
manager.get(runId: string): WebRunSummary;
manager.list(): WebRunSummary[];
manager.snapshot(runId: string): WebRunSnapshot;
manager.journal(runId: string): EventJournal;
manager.cancel(runId: string): WebRunSummary;
manager.resolveApproval(runId: string, requestId: string, allowed: boolean): void;
manager.resolveInput(runId: string, requestId: string, answer: string): void;
manager.setRouteOverride(runId: string, override: WebRouteOverride): void;

barrier.track<T>(promise: Promise<T>): Promise<T>;
barrier.settle(): Promise<void>;
```

- [ ] **Step 1: Write red manager reservation/snapshot tests**

Assert `start()` returns the run ID while execution is pending, canonical path aliases and simultaneous starts permit one run, config/env are deeply cloned/frozen, only referenced env names are captured, later edits affect only later runs, and only the newest 100 terminal in-memory snapshots are retained.

- [ ] **Step 2: Write red cancellation/effect tests**

Assert cancelling is published immediately but the workspace remains reserved through deferred atomic rename or shell close. Runner rejection must close brokers, wait effects, publish a safe terminal state, and then release the workspace.

- [ ] **Step 3: Write red override safety tests**

Assert an override is consumed by exactly one future route, records `user_override`, rejects stale/terminal runs, and cannot bypass supported target/effort, output/context/model limits, temperature support, tool ceiling, approvals, max steps, elapsed deadline, or the real completion gate.

- [ ] **Step 4: Run the focused tests and verify red state**

Run: `npx vitest run tests/web-run-manager.test.ts tests/effect-barrier.test.ts tests/route-override.test.ts tests/runner.test.ts tests/router.test.ts tests/tools.test.ts`

Expected: FAIL because the manager, snapshots, override hook, and barrier do not exist.

- [ ] **Step 5: Implement immutable snapshots and workspace reservation**

Canonicalize the manager's configured workspace once and reserve it synchronously before async preparation. `StartRunOptions` never accepts a workspace override. Generate run ID/journal/brokers before launching the background promise and never return config/env snapshots through public methods.

- [ ] **Step 6: Implement effect tracking and bounded run finalization**

Register the actual write/shell promise synchronously before a guard race can return. On cancel, abort and close brokers immediately; publish terminal/release only after runner and `barrier.settle()` finish.

- [ ] **Step 7: Implement one-shot route overrides through normal resolution**

Add an optional next-route hook to `RunOptions`; validate offered values, mark provenance, and apply the existing capability/safety clamps after the override.

- [ ] **Step 8: Verify Task 3 and complete Shared Stage Gate items 1–5**

Run: `npx vitest run tests/web-run-manager.test.ts tests/effect-barrier.test.ts tests/route-override.test.ts tests/runner.test.ts tests/router.test.ts tests/tools.test.ts && npm run typecheck && npm test`

Review focus: losing abort-race promises, reservation lifetime, terminal ownership, snapshot immutability, override consumption, and late replies.

- [ ] **Step 9: Commit and push Task 3**

Commit: `feat: manage concurrent web runs safely`

---

### Task 4: Configuration, Credentials, Environment, and Safe Receipts

**Files:**
- Create: `src/config/dotenv.ts`
- Create: `src/config/environment.ts`
- Create: `src/web/services/mutation-queue.ts`
- Create: `src/web/services/atomic-file.ts`
- Create: `src/web/services/config-service.ts`
- Create: `src/web/services/credential-service.ts`
- Create: `src/web/services/safe-file.ts`
- Create: `src/web/services/receipt-service.ts`
- Modify: `src/web/contracts.ts`
- Modify: `src/commands/run.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/web/run-manager.ts`
- Test: `tests/environment.test.ts`
- Test: `tests/web-services.test.ts`
- Test: `tests/web-receipts.test.ts`
- Modify test: `tests/doctor.test.ts`
- Modify test: `tests/cli.test.ts`
- Modify test: `tests/e2e.test.ts`

**Interfaces:**
- Consumes: existing strict `parseConfig`, Task 3 snapshot loader seam, and Task 2 config/receipt DTOs.
- Produces: `ConfigService`, `CredentialService`, `ReceiptService`, atomic path mutation helpers, dotenv codec, and shared environment loader for Tasks 5–6.

```ts
withPathMutation<T>(path: string, mutate: () => Promise<T>): Promise<T>;
atomicReplace(path: string, bytes: Uint8Array): Promise<void>;
encodeManagedCredential(value: string): string;
decodeManagedCredential(value: string): string;
loadProjectEnvironment(configPath, supplied): Promise<Record<string, string | undefined>>;

class ConfigService {
  constructor(path: string);
  read(): Promise<WebConfigDocument>;
  validate(value: unknown): WebConfigValidation;
  update(value: unknown, expectedRevision: string): Promise<WebConfigDocument>;
  loadInternal(): Promise<LoadedConfig>;
}

class CredentialService {
  constructor(config: ConfigService, suppliedEnvironment: Record<string, string | undefined>);
  status(): Promise<WebCredentialStatus[]>;
  update(name: string, value: string): Promise<WebCredentialStatus>;
}

class ReceiptService {
  constructor(directory: string, options?: {
    maxFileBytes?: number; // default 4 MiB
    maxRecords?: number; // default 2,000
    maxStringBytes?: number; // default 16 KiB
  });
  list(query?: WebReceiptListQuery): Promise<WebReceiptSummary[]>;
  read(runId: string): Promise<WebReceipt>; // safe summary, events, latestRoute
}

interface WebReceiptListQuery {
  limit?: number; // 1..100, default 50
  beforeRunId?: string;
}
```

- [ ] **Step 1: Write red config revision/CAS tests**

Assert exact-byte `sha256:<lowercase-hex>`, strict safe editor validation, hidden `extraBody`/header preservation, deterministic YAML, 0600 atomic replace, temp cleanup, stale revision 412 data, queue recovery, and exactly one winner for simultaneous identical revisions across service instances.

- [ ] **Step 2: Write red credential codec/tokenizer tests**

Round-trip empty/Unicode/quotes/equals/hash and LF/CRLF/CR/U+2028/U+2029 values through exact `JEVH_MANAGED_B64_V1:` canonical base64. Reject invalid padding, noncanonical encodings, embedded/trailing marker text, duplicate target assignments, and preserve unrelated bytes/comments/order/BOM/final newline/multiline quoted values.

- [ ] **Step 3: Write red environment integration tests**

Assert supplied env wins unchanged, managed dotenv values decode only when file-originated, updates to different names serialize on one file, CLI run/doctor keep current caller-env compatibility, web snapshots remain fresh/referenced-only, and no provider receives the marker.

- [ ] **Step 4: Write red safe receipt tests**

Reject absolute/traversal IDs, symlinked files/parents, FIFO/device/socket, oversized/growing/replaced files, and regular-file-to-FIFO races without blocking. Project per-kind allowlists into a reconstructable terminal summary, ordered public events, and latest route; bound collections/strings and process a 100,000-element nested/flat array without recursion or argument-spread overflow. Historical projections assign deterministic snapshot-local sequences from record order but never claim continuity with a prior live journal. A receipt without `run_finished` becomes terminal `interrupted` with a fixed safe message. Test pagination and reconstruction from complete/incomplete receipts after a fresh service instance.

- [ ] **Step 5: Run the focused tests and verify red state**

Run: `npx vitest run tests/web-services.test.ts tests/environment.test.ts tests/web-receipts.test.ts tests/doctor.test.ts tests/cli.test.ts tests/e2e.test.ts`

Expected: FAIL because persistence services and shared managed environment loading do not exist.

- [ ] **Step 6: Implement serialized atomic config updates**

Hold one canonical-path queue from revision reread through fsync/rename. Merge editor fields into the latest internal baseline so excluded fields survive. Return bounded issue paths/codes/messages only.

- [ ] **Step 7: Implement managed dotenv credentials and shared loading**

Tokenize all five separator forms and quoted multiline values without normalizing unrelated bytes. Serialize all edits for one dotenv path and decode only file-originated exact canonical markers before filling absent supplied-env names.

- [ ] **Step 8: Implement safe nonblocking receipt access**

Use no-follow/nonblocking flags where supported, pre/post identity checks, `fstat` regular-file validation, incremental capped reads, browser run IDs only, and iterative allowlist projection independent from unrestricted CLI replay. `WebReceipt` must provide enough safe state for the server to select a historical run after manager eviction or restart, while marking it historical so transport never mixes its synthetic snapshot-local sequence with live replay cursors.

- [ ] **Step 9: Verify Task 4 and complete Shared Stage Gate items 1–5**

Run: `npx vitest run tests/web-services.test.ts tests/environment.test.ts tests/web-receipts.test.ts && npx vitest run tests/config.test.ts tests/doctor.test.ts tests/receipts.test.ts tests/cli.test.ts tests/e2e.test.ts && npm run typecheck && npm test`

Review focus: hidden-config preservation, cross-instance mutation serialization, exact marker origin/precedence, special-file races, and separation from `ReceiptStore.read`.

- [ ] **Step 10: Commit and push Task 4**

Commit: `feat: persist safe web console state`

---

### Task 5: Secure REST, Static Files, SSE, and Bounded Shutdown

**Files:**
- Create: `src/web/server.ts`
- Create: `src/web/request-policy.ts`
- Create: `src/web/http-schemas.ts`
- Create: `src/web/json-body.ts`
- Create: `src/web/static-files.ts`
- Create: `src/web/sse.ts`
- Create: `src/web/shutdown.ts`
- Test helper: `tests/web-fixtures.ts`
- Test: `tests/web-server.test.ts`
- Test: `tests/web-static.test.ts`
- Test: `tests/web-sse.test.ts`
- Test: `tests/web-shutdown.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 manager, journal, broker, contracts, and services.
- Produces: already-listening `createWebServer()`/`WebServerHandle` consumed by Task 6 and the complete REST/SSE/static surface consumed by Task 7.

```ts
export interface WebServerHandle { readonly url: string; close(): Promise<void>; }
export function createWebServer(options: WebServerOptions): Promise<WebServerHandle>;
export function readJsonBody(request: IncomingMessage, limitBytes = 262_144): Promise<unknown>;
```

- [ ] **Step 1: Write red request-policy and REST table tests**

Cover every specified endpoint and real service call, exact/duplicate Host, IPv4/IPv6 authority, exact token, required unsafe Origin, mismatched safe Origin, absent permissive CORS, method/media/schema errors, unknown fields, safe error envelopes, config 412, broker conflicts, and a streamed body crossing 256 KiB with ingestion stopped. The start body has no workspace/path field; strict validation rejects attempts to switch execution roots.

- [ ] **Step 2: Write red security-header and static tests**

Assert in-memory token injection, CSP, nosniff, frame denial, referrer policy, API no-store, fixed MIME types, GET/HEAD parity, safe extensionless SPA fallback, and rejection of raw NUL/backslash/dot/encoded separator/double-encoded/residual traversal, prefix collision, symlink, and special-file paths.

- [ ] **Step 3: Write red SSE replay/race tests**

Cover strict `Last-Event-ID`, replay strictly after a cursor, authoritative reset for malformed/foreign/evicted cursor, and an append between subscription and snapshot with no gap/duplicate. Also restart with an empty manager and existing complete/incomplete receipts: `GET /api/runs` merges live summaries with deduplicated durable summaries, `GET /api/runs/:runId` selects an evicted historical run, and its events stream always ignores cursor continuity, sends one authoritative reset snapshot, and closes. Assert it never sends historical events as live replay and maps missing terminal records to `interrupted`.

- [ ] **Step 4: Write red deterministic backpressure tests**

With a response double, assert `write(false)` accepts a frame exactly once, later events queue FIFO, `drain` resumes order, heartbeats skip while blocked, count/byte overflow closes only that client, cleanup removes listeners/timers/subscription, and terminal closes only after its queued frame drains.

- [ ] **Step 5: Write red healthy large-stream and raw-socket shutdown tests**

Pause/resume a real SSE reader until backpressure occurs and verify complete ordered delivery. Use `net.Socket` for no headers, partial headers, partial JSON body, idle keep-alive, paused SSE, and in-flight response; assert `close()` resolves near the injected grace bound and is idempotent.

- [ ] **Step 6: Run the focused tests and verify red state**

Run: `npx vitest run tests/web-server.test.ts tests/web-static.test.ts tests/web-sse.test.ts tests/web-shutdown.test.ts`

Expected: FAIL because the HTTP server modules do not exist.

- [ ] **Step 7: Implement strict REST/security/static handling**

Generate one process token, inject it only into HTML, validate every route component with strict schemas, and pin run starts to the manager's configured canonical workspace. Project doctor/bootstrap/receipt DTOs rather than returning internal objects. Merge live manager history with `ReceiptService.list()` by run ID; use `ReceiptService.read()` for evicted/restarted historical detail. Historical `/events` always emits a reset snapshot and closes, regardless of `Last-Event-ID`; only an in-memory journal may perform cursor replay. Open static files through the safe regular-file boundary.

- [ ] **Step 8: Implement SSE delivery and accepted-write backpressure**

Subscribe before replay, buffer live events through high water, deduplicate, use the 256-event/1-MiB FIFO, skip blocked heartbeats, close overflowed clients, and drain terminal frames before ending.

- [ ] **Step 9: Implement bounded connection shutdown**

Track sockets at `connection` time before HTTP parsing. Stop admission, request orderly SSE/idle closure, then destroy every remaining accepted socket after 1,000 ms and resolve only after the server close callback.

- [ ] **Step 10: Verify Task 5 and complete Shared Stage Gate items 1–5**

Run: `npx vitest run tests/web-server.test.ts tests/web-static.test.ts tests/web-sse.test.ts tests/web-shutdown.test.ts && npm run typecheck && npm test`

Review focus: browser DTO traces, raw path/header parsing, accepted-write semantics, replay/reset race, terminal draining, and pre-header socket tracking.

- [ ] **Step 11: Commit and push Task 5**

Commit: `feat: serve the secure web console API`

---

### Task 6: `jevh web`, Dual Builds, and Package Delivery

**Files:**
- Create: `src/commands/web.ts`
- Modify: `src/cli.ts`
- Create: `tsconfig.base.json`
- Create: `tsconfig.server.json`
- Create: `tsconfig.browser.json`
- Modify: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `src/web/client/index.html`
- Create: `src/web/client/main.tsx`
- Create: `src/web/client/App.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Test: `tests/web-command.test.ts`
- Test: `tests/build-package.test.ts`
- Modify test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: Task 5 `createWebServer()` and Tasks 3–4 actual runtime/service factories.
- Produces: `startWebConsole(options): Promise<WebServerHandle>`, CLI `web`, independent server/browser builds, and packaged `dist/web-ui` for Tasks 7–9.

- [ ] **Step 1: Write red CLI assembly tests**

Assert help includes `web`; defaults are `127.0.0.1:4317`; config/workspace discovery uses current conventions; remote/wildcard bind fails before startup unless explicitly allowed; actual URL prints without secret sentinels; SIGINT/SIGTERM close once and remove listeners.

- [ ] **Step 2: Write red build/package tests**

Assert browser build after server build preserves `dist/cli.js`, declarations, and maps; assets resolve relative to compiled `import.meta.url` from an unrelated cwd; both binary aliases and hashed UI assets appear in `npm pack --dry-run`.

- [ ] **Step 3: Run red tests**

Run: `npx vitest run tests/web-command.test.ts tests/cli.test.ts tests/build-package.test.ts`

Expected: FAIL because the command, dependencies, configs, and browser entry do not exist.

- [ ] **Step 4: Add pinned-compatible React/Vite dependencies**

Add runtime `react@^19`, `react-dom@^19`; add dev `vite@^6`, `@vitejs/plugin-react@^4`, `@types/react@^19`, `@types/react-dom@^19`; commit the resulting lockfile later with this task.

- [ ] **Step 5: Implement separate server/browser typecheck and builds**

Server remains NodeNext/ES2022 with declarations/maps to `dist` and excludes client TSX. Browser uses ESNext/Bundler, DOM, `react-jsx`, no emit. Vite root is `src/web/client`, output is exactly `dist/web-ui`, and only that nested directory is emptied.

- [ ] **Step 6: Implement `startWebConsole` and CLI wiring**

Resolve config/workspace, create real services/manager/runner with no terminal prompts, locate installed assets via compiled module URL, validate bind before listen, and provide idempotent signal cleanup.

- [ ] **Step 7: Verify Task 6 and complete Shared Stage Gate items 1–5**

Run: `npx vitest run tests/web-command.test.ts tests/cli.test.ts tests/build-package.test.ts && npm run typecheck && npm test && npm run build && npm pack --dry-run`

Review focus: Node 20 floor, CLI compatibility, process cleanup, installed asset lookup, and Vite never erasing server output.

- [ ] **Step 8: Commit and push Task 6**

Commit: `feat: ship the web console runtime`

---

### Task 7: Browser API, Fetch-SSE, and Normalized Store

**Files:**
- Create: `src/web/client/api.ts`
- Create: `src/web/client/sse-parser.ts`
- Create: `src/web/client/event-stream.ts`
- Create: `src/web/client/store.ts`
- Create: `src/web/client/selectors.ts`
- Create: `src/web/client/controller.ts`
- Test: `tests/web-client.test.ts`
- Test: `tests/web-sse-parser.test.ts`
- Test: `tests/web-event-stream.test.ts`
- Test: `tests/web-store.test.ts`

**Interfaces:**
- Consumes: only `src/web/contracts.ts` and the Task 5 HTTP surface.
- Produces: `WebApiClient`, `SseParser`, `createRunEventStream`, normalized `WebStore`, selectors, and `WebController` used by Task 8.

```ts
createApiClient({ baseUrl, token, fetcher? }): WebApiClient;
new SseParser().push(chunk: string): ParsedSseFrame[];
createRunEventStream(options): { close(): void };
createWebStore(): WebStore;
reduceWebState(state: WebState, action: WebAction): WebState;
```

- [ ] **Step 1: Write red API client tests**

Assert every API request sends the exact token, config PUT sends exact `If-Match`, all endpoint methods validate success/error DTOs, malformed envelopes fail safely, and 412 produces a typed conflict with current revision while preserving the local draft.

- [ ] **Step 2: Write red streaming parser/transport tests**

Cover split UTF-8, CRLF split between chunks, comments, multiline data, empty IDs, incomplete final frame, token plus explicit `Last-Event-ID`, cursor advance only after valid accepted frames, terminal EOF without reconnect, bounded reconnect states, auth restart without retry storm, and close/run-switch aborting old readers/timers/callbacks.

- [ ] **Step 3: Write red normalized reducer tests**

Assert duplicate/out-of-order events cannot duplicate UI or regress routes; reset bypasses ordinary dedup, atomically replaces stale routes/approvals/input/events, sets even a lower/equal high-water cursor, and then applies buffered newer events once.

- [ ] **Step 4: Run focused tests and verify red state**

Run: `npx vitest run tests/web-client.test.ts tests/web-sse-parser.test.ts tests/web-event-stream.test.ts tests/web-store.test.ts`

Expected: FAIL because the browser transport/store modules do not exist.

- [ ] **Step 5: Implement validated API methods and typed errors**

Expose every documented endpoint, retain only safe validated error fields, and keep credential values write-only outside normalized state.

- [ ] **Step 6: Implement fetch-based SSE and manual parser**

Use fetch/ReadableStream so custom headers are present. Decode streaming UTF-8 correctly, validate frames before cursor updates, bound retry delay, stop on terminal/auth failures, and ignore disposed stream callbacks.

- [ ] **Step 7: Implement normalized reducer/store/controller**

Normalize run/event/route/request maps, ordered IDs, per-run cursors, connection state, config draft/revision/conflict, credentials status, and operation states. Controller owns API/stream lifetimes.

- [ ] **Step 8: Verify Task 7 and complete Shared Stage Gate items 1–5**

Run: `npx vitest run tests/web-client.test.ts tests/web-sse-parser.test.ts tests/web-event-stream.test.ts tests/web-store.test.ts && npm run typecheck && npm test && npm run build`

Review focus: stream framing, reset-before-dedup, stale ownership, retry bounds, credential absence, and draft preservation.

- [ ] **Step 9: Commit and push Task 7**

Commit: `feat: connect the web console client`

---

### Task 8: Reference-Driven Responsive Operational UI

**Files:**
- Modify: `src/web/client/App.tsx`
- Modify: `src/web/client/main.tsx`
- Create: `src/web/client/styles.css`
- Create: `src/web/client/use-web-store.ts`
- Create: `src/web/client/components/HarnessStatus.tsx`
- Create: `src/web/client/components/RunHistory.tsx`
- Create: `src/web/client/components/TaskStream.tsx`
- Create: `src/web/client/components/TaskComposer.tsx`
- Create: `src/web/client/components/PendingRequests.tsx`
- Create: `src/web/client/components/DecisionInspector.tsx`
- Create: `src/web/client/components/SettingsPanel.tsx`
- Create: `src/web/client/components/RouteOverrideEditor.tsx`
- Test: `tests/web-ui.test.tsx`
- Modify: `vitest.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 7 `WebController`, store, selectors, and Task 2 public contracts.
- Produces: the complete responsive operational UI exercised by Task 9.

- [ ] **Step 1: Obtain and inspect the reference video**

Ask the user to attach the unavailable reference video again. Do not block completed backend Tasks 1–7; pause only Task 8 if it remains unavailable. Record concrete visual observations before styling.

- [ ] **Step 2: Write red operational component tests**

Using Testing Library, assert composer, cancel, approval, input, override, config validate/save, credential update, doctor, history, and receipt controls invoke real controller operations and render pending/success/failure. Block duplicate submissions while pending.

- [ ] **Step 3: Write red decision/settings/accessibility tests**

Assert null scores show unavailable, fallback/user_override are explicit, multiple providers/models plus URLs/effort/context/output/temperature/tools are editable, CAS conflict preserves draft, credential input clears after success, focus order/labels/focus return work, and reduced motion disables ticker animation.

- [ ] **Step 4: Run UI tests and verify red state**

Run: `npx vitest run tests/web-ui.test.tsx`

Expected: FAIL because operational components and styling do not exist.

- [ ] **Step 5: Add UI test dependencies and component/store bridge**

Add `@testing-library/react@^16`, `@testing-library/user-event@^14`, `@testing-library/jest-dom@^6`, `jsdom@^26`; include TSX tests with file-specific jsdom environment. Components consume selectors/controller only and never fetch or import internal server descriptors.

- [ ] **Step 6: Implement the reference-driven three-column dashboard**

Build cream/warm masthead, active model, real decision ticker, left telemetry/status/history, centre task stream/composer/pending requests, and right five-stage inspector/settings/override. Every visible control must have a real operation and state.

- [ ] **Step 7: Implement responsive/accessibility behavior**

Collapse history/inspector into labelled panels at narrow widths, preserve primary task controls, support keyboard/touch/long text/high contrast/reduced motion, and avoid decorative fake data.

- [ ] **Step 8: Verify Task 8 and complete Shared Stage Gate items 1–5**

Run: `npx vitest run tests/web-ui.test.tsx && npm run typecheck && npm test && npm run build`

Review focus: reference fidelity, every visible control operational, truthful telemetry, safe state ownership, responsiveness, and accessibility.

- [ ] **Step 9: Commit and push Task 8**

Commit: `feat: build the Jev decision dashboard`

---

### Task 9: Playwright Operations, Documentation, and Release Verification

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/browser/fixtures/harness.ts`
- Create: `tests/browser/operations.spec.ts`
- Create: `tests/browser/reconnect.spec.ts`
- Create: `tests/browser/config-conflict.spec.ts`
- Create: `tests/browser/responsive.spec.ts`
- Create: `scripts/verify-installed-package.ts`
- Create: `docs/web-console.md`
- Create: `docs/screenshots/web-console-desktop.png`
- Create: `docs/screenshots/web-console-mobile.png`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the shipped CLI/server/client from Tasks 1–8.
- Produces: real operational browser coverage, reviewed screenshots, PowerShell documentation, installed-package smoke verification, and final release evidence.

- [ ] **Step 1: Add Playwright and build the real backend fixture**

Add `@playwright/test@^1` and `test:browser`. Start actual config/services/manager/server/runner in a temp workspace; mock only external Jev/provider HTTP servers. Do not intercept frontend API responses to fake successful operations.

- [ ] **Step 2: Write the operational run/approval/input/cancel/override tests**

Cover real completed history/receipt after reload and after a full server restart with an empty manager; approve/reject write with exact filesystem assertions; ask-user continuation; cancellation while waiting/executing with late reply rejection and subsequent workspace reuse; reject injected workspace/path fields; and observe exactly one next-step `user_override` route.

- [ ] **Step 3: Write reconnect/reset/credential/config tests**

Interrupt/resume network and assert ordered unique events/pending cards; force journal eviction and authoritative reset; prove old/new credential snapshots and no browser leaks; use two contexts for one-winner CAS where the second draft survives 412.

- [ ] **Step 4: Write responsive/accessibility screenshot tests**

Capture stable reviewed screenshots at 1440×1000 and 390×844. Exercise keyboard operation, long strings, reduced motion, touch targets, and access to collapsed panels.

- [ ] **Step 5: Update README and detailed web documentation**

Document Unix and Windows PowerShell install/build/start commands, global config/workspace use, default/remote bind, shutdown bound, CAS conflicts, managed credentials/env precedence, reconnect/reset, semantic-not-token streaming, and the non-sandbox boundary. Remove obsolete CLI-only scope claims.

- [ ] **Step 6: Implement installed-package smoke verification**

Pack to a temp directory, install into another temp project, run both executable aliases from an unrelated cwd, start web on ephemeral loopback, fetch injected HTML and hashed assets, and close within the documented bound.

- [ ] **Step 7: Run the full release matrix**

Run:

```bash
npm ci
npm run typecheck
npm test
npm run build:server
npm run build:browser
npx playwright install chromium
npm run test:browser
node dist/cli.js --help
node dist/cli.js web --help
npm pack --dry-run
npx tsx scripts/verify-installed-package.ts
```

Expected: every command exits 0; browser screenshots are intentional and reviewed; tarball contains CLI, server declarations/maps, and UI assets.

- [ ] **Step 8: Request independent final review and remediate**

Give a fresh reviewer the approved spec, plan, base SHA, complete diff, and test evidence. Fix every Critical/Important with a failing regression first, rerun the relevant focused tests and full release matrix, and obtain clean re-review.

- [ ] **Step 9: Commit and push Task 9**

Commit: `test: verify the web console release`

- [ ] **Step 10: Prove clean final branch and report SHA**

Run: `git status --short`, `git log --oneline -10`, `git branch -vv`, and `git ls-remote origin refs/heads/jev-web-console-rebuild` when Git transport is available. Otherwise verify the branch head and representative files through the GitHub connector. Report the authoritative remote SHA and any distinct local SHA caused by connector publishing.
