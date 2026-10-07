import { describe, expect, test, vi } from "vitest";

import { JevHttpClient } from "../src/router/jev-client.js";
import { buildQuestions } from "../src/router/questions.js";
import { resolveRoute, type RawRouteDecision } from "../src/router/resolve.js";
import { testConfig } from "./fixtures.js";

function choice(value: string, confidence = 0.95) {
  return { value, confidence, probabilities: { [value]: 0.95 } };
}

function raw(overrides: Partial<RawRouteDecision> = {}): RawRouteDecision {
  return {
    action: choice("edit"),
    target: choice("beta/deep"),
    effort: choice("high"),
    contextTokens: choice("16000"),
    maxOutputTokens: choice("8000"),
    temperature: choice("0.8"),
    toolPolicy: choice("shell"),
    completionProbability: 0.1,
    model: "jev-1.13.0",
    usage: { inputTokens: 300, outputTokens: 40 },
    errors: {},
    ...overrides
  };
}

describe("Jev questions", () => {
  test("batches every atomic route coordinate into one question map", () => {
    const questions = buildQuestions(testConfig());

    expect(Object.keys(questions)).toEqual([
      "action",
      "target",
      "effort",
      "context_tokens",
      "max_output_tokens",
      "temperature",
      "tool_policy",
      "is_complete"
    ]);
    expect(questions.target).toMatchObject({
      type: "choice",
      criteria: {
        "alpha/fast": expect.stringContaining("Fast model"),
        "beta/deep": expect.stringContaining("Deep model")
      }
    });
    expect(questions.context_tokens).toMatchObject({
      criteria: { "4000": expect.any(String), "32000": expect.any(String) }
    });
  });

  test("posts the documented System One shape and retries a transient response", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":"busy"}', { status: 529 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          action: { type: "choice", choice: "inspect", probabilities: { inspect: 1 }, confidence: 0.99 },
          target: { type: "choice", choice: "alpha/fast", probabilities: { "alpha/fast": 1 }, confidence: 0.98 },
          effort: { type: "choice", choice: "medium", probabilities: { medium: 1 }, confidence: 0.97 },
          context_tokens: { type: "choice", choice: "8000", probabilities: { "8000": 1 }, confidence: 0.96 },
          max_output_tokens: { type: "choice", choice: "4000", probabilities: { "4000": 1 }, confidence: 0.95 },
          temperature: { type: "choice", choice: "0.2", probabilities: { "0.2": 1 }, confidence: 0.94 },
          tool_policy: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 0.93 },
          is_complete: { type: "noul", noul: 0.2 }
        },
        usage: { input_tokens: 321, output_tokens: 22 }
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const sleep = vi.fn(async () => undefined);
    const client = new JevHttpClient(testConfig(), {
      env: { TEST_JEV_KEY: "secret-key" },
      fetch: fetcher,
      sleep,
      random: () => 0
    });

    const decision = await client.decide({ goal: "Inspect the project", step: 1 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    const [, request] = fetcher.mock.calls[1]!;
    expect(request?.headers).toMatchObject({ Authorization: "Bearer secret-key" });
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      state: { goal: "Inspect the project", step: 1 },
      model: "jev-test",
      questions: { action: { type: "choice" }, is_complete: { type: "noul" } }
    });
    expect(decision).toMatchObject({
      action: { value: "inspect", confidence: 0.99 },
      target: { value: "alpha/fast" },
      contextTokens: { value: "8000" },
      completionProbability: 0.2,
      usage: { inputTokens: 321, outputTokens: 22 }
    });
  });

  test("marks one malformed answer without discarding valid sibling answers", async () => {
    const answers = {
      action: { type: "choice", choice: "inspect", probabilities: { inspect: 1 }, confidence: 0.9 },
      target: { type: "choice", choice: "alpha/fast", probabilities: { "alpha/fast": 1 }, confidence: 0.9 },
      effort: { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: 4 },
      context_tokens: { type: "choice", choice: "8000", probabilities: { "8000": 1 }, confidence: 0.9 },
      max_output_tokens: { type: "choice", choice: "4000", probabilities: { "4000": 1 }, confidence: 0.9 },
      temperature: { type: "choice", choice: "0.2", probabilities: { "0.2": 1 }, confidence: 0.9 },
      tool_policy: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 0.9 },
      is_complete: { type: "noul", noul: 0.1 }
    };
    const client = new JevHttpClient(testConfig(), {
      env: { TEST_JEV_KEY: "secret" },
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        model: "jev-test",
        answers,
        usage: { input_tokens: 1, output_tokens: 1 }
      }), { status: 200 })),
      sleep: async () => undefined,
      random: () => 0
    });

    const decision = await client.decide({ goal: "x" });

    expect(decision.action?.value).toBe("inspect");
    expect(decision.effort).toBeUndefined();
    expect(decision.errors.effort).toMatch(/confidence/);
  });
});

