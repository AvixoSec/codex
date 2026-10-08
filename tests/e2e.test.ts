import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, test } from "vitest";

import { runHarnessTask } from "../src/commands/run.js";
import { testConfig } from "./fixtures.js";
import { encodeManagedCredential } from "../src/config/dotenv.js";
import { doctorProject } from "../src/commands/doctor.js";

async function jsonBody(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
}

async function mockServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server has no TCP address");
  return {
    origin: "http://127.0.0.1:" + address.port,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    )
  };
}

function choice(choiceValue: string) {
  return {
    type: "choice",
    choice: choiceValue,
    probabilities: { [choiceValue]: 1 },
    confidence: 0.99
  };
}

describe("HTTP end-to-end rerouting", () => {
  test("continues run with supplied credentials when optional dotenv cannot be read", async () => {
    let requests = 0; const secret = "OPTIONAL_SECRET_SENTINEL";
    const server = await mockServer(async (request, response) => {
      requests += 1; expect(request.headers.authorization).toBe("Bearer " + secret); const body = await jsonBody(request); expect(JSON.stringify(body)).not.toContain(secret);
      response.end(JSON.stringify(request.url === "/jev" ? { answers: { action: choice("analyze"), target: choice("alpha/fast"), effort: choice("low"), context_tokens: choice("8000"), max_output_tokens: choice("1000"), temperature: choice("0.2"), tool_policy: choice("none"), is_complete: { type: "noul", noul: 0 } } } : { choices: [{ message: { content: "safe" } }] }));
    });
    try {
      const root = await mkdtemp(join(tmpdir(), "task4-run-optional-")); const config = testConfig(); config.routing.maxSteps = 1; config.jev.endpoint = server.origin + "/jev"; config.providers.alpha!.baseUrl = server.origin;
      const path = join(root, "config.yaml"); await writeFile(path, stringifyYaml(config)); const dotenvPath = join(root, ".env"); await mkdir(dotenvPath);
      const env = { TEST_JEV_KEY: secret, ALPHA_KEY: secret, BETA_KEY: secret };
      const result = await runHarnessTask({ configPath: path, workspace: root, goal: "safe", env, interactive: false });
      expect(result).toMatchObject({ status: "limit", steps: 1, finalText: "safe" }); expect(requests).toBe(2); expect(env.TEST_JEV_KEY).toBe(secret);
      const output = JSON.stringify(result); expect(output).not.toContain(dotenvPath); expect(output).not.toMatch(/EISDIR|EACCES|SENTINEL|Project environment/u);
    } finally { await server.close(); }
  });
  test("keeps an inherited marker-looking value literal in run and doctor", async () => {
    const literal = encodeManagedCredential("INHERITED_SENTINEL"); let requests = 0;
    const server = await mockServer(async (request, response) => {
      requests += 1; expect(request.headers.authorization).toBe("Bearer " + literal);
      const body = await jsonBody(request); expect(JSON.stringify(body)).not.toContain(literal);
      response.end(JSON.stringify(request.url === "/jev" ? { answers: { action: choice("analyze"), target: choice("alpha/fast"), effort: choice("low"), context_tokens: choice("8000"), max_output_tokens: choice("1000"), temperature: choice("0.2"), tool_policy: choice("none"), is_complete: { type: "noul", noul: 0 } } } : { choices: [{ message: { content: "safe" } }] }));
    });
    try {
      const root = await mkdtemp(join(tmpdir(), "task4-inherited-")); const config = testConfig(); config.routing.maxSteps = 1; config.jev.endpoint = server.origin + "/jev"; config.providers.alpha!.baseUrl = server.origin;
      const path = join(root, "config.yaml"); await writeFile(path, stringifyYaml(config)); await writeFile(join(root, ".env"), "TEST_JEV_KEY=" + encodeManagedCredential("file") + "\nALPHA_KEY=" + encodeManagedCredential("file"));
      const env = { TEST_JEV_KEY: literal, ALPHA_KEY: literal, BETA_KEY: literal };
      const result = await runHarnessTask({ configPath: path, workspace: root, goal: "safe", env, interactive: false });
      const report = await doctorProject(path, env, root); expect(report.ok).toBe(true); expect(requests).toBe(2); expect(env.TEST_JEV_KEY).toBe(literal);
      expect(JSON.stringify([result, report])).not.toContain(literal); expect(JSON.stringify([result, report])).not.toContain("INHERITED_SENTINEL");
    } finally { await server.close(); }
  });
  test("passes decoded managed credentials to Jev and every provider without passing the marker", async () => {
    const seen: string[] = []; let turn = 0;
    const secret = "credential-ü-'\"=#-SENTINEL";
    const jev = await mockServer(async (request, response) => {
      seen.push(String(request.headers.authorization)); expect(request.headers.authorization).toBe("Bearer " + secret);
      const body = await jsonBody(request); expect(JSON.stringify(body)).not.toContain("SENTINEL");
      const target = turn++ === 0 ? "alpha/fast" : "beta/deep";
      response.end(JSON.stringify({ answers: { action: choice("analyze"), target: choice(target), effort: choice("low"), context_tokens: choice("8000"), max_output_tokens: choice("1000"), temperature: choice("0.2"), tool_policy: choice("none"), is_complete: { type: "noul", noul: 0 } } }));
    });
    const provider = await mockServer(async (request, response) => {
      seen.push(String(request.headers.authorization)); expect(request.headers.authorization).toBe("Bearer " + secret);
      expect(request.headers["x-custom"]).toBe(secret); const body = await jsonBody(request);
      expect(JSON.stringify(body)).not.toContain("SENTINEL");
      response.end(JSON.stringify(request.url?.endsWith("responses") ? { output: [{ type: "message", content: [{ type: "output_text", text: "safe" }] }] } : { choices: [{ message: { content: "safe" } }] }));
    });
    try {
      const root = await mkdtemp(join(tmpdir(), "task4-managed-http-")); const config = testConfig();
      config.jev.endpoint = jev.origin; config.routing.maxSteps = 2;
      for (const p of Object.values(config.providers)) { p.baseUrl = provider.origin; p.headersFromEnv = { "X-Custom": "HEADER_KEY" }; }
      const path = join(root, "config.yaml"); await writeFile(path, stringifyYaml(config));
      await writeFile(join(root, ".env"), ["TEST_JEV_KEY", "ALPHA_KEY", "BETA_KEY", "HEADER_KEY"].map((name) => name + "=" + encodeManagedCredential(secret)).join("\u2028"));
      const result = await runHarnessTask({ configPath: path, workspace: root, goal: "safe goal", interactive: false, env: {} });
      expect(result.steps).toBe(2); expect(seen).toHaveLength(4); expect(JSON.stringify(result)).not.toContain("SENTINEL"); expect(seen.join()).not.toContain("JEVH_MANAGED");
    } finally { await Promise.all([jev.close(), provider.close()]); }
  });
  test("Jev selects two base URLs and fresh atomic settings across semantic steps", async () => {
    const sequence: string[] = [];
    const jevBodies: Record<string, any>[] = [];
    const alphaBodies: Record<string, any>[] = [];
    const betaBodies: Record<string, any>[] = [];
    let decisionIndex = 0;

    const jev = await mockServer(async (request, response) => {
      sequence.push("jev-" + (decisionIndex + 1));
      const body = await jsonBody(request);
      jevBodies.push(body);
      decisionIndex += 1;
      const selections = decisionIndex === 1
        ? {
            action: "inspect", target: "alpha/fast", effort: "low",
            context: "8000", output: "1000", temperature: "0.2", tools: "read", complete: 0.05
          }
        : decisionIndex === 2
          ? {
              action: "analyze", target: "beta/deep", effort: "high",
              context: "4000", output: "4000", temperature: "0.8", tools: "none", complete: 0.2
            }
          : {
              action: "finish", target: "beta/deep", effort: "high",
              context: "4000", output: "4000", temperature: "0.8", tools: "none", complete: 0.96
            };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          action: choice(selections.action),
          target: choice(selections.target),
          effort: choice(selections.effort),
          context_tokens: choice(selections.context),
          max_output_tokens: choice(selections.output),
          temperature: choice(selections.temperature),
          tool_policy: choice(selections.tools),
          is_complete: { type: "noul", noul: selections.complete }
        },
        usage: { input_tokens: 100, output_tokens: 20 }
      }));
    });
    const alpha = await mockServer(async (request, response) => {
      sequence.push("alpha");
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer alpha-secret");
      const body = await jsonBody(request);
      alphaBodies.push(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Reading the implementation.",
            tool_calls: [{
              id: "read-1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/index.ts"}' }
            }]
          }
        }],
        usage: { prompt_tokens: 30, completion_tokens: 8 }
      }));
    });
    const beta = await mockServer(async (request, response) => {
      sequence.push("beta");
      expect(request.url).toBe("/api/responses");
      expect(request.headers.authorization).toBe("Bearer beta-secret");
      const body = await jsonBody(request);
      betaBodies.push(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The implementation exports value 7." }]
        }],
        usage: { input_tokens: 40, output_tokens: 9 }
      }));
    });

    try {
      const root = await mkdtemp(join(tmpdir(), "jevh-e2e-"));
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "index.ts"), "export const value = 7;\n", "utf8");
      const config = testConfig();
      config.jev.endpoint = jev.origin + "/v1/systemone";
      config.providers.alpha!.baseUrl = alpha.origin + "/v1";
      config.providers.beta!.baseUrl = beta.origin + "/api";
      config.receipts.directory = ".receipts";
      const configPath = join(root, "jev-harness.yaml");
      await writeFile(configPath, stringifyYaml(config), "utf8");

      const result = await runHarnessTask({
        configPath,
        goal: "Inspect src/index.ts and report the exported value",
        workspace: root,
        interactive: false,
        env: {
          TEST_JEV_KEY: "jev-secret",
          ALPHA_KEY: "alpha-secret",
          BETA_KEY: "beta-secret"
        }
      });

      expect(result).toMatchObject({
        status: "completed",
        finalText: "The implementation exports value 7.",
        steps: 2
      });
      expect(sequence).toEqual(["jev-1", "alpha", "jev-2", "beta", "jev-3"]);
      expect(jevBodies).toHaveLength(3);
      expect(Object.keys(jevBodies[0]!.questions)).toEqual([
        "action", "target", "effort", "context_tokens", "max_output_tokens",
        "temperature", "tool_policy", "is_complete"
      ]);
      expect(alphaBodies[0]).toMatchObject({
        model: "fast-wire",
        reasoning_effort: "low",
        max_completion_tokens: 1_000,
        temperature: 0.2
      });
      expect(betaBodies[0]).toMatchObject({
        model: "deep-wire",
        reasoning: { effort: "deep" },
        max_output_tokens: 4_000
      });
      expect(betaBodies[0]).not.toHaveProperty("temperature");
      expect(betaBodies[0].input).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "read-1",
          output: expect.stringContaining("value = 7")
        })
      ]));

      const receipt = await readFile(join(root, ".receipts", result.runId + ".jsonl"), "utf8");
      expect(receipt).toContain('"target":"alpha/fast"');
      expect(receipt).toContain('"target":"beta/deep"');
      expect(receipt).not.toContain("jev-secret");
      expect(receipt).not.toContain("alpha-secret");
      expect(receipt).not.toContain("beta-secret");
    } finally {
      await Promise.all([jev.close(), alpha.close(), beta.close()]);
    }
  });
});
