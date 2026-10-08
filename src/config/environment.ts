import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { decodeManagedCredential, parseDotenv } from "./dotenv.js";

/** Internal discriminator so CLI can retain optional-file I/O compatibility. */
export class ProjectEnvironmentReadError extends Error {
  constructor() { super("Project environment could not be loaded."); this.name = "ProjectEnvironmentReadError"; }
}

/** Fill absent own properties, retaining dotenv's caller mutation/precedence. */
export async function loadProjectEnvironment(configPath: string, supplied: Record<string, string | undefined>): Promise<Record<string, string | undefined>> {
  let bytes: Buffer;
  try { bytes = await readFile(join(dirname(resolve(configPath)), ".env")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return supplied; throw new ProjectEnvironmentReadError(); }
  for (const [name, value] of Object.entries(parseDotenv(bytes).values)) {
    if (!Object.hasOwn(supplied, name)) Object.defineProperty(supplied, name, { value: decodeManagedCredential(value), enumerable: true, configurable: true, writable: true });
  }
  return supplied;
}
