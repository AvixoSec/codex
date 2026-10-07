import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { LoadedConfig } from "../core/types.js";
import { parseConfig } from "./schema.js";

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const absolutePath = resolve(path);
  const source = await readFile(absolutePath, "utf8");
  const value = parseYaml(source);
  return { path: absolutePath, config: parseConfig(value) };
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveConfigPath(
  explicit: string | undefined,
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  if (explicit) return resolve(cwd, explicit);
  if (env.JEV_HARNESS_CONFIG) return resolve(cwd, env.JEV_HARNESS_CONFIG);
  let directory = resolve(cwd);
  while (true) {
    const candidate = join(directory, "jev-harness.yaml");
    if (await readable(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("No jev-harness.yaml found. Run jevh init or pass --config.");
}
