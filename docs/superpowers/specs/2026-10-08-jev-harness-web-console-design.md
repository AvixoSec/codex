# Jev Harness Web Console Design

## Intent

Build a production-shaped local web console for the existing Jev Harness without
weakening its routing, credential, workspace, approval, or cancellation
boundaries. The console is an operator interface for one configured workspace:
it exposes sanitized realtime state, starts and controls runs, edits validated
configuration, manages referenced credentials without revealing values, and
renders durable safe history.

Success means that the existing CLI remains compatible, `jevh web` starts a
loopback-only server by default, every browser action reaches a real backend
operation, large healthy SSE streams remain ordered under backpressure, and
shutdown completes within a documented bound even when clients leave headers or
request bodies incomplete.

## Constraints and non-goals

- Node.js 20 or newer, npm, TypeScript, ESM, React, and Vite remain the selected
  platform.
- The web console extends the existing package; it does not split the repository
  into workspaces or replace the current CLI runtime.
- The server is not a multi-tenant hosted control plane. Remote binding is an
  explicit opt-in and retains all request protections.
- The UI does not receive provider credentials, resolved environment values,
  authorization headers, Jev endpoints, provider request bodies, stack traces,
  or internal error diagnostics.
- The server is a policy boundary, not an operating-system sandbox. Existing
  workspace path and tool approval protections remain authoritative.
- Worker token streaming is not added. Realtime events describe semantic steps,
  route decisions, worker lifecycle, tools, approvals, input, and run state.

## Selected architecture

The implementation is a layered extension of the current package:

1. The existing runner emits a stable public telemetry contract in addition to
   its internal receipts.
2. Browser-safe contracts, an event journal, and approval/input brokers form a
   transport-independent web runtime.
3. A run manager snapshots configuration and credentials, owns concurrency and
   cancellation, and feeds events into the journal.
4. Persistence services own configuration, credentials, and safe receipt views.
5. A Node `http` server exposes strict REST, SSE, and static-file handlers.
6. `jevh web` assembles the server and the existing harness dependencies.
7. A React/Vite client consumes only browser-safe contracts and normalized state.

This keeps routing and tool execution in one implementation while isolating all
browser-facing data projection from internal runtime objects.

## Public telemetry and DTO boundary

`RunOptions` gains optional `runId` and `onTelemetry`. A supplied run ID is
validated and used unchanged; otherwise the runner generates one as today. The
callback receives structured, sanitized events and is awaited in emission order.
The legacy lifecycle callback remains available for CLI compatibility until all
CLI rendering is migrated.

Telemetry covers:

- run accepted, started, cancellation requested, and terminal state;
- semantic step started and completed;
- route decision requested and resolved;
- worker started, completed, and failed;
- tool requested, approval requested/resolved, started, completed, and failed;
- user input requested and resolved.

Route telemetry contains public target identifiers, model identifiers, selected
action, effort, context and output budgets, temperature, tool policy,
adjustments, and provenance. Provenance is `jev`, `fallback`, or
`user_override`. Each actual Jev score is `number | null`; absent, malformed, or
unavailable scores are never represented as a synthetic zero. Fallback and
override decisions remain visibly distinct.

The public projector uses explicit allowlists. It cannot serialize a target
descriptor or error object wholesale. Telemetry, run summaries, receipts, and
bootstrap DTOs omit URLs/endpoints, credential values, API-key fields, header
maps, request bodies, stack traces, causes, and internal error messages. Public
failures use stable codes and safe operator messages. The authenticated config
editor has a separate DTO because it must edit provider base URLs and referenced
environment names; it still never returns resolved values or arbitrary headers.

## Browser-safe contracts

`src/web/contracts.ts` contains no Node imports and compiles under both the
server and browser projects. Every realtime envelope has exactly these common
fields:

```ts
interface WebRunEvent {
  schemaVersion: 1;
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  step: number;
  type: WebRunEventType;
  data: WebRunEventData;
}
```

IDs are `${runId}:${sequence}` and sequences increase once per run. Event data
is a discriminated union keyed by `type`; consumers never cast an untyped record.
REST error envelopes use `{ error: { code, message, details? } }`, where details
are schema-defined and contain no internal diagnostics.

## Event journal and realtime delivery

