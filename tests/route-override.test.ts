import { expect, test } from "vitest";
import { validateRouteOverride } from "../src/router/override.js";
import { testConfig } from "./fixtures.js";

test("rejects empty unknown wrong-type unsafe and unoffered override coordinates", () => {
  for (const value of [null, [], {}, { action: undefined }, { action: "invented" }, { action: "edit", completionProbability: 1 }, { target: "other/model" }, { effort: "ultra" }, { contextTokens: "8000" }, { contextTokens: 1.5 }, { contextTokens: Number.MAX_SAFE_INTEGER + 1 }, { maxOutputTokens: Infinity }, { maxOutputTokens: 999 }, { temperature: NaN }, { temperature: "0.2" }, { temperature: 0.3 }, { toolPolicy: "invented" }]) {
    expect(() => validateRouteOverride(value, testConfig())).toThrow("Invalid route override.");
  }
});

test("accepts all seven offered coordinates as a detached frozen value", () => {
  const value = { action: "edit", target: "beta/deep", effort: "xhigh", contextTokens: 32000, maxOutputTokens: 8000, temperature: 0.8, toolPolicy: "shell" };
  const result = validateRouteOverride(value, testConfig());
  expect(result).toEqual(value);
  expect(result).not.toBe(value);
  expect(Object.isFrozen(result)).toBe(true);
  value.target = "alpha/fast";
  expect(result.target).toBe("beta/deep");
});
