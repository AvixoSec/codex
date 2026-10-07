# Jev Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a polished TypeScript CLI where Jev independently selects every execution setting before each semantic agent step across arbitrary OpenAI-compatible providers.

**Architecture:** A strict local policy kernel loads a YAML registry, sends one batched typed decision request to Jev, resolves each atomic answer against model capabilities, executes one worker step through a provider adapter, brokers bounded tools, writes a redacted receipt, and routes again. The core uses injected clients so routing, execution, and safety behavior are testable without live credentials.

**Tech Stack:** Node.js 20+, TypeScript ESM, npm, Zod, YAML, Commander, Chalk, dotenv, Vitest.

**Spec:** docs/superpowers/specs/2026-10-08-jev-harness-design.md

## Global Constraints

- No named or implicit execution profiles; route coordinates are selected and resolved independently.
- Support any number of configured providers/models up to Jev Choice's 255-target limit.
- Support OpenAI-compatible chat-completions and responses transports.
- Keep credentials in environment variables and out of prompts, terminal output, and receipts.
- Route every semantic worker step through Jev; return to Jev after tool execution.
- Default to automatic reads and approval-gated writes/shell commands.
- Node.js 20 or newer, TypeScript ESM, npm.
- Receipts are append-only JSONL and replay never performs effects.

## Review Focus

- A low-confidence or malformed field must reduce capability independently, never inherit another field's unsafe selection; covered in Task 2 policy tests.
- A selected context/output pair near a model limit must retain a positive safety margin and never create a negative input budget; covered in Task 2 boundary tests.
- A path using traversal, prefix collision, or a symlinked parent must not leave the workspace; covered in Task 4 path tests.
- A command with control characters, a blocked destructive form, or a non-allowlisted prefix must not auto-execute; covered in Task 4 approval tests.
- A provider response with unknown tools, invalid JSON arguments, or duplicated call IDs must not execute any effect; covered in Task 3 normalization and Task 5 runner tests.

---

### Task 1: Project foundation and validated registry

**Files:**
- Create: package.json, tsconfig.json, vitest.config.ts, .gitignore
- Create: src/core/types.ts
- Create: src/config/schema.ts
- Create: src/config/load.ts
- Create: src/config/example.ts
- Test: tests/config.test.ts

**Interfaces:**
- Produces: HarnessConfig, ProviderConfig, ModelConfig, RouteChoices, RouteFallback, loadConfig(path, env), parseConfig(value), listTargets(config), EXAMPLE_CONFIG.
- Consumes: none.

- [ ] Write failing tests for a multi-base configuration, environment references, exact atomic choices, invalid fallback coordinates, duplicate choice values, invalid URLs/numbers, and more than 255 targets.
- [ ] Run npm test -- tests/config.test.ts and verify the missing-module failure.
- [ ] Add the package/build configuration and minimal schema/loader implementation.
- [ ] Run the focused test and verify all configuration cases pass.
- [ ] Commit the task.

### Task 2: Jev client, batched questions, and atomic route resolver

**Files:**
- Create: src/router/questions.ts
- Create: src/router/jev-client.ts
- Create: src/router/resolve.ts
- Test: tests/router.test.ts

**Interfaces:**
- Consumes: HarnessConfig, ModelConfig, listTargets.
- Produces: DecisionClient.decide(snapshot), buildQuestions(config), JevHttpClient, RawRouteDecision, ResolvedRoute, resolveRoute(raw, config, shadow), RouteAdjustment.

- [ ] Write failing tests asserting one request contains action, target, effort, contextTokens, maxOutputTokens, temperature, toolPolicy, and completion questions.
- [ ] Add failing resolver tests for per-field confidence fallback, unsupported effort downgrade, context/output safety bounds, temperature omission, tool ceiling, invalid Jev values, shadow mode, and target cap.
- [ ] Run npm test -- tests/router.test.ts and verify failures name the missing router modules.
- [ ] Implement strict Jev response parsing, bounded retry behavior, and deterministic field-by-field resolution.
- [ ] Run the focused test and verify all router cases pass.
- [ ] Commit the task.

### Task 3: Context builder and OpenAI-compatible worker adapters

**Files:**
- Create: src/context/budget.ts
- Create: src/providers/http.ts
- Create: src/providers/chat-completions.ts
- Create: src/providers/responses.ts
- Create: src/providers/worker-client.ts
- Test: tests/context.test.ts
- Test: tests/providers.test.ts

**Interfaces:**
- Consumes: ResolvedRoute, ProviderConfig, ModelConfig, AgentEvent.
- Produces: buildContext(goal, events, tokenBudget), estimateTokens(value), WorkerClient.execute(input), normalize chat/responses outputs into WorkerResult and ToolCall.

