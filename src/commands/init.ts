import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { EXAMPLE_CONFIG } from "../config/example.js";
import { loadConfig } from "../config/load.js";

export interface InitResult {
  directory: string;
  configPath: string;
  created: string[];
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function initProject(directory: string): Promise<InitResult> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const configPath = join(root, "jev-harness.yaml");
  try {
    await writeFile(configPath, EXAMPLE_CONFIG, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Configuration already exists: " + configPath);
    }
    throw error;
  }
  const created = [configPath];

  const envPath = join(root, ".env.example");
  if (await writeIfMissing(envPath, [
    "# Copy to .env and set real values. Never commit .env.",
    "TYPESAFE_API_KEY=",
    "OPENAI_API_KEY=",
    ""
  ].join("\n"))) created.push(envPath);

  const ignorePath = join(root, ".gitignore");
  let ignore = "";
  try {
    ignore = await readFile(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!ignore.split(/\r?\n/u).includes(".jev-harness/")) {
    const next = (ignore && !ignore.endsWith("\n") ? ignore + "\n" : ignore) + ".jev-harness/\n.env\n";
    await writeFile(ignorePath, next, { encoding: "utf8", mode: 0o600 });
    created.push(ignorePath);
  }

  await loadConfig(configPath);
  return { directory: root, configPath, created };
}
