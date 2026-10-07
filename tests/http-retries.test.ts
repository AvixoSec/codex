import { describe, expect, test, vi } from "vitest";

import { postJson } from "../src/providers/http.js";
import { JevHttpClient } from "../src/router/jev-client.js";
import { testConfig } from "./fixtures.js";

function validJevPayload(): Record<string, unknown> {
  return {
    model: "jev-test",
    answers: {
      action: { type: "choice", choice: "inspect", probabilities: { inspect: 1 }, confidence: 1 },
      target: { type: "choice", choice: "alpha/fast", probabilities: { "alpha/fast": 1 }, confidence: 1 },
      effort: { type: "choice", choice: "low", probabilities: { low: 1 }, confidence: 1 },
      context_tokens: { type: "choice", choice: "8000", probabilities: { "8000": 1 }, confidence: 1 },
      max_output_tokens: { type: "choice", choice: "1000", probabilities: { "1000": 1 }, confidence: 1 },
      temperature: { type: "choice", choice: "0.2", probabilities: { "0.2": 1 }, confidence: 1 },
      tool_policy: { type: "choice", choice: "read", probabilities: { read: 1 }, confidence: 1 },
      is_complete: { type: "noul", noul: 0.1 }
    }
  };
}

function responseFactory(body: string, status = 200): () => Promise<Response> {
  return async () => new Response(body, { status });
}

describe("provider retry boundaries", () => {
  test.each([
    {
      name: "malformed successful JSON",
      response: responseFactory("not-json"),
      expected: /invalid JSON/,
      maxResponseBytes: 1_000
    },
    {
      name: "a successful error envelope",
      response: responseFactory('{"error":{"message":"permanent"}}'),
      expected: /error object/,
      maxResponseBytes: 1_000
    },
    {
      name: "an oversized successful response",
      response: responseFactory('{"value":"too large"}'),
      expected: /byte limit/,
      maxResponseBytes: 10
    }
  ])("does not retry $name", async ({ response, expected, maxResponseBytes }) => {
    const fetcher = vi.fn<typeof fetch>(response);
    const sleep = vi.fn(async () => undefined);

    await expect(postJson({
      url: "https://provider.example/v1/responses",
      headers: {},
      body: {},
      timeoutMs: 1_000,
      retries: 2,
      maxResponseBytes
    }, { fetch: fetcher, sleep })).rejects.toThrow(expected);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("retries an explicitly transient HTTP status with the existing bounded backoff", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const sleep = vi.fn(async () => undefined);

    await expect(postJson({
      url: "https://provider.example/v1/responses",
      headers: {},
      body: {},
      timeoutMs: 1_000,
      retries: 2
    }, { fetch: fetcher, sleep })).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(150);
  });

  test("retries a fetch network failure but not an arbitrary thrown error", async () => {
    const networkFetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const networkSleep = vi.fn(async () => undefined);

    await expect(postJson({
      url: "https://provider.example/v1/responses",
      headers: {},
      body: {},
      timeoutMs: 1_000,
      retries: 2
    }, { fetch: networkFetcher, sleep: networkSleep })).resolves.toEqual({ ok: true });
    expect(networkFetcher).toHaveBeenCalledTimes(2);
    expect(networkSleep).toHaveBeenCalledWith(150);

    const permanentFetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("local request failure"));
    const permanentSleep = vi.fn(async () => undefined);
    await expect(postJson({
      url: "https://provider.example/v1/responses",
      headers: {},
      body: {},
      timeoutMs: 1_000,
      retries: 2
    }, { fetch: permanentFetcher, sleep: permanentSleep })).rejects.toThrow("local request failure");
    expect(permanentFetcher).toHaveBeenCalledTimes(1);
    expect(permanentSleep).not.toHaveBeenCalled();
  });
});

describe("Jev retry boundaries", () => {
  test.each([
    {
      name: "malformed successful JSON",
      response: responseFactory("not-json"),
      expected: /invalid JSON/
    },
    {
      name: "a successful error envelope",
      response: responseFactory('{"error":{"message":"permanent"}}'),
      expected: /error object/
    },
    {
      name: "an oversized successful response",
      response: responseFactory("x".repeat(2_000_001)),
      expected: /exceeded 2 MB/
    }
  ])("does not retry $name", async ({ response, expected }) => {
    const fetcher = vi.fn<typeof fetch>(response);
    const sleep = vi.fn(async () => undefined);
    const client = new JevHttpClient(testConfig(), {
      env: { TEST_JEV_KEY: "secret" },
      fetch: fetcher,
      sleep,
      random: () => 0
    });

    await expect(client.decide({ goal: "inspect" })).rejects.toThrow(expected);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("retries Jev 529 with the existing bounded backoff", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 529 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(validJevPayload()), { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    const client = new JevHttpClient(testConfig(), {
      env: { TEST_JEV_KEY: "secret" },
      fetch: fetcher,
      sleep,
      random: () => 0
    });

    await expect(client.decide({ goal: "inspect" })).resolves.toMatchObject({
      action: { value: "inspect" }
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(100);
  });

  test("retries a Jev fetch network failure but not an arbitrary thrown error", async () => {
    const networkFetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify(validJevPayload()), { status: 200 }));
    const networkSleep = vi.fn(async () => undefined);
    const networkClient = new JevHttpClient(testConfig(), {
      env: { TEST_JEV_KEY: "secret" },
      fetch: networkFetcher,
      sleep: networkSleep,
      random: () => 0
    });

    await expect(networkClient.decide({ goal: "inspect" })).resolves.toMatchObject({
      action: { value: "inspect" }
    });
    expect(networkFetcher).toHaveBeenCalledTimes(2);
    expect(networkSleep).toHaveBeenCalledWith(100);

    const permanentFetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("local request failure"));
    const permanentSleep = vi.fn(async () => undefined);
    const permanentClient = new JevHttpClient(testConfig(), {
      env: { TEST_JEV_KEY: "secret" },
      fetch: permanentFetcher,
      sleep: permanentSleep,
      random: () => 0
    });
    await expect(permanentClient.decide({ goal: "inspect" })).rejects.toThrow("local request failure");
    expect(permanentFetcher).toHaveBeenCalledTimes(1);
    expect(permanentSleep).not.toHaveBeenCalled();
  });

  test("does not retry a caller abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(controller.signal.reason);
    const sleep = vi.fn(async () => undefined);
    const client = new JevHttpClient(testConfig(), {
      env: { TEST_JEV_KEY: "secret" },
      fetch: fetcher,
      sleep,
      random: () => 0
    });

    await expect(client.decide({ goal: "inspect" }, controller.signal)).rejects.toThrow("cancelled");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
