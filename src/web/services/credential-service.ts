import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { editDotenv, parseDotenv } from "../../config/dotenv.js";
import { loadProjectEnvironment } from "../../config/environment.js";
import type { WebCredentialStatus, WebCredentialRequirement } from "../contracts.js";
import { atomicReplace } from "./atomic-file.js";
import { ConfigService, ServiceError } from "./config-service.js";
import { withPathMutation } from "./mutation-queue.js";

export class CredentialService {
  private readonly path: string;
  constructor(private readonly config: ConfigService, private readonly suppliedEnvironment: Record<string, string | undefined>) {
    this.path = join(dirname(config.path), ".env");
  }
  private async requirements(): Promise<Map<string, WebCredentialRequirement[]>> {
    const { config } = await this.config.loadInternal(); const map = new Map<string, WebCredentialRequirement[]>();
    const add = (name: string, requirement: WebCredentialRequirement) => {
      const list = map.get(name) ?? []; if (!list.some((item) => JSON.stringify(item) === JSON.stringify(requirement))) list.push(requirement); map.set(name, list);
    };
    add(config.jev.apiKeyEnv, { kind: "jev" });
    for (const id of Object.keys(config.providers).sort()) {
      const provider = config.providers[id]!;
      if (provider.apiKeyEnv !== undefined) add(provider.apiKeyEnv, { kind: "provider", providerId: id, usage: "api_key" });
      for (const name of Object.values(provider.headersFromEnv)) add(name, { kind: "provider", providerId: id, usage: "header" });
    }
    return map;
  }
  async status(): Promise<WebCredentialStatus[]> {
    try {
      const requirements = await this.requirements();
      const values = await loadProjectEnvironment(this.config.path, { ...this.suppliedEnvironment });
      const status = Array.from(requirements.keys()).sort().map((name) => Object.freeze({ name,
        requiredBy: Object.freeze(requirements.get(name)!.map((requirement) => Object.freeze(requirement))),
        present: typeof values[name] === "string" }));
      return Object.freeze(status) as unknown as WebCredentialStatus[];
    } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError("CREDENTIAL_IO"); }
  }
  async update(name: string, value: string): Promise<WebCredentialStatus> {
    try {
      if (typeof name !== "string" || typeof value !== "string" || !(await this.requirements()).has(name)) throw new ServiceError("INVALID_CREDENTIAL");
      await withPathMutation(this.path, async () => {
        if (!(await this.requirements()).has(name)) throw new ServiceError("INVALID_CREDENTIAL");
        let bytes: Buffer;
        try { bytes = await readFile(this.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; bytes = Buffer.alloc(0); }
        if (parseDotenv(bytes).assignments.filter((a) => a.name === name).length > 1) throw new ServiceError("AMBIGUOUS_CREDENTIAL");
        await atomicReplace(this.path, editDotenv(bytes, name, value));
      });
      const status = (await this.status()).find((item) => item.name === name);
      if (!status) throw new ServiceError("INVALID_CREDENTIAL");
      return status;
    } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError("CREDENTIAL_IO"); }
  }
}
