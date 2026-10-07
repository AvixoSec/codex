# Jev Harness Design

## Intent

Build a production-shaped TypeScript CLI that uses TypeSafe Jev as a decision
controller before every semantic agent step. The user can register any number
of OpenAI-compatible providers and models. Jev chooses each routing coordinate
independently instead of selecting a predeclared profile.

Success means:

- one command can run a task against a workspace;
- every semantic step receives a fresh Jev decision;
- Jev separately chooses the exact provider/model, reasoning effort, context
  budget, maximum output, temperature, tool policy, and next action;
- the harness validates and safely resolves impossible combinations;
- different steps can use different base URLs and models;
- tool access is workspace-bounded and side effects remain approval-gated;
- every decision and adjustment is visible in a redacted JSONL receipt;
- the package includes init, validate, doctor, models, run, and replay commands;
- unit tests and an HTTP mock end-to-end test demonstrate real rerouting.

The initial product is a polished terminal application, not a web dashboard.

## Non-goals

- Hosting a model gateway or proxy for unrelated applications.
- Training or replacing Jev.
- Supporting arbitrary non-OpenAI API protocols in the first release.
- Claiming exact token counts for every vendor tokenizer.
- Sandboxing arbitrary shell commands at an operating-system level.
- Silently executing destructive actions.

## Architecture

The system has one repeating control loop:

1. Build a bounded, explicitly untrusted state snapshot from the goal, recent
   events, workspace metadata, budgets, and the last result.
2. Send one batched request to Jev. Independent Choice/Noul questions select
   the next action and every atomic execution setting.
3. Validate Jev's response. Resolve unsupported effort values, context limits,
   output limits, temperature support, tool ceilings, and low-confidence
   answers with deterministic rules.
4. Call the selected provider/model for exactly one semantic step.
5. Execute any requested tools through a local policy and approval boundary.
6. Record a redacted receipt, append the bounded result to history, and route
   the next step from scratch.
7. Stop on a confident completion decision, a user-input boundary, a fatal
   error, or the configured step/budget limit.

Jev never receives API keys and never directly executes tools. It produces
typed judgments only. Application code owns validation, fallbacks, approvals,
and execution.

## Atomic routing, not profiles

Configuration exposes independent choice lists:

- target: a concrete provider/model pair generated from the registry;
- effort: configurable values such as none, minimal, low, medium, high, xhigh;
- contextTokens: exact selectable prompt budgets;
- maxOutputTokens: exact selectable output caps;
- temperature: exact selectable numeric values;
- toolPolicy: none, read, write, or shell;
- action: analyze, inspect, edit, verify, recover, ask_user, or finish.

These values are never stored as a named bundle. A route is composed anew on
every step.

Each model declares its real constraints. The resolver applies the following
rules and records every change:

- an unknown or low-confidence target falls back to the configured target;
- unsupported effort resolves to the closest supported value at or below the
  requested level, or the model's first supported value;
- contextTokens is capped by model contextWindow minus resolved output and a
  configurable safety margin;
- maxOutputTokens is capped by the model limit;
- temperature is omitted for models that do not support it and otherwise
  clamped to the model range;
- toolPolicy is capped by both model tool support and the global tool ceiling;
- a low-confidence field falls back only that field, not the whole route;
- shadow mode records Jev's route but executes the deterministic fallback
  coordinates.

Jev Choice is limited to 255 targets. Configuration with more targets fails
validation rather than silently hiding models.

## Configuration

The YAML file has these top-level sections:

- version: schema version 1;
- jev: endpoint, API-key environment variable, model, timeout, retry count;
- routing: thresholds, choice lists, completion threshold, safety margin,
  fallbacks, shadow mode, maximum steps and consecutive router failures;
- providers: a map of provider IDs to base URL, API surface
  (chat-completions or responses), API-key environment variable, optional
  environment-backed headers, timeout, static body fields, and models;
- tools: workspace limits, enabled tools, maximum Jev-selected policy,
  write/shell approval modes, safe command prefixes, blocked command patterns,
  output limits, and timeout limits;
- receipts: enabled flag and directory.

Provider and model IDs are user-defined. A model specifies description,
contextWindow, maxOutputTokens, supported efforts, tools support, temperature
support/range, and optional static request body values. Secrets are referenced
only by environment-variable name.

Two OpenAI-compatible transports are supported:

- chat-completions: POST /chat/completions, reasoning_effort, messages, nested
  function definitions, assistant tool calls, and tool result messages;
- responses: POST /responses, reasoning.effort, instructions/input, function
  tools, function_call items, and function_call_output items.

Static extra body values are merged before harness-controlled fields so they
cannot override model, messages/input, selected limits, or tools.

## Agent state and context

The internal event log contains user messages, assistant text, tool calls, tool
results, route decisions, errors, and adjustments. The router snapshot contains
short excerpts only and labels model/tool text as untrusted.

