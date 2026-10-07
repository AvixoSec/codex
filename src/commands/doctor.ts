import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";

import { config as loadDotenv } from "dotenv";

import { loadConfig } from "../config/load.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function doctorProject(
  path: string,
  env: Record<string, string | undefined> = process.env,
  workspace = process.cwd(),
  online = false,
  fetcher: typeof fetch = fetch
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js",
    status: major >= 20 ? "pass" : "fail",
    message: process.versions.node
  });

  const loaded = await loadConfig(path);
  loadDotenv({
    path: join(dirname(loaded.path), ".env"),
    processEnv: env,
    override: false,
    quiet: true
  });
  checks.push({ name: "Configuration", status: "pass", message: loaded.path });
  checks.push({ name: "Schema", status: "pass", message: "version " + loaded.config.version });

  const environmentNames = new Set<string>([loaded.config.jev.apiKeyEnv]);
  for (const provider of Object.values(loaded.config.providers)) {
    if (provider.apiKeyEnv) environmentNames.add(provider.apiKeyEnv);
    for (const name of Object.values(provider.headersFromEnv)) environmentNames.add(name);
  }
  for (const name of [...environmentNames].sort()) {
    checks.push({
      name,
      status: env[name] ? "pass" : "fail",
      message: env[name] ? "set" : "missing"
    });
  }

  try {
    await access(workspace, constants.R_OK | constants.W_OK);
    checks.push({ name: "Workspace", status: "pass", message: workspace });
  } catch {
    checks.push({ name: "Workspace", status: "fail", message: "not readable/writable: " + workspace });
  }
  try {
    await access(dirname(loaded.path), constants.W_OK);
    checks.push({ name: "Config directory", status: "pass", message: dirname(loaded.path) });
  } catch {
    checks.push({ name: "Config directory", status: "warn", message: "not writable" });
  }

  if (online) {
    const urls = [
      loaded.config.jev.endpoint,
      ...Object.values(loaded.config.providers).map((provider) => provider.baseUrl)
    ];
    for (const url of [...new Set(urls)]) {
      try {
        const response = await fetcher(url, {
          method: "HEAD",
          redirect: "error",
          signal: AbortSignal.timeout(5_000)
        });
        checks.push({
          name: "Network " + url,
          status: response.status < 500 ? "pass" : "fail",
          message: "HTTP " + response.status
        });
      } catch (error) {
        checks.push({
          name: "Network " + url,
          status: "fail",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } else {
    checks.push({ name: "Network", status: "warn", message: "not checked; use --online" });
  }

  return { ok: !checks.some((check) => check.status === "fail"), checks };
}
