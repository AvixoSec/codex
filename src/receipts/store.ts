import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { redact } from "./redact.js";

export type ReceiptRecord = Record<string, unknown>;

export class ReceiptStore {
  readonly directory: string;
  readonly #secrets: readonly string[];
  readonly #queues = new Map<string, Promise<void>>();

  constructor(directory: string, secrets: readonly string[] = []) {
    this.directory = resolve(directory);
    this.#secrets = secrets;
  }

  resolveRun(runOrPath: string): string {
    if (isAbsolute(runOrPath)) return resolve(runOrPath);
    if (runOrPath.includes("/") || runOrPath.includes("\\") || runOrPath.includes(sep)) {
      throw new Error("Receipt run ID must not contain path separators");
    }
    if (!/^[A-Za-z0-9_-]+$/u.test(runOrPath)) {
      throw new Error("Invalid receipt run ID");
    }
    return resolve(this.directory, `${runOrPath}.jsonl`);
  }

  async append(runId: string, record: ReceiptRecord): Promise<void> {
    const path = this.resolveRun(runId);
    const previous = this.#queues.get(path) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const line = JSON.stringify(redact(record, this.#secrets)) + "\n";
      await appendFile(path, line, { encoding: "utf8", mode: 0o600, flag: "a" });
      await chmod(path, 0o600);
    });
    this.#queues.set(path, next);
    try {
      await next;
    } finally {
      if (this.#queues.get(path) === next) this.#queues.delete(path);
    }
  }

  async read(runOrPath: string): Promise<ReceiptRecord[]> {
    const path = this.resolveRun(runOrPath);
    const source = await readFile(path, "utf8");
    return source
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line, index) => {
        try {
          const value: unknown = JSON.parse(line);
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("record must be an object");
          }
          return value as ReceiptRecord;
        } catch (error) {
          throw new Error(`Invalid receipt JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
  }
}
