import { resolve } from "node:path";
import { loadProjectEnvironment, ProjectEnvironmentReadError } from "../config/environment.js";
import { createInterface } from "node:readline/promises";

import { loadConfig } from "../config/load.js";
import { HarnessRunner, type RunOptions, type RunResult, type RunnerLifecycleEvent } from "../core/runner.js";
import { OpenAICompatibleWorkerClient } from "../providers/worker-client.js";
import { ReceiptStore } from "../receipts/store.js";
import { JevHttpClient } from "../router/jev-client.js";
import type { ApprovalRequest } from "../tools/approval.js";
import { ToolExecutor } from "../tools/executor.js";

export interface RunCommandOptions {
  configPath: string;
  goal: string;
  workspace?: string;
  maxSteps?: number;
  shadow?: boolean;
  assumeYes?: boolean;
  interactive?: boolean;
  env?: Record<string, string | undefined>;
  onEvent?: (event: RunnerLifecycleEvent) => void | Promise<void>;
  promptApproval?: (request: ApprovalRequest) => Promise<boolean>;
  askUser?: (question: string) => Promise<string>;
  signal?: AbortSignal;
}

async function confirm(request: ApprovalRequest): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question("Approve " + request.summary + "? [y/N] ");
    return /^(y|yes)$/iu.test(answer.trim());
  } finally {
    terminal.close();
  }
}

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(question + "\n> ");
  } finally {
    terminal.close();
  }
}

export async function runHarnessTask(options: RunCommandOptions): Promise<RunResult> {
  const env = options.env ?? process.env;
  try { await loadProjectEnvironment(options.configPath, env); }
  catch (error) { if (!(error instanceof ProjectEnvironmentReadError)) throw error; }
  const { config } = await loadConfig(options.configPath);
  const workspace = resolve(options.workspace ?? process.cwd());
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const secrets = new Set<string>();
  const secretNames = new Set<string>([config.jev.apiKeyEnv]);
  for (const provider of Object.values(config.providers)) {
    if (provider.apiKeyEnv) secretNames.add(provider.apiKeyEnv);
    Object.values(provider.headersFromEnv).forEach((name) => secretNames.add(name));
  }
  for (const name of secretNames) if (env[name]) secrets.add(env[name]!);

  const decisionClient = new JevHttpClient(config, { env });
  const workerClient = new OpenAICompatibleWorkerClient(config, { env });
  const toolExecutor = await ToolExecutor.create(config, workspace, {
    interactive,
    ...(options.assumeYes !== undefined ? { assumeYes: options.assumeYes } : {}),
    ...(options.promptApproval ? { prompt: options.promptApproval } : interactive ? { prompt: confirm } : {})
  });
  const receipts = new ReceiptStore(resolve(workspace, config.receipts.directory), [...secrets]);
  const runner = new HarnessRunner(config, {
    decisionClient,
    workerClient,
    toolExecutor,
    receipts,
    secrets: [...secrets]
  });
  const runOptions: RunOptions = {
    goal: options.goal,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.shadow !== undefined ? { shadow: options.shadow } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.askUser ? { askUser: options.askUser } : interactive ? { askUser: ask } : {})
  };
  return runner.run(runOptions);
}
