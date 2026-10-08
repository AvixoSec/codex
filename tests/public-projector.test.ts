import { describe, expect, test } from "vitest";

import { projectRouteDecision, publicError, publicText } from "../src/core/public-projector.js";
import { resolveRoute, type RawRouteDecision } from "../src/router/resolve.js";
import { testConfig } from "./fixtures.js";

describe("public projection", () => {
  test("preserves real zero and maps absent or malformed scores to null", () => {
    const raw: RawRouteDecision = { action: { value: "analyze", confidence: 0, probabilities: {} }, completionProbability: 0, errors: {} };
    const route = resolveRoute(raw, testConfig());
    expect(projectRouteDecision(route, raw, "jev").scores).toEqual({ action: 0, target: null, effort: null, contextTokens: null, maxOutputTokens: null, temperature: null, toolPolicy: null, completion: 0 });
    for (const invalid of [NaN, Infinity, -1, 1.1, "0", null]) {
      const malformed = { ...raw, completionProbability: invalid, target: { value: "alpha/fast", confidence: invalid, probabilities: {} } } as unknown as RawRouteDecision;
      expect(projectRouteDecision(route, malformed, "jev").scores).toMatchObject({ target: null, completion: null });
    }
  });

  test("retains real proposal scores in shadow fallback and no synthetic fallback scores", () => {
    const raw: RawRouteDecision = { completionProbability: 0.7, errors: {} };
    const route = resolveRoute(raw, testConfig(), true);
    expect(projectRouteDecision(route, raw, "fallback")).toMatchObject({ provenance: "fallback", scores: { completion: 0.7 } });
    expect(projectRouteDecision(route, undefined, "fallback").scores).toEqual({ action: null, target: null, effort: null, contextTokens: null, maxOutputTokens: null, temperature: null, toolPolicy: null, completion: null });
    expect(projectRouteDecision(route, raw, "user_override").provenance).toBe("user_override");
  });

  test("allowlists route fields instead of copying nested internals or adjustment values", () => {
    const config = testConfig();
    const raw: RawRouteDecision = { errors: { action: "secret-internal-error" }, model: "https://jev-endpoint.invalid", usage: { inputTokens: 2, outputTokens: 3 } };
    const route = resolveRoute(raw, config);
    Object.assign(route.target, { baseUrl: "https://private.invalid", headers: { Authorization: "Bearer sk-private" }, body: { secret: "payload-secret" }, stack: "private-stack", cause: { secret: "private-cause" }, diagnostics: { nested: "nested-diagnostic" } });
    route.target.provider.extraBody = { apiKey: "body-secret" };
    route.target.provider.headersFromEnv = { Authorization: "CREDENTIAL_REFERENCE" };
    route.adjustments.push({ field: "target", from: { secret: "adjustment-secret" }, to: "https://private.invalid", reason: "not_offered" });
    const projected = projectRouteDecision(route, raw, "jev");
    expect(Object.keys(projected).sort()).toEqual(["action", "target", "provider", "model", "effort", "contextTokens", "maxOutputTokens", "temperature", "toolPolicy", "provenance", "scores", "adjustments"].sort());
    const serialized = JSON.stringify(projected);
    for (const forbidden of ["https://", "sk-private", "payload-secret", "private-stack", "private-cause", "nested-diagnostic", "body-secret", "CREDENTIAL_REFERENCE", "adjustment-secret", "secret-internal-error", "headers", "extraBody", "apiKey", "probabilities"]) expect(serialized).not.toContain(forbidden);
  });

  test("bounds UTF-8 public text without splitting a code point and masks known secrets and endpoints", () => {
    const value = publicText("💫".repeat(2000), 2048);
    expect(Buffer.byteLength(value)).toBe(2048);
    expect(value).not.toContain("�");
    expect(publicText("secret-value https://private.invalid/api Bearer sk-abcdefghijk", 2048, ["secret-value"])).not.toMatch(/secret-value|https:\/\/|sk-abcdefghijk/);
  });

  test("returns stable public errors without inspecting an internal error", () => {
    expect(publicError("PROVIDER_FAILED")).toEqual({ code: "PROVIDER_FAILED", message: "Worker provider failed." });
    expect(Buffer.byteLength(publicError("PROVIDER_FAILED").message)).toBeLessThanOrEqual(512);
  });
});
