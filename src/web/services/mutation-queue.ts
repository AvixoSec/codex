import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const tails = new Map<string, Promise<unknown>>();
export async function withPathMutation<T>(path: string, mutate: () => Promise<T>): Promise<T> {
  const absolute = resolve(path);
  const key = join(await realpath(dirname(absolute)), basename(absolute));
  const previous = tails.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(mutate);
  tails.set(key, next);
  try { return await next; }
  finally { if (tails.get(key) === next) tails.delete(key); }
}
