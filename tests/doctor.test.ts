import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { doctorProject } from "../src/commands/doctor.js";
import { initProject } from "../src/commands/init.js";

describe("doctor environment loading", () => {
  test("loads config-adjacent .env without overriding explicit environment values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-doctor-dotenv-"));
    const created = await initProject(directory);
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "explicit-openai-secret"
    };
    await writeFile(
      join(directory, ".env"),
      [
        "TYPESAFE_API_KEY=dotenv-jev-secret",
        "OPENAI_API_KEY=dotenv-openai-secret"
      ].join("\n") + "\n",
      "utf8"
    );

    const report = await doctorProject(created.configPath, env, directory);

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "TYPESAFE_API_KEY", status: "pass", message: "set" }),
      expect.objectContaining({ name: "OPENAI_API_KEY", status: "pass", message: "set" })
    ]));
    expect(env).toMatchObject({
      TYPESAFE_API_KEY: "dotenv-jev-secret",
      OPENAI_API_KEY: "explicit-openai-secret"
    });
    expect(JSON.stringify(report)).not.toContain("dotenv-jev-secret");
    expect(JSON.stringify(report)).not.toContain("explicit-openai-secret");
    expect(JSON.stringify(report)).not.toContain("dotenv-openai-secret");
  });

  test("still fails when a required key is absent from both sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevh-doctor-dotenv-missing-"));
    const created = await initProject(directory);
    await writeFile(join(directory, ".env"), "TYPESAFE_API_KEY=dotenv-jev-secret\n", "utf8");

    const report = await doctorProject(created.configPath, {}, directory);

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "TYPESAFE_API_KEY", status: "pass" }),
      expect.objectContaining({ name: "OPENAI_API_KEY", status: "fail", message: "missing" })
    ]));
    expect(JSON.stringify(report)).not.toContain("dotenv-jev-secret");
  });
});