Each run owns a bounded `EventJournal`, limited by both event count and encoded
byte size. Limits are server constants with conservative defaults and are
covered by boundary tests. Appending assigns the next sequence and immutable
timestamp. `snapshot()` returns a consistent ordered copy and high-water mark.
`replay(afterId)` returns retained events after the cursor or an explicit reset
result when the cursor is invalid, belongs to another run, or predates retained
history. `reset()` advances the journal generation and produces a reset snapshot
without reusing sequence numbers.

SSE uses a subscribe-before-replay protocol. A subscriber first begins buffering
live events, then reads the journal snapshot, sends replay through its high-water
mark, and finally flushes buffered live events after sequence deduplication. This
prevents the gap between snapshot and subscription.

`ServerResponse.write()` returning `false` means the chunk was accepted into
Node's buffer. That event is not retried or treated as an error. The connection
enters blocked mode, subsequent event frames enter a bounded per-client FIFO,
and `drain` resumes flushing in order. Heartbeats are comments and are skipped
while blocked rather than consuming queue capacity. If the FIFO reaches either
its count or byte bound, the server closes that slow client; the journal remains
the recovery source on reconnect. A terminal event closes the response only
after that event and all earlier queued frames have drained. Tests exercise
streams large enough to produce real healthy backpressure.

`Last-Event-ID` accepts only the exact event-ID grammar. Replay either resumes
strictly after that event or emits an explicit `stream.reset` event containing a
safe current snapshot. `WebRunSnapshot` is the authoritative rebuild DTO: it
contains the current run summary, the latest resolved route, the retained
ordered event window plus its truncation flag, pending approval and input
requests, and the journal high-water event ID. A reset control event uses that
high-water ID. The client processes reset before normal sequence deduplication,
atomically replaces normalized state, sets its resume cursor to the supplied
high-water ID, and then accepts only buffered live events above that sequence.
This gives reset deterministic semantics even after history eviction. Normal
events are deduplicated by `(runId, sequence)`.

## Approval and input brokers

`ApprovalBroker` and `InputBroker` create server-generated request IDs and bind
each request to one run, one semantic step, and one pending promise. Resolution
requires the matching `runId` and request ID. Each request is single-use.

Unknown, already-resolved, expired, cancelled, terminal, and cross-run replies
receive stable conflict/not-found errors and cannot affect execution. Cancelling
or finishing a run rejects all pending broker promises and removes them. A late
approval cannot begin a mutating effect. Public approval DTOs expose a bounded
summary and policy category, not raw secret-bearing arguments.

## Run manager

The manager canonicalizes a workspace with realpath and permits one active run
per canonical workspace. `start()` allocates the run ID, reserves the workspace,
creates its journal and brokers, and returns the run summary before awaiting the
runner promise.

Every run receives an immutable deep snapshot of parsed configuration and a
new environment record containing only the referenced names and their values at
start time. Later config or credential edits affect only later runs. Snapshot
objects are not returned to the browser.

Cancellation aborts the shared controller and changes public state immediately
to cancelling. The workspace remains reserved until the runner and every tracked
mutating effect have settled. Tool execution registers write/shell effect
promises with an effect barrier so a guard race cannot release the workspace
while an old effect can still commit. The terminal state is recorded only after
that barrier settles.

The manager supports a one-shot next-step route override. Override fields are
validated against configurable choices and tagged `user_override`, then passed
through the normal resolver. Model limits, context safety margin, tool ceiling,
supported efforts, temperature support, maximum steps, elapsed deadline, and
all approval policies still apply. An override is consumed by at most one route
decision and is rejected for stale/terminal runs.

## Persistence services

### ConfigService

The service reads the configured YAML as bytes, parses it with the existing
strict Zod schema, and computes revision `sha256:<lowercase-hex>` over those exact
bytes. Validation accepts the editor DTO and returns structured Zod issues
without writing. Update requires an exact `If-Match` revision, re-reads before
commit, and returns a conflict with the current revision when it changed.

Successful updates serialize deterministic YAML, write an exclusive mode-0600
temporary file in the same directory, fsync the file, atomically rename it, and
fsync the directory where supported. Temporary files are removed on failure.
The revision check, serialization, write, fsync, and rename run inside a
per-config-path mutation queue, so two concurrent requests with the same old
revision cannot both commit. Tests race simultaneous updates with an identical
`If-Match` and require exactly one success. The active run keeps its previous
snapshot.

