import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { doctorProject } from "../src/commands/doctor.js";
import { initProject } from "../src/commands/init.js";
import { encodeManagedCredential } from "../src/config/dotenv.js";

describe("doctor environment loading", () => {
  test("continues doctor with supplied credentials when optional dotenv cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "task4-doctor-optional-")); const created = await initProject(root);
    const dotenvPath = join(root, ".env"); await mkdir(dotenvPath);
    const env = { TYPESAFE_API_KEY: "JEV_SECRET_SENTINEL", OPENAI_API_KEY: "PROVIDER_SECRET_SENTINEL" };
    const report = await doctorProject(created.configPath, env, root);
    expect(report.ok).toBe(true); expect(env).toEqual({ TYPESAFE_API_KEY: "JEV_SECRET_SENTINEL", OPENAI_API_KEY: "PROVIDER_SECRET_SENTINEL" });
    const output = JSON.stringify(report); expect(output).not.toContain(dotenvPath); expect(output).not.toMatch(/EISDIR|EACCES|SENTINEL|Project environment/u);
  });
  test("doctor recognizes managed credentials without exposing their values", async () => {
    const root = await mkdtemp(join(tmpdir(), "task4-doctor-")); const created = await initProject(root);
    const value = "DOCTOR_SENTINEL\0\r\nü"; const env: Record<string, string | undefined> = {};
    await writeFile(join(root, ".env"), "TYPESAFE_API_KEY=" + encodeManagedCredential(value) + "\u2029OPENAI_API_KEY=" + encodeManagedCredential(value));
    const report = await doctorProject(created.configPath, env, root);
    expect(report.ok).toBe(true); expect(env.TYPESAFE_API_KEY).toBe(value); expect(env.OPENAI_API_KEY).toBe(value);
    expect(JSON.stringify(report)).not.toContain("SENTINEL"); expect(JSON.stringify(report)).not.toContain("JEVH_MANAGED");
  });
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
