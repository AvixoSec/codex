# Jev Harness

    ╭──────────────────────────────────────────────────────────────╮
    │  Jev decides every step. Your code keeps authority.          │
    ╰──────────────────────────────────────────────────────────────╯

Jev Harness is a TypeScript CLI that asks TypeSafe Jev how to execute every
semantic agent step. It does not choose a named profile. Jev independently
selects the provider/model, reasoning effort, included context, output cap,
temperature, tool policy, and next action from values you configure.

This design follows TypeSafe's official System One contract: the harness sends
one structured state plus several independent typed questions, then uses the
returned choices, probabilities, and confidence in ordinary code. See the
[TypeSafe introduction](https://docs.typesafe.ai/introduction),
[HTTP API reference](https://docs.typesafe.ai/api), and
[confidence-gated routing pattern](https://docs.typesafe.ai/patterns/confidence-routing).

Different steps may use entirely different OpenAI-compatible base URLs:

    goal
      ↓
    Jev decision: action + target + effort + context + output + temperature + tools
      ↓
    one bounded worker step on the selected base URL
      ↓
    optional guarded tool call
      ↓
    receipt + fresh Jev decision

## Requirements

- Node.js 20 or newer
- A TypeSafe API key for live Jev decisions
- At least one OpenAI-compatible model endpoint

## 60-second start

    npm install
    npm run build
    node dist/cli.js init ./my-project
    cd my-project
    cp .env.example .env
    # Add TYPESAFE_API_KEY and provider keys to .env
    node /path/to/jev-harness/dist/cli.js doctor
    node /path/to/jev-harness/dist/cli.js run "inspect this project and fix the failing test"

For local development:

    npm run dev -- --help
    npm run dev -- init ./demo
    npm run dev -- --config ./demo/jev-harness.yaml models

## What is atomic routing?

There are no FAST, SMART, REVIEW, or other bundled profiles. The YAML exposes
independent lists:

- actions
- efforts
- contextTokens
- maxOutputTokens
- temperatures
- toolPolicies
- every provider/model target in the registry

Jev answers all questions in one batched System One request. The local resolver
then validates each field separately. If only effort has low confidence, only
effort falls back. If a model cannot use the selected temperature, temperature
is omitted while the chosen target and other valid settings remain intact.

The selected contextTokens value controls how much task history Jev Harness
includes in the next worker request. It does not change a remote model's
physical context window. The declared model contextWindow remains a hard local
ceiling, with output tokens and a safety margin reserved first. The serialized
request—including fixed instructions and tool schemas—is fitted to the selected
input budget. Tool calls and their results are retained or dropped as atomic
pairs so provider history is never malformed.

## Configuration

Run jevh init to generate a fully commented starter file, or copy
examples/jev-harness.example.yaml.

Each provider declares:

- its user-chosen ID and baseUrl;
- chat-completions or responses protocol;
- the environment variable containing its credential;
- optional headers sourced from environment variables;
- one or more model aliases and wire model names.

Each model declares:

- contextWindow and maxOutputTokens;
- normalized efforts it supports;
- an optional effortMap for provider-specific wire values;
- tool and temperature support;
- static extraBody values.

Harness-controlled fields always overwrite extraBody. A config cannot use
extraBody to replace the selected model, messages, input, tools, effort, or
output limit.

## Commands

    jevh init [directory]
    jevh validate [file]
    jevh doctor [--online] [--workspace PATH]
    jevh models
    jevh run TASK... [--workspace PATH] [--max-steps N] [--shadow] [--yes]
    jevh replay RUN_ID_OR_PATH

Global flags:

    --config PATH    Use an explicit YAML file
    --json           Emit exactly one versioned JSON document
    --no-color       Disable ANSI colors
    --quiet          Hide progress events

Config discovery order is: --config, JEV_HARNESS_CONFIG, then the nearest
jev-harness.yaml while walking toward the filesystem root.

Both `doctor` and `run` load `.env` next to the resolved configuration without
overwriting variables already present in the process environment.

### Normal mode

Jev decisions are validated and executed. Human-readable progress goes to
stderr; the final worker answer goes to stdout.

### Shadow mode

Jev proposals are written to receipts, but every execution coordinate uses the
configured fallback. Because the fallback action is authoritative too, shadow
mode is deliberately non-authoritative and ends at a configured limit or
error; it never accepts Jev's proposed finish as completed.

### JSON mode

JSON mode emits one object to stdout and suppresses progress output:

    {
      "schemaVersion": 1,
      "ok": true,
      "command": "run",
      "data": {
        "runId": "run_...",
        "status": "completed",
        "finalText": "...",
        "steps": 4
      }
    }

## Safety model

Jev and worker models are untrusted planners. They cannot directly:

- invent a base URL or model outside the registry;
- raise context/output/tool limits;
- read credentials;
- approve a tool;
- write outside the selected workspace;
- bypass blocked command patterns.

Read-only tools can run automatically. Writes and shell commands use ask,
allow, or deny policy. Noninteractive ask fails closed. Automatic shell
execution additionally requires a configured safe command prefix. The --yes
flag never bypasses blocked-command patterns.

Filesystem operations reject absolute paths, traversal, prefix collisions, and
resolved symlink escapes. Writes validate the nearest existing parent and use
an atomic temporary-file rename.

Important: command policy is not an operating-system sandbox. An approved
run_command process has the CLI user's host privileges. Use a container, VM, or
another real sandbox for hostile repositories. The harness strips API keys and
most environment variables from child processes, but that is not equivalent to
OS isolation.

## Receipts

Runs write append-only JSONL under .jev-harness/runs by default. A receipt
contains:

- proposed and resolved atomic route values;
- confidence and every adjustment;
- selected base URL/model and API surface;
- estimated context and reported usage;
- tool intent and result;
- terminal status.

Authorization headers, sensitive key names, and known credential values are
redacted before the write. Receipts can still contain source snippets, prompts,
tool arguments, and model outputs. Treat them as private project data.

Replay is read-only:

    jevh replay run_123
    jevh replay .jev-harness/runs/run_123.jsonl

It never calls Jev, a model provider, or a tool.

## Reliability

- Jev retries only transient network, 429, 5xx, and 529 failures with bounded
  backoff.
- Worker requests use bounded retries and never automatically replay a local
  tool effect.
- Repeated router/provider failures stop the loop.
- Step and elapsed-time limits are enforced locally.
- One deadline signal covers Jev, worker, approval, tool, and user-input waits;
  no later phase starts after the elapsed limit.
- Unknown, malformed, or duplicated tool calls are converted to failed tool
  results and never executed.
- The router snapshot contains bounded excerpts labeled as untrusted content.

## Development

    npm install
    npm test
    npm run typecheck
    npm run build

The suite includes unit tests for configuration, routing, context selection,
both provider transports, path/approval policy, receipts, the agent loop and
CLI, plus a mock HTTP end-to-end rerouting scenario.

## Scope

This release intentionally focuses on one excellent CLI control loop. It is not
a gateway daemon, web dashboard, model marketplace, or OS sandbox.

## License

MIT
