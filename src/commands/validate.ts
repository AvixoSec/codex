import { loadConfig } from "../config/load.js";
import { listTargets } from "../config/schema.js";
import type { RouteChoices, TargetDescriptor } from "../core/types.js";

export interface ValidationResult {
  path: string;
  version: number;
  choices: RouteChoices;
  targets: TargetDescriptor[];
}

export async function validateProject(path: string): Promise<ValidationResult> {
  const loaded = await loadConfig(path);
  return {
    path: loaded.path,
    version: loaded.config.version,
    choices: loaded.config.routing.choices,
    targets: listTargets(loaded.config)
  };
}
