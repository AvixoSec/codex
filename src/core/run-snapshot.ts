import type { HarnessConfig } from "./types.js";

export interface RunDependencySnapshot {
  readonly config: HarnessConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export function referencedEnvironmentNames(config: HarnessConfig): readonly string[] {
  const names = new Set<string>([config.jev.apiKeyEnv]);
  for (const provider of Object.values(config.providers)) {
    if (provider.apiKeyEnv !== undefined) names.add(provider.apiKeyEnv);
    for (const name of Object.values(provider.headersFromEnv)) names.add(name);
  }
  return Object.freeze(Array.from(names));
}

export function createRunDependencySnapshot(config: HarnessConfig, environment: Record<string, string | undefined>): RunDependencySnapshot {
  const copy = structuredClone(config);
  const stack: object[] = [copy];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") stack.push(child);
    }
    Object.freeze(value);
  }
  const filtered = Object.fromEntries(referencedEnvironmentNames(copy).map((name) => [name, Object.hasOwn(environment, name) ? environment[name] : undefined]));
  return Object.freeze({ config: copy, environment: Object.freeze(filtered) });
}
