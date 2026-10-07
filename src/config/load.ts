import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { LoadedConfig } from "../core/types.js";
import { parseConfig } from "./schema.js";

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const absolutePath = resolve(path);
  const source = await readFile(absolutePath, "utf8");
  const value = parseYaml(source);
  return { path: absolutePath, config: parseConfig(value) };
}
