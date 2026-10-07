#!/usr/bin/env node
import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { doctorProject } from "./commands/doctor.js";
import { initProject } from "./commands/init.js";
import { listModels } from "./commands/models.js";
import { replayReceipts } from "./commands/replay.js";
import { runHarnessTask, type RunCommandOptions } from "./commands/run.js";
import { validateProject } from "./commands/validate.js";
import { loadConfig, resolveConfigPath } from "./config/load.js";
import type { RunResult } from "./core/runner.js";
import { ConsoleUI, jsonEnvelope, jsonError, type OutputStream } from "./ui/console.js";

interface GlobalOptions {
  config?: string;
  json?: boolean;
  color: boolean;
  quiet?: boolean;
}

interface CommandOutcome {
  ok: boolean;
  exitCode?: number;
}

export interface CliDependencies {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: OutputStream;
  stderr?: OutputStream;
  runTask?: (options: RunCommandOptions) => Promise<RunResult>;
  setExitCode?: (code: number) => void;
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Expected a positive integer");
  return parsed;
}

export function createProgram(dependencies: CliDependencies = {}): Command {
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode = dependencies.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const runTask = dependencies.runTask ?? runHarnessTask;
  const program = new Command();

  program
    .name("jevh")
    .description("Jev-controlled per-step model, effort, context and tool routing")
    .version("0.1.0")
    .option("-c, --config <path>", "configuration file")
    .option("--json", "emit one machine-readable JSON document")
    .option("--no-color", "disable terminal colors")
    .option("-q, --quiet", "hide progress output")
    .showHelpAfterError()
    .configureOutput({
      writeOut: (value) => { stdout.write(value); },
      writeErr: (value) => { stderr.write(value); }
    });

  const globals = () => program.opts<GlobalOptions>();
  const ui = () => new ConsoleUI({
    stdout,
    stderr,
    color: globals().color && Boolean((dependencies.stdout ? false : process.stdout.isTTY)) && !env.NO_COLOR,
    ...(globals().quiet !== undefined ? { quiet: globals().quiet } : {})
  });
  const perform = async (
    command: string,
    action: () => Promise<unknown>,
    human: (value: any, output: ConsoleUI) => void,
    outcome: (value: any) => CommandOutcome = () => ({ ok: true })
  ) => {
    try {
      const value = await action();
      const commandOutcome = outcome(value);
      if (commandOutcome.exitCode !== undefined) setExitCode(commandOutcome.exitCode);
      if (globals().json) stdout.write(jsonEnvelope(command, value, commandOutcome.ok) + "\n");
      else human(value, ui());
    } catch (error) {
      setExitCode(1);
      if (globals().json) stdout.write(jsonError(command, error) + "\n");
      else ui().line("error[" + command.toUpperCase() + "]: " + (error instanceof Error ? error.message : String(error)), true);
    }
  };

  program.command("init")
    .description("create a safe starter configuration")
    .argument("[directory]", "project directory", ".")
    .action(async (directory: string) => perform(
      "init",
      () => initProject(resolve(cwd, directory)),
      (value, output) => {
        output.line("Jev Harness initialized");
        for (const path of value.created) output.line("CREATE " + path);
        output.line("Next: copy .env.example to .env, add keys, then run jevh doctor");
      }
    ));

  program.command("validate")
    .description("validate config and show every atomic choice")
    .argument("[file]", "configuration file")
    .action(async (file?: string) => perform(
      "validate",
      async () => validateProject(await resolveConfigPath(file ?? globals().config, cwd, env)),
      (value, output) => {
        output.line("PASS configuration " + value.path);
        output.line("Targets: " + value.targets.map((target: { id: string }) => target.id).join(", "));
        output.line("Efforts: " + value.choices.efforts.join(", "));
        output.line("Context: " + value.choices.contextTokens.join(", "));
        output.line("Output: " + value.choices.maxOutputTokens.join(", "));
        output.line("Temperature: " + value.choices.temperatures.join(", "));
        output.line("Tools: " + value.choices.toolPolicies.join(", "));
      }
    ));

  program.command("doctor")
    .description("check runtime, config, credentials and workspace")
    .option("--online", "also probe configured endpoints")
    .option("-w, --workspace <path>", "workspace directory", ".")
    .action(async (options: { online?: boolean; workspace: string }) => perform(
      "doctor",
      async () => doctorProject(
        await resolveConfigPath(globals().config, cwd, env),
        env,
        resolve(cwd, options.workspace),
        options.online ?? false
      ),
      (value, output) => {
        for (const check of value.checks) {
          const label = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
          output.line(label.padEnd(5) + " " + check.name + " · " + check.message);
        }
      },
      (value) => value.ok ? { ok: true } : { ok: false, exitCode: 1 }
    ));

  program.command("models")
    .description("list every configured provider/model capability")
    .action(async () => perform(
      "models",
      async () => listModels(await resolveConfigPath(globals().config, cwd, env)),
      (rows, output) => output.table(
        ["TARGET", "WIRE MODEL", "API", "CONTEXT", "OUTPUT", "EFFORTS", "TOOLS", "TEMP"],
        rows.map((row: any) => [
          row.target, row.apiModel, row.api, row.context, row.output,
          row.efforts, row.tools, row.temperature
        ])
      )
    ));

  program.command("run")
    .description("run a task, asking Jev before every semantic worker step")
    .argument("<task...>", "task text")
    .option("-w, --workspace <path>", "workspace directory", ".")
    .option("--max-steps <count>", "lower the configured step limit", integer)
    .option("--shadow", "record Jev proposals but execute configured fallbacks")
    .option("-y, --yes", "approve configured safe writes and allowlisted commands")
    .option("--non-interactive", "deny all approval prompts and stop at user-input boundaries")
    .action(async (task: string[], options: {
      workspace: string;
      maxSteps?: number;
      shadow?: boolean;
      yes?: boolean;
      nonInteractive?: boolean;
    }) => {
      const goal = task.join(" ");
      await perform(
        "run",
        async () => {
          const output = ui();
          if (!globals().json) output.banner(goal);
          return runTask({
            configPath: await resolveConfigPath(globals().config, cwd, env),
            goal,
            workspace: resolve(cwd, options.workspace),
            env,
            ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
            ...(options.shadow !== undefined ? { shadow: options.shadow } : {}),
            ...(options.yes !== undefined ? { assumeYes: options.yes } : {}),
            ...(options.nonInteractive ? { interactive: false } : {}),
            ...(!globals().json ? { onEvent: (event) => output.lifecycle(event) } : {})
          });
        },
        (result: RunResult, output) => {
          output.final(result);
        },
        (result: RunResult) => result.status === "completed"
          ? { ok: true }
          : { ok: false, exitCode: result.status === "needs_input" ? 2 : 1 }
      );
    });

  program.command("replay")
    .description("render a JSONL receipt without re-executing tools or network requests")
    .argument("<run-or-path>", "receipt path or run ID")
    .action(async (runOrPath: string) => perform(
      "replay",
      async () => {
        let path: string;
        if (existsSync(resolve(cwd, runOrPath)) || runOrPath.includes("/") || runOrPath.includes("\\")) {
          path = resolve(cwd, runOrPath);
        } else {
          const { config } = await loadConfig(await resolveConfigPath(globals().config, cwd, env));
          path = resolve(cwd, config.receipts.directory, runOrPath + ".jsonl");
        }
        return replayReceipts(path);
      },
      (value, output) => {
        output.table(
          ["STEP", "ACTION", "TARGET", "EFFORT", "CONTEXT", "OUTPUT", "TOOLS"],
          value.routes.map((route: any) => [
            route.step, route.action ?? "", route.target ?? "", route.effort ?? "",
            route.contextTokens ?? "", route.maxOutputTokens ?? "", route.toolPolicy ?? ""
          ])
        );
        if (value.status) output.line("STATUS " + value.status);
        if (value.finalText) output.line("\n" + value.finalText);
      }
    ));

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  await main();
}
