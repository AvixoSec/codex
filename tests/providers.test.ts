import { describe, expect, test, vi } from "vitest";

import type { ToolDefinition } from "../src/core/types.js";
import {
  buildChatCompletionsRequest,
  parseChatCompletionsResponse
} from "../src/providers/chat-completions.js";
import {
  buildResponsesRequest,
  parseResponsesResponse
} from "../src/providers/responses.js";
import { OpenAICompatibleWorkerClient } from "../src/providers/worker-client.js";
import { resolveRoute, type RawRouteDecision } from "../src/router/resolve.js";
import { testConfig } from "./fixtures.js";

const tools: ToolDefinition[] = [{
  name: "read_file",
  description: "Read a workspace file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false
  },
  minimumPolicy: "read"
}];

function choice(value: string) {
  return { value, confidence: 0.99, probabilities: { [value]: 1 } };
}

function route(target = "alpha/fast") {
  const raw: RawRouteDecision = {
    action: choice("inspect"),
    target: choice(target),
    effort: choice(target === "beta/deep" ? "high" : "medium"),
    contextTokens: choice(target === "beta/deep" ? "4000" : "8000"),
    maxOutputTokens: choice("4000"),
    temperature: choice("0.8"),
    toolPolicy: choice("read"),
    completionProbability: 0,
    errors: {}
  };
  return resolveRoute(raw, testConfig());
}

const context = {
  goal: "Inspect src/index.ts",
  events: [
    { type: "assistant_text" as const, content: "I will inspect it.", step: 1 },
    { type: "tool_call" as const, id: "old-call", name: "read_file", arguments: { path: "README.md" }, step: 1 },
    { type: "tool_result" as const, callId: "old-call", name: "read_file", content: "readme", ok: true, step: 1 }
  ],
  estimatedTokens: 30,
  truncated: false
};

describe("chat-completions adapter", () => {
  test("serializes exact selected settings and protects harness-owned body fields", () => {
    const selected = route();
    const request = buildChatCompletionsRequest({
      goal: context.goal,
      context,
      route: selected,
      tools,
      providerExtraBody: {
        model: "attacker-model",
        messages: [{ role: "user", content: "wrong" }],
        max_completion_tokens: 999_999,
        custom_flag: true
      },
      modelExtraBody: { reasoning_effort: "wrong" }
    });

    expect(request).toMatchObject({
      custom_flag: true,
      model: "fast-wire",
      reasoning_effort: "medium",
      max_completion_tokens: 4_000,
      temperature: 0.8,
      parallel_tool_calls: false
    });
    expect(request.messages[0]).toMatchObject({ role: "system" });
    expect(request.messages.some((message: { role: string }) => message.role === "tool")).toBe(true);
    expect(request.tools[0]).toMatchObject({
      type: "function",
      function: { name: "read_file", strict: true }
    });
  });

  test("normalizes text, tool calls, and usage", () => {
    const result = parseChatCompletionsResponse({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "Reading the file.",
          tool_calls: [{
            id: "call-2",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"src/index.ts"}' }
          }]
        }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    }, tools);

    expect(result).toEqual({
      text: "Reading the file.",
      toolCalls: [{ id: "call-2", name: "read_file", arguments: { path: "src/index.ts" } }],
      usage: { inputTokens: 10, outputTokens: 4 },
      finishReason: "tool_calls"
    });
  });

  test.each([
    ["invalid arguments", '{"path":'],
    ["non-object arguments", '["src/index.ts"]'],
    ["prototype key", '{"__proto__":{"polluted":true}}']
  ])("rejects %s", (_label, args) => {
    expect(() => parseChatCompletionsResponse({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            { id: "x", type: "function", function: { name: "read_file", arguments: args } }
          ]
        }
      }]
    }, tools)).toThrow();
  });

  test("rejects duplicate call IDs and unknown tools", () => {
    const response = {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            { id: "same", type: "function", function: { name: "read_file", arguments: "{}" } },
            { id: "same", type: "function", function: { name: "run_command", arguments: "{}" } }
          ]
        }
      }]
    };
    expect(() => parseChatCompletionsResponse(response, tools)).toThrow(/duplicate|unknown/i);
  });
});

describe("responses adapter", () => {
  test("uses Responses effort, output and flat tool fields and omits unsupported temperature", () => {
    const selected = route("beta/deep");
    const request = buildResponsesRequest({
      goal: context.goal,
      context,
      route: selected,
      tools,
      providerExtraBody: { model: "wrong", input: "wrong", max_output_tokens: 999 },
      modelExtraBody: { instructions: "wrong" }
    });

    expect(request).toMatchObject({
      model: "deep-wire",
      reasoning: { effort: "deep" },
      max_output_tokens: 4_000
    });
    expect(request).not.toHaveProperty("temperature");
    expect(request.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "old-call" }),
      expect.objectContaining({ type: "function_call_output", call_id: "old-call" })
    ]));
    expect(request).not.toHaveProperty("tools");

    const toolRequest = buildResponsesRequest({
      goal: context.goal,
      context,
      route: route(),
      tools,
      providerExtraBody: {},
      modelExtraBody: {}
    });
    expect(toolRequest.tools[0]).toMatchObject({ type: "function", name: "read_file", strict: true });
  });

  test("normalizes output text and function calls", () => {
    const result = parseResponsesResponse({
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Checking." }] },
        { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"x.ts"}' }
      ],
      usage: { input_tokens: 11, output_tokens: 5 }
    }, tools);

    expect(result.text).toBe("Checking.");
    expect(result.toolCalls).toEqual([{ id: "c1", name: "read_file", arguments: { path: "x.ts" } }]);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
  });
});

describe("worker HTTP client", () => {
  test("dispatches to the selected base URL with only that provider's credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }), { status: 200 }));
    const client = new OpenAICompatibleWorkerClient(testConfig(), {
      env: { ALPHA_KEY: "alpha-secret", BETA_KEY: "beta-secret" },
      fetch: fetcher
    });

    const result = await client.execute({ goal: context.goal, context, route: route(), tools });

    expect(result.text).toBe("done");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://alpha.example/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer alpha-secret" });
    expect(JSON.stringify(init?.headers)).not.toContain("beta-secret");
  });

  test("propagates abort and HTTP failures without parsing a worker result", async () => {
    const client = new OpenAICompatibleWorkerClient(testConfig(), {
      env: { ALPHA_KEY: "alpha-secret" },
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"bad"}', { status: 400 }))
    });

    await expect(client.execute({ goal: context.goal, context, route: route(), tools }))
      .rejects.toThrow(/HTTP 400/);
  });
});