### CredentialService

The service derives the only permitted names from `jev.apiKeyEnv`, provider
`apiKeyEnv`, and `headersFromEnv` references in the validated config. APIs reject
all other names and return only name, required-by references, and present/absent
status—never a value, hash, length, or prefix.

Web-managed credential values are UTF-8 encoded and stored as a single logical
dotenv value with the exact marker `JEVH_MANAGED_B64_V1:` followed by canonical
RFC 4648 base64. Decoding occurs only when the complete logical value matches the
marker grammar and re-encoding produces exactly the same base64. This permits
arbitrary Unicode, quotes, equals signs, empty strings, and line separators
without heuristic decoding.

The dotenv tokenizer recognizes LF, CRLF, CR, U+2028, and U+2029 separators and
quoted multiline values. It preserves unrelated bytes, comments, ordering, and
line endings. An update replaces one unambiguous assignment or appends one using
the file's dominant separator; duplicate assignments for the target name are
rejected rather than silently rewriting an ambiguous file. All edits of the
same dotenv path, including edits to different credential names, share one
serialized mutation queue. Writes use the same atomic durability rules as
configuration.

A shared environment loader is used by web runs, existing CLI runs, and doctor.
It parses the adjacent dotenv file, decodes the managed marker only for values
originating in that file, and then fills names absent from the caller-supplied
environment. An inherited or explicitly supplied environment value therefore
keeps today's higher precedence and is never marker-decoded merely because its
literal text starts with the prefix. Tests cover managed values through all
three entry points so no provider receives the encoded marker.

### ReceiptService

Receipt listing and reads accept validated run IDs only and resolve beneath the
configured receipt directory. Browser callers cannot supply absolute paths. The
service opens with no-follow semantics where supported, compares pre-open and
post-open identity, verifies a regular file with `fstat`, enforces a byte cap,
and reads asynchronously. Symlinks, FIFOs, devices, sockets, oversized files,
and replacement races are rejected without blocking the event loop.

Records are projected through per-record allowlists into bounded public DTOs.
Raw configuration, arbitrary errors, provider payloads, tool arguments, and
secret-bearing fields never pass through. Traversal uses iterative loops rather
than argument spread or recursive variadic calls, so large nested arrays cannot
overflow the argument stack.

## HTTP API

The Node `http` server exposes:

