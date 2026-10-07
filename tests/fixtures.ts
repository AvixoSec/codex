import { parseConfig } from "../src/config/schema.js";

export function testConfig() {
  return parseConfig({
    version: 1,
    jev: {
      endpoint: "https://jev.example/v1/systemone",
      apiKeyEnv: "TEST_JEV_KEY",
      model: "jev-test",
      timeoutMs: 1_000,
      retries: 2
    },
    routing: {
      confidenceThreshold: 0.6,
      completionThreshold: 0.8,
      safetyMarginTokens: 1_000,
      maxSteps: 12,
      maxConsecutiveRouterFailures: 2,
      maxProviderFailures: 2,
      maxElapsedMs: 60_000,
      shadow: false,
      choices: {
        actions: ["analyze", "inspect", "edit", "verify", "recover", "ask_user", "finish"],
        efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
        contextTokens: [4_000, 8_000, 16_000, 32_000],
        maxOutputTokens: [1_000, 4_000, 8_000],
        temperatures: [0, 0.2, 0.8],
        toolPolicies: ["none", "read", "write", "shell"]
      },
      fallback: {
        action: "analyze",
        target: "alpha/fast",
        effort: "low",
        contextTokens: 8_000,
        maxOutputTokens: 1_000,
        temperature: 0.2,
        toolPolicy: "read"
      }
    },
    providers: {
      alpha: {
        baseUrl: "https://alpha.example/v1",
        api: "chat-completions",
        apiKeyEnv: "ALPHA_KEY",
        timeoutMs: 2_000,
        headersFromEnv: {},
        extraBody: {},
        models: {
          fast: {
            model: "fast-wire",
            description: "Fast model",
            contextWindow: 32_000,
            maxOutputTokens: 8_000,
            efforts: ["none", "low", "medium"],
            effortMap: {},
            supportsTools: true,
            temperature: { min: 0, max: 1 },
            extraBody: {}
          }
        }
      },
      beta: {
        baseUrl: "https://beta.example/api",
        api: "responses",
        apiKeyEnv: "BETA_KEY",
        timeoutMs: 2_000,
        headersFromEnv: {},
        extraBody: {},
        models: {
          deep: {
            model: "deep-wire",
            description: "Deep model without tools or temperature",
            contextWindow: 12_000,
            maxOutputTokens: 6_000,
            efforts: ["low", "high"],
            effortMap: { high: "deep" },
            supportsTools: false,
            temperature: false,
            extraBody: {}
          }
        }
      }
    },
    tools: {
      enabled: ["list_files", "read_file", "search_text", "write_file", "replace_in_file", "run_command"],
      maxPolicy: "write",
      approvals: { write: "ask", shell: "ask" },
      safeCommandPrefixes: ["npm test"],
      blockedCommandPatterns: ["\\bsudo\\b"],
      maxFileBytes: 100_000,
      maxOutputBytes: 20_000,
      maxCommandTimeoutMs: 5_000
    },
    receipts: { enabled: true, directory: ".jev-harness/runs" }
  });
}