- [ ] Write failing context tests for goal/latest preservation, newest-first inclusion, explicit truncation, multilingual byte estimates, and tiny budgets.
- [ ] Write failing adapter tests for exact effort/output/temperature fields, protected body keys, tool schemas, normalized text/tool calls, usage, invalid arguments, duplicate call IDs, and abort/HTTP errors.
- [ ] Run both focused test files and verify missing-module failures.
- [ ] Implement the context builder, bounded HTTP helper, both serializers/normalizers, and registry-dispatched worker client.
- [ ] Run both focused tests and verify they pass.
- [ ] Commit the task.

### Task 4: Workspace tools, approvals, redaction, and receipts

**Files:**
- Create: src/tools/definitions.ts
- Create: src/tools/path-policy.ts
- Create: src/tools/approval.ts
- Create: src/tools/executor.ts
- Create: src/receipts/redact.ts
- Create: src/receipts/store.ts
- Test: tests/tools.test.ts
- Test: tests/receipts.test.ts

**Interfaces:**
- Consumes: ToolCall, HarnessConfig.
- Produces: toolDefinitions(policy), PathPolicy, ApprovalHandler, ToolExecutor.execute(call, context), redact(value, secrets), ReceiptStore.append/read/resolveRun.

- [ ] Write failing path tests for traversal, absolute paths, workspace-prefix collision, symlink escape, missing-parent writes, byte limits, and valid nested files.
- [ ] Write failing approval tests for read/write/shell policies, noninteractive ask, blocked commands, safe-prefix auto execution, control characters, timeout, and output truncation.
- [ ] Write failing receipt tests for recursive sensitive-key/value redaction, secret substrings, append/read ordering, permissions, and replay resolution.
- [ ] Run the focused files and verify missing-module failures.
- [ ] Implement filesystem tools without shelling out, guarded command execution, interactive injection points, and JSONL receipts.
- [ ] Run the focused tests and verify they pass.
- [ ] Commit the task.

### Task 5: Re-routing agent loop

**Files:**
- Create: src/core/snapshot.ts
- Create: src/core/runner.ts
- Test: tests/runner.test.ts

**Interfaces:**
- Consumes: DecisionClient, resolveRoute, WorkerClient, ToolExecutor, ReceiptStore, buildContext.
- Produces: HarnessRunner.run(options) returning RunResult with completed, needs_input, limit, or failed status; calls callbacks for route, worker, tool, and status events.

- [ ] Write failing tests for Jev-before-every-worker ordering, target changes between steps, returning to Jev after a tool result, finish gating, ask-user behavior, shadow mode, max steps, repeated router failure, provider recovery, unknown/duplicate tools, and abort.
- [ ] Run npm test -- tests/runner.test.ts and verify missing-module failures.
- [ ] Implement the bounded event loop and terminal-state rules, with pre/post receipts around effects.
- [ ] Run the focused test and verify all loop cases pass.
- [ ] Commit the task.

### Task 6: Polished CLI, onboarding, and documentation

**Files:**
- Create: src/ui/console.ts
- Create: src/commands/init.ts
- Create: src/commands/validate.ts
- Create: src/commands/doctor.ts
- Create: src/commands/models.ts
- Create: src/commands/run.ts
- Create: src/commands/replay.ts
- Create: src/cli.ts
- Create: README.md
- Create: examples/jev-harness.example.yaml
- Test: tests/cli.test.ts

**Interfaces:**
- Consumes: all public core interfaces.
- Produces: jevh executable with init, validate, doctor, models, run, and replay commands; createProgram(deps) for CLI tests.

- [ ] Write failing CLI tests for help, safe init/no-overwrite, validate summary, missing-secret doctor result, models table, JSON run output, and receipt replay.
- [ ] Run npm test -- tests/cli.test.ts and verify missing-module failures.
- [ ] Implement commands, stable non-TTY output, colored TTY events, actionable errors, example configuration, and README quickstart/configuration/security notes.
- [ ] Run the focused test and verify it passes.
- [ ] Commit the task.

### Task 7: HTTP end-to-end rerouting and release verification

**Files:**
- Create: tests/e2e.test.ts
- Modify: package.json
- Modify: README.md

**Interfaces:**
- Consumes: public CLI/core, Jev HTTP client, both provider transports.
- Produces: a deterministic mock-network proof that two base URLs and atomic settings are selected across semantic steps.

- [ ] Write the end-to-end test with one mock Jev server and two provider servers: provider A requests a read tool, provider B receives its result and returns final text, and Jev then selects finish.
- [ ] Run npm test -- tests/e2e.test.ts and verify it fails before any necessary integration corrections.
- [ ] Make only the integration corrections required by the test.
- [ ] Run npm test, npm run typecheck, npm run build, CLI help, example validation, and doctor; verify every command exits as documented.
- [ ] Commit the task.

## Completion contract

- All focused RED→GREEN cycles were observed.
- The full Vitest suite passes with the HTTP end-to-end scenario.
- TypeScript type checking and production build pass.
- The built CLI prints help and validates the shipped example.
- README documents that contextTokens controls included context, not a remote
  model's physical window, and that shell policy is not an OS sandbox.
- A fresh independent reviewer checks the whole branch; Critical and Important
  findings receive one test-backed fix pass.
