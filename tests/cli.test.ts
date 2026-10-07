import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createProgram } from "../src/cli.js";
import { doctorProject } from "../src/commands/doctor.js";
import { initProject } from "../src/commands/init.js";
import { listModels } from "../src/commands/models.js";
import { replayReceipts } from "../src/commands/replay.js";
import { validateProject } from "../src/commands/validate.js";
import type { RunResult } from "../src/core/runner.js";

function capture() {
  let value = "";
  return {
    stream: { write(chunk: string | Uint8Array) { value += String(chunk); return true; } },
    value: () => value
  };
}

describe("CLI commands", () => {
  test("exposes a concise command surface in help", () => {
    const program = createProgram();
    const help = program.helpInformation();

    expect(help).toContain("init");
    expect(help).toContain("validate");
    expect(help).toContain("doctor");
    expect(help).toContain("models");
    expect(help).toContain("run");
    expect(help).toContain("replay");
    expect(help).toContain("--config");
  });

  test("initializes a valid project without overwriting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-init-"));

    const created = await initProject(directory);
    const config = await validateProject(created.configPath);

    expect(config.targets).toHaveLength(2);
    expect(await readFile(join(directory, ".env.example"), "utf8")).toContain("TYPESAFE_API_KEY=");
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toContain(".jev-harness/");
    await expect(initProject(directory)).rejects.toThrow(/already exists/i);
  });

  test("validation reports exact atomic choices and targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-validate-"));
    const created = await initProject(directory);

    const result = await validateProject(created.configPath);

    expect(result.targets.map((target) => target.id)).toEqual(["primary/main", "local/local"]);
    expect(result.choices).toMatchObject({
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
      contextTokens: [8_192, 16_384, 32_768, 65_536, 131_072]
    });
  });

  test("doctor reports every missing credential without exposing values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-doctor-"));
    const created = await initProject(directory);

    const report = await doctorProject(created.configPath, {}, directory);

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "TYPESAFE_API_KEY", status: "fail" }),
      expect.objectContaining({ name: "OPENAI_API_KEY", status: "fail" })
    ]));
    expect(JSON.stringify(report)).not.toContain("Bearer");
  });

  test("models returns a capability row for each base/model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-models-"));
    const created = await initProject(directory);

    const rows = await listModels(created.configPath);

    expect(rows).toEqual([
      expect.objectContaining({ target: "primary/main", api: "responses", tools: true }),
      expect.objectContaining({ target: "local/local", api: "chat-completions", tools: true })
    ]);
  });

  test("emits exactly one JSON document for a run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-json-"));
    const created = await initProject(directory);
    const stdout = capture();
    const stderr = capture();
    const fakeResult: RunResult = {
      runId: "run-json",
      status: "completed",
      finalText: "done",
      events: [],
      steps: 2
    };
    const program = createProgram({
      cwd: directory,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      runTask: async () => fakeResult
    });

    await program.parseAsync(["--config", created.configPath, "--json", "run", "fix", "the", "parser"], { from: "user" });

    const envelope = JSON.parse(stdout.value());
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "run",
      data: { runId: "run-json", status: "completed", finalText: "done" }
    });
    expect(stdout.value().trim().split("\n")).toHaveLength(1);
    expect(stderr.value()).toBe("");
  });

  test("replays receipt records without executing a run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-replay-"));
    const path = join(directory, "receipt.jsonl");
    await writeFile(path, [
      JSON.stringify({ kind: "route", step: 1, resolved: { target: "a/m", effort: "low" } }),
      JSON.stringify({ kind: "run_finished", status: "completed", finalText: "answer" })
    ].join("\n") + "\n", "utf8");

    const replay = await replayReceipts(path);

    expect(replay.status).toBe("completed");
    expect(replay.finalText).toBe("answer");
    expect(replay.routes).toEqual([
      expect.objectContaining({ step: 1, target: "a/m", effort: "low" })
    ]);
  });
});
