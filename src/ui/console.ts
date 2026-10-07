import { Chalk, type ChalkInstance } from "chalk";

import type { RunnerLifecycleEvent, RunResult } from "../core/runner.js";

export interface OutputStream {
  write(chunk: string | Uint8Array): unknown;
}

export class ConsoleUI {
  readonly #stdout: OutputStream;
  readonly #stderr: OutputStream;
  readonly #color: ChalkInstance;
  readonly #quiet: boolean;

  constructor(options: {
    stdout?: OutputStream;
    stderr?: OutputStream;
    color?: boolean;
    quiet?: boolean;
  } = {}) {
    this.#stdout = options.stdout ?? process.stdout;
    this.#stderr = options.stderr ?? process.stderr;
    this.#color = new Chalk({ level: options.color ? 1 : 0 });
    this.#quiet = options.quiet ?? false;
  }

  banner(goal: string): void {
    if (this.#quiet) return;
    this.#stderr.write(this.#color.cyan("╭─ JEV HARNESS ─────────────────────────────────────────\n"));
    this.#stderr.write("│ " + goal + "\n");
    this.#stderr.write(this.#color.cyan("╰────────────────────────────────────────────────────────\n"));
  }

  lifecycle(event: RunnerLifecycleEvent): void {
    if (this.#quiet) return;
    const step = String(event.step).padStart(2, "0");
    const labels = {
      status: this.#color.dim("STATUS"),
      route: this.#color.magenta("ROUTE "),
      worker: this.#color.blue("WORKER"),
      tool: this.#color.yellow("TOOL  ")
    };
    this.#stderr.write(labels[event.kind] + " " + step + "  " + event.message + "\n");
    if (event.kind === "route" && event.route?.adjustments.length) {
      for (const adjustment of event.route.adjustments) {
        this.#stderr.write(this.#color.dim(
          "          ↳ " + adjustment.field + ": " + String(adjustment.from) + " → " +
          String(adjustment.to) + " (" + adjustment.reason + ")\n"
        ));
      }
    }
  }

  final(result: RunResult): void {
    if (result.finalText) this.#stdout.write(result.finalText.trimEnd() + "\n");
    if (this.#quiet) return;
    const color = result.status === "completed" ? this.#color.green : this.#color.yellow;
    this.#stderr.write(color(
      "DONE     " + result.status + " · " + result.steps + " worker step(s) · " + result.runId + "\n"
    ));
  }

  line(value: string, error = false): void {
    (error ? this.#stderr : this.#stdout).write(value + "\n");
  }

  table(headers: string[], rows: Array<Array<string | number | boolean>>): void {
    const values = [headers, ...rows.map((row) => row.map(String))];
    const widths = headers.map((_, column) => Math.max(...values.map((row) => String(row[column] ?? "").length)));
    const render = (row: Array<string | number | boolean>) =>
      row.map((cell, column) => String(cell).padEnd(widths[column] ?? 0)).join("  ").trimEnd();
    this.#stdout.write(this.#color.bold(render(headers)) + "\n");
    for (const row of rows) this.#stdout.write(render(row) + "\n");
  }
}

export function jsonEnvelope(command: string, data: unknown, ok = true): string {
  return JSON.stringify({ schemaVersion: 1, ok, command, data });
}

export function jsonError(command: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({
    schemaVersion: 1,
    ok: false,
    command,
    error: { code: "COMMAND_FAILED", message }
  });
}
