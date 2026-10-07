export const EXAMPLE_CONFIG = `# Jev Harness — every value below is selected independently per semantic step.
version: 1

jev:
  endpoint: https://api.typesafe.ai/v1/systemone
  apiKeyEnv: TYPESAFE_API_KEY
  model: jev-1.13.0
  timeoutMs: 5000
  retries: 2

routing:
  confidenceThreshold: 0.62
  completionThreshold: 0.84
  safetyMarginTokens: 1024
  maxSteps: 24
  maxConsecutiveRouterFailures: 2
  maxProviderFailures: 3
  maxElapsedMs: 900000
  shadow: false
  choices:
    actions: [analyze, inspect, edit, verify, recover, ask_user, finish]
    efforts: [none, minimal, low, medium, high, xhigh]
    contextTokens: [8192, 16384, 32768, 65536, 131072]
    maxOutputTokens: [1024, 2048, 4096, 8192, 16384]
    temperatures: [0, 0.2, 0.7, 1]
    toolPolicies: [none, read, write, shell]
  fallback:
    action: analyze
    target: primary/main
    effort: medium
    contextTokens: 16384
    maxOutputTokens: 4096
    temperature: 0.2
    toolPolicy: read

providers:
  primary:
    baseUrl: https://api.openai.com/v1
    api: responses
    apiKeyEnv: OPENAI_API_KEY
    timeoutMs: 120000
    headersFromEnv: {}
    extraBody: {}
    models:
      main:
        model: gpt-5
        description: Main reasoning and coding model
        contextWindow: 400000
        maxOutputTokens: 128000
        efforts: [none, minimal, low, medium, high, xhigh]
        effortMap: {}
        supportsTools: true
        temperature: false
        extraBody: {}
  local:
    baseUrl: http://127.0.0.1:11434/v1
    api: chat-completions
    timeoutMs: 120000
    headersFromEnv: {}
    extraBody: {}
    models:
      local:
        model: qwen3-coder
        description: Local OpenAI-compatible coding model
        contextWindow: 65536
        maxOutputTokens: 8192
        efforts: [none, low, medium, high]
        effortMap: {}
        supportsTools: true
        temperature:
          min: 0
          max: 2
        extraBody: {}

tools:
  enabled: [list_files, read_file, search_text, write_file, replace_in_file, run_command]
  maxPolicy: shell
  approvals:
    write: ask
    shell: ask
  safeCommandPrefixes: [git status, git diff, npm test, npm run typecheck, npm run build]
  blockedCommandPatterns:
    - '\\brm\\s+-[^\\n]*r[^\\n]*f'
    - '\\bsudo\\b'
    - '\\bgit\\s+reset\\s+--hard\\b'
    - '\\bgit\\s+clean\\s+-[^\\n]*f'
    - '\\b(curl|wget)\\b[^\\n|]*\\|'
  maxFileBytes: 1000000
  maxOutputBytes: 200000
  maxCommandTimeoutMs: 120000

receipts:
  enabled: true
  directory: .jev-harness/runs
`;
