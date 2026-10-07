import { describe, expect, test } from "vitest";

import { buildContext, estimateTokens } from "../src/context/budget.js";
import type { AgentEvent } from "../src/core/types.js";

describe("context budgeting", () => {
  test("uses a conservative UTF-8 estimate for multilingual content", () => {
    expect(estimateTokens("hello")).toBeGreaterThan(0);
    expect(estimateTokens("привет")).toBeGreaterThan(estimateTokens("hello"));
    expect(estimateTokens({ text: "こんにちは", count: 2 })).toBeGreaterThan(5);
  });

  test("keeps the goal and newest events while dropping older events first", () => {
    const events: AgentEvent[] = [
      { type: "assistant_text", content: "old ".repeat(1_000), step: 1 },
      { type: "assistant_text", content: "middle evidence", step: 2 },
      { type: "assistant_text", content: "latest result", step: 3 }
    ];

    const context = buildContext("Fix the failing parser", events, 80);

    expect(context.goal).toContain("Fix the failing parser");
    expect(context.events.at(-1)).toMatchObject({ content: "latest result" });
    expect(context.events.some((event) => "content" in event && event.content.includes("old old"))).toBe(false);
    expect(context.estimatedTokens).toBeLessThanOrEqual(80);
  });

  test("uses an explicit marker when a required latest event must be truncated", () => {
    const events: AgentEvent[] = [
      { type: "assistant_text", content: "important ".repeat(1_000), step: 1 }
    ];

    const context = buildContext("goal", events, 40);

    expect(context.events).toHaveLength(1);
    expect(context.events[0]).toMatchObject({ type: "assistant_text" });
    expect((context.events[0] as { content: string }).content).toContain("[…truncated by Jev Harness…]");
    expect(context.truncated).toBe(true);
  });

  test("keeps a tool call with its latest tool result", () => {
    const events: AgentEvent[] = [
      { type: "assistant_text", content: "older".repeat(500), step: 1 },
      { type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "src/a.ts" }, step: 2 },
      { type: "tool_result", callId: "call-1", name: "read_file", content: "export const a = 1;", ok: true, step: 2 }
    ];

    const context = buildContext("inspect", events, 100);

    expect(context.events.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);
  });

  test("never retains an incomplete tool call/result pair", () => {
    const call: AgentEvent = {
      type: "tool_call",
      id: "call-1",
      name: "read_file",
      arguments: { path: "src/a.ts" },
      step: 1
    };
    const result: AgentEvent = {
      type: "tool_result",
      callId: "call-1",
      name: "read_file",
      content: "a".repeat(2_000),
      ok: true,
      step: 1
    };
    const budgetThatFitsOnlyTheCall = estimateTokens("inspect") + estimateTokens(call) + 2;

    const context = buildContext("inspect", [call, result], budgetThatFitsOnlyTheCall);

    expect(context.events).toEqual([]);
    expect(context.truncated).toBe(true);
  });

  test("drops orphaned tool protocol events instead of serializing invalid history", () => {
    const context = buildContext("inspect", [
      { type: "tool_call", id: "orphan-call", name: "read_file", arguments: { path: "a.ts" }, step: 1 },
      { type: "tool_result", callId: "orphan-result", name: "read_file", content: "result", ok: true, step: 2 },
      { type: "assistant_text", content: "latest safe event", step: 3 }
    ], 200);

    expect(context.events).toEqual([
      { type: "assistant_text", content: "latest safe event", step: 3 }
    ]);
    expect(context.truncated).toBe(true);
  });

  test("still returns bounded context for a tiny positive budget", () => {
    const context = buildContext("a very long goal ".repeat(100), [
      { type: "assistant_text", content: "latest ".repeat(100), step: 1 }
    ], 16);

    expect(context.goal).toContain("[…truncated by Jev Harness…]");
    expect(context.events).toHaveLength(0);
    expect(context.estimatedTokens).toBeLessThanOrEqual(16);
  });
});