describe("atomic route resolution", () => {
  test("resolves each coordinate against only the selected model capabilities", () => {
    const route = resolveRoute(raw(), testConfig());

    expect(route.target.id).toBe("beta/deep");
    expect(route.action).toBe("edit");
    expect(route.effort).toBe("high");
    expect(route.wireEffort).toBe("deep");
    expect(route.maxOutputTokens).toBe(6_000);
    expect(route.contextTokens).toBe(5_000);
    expect(route.temperature).toBeUndefined();
    expect(route.toolPolicy).toBe("none");
    expect(route.adjustments.map((item) => item.field)).toEqual(
      expect.arrayContaining(["maxOutputTokens", "contextTokens", "temperature", "toolPolicy"])
    );
  });

  test("falls back only a low-confidence field", () => {
    const route = resolveRoute(raw({ effort: choice("high", 0.2) }), testConfig());

    expect(route.target.id).toBe("beta/deep");
    expect(route.action).toBe("edit");
    expect(route.effort).toBe("low");
    expect(route.contextTokens).toBe(5_000);
    expect(route.adjustments).toContainEqual(expect.objectContaining({
      field: "effort",
      reason: "low_confidence"
    }));
  });

  test("uses the nearest supported effort at or below a requested level", () => {
    const route = resolveRoute(raw({
      target: choice("alpha/fast"),
      effort: choice("xhigh"),
      contextTokens: choice("8000"),
      maxOutputTokens: choice("1000"),
      toolPolicy: choice("read")
    }), testConfig());

    expect(route.effort).toBe("medium");
    expect(route.adjustments).toContainEqual(expect.objectContaining({
      field: "effort",
      reason: "unsupported_by_model"
    }));
  });

  test("falls back an unknown answer instead of accepting invented coordinates", () => {
    const route = resolveRoute(raw({
      target: choice("attacker/imaginary"),
      action: choice("erase_everything")
    }), testConfig());

    expect(route.target.id).toBe("alpha/fast");
    expect(route.action).toBe("analyze");
    expect(route.adjustments).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "target", reason: "not_offered" }),
      expect.objectContaining({ field: "action", reason: "not_offered" })
    ]));
  });

  test("caps tool policy at the configured ceiling independently", () => {
    const route = resolveRoute(raw({
      target: choice("alpha/fast"),
      effort: choice("medium"),
      contextTokens: choice("8000"),
      maxOutputTokens: choice("1000"),
      temperature: choice("0.8"),
      toolPolicy: choice("shell")
    }), testConfig());

    expect(route.toolPolicy).toBe("write");
    expect(route.temperature).toBe(0.8);
  });

  test("shadow mode executes all explicit fallback coordinates while retaining proposed values", () => {
    const route = resolveRoute(raw(), testConfig(), true);

    expect(route.shadow).toBe(true);
    expect(route.proposed).toMatchObject({
      target: "beta/deep",
      effort: "high",
      contextTokens: 16_000,
      maxOutputTokens: 8_000,
      temperature: 0.8,
      toolPolicy: "shell"
    });
    expect(route.target.id).toBe("alpha/fast");
    expect(route.action).toBe("analyze");
    expect(route.effort).toBe("low");
    expect(route.contextTokens).toBe(8_000);
    expect(route.maxOutputTokens).toBe(1_000);
    expect(route.temperature).toBe(0.2);
    expect(route.toolPolicy).toBe("read");
  });

  test("requires both finish action and completion probability to finish", () => {
    const yes = resolveRoute(raw({
      action: choice("finish"),
      completionProbability: 0.91
    }), testConfig());
    const no = resolveRoute(raw({
      action: choice("finish"),
      completionProbability: 0.5
    }), testConfig());

    expect(yes.complete).toBe(true);
    expect(no.complete).toBe(false);
  });
});