- `GET /api/bootstrap`
- `GET /api/config`
- `POST /api/config/validate`
- `PUT /api/config` with `If-Match`
- `GET /api/credentials/status`
- `PUT /api/credentials/:name`
- `POST /api/doctor`
- `POST /api/runs`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events`
- `POST /api/runs/:runId/cancel`
- `POST /api/runs/:runId/approval`
- `POST /api/runs/:runId/input`
- `POST /api/runs/:runId/route-override`
- `GET /api/runs/:runId/receipt`

Every route has a strict Zod schema for params, query, headers, and JSON body.
Unknown body fields fail. JSON is collected incrementally with a 256 KiB byte
cap; exceeding it destroys further ingestion and returns 413 without retaining
the rest of the body.

The server compares `Host` to the exact configured authority. Browser unsafe
methods require the exact configured `Origin`; safe methods reject any present
non-matching Origin. There is no permissive CORS response. A cryptographically
random per-process token is injected into the served HTML metadata and is
required as exact `x-jev-request-token` on every API and SSE request. It is never
written to disk. Responses set a restrictive CSP, `X-Content-Type-Options:
nosniff`, no-store API caching, frame denial, and a restrictive referrer policy.

The static root is resolved once. Request paths reject NUL, backslashes,
dot-segments, encoded separators, residual encoded traversal, and double
encoding. Every served path stays under the root, traverses no symlink, opens as
a regular file, and uses a fixed MIME allowlist. SPA fallback applies only to
safe extensionless GET/HEAD navigation paths; missing assets and API paths never
fall back to HTML. HEAD returns the same headers without a body.

## Bounded shutdown

The server tracks every accepted socket and active response. `close()` stops new
connections, ends SSE streams through their ordered queues, and asks idle
connections to close. It then waits only for a configurable grace period with a
short production default. At expiry it destroys every remaining socket and
resolves after the close callback. The bound applies to incomplete request
headers, partial bodies, keep-alive connections, blocked SSE clients, and normal
requests. Raw-socket tests cover each incomplete state and assert the measured
upper bound with timing tolerance.

## CLI, build, and package delivery

`jevh web` accepts config/workspace plus bind options. Defaults are
`127.0.0.1:4317`. Any non-loopback address requires an explicit
`--allow-remote` flag; wildcard and remote binding without it fail before the
socket is opened. Startup prints the exact local URL and no credential values.

The existing Node project gets separate server and browser typecheck/build
configs. Node ESM continues to emit CLI/server declarations and source maps.
Vite builds React into `dist/web-ui` without emptying the Node output. Build
scripts run the two typechecks and builds explicitly. The published package
contains both executable names, server modules, declarations, and all UI assets.
Installed execution locates assets relative to `import.meta.url`, not cwd.

## Browser client and normalized state

The API client applies the injected request token, validates response envelopes,
and maps HTTP conflicts to typed client errors. SSE uses `fetch` plus an
incremental `text/event-stream` parser rather than native `EventSource`, because
the transport must send both `x-jev-request-token` and explicit
`Last-Event-ID` headers. The controller reconnects with the last accepted event
ID, deduplicates by run/sequence, handles explicit reset, and exposes
`connecting`, `live`, `reconnecting`, and `offline` states.

The store normalizes runs, ordered event IDs, route decisions, pending approvals,
pending input, config revision, credentials, and connection state. Reducers are
deterministic and reset-aware. Config saves send `If-Match`; 412 conflicts retain
the local draft and offer the newly fetched remote revision instead of silently
overwriting it. Approval, input, cancellation, and route override controls show
their actual pending/success/failure state.

## UI design

The responsive dashboard uses a warm cream canvas and three functional columns:

- left: connection and harness status, telemetry summary, and run history;
- centre: ordered task stream, pending approval/input cards, and task composer;
- right: a five-stage Jev decision inspector covering intent/action, target,
  effort/budgets, temperature/tools, and resolution/provenance.

A large JEV masthead shows the active model and connection state. A decision
ticker presents real route transitions. Settings edit multiple providers and
models, base URLs, effort choices, context/output choices, temperatures, and
tool policies through the real config API. A next-step override editor writes
the real one-shot override. No fake metrics, disabled decorative controls, or
placeholder cards ship.

Desktop uses the three-column layout; narrower screens collapse inspector and
history into accessible panels while keeping task controls primary. Keyboard
focus, labels, contrast, reduced motion, long text, and touch sizing are tested.
Final visual styling waits for the reference video; backend Tasks 1–7 do not.

## Testing and delivery sequence

Every task follows red-green-refactor: add a failing focused test, implement the
smallest behavior, run focused tests, then run the relevant broader suite. After
each major task an independent reviewer checks requirements, runtime regressions,
security boundaries, and tests. Critical and Important findings are fixed and
re-reviewed before commit and push.

The stages are:

1. public telemetry and DTOs;
2. browser contracts, journal, and brokers;
3. run manager, snapshots, override safety, and effect barrier;
4. config, credential, and receipt services;
5. REST/SSE/static server, backpressure, and bounded shutdown;
6. CLI command and dual build/package pipeline;
7. browser client and normalized store;
8. reference-driven responsive UI;
9. Playwright operational flows, desktop/mobile screenshots, reconnect,
   cancel/approval/input/config conflict scenarios, PowerShell documentation,
   full release verification, and final independent review.

Release verification runs focused tests, `npm run typecheck`, `npm test`, both
production builds, Playwright, CLI smoke tests, and `npm pack --dry-run`. The
final branch must be clean and pushed, and the delivered SHA must match the
remote branch.

## Compatibility and migration

Existing config version 1 and all current CLI commands remain valid. Existing
runner lifecycle consumers continue to compile during the telemetry migration.
No existing receipt is trusted as a browser DTO; old records are parsed and
projected through the new allowlist or reported as unsupported. Active runs do
not adopt mid-run config changes. The console introduces no automatic remote
binding, credential migration, or tool-policy relaxation.
