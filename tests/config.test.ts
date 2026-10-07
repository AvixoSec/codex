import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { EXAMPLE_CONFIG } from "../src/config/example.js";
import { loadConfig } from "../src/config/load.js";
import { listTargets, parseConfig } from "../src/config/schema.js";

function validConfig() {
  return {
    version: 1,
    jev: {
      endpoint: "https://api.typesafe.ai/v1/systemone",
      apiKeyEnv: "TYPESAFE_API_KEY",
      model: "jev-1.13.0",
      timeoutMs: 3_000,
      retries: 2
    },
    routing: {
      confidenceThreshold: 0.62,
      completionThreshold: 0.84,
      safetyMarginTokens: 1_024,
      maxSteps: 20,
      maxConsecutiveRouterFailures: 2,
      maxProviderFailures: 3,
      maxElapsedMs: 600_000,
      shadow: false,
      choices: {
        actions: ["analyze", "inspect", "edit", "verify", "recover", "ask_user", "finish"],
        efforts: ["none", "low", "medium", "high"],
        contextTokens: [8_192, 32_768, 65_536],
        maxOutputTokens: [1_024, 4_096, 8_192],
        temperatures: [0, 0.2, 0.8],
        toolPolicies: ["none", "read", "write", "shell"]
      },
      fallback: {
        action: "analyze",
        target: "alpha/fast",
        effort: "low",
        contextTokens: 8_192,
        maxOutputTokens: 1_024,
        temperature: 0,
        toolPolicy: "read"
      }
    },
    providers: {
      alpha: {
        baseUrl: "https://one.example/v1",
        api: "chat-completions",
        apiKeyEnv: "ALPHA_API_KEY",
        timeoutMs: 90_000,
        headersFromEnv: { "X-Tenant": "ALPHA_TENANT" },
        extraBody: { service_tier: "auto" },
        models: {
          fast: {
            description: "Fast code and inspection model",
            contextWindow: 131_072,
            maxOutputTokens: 16_384,
            efforts: ["none", "low", "medium", "high"],
            supportsTools: true,
            temperature: { min: 0, max: 2 }
          }
        }
      },
      beta: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "responses",
        models: {
          deep: {
            description: "Local reasoning model",
            contextWindow: 65_536,
            maxOutputTokens: 8_192,
            efforts: ["low", "high"],
            effortMap: { low: "light", high: "deep" },
            supportsTools: false,
            temperature: false
          }
        }
      }
    },
    tools: {
      enabled: ["list_files", "read_file", "search_text", "write_file", "replace_in_file", "run_command"],
      maxPolicy: "shell",
      approvals: { write: "ask", shell: "ask" },
      safeCommandPrefixes: ["git status", "git diff", "npm test"],
      blockedCommandPatterns: ["\\brm\\s+-[^\\n]*r[^\\n]*f", "\\bsudo\\b"],
      maxFileBytes: 1_000_000,
      maxOutputBytes: 200_000,
      maxCommandTimeoutMs: 120_000
    },
    receipts: {
      enabled: true,
      directory: ".jev-harness/runs"
    }
  };
}

describe("configuration", () => {
  test("parses multiple base URLs and preserves independent route choices", () => {
    const config = parseConfig(validConfig());

    expect(Object.keys(config.providers)).toEqual(["alpha", "beta"]);
    expect(config.routing.choices.contextTokens).toEqual([8_192, 32_768, 65_536]);
    expect(config.routing.choices.efforts).toEqual(["none", "low", "medium", "high"]);
    expect(config.routing.fallback).toMatchObject({
      target: "alpha/fast",
      effort: "low",
      contextTokens: 8_192
    });
  });

  test("lists concrete provider/model targets without creating profiles", () => {
    const targets = listTargets(parseConfig(validConfig()));

    expect(targets.map((target) => target.id)).toEqual(["alpha/fast", "beta/deep"]);
    expect(targets[1]).toMatchObject({
      providerId: "beta",
      modelId: "deep",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "responses"
    });
  });

  test("loads strict YAML from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-config-"));
    const path = join(directory, "jev-harness.yaml");
    await writeFile(path, EXAMPLE_CONFIG, "utf8");

    const loaded = await loadConfig(path);

    expect(loaded.path).toBe(path);
    expect(loaded.config.version).toBe(1);
    expect(listTargets(loaded.config).length).toBeGreaterThan(1);
  });

  test.each([
    ["unknown fallback target", (value: ReturnType<typeof validConfig>) => {
      value.routing.fallback.target = "missing/model";
    }],
    ["fallback effort outside choices", (value: ReturnType<typeof validConfig>) => {
      value.routing.fallback.effort = "xhigh";
    }],
    ["duplicate numeric choice", (value: ReturnType<typeof validConfig>) => {
      value.routing.choices.contextTokens = [8_192, 8_192];
    }],
    ["invalid base URL", (value: ReturnType<typeof validConfig>) => {
      value.providers.alpha!.baseUrl = "one.example";
    }],
    ["negative context window", (value: ReturnType<typeof validConfig>) => {
      value.providers.alpha!.models.fast!.contextWindow = -1;
    }],
    ["unknown configuration key", (value: ReturnType<typeof validConfig>) => {
      Object.assign(value.jev, { apiKey: "must-not-be-accepted" });
    }]
  ])("rejects %s", (_name, mutate) => {
    const value = validConfig();
    mutate(value);
    expect(() => parseConfig(value)).toThrow();
  });

  test("rejects more targets than one Jev Choice supports", () => {
    const value = validConfig();
    value.providers.alpha!.models = Object.fromEntries(
      Array.from({ length: 255 }, (_, index) => [
        `model-${index}`,
        {
          description: `Model ${index}`,
          contextWindow: 16_384,
          maxOutputTokens: 2_048,
          efforts: ["low"],
          supportsTools: false,
          temperature: false
        }
      ])
    );

    expect(() => parseConfig(value)).toThrow(/255/);
  });
});