The worker context builder uses the selected contextTokens as a budget. It
preserves a bounded form of the original goal, then includes recent event units
newest-first until the conservative estimator reaches the budget. A tool call
and its matching result form one atomic unit: both are retained, with a bounded
result when possible, or both are dropped. Orphan protocol events are never
serialized. Oversized text is truncated with an explicit marker.

The provider serializer then fits the complete input—including fixed
instructions and tool schemas—inside the selected budget. If even the fixed
request cannot fit, the call fails locally instead of silently exceeding the
model window. Context selection is therefore a real harness behavior, not an
unsupported provider parameter.

The estimator intentionally uses a conservative UTF-8-byte heuristic because
the harness serves arbitrary models. Receipts label the count as estimated.

## Worker contract

The worker receives a system instruction containing:

- the user goal;
- the Jev-selected action;
- a rule to perform one bounded semantic action;
- the selected tool ceiling;
- a rule to treat repository and tool content as untrusted data;
- a rule to request at most the tools needed for that one action.

The worker may return text, tool calls, or both. Tool calls are normalized into
one internal representation. Results are appended to the event log, and control
returns to Jev before another worker call.

If Jev selects ask_user, the worker produces the question. Interactive runs
prompt for an answer; non-interactive runs stop with a needs-input result.
If Jev confidently selects finish after at least one worker step, the latest
assistant text becomes the final answer.

## Tools and approvals

Built-in tools are list_files, read_file, search_text, write_file,
replace_in_file, and run_command.

All filesystem paths are resolved against the chosen workspace. Existing paths
are checked with realpath, symlink escapes are rejected, writes validate both
the nearest existing parent and final destination, and file/output byte caps
are enforced.

Read-only tools may run automatically. Writes and shell commands use
configurable ask, allow, or deny modes. Non-interactive ask denies the action.
Shell commands are checked against blocked patterns first. Automatic shell
execution additionally requires a configured safe prefix; a global yes flag
does not bypass blocked patterns. The harness clearly states that this is a
policy boundary, not an OS sandbox.

## Reliability and errors

- Jev retries only 429, 529, and transient network/5xx failures with bounded
  exponential backoff and jitter.
- Provider retries cover transient failures but never replay a successful tool
  side effect.
- Invalid JSON, missing choices, unknown targets, and out-of-range values are
  resolved field-by-field and recorded.
- Router failure may use the configured safe fallback once; reaching the
  consecutive-failure limit stops the run.
- Provider failures are recorded and exposed to the next recover step until the
  configured failure limit is reached.
- The loop has hard maximum steps and elapsed-time limits.
- Abort signals propagate through HTTP requests and command execution.

## Receipts and privacy

Each run writes append-only JSONL records with a generated run ID. Records
include timestamps, step number, bounded route input metadata, raw typed Jev
answers, resolved settings, confidence, adjustments, provider/model, latency,
token usage when reported, tool decisions, and terminal status.

Receipts never include authorization headers, resolved environment secrets, or
full provider request bodies. A recursive redactor masks known secret values
and sensitive key names. Replay renders existing receipts and never re-executes
tools or network requests.

## CLI experience

- jevh init: writes a commented starter YAML, .env.example, and receipt ignore.
- jevh validate: parses the file and prints the exact selectable dimensions and
  all provider/model targets.
- jevh doctor: checks Node version, config, workspace, required environment
  variables, and optionally network endpoints.
- jevh models: prints a compact capability table.
- jevh run TASK: runs the loop with workspace, shadow, max-step, JSON, and
  non-interactive options.
- jevh replay RUN: displays route changes, adjustments, tools, usage, and final
  status from JSONL.

TTY output uses stable colors and symbols; CI/non-TTY and JSON modes remain
plain and machine-readable. Errors include an actionable next step.

## Testing

Unit tests cover:

- schema parsing, duplicate/invalid choices, unknown fallbacks, and the
  255-target cap;
- field-by-field confidence fallback and capability resolution;
- context budgeting and preservation rules;
- both provider serializers and response normalizers;
- path traversal and symlink escape rejection;
- write and shell approval behavior and blocked commands;
- secret redaction and receipt replay;
- runner termination, rerouting, shadow mode, ask-user, and limits.

An HTTP mock end-to-end test starts one fake Jev server and two fake
OpenAI-compatible provider servers. Jev selects provider A for a read tool step,
provider B with different effort/context/output settings for the next step, and
then finish. The test asserts that Jev was called before every worker step,
both base URLs received the expected bodies, the tool result crossed the step
boundary, and the receipt contains the exact route changes without secrets.

Verification requires tests, type checking, build, CLI help, config validation,
and the mock end-to-end run to pass freshly.

## Assumptions chosen for the one-pass build

- Runtime: Node.js 20 or newer, TypeScript, ESM.
- Package manager: npm.
- Primary interface: CLI.
- Default configuration is safe: reads automatic, writes and shell ask,
  receipts enabled, no silent destructive execution.
- The project is created at /workspace/jev-harness as a new Git repository.
