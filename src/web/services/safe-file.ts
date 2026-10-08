import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ServiceError } from "./config-service.js";

/** Internal seam for deterministic check/open/read replacement tests. */
export const safeFileOperations = { lstat, open, readdir };
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
interface DirectoryIdentity { path: string; stat: BigIntStats }
async function directories(root: string): Promise<DirectoryIdentity[]> {
  const paths: string[] = []; let path = resolve(root);
  while (true) { paths.push(path); const parent = dirname(path); if (parent === path) break; path = parent; }
  const identities: DirectoryIdentity[] = [];
  for (let i = paths.length - 1; i >= 0; i--) {
    const path = paths[i]!; const stat = await safeFileOperations.lstat(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ServiceError("UNSUPPORTED_RECEIPT");
    identities.push({ path, stat });
  }
  return identities;
}
async function checkDirectories(identities: DirectoryIdentity[]): Promise<void> {
  for (let index = 0; index < identities.length; index++) {
    const entry = identities[index]!;
    const stat = await safeFileOperations.lstat(entry.path, { bigint: true });
    // Ancestor content may change independently; directory ownership must not.
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino || stat.mode !== entry.stat.mode) throw new ServiceError("UNSUPPORTED_RECEIPT");
    if (index === identities.length - 1 && !same(entry.stat, stat)) throw new ServiceError("UNSUPPORTED_RECEIPT");
  }
}
function fixed(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new ServiceError("RECEIPT_NOT_FOUND");
  if (code === "ELOOP" || code === "ENOTDIR" || code === "ENXIO") return new ServiceError("UNSUPPORTED_RECEIPT");
  return new ServiceError("RECEIPT_IO");
}
export async function safeReadFile(root: string, basename: string, maxFileBytes: number): Promise<Buffer> {
  if (typeof basename !== "string" || !basename || basename === "." || basename === ".." || isAbsolute(basename) || /[\0/\\]/u.test(basename) || !Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new ServiceError("INVALID_RECEIPT");
  let handle: FileHandle | undefined;
  try {
    const parents = await directories(root); const path = join(resolve(root), basename);
    const before = await safeFileOperations.lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxFileBytes)) throw new ServiceError("UNSUPPORTED_RECEIPT");
    handle = await safeFileOperations.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !same(before, opened)) throw new ServiceError("UNSUPPORTED_RECEIPT");
    const chunks: Buffer[] = []; let total = 0;
    while (total <= maxFileBytes) {
      const chunk = Buffer.alloc(Math.min(65536, maxFileBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxFileBytes) throw new ServiceError("UNSUPPORTED_RECEIPT");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const entry = await safeFileOperations.lstat(path, { bigint: true });
    await checkDirectories(parents);
    if (!after.isFile() || !entry.isFile() || !same(before, after) || !same(before, entry) || BigInt(total) !== after.size) throw new ServiceError("UNSUPPORTED_RECEIPT");
    return Buffer.concat(chunks, total);
  } catch (error) { throw fixed(error); }
  finally { if (handle) { try { await handle.close(); } catch { throw new ServiceError("RECEIPT_IO"); } } }
}
export async function safeListFiles(root: string): Promise<string[]> {
  try { const parents = await directories(root); const entries = await safeFileOperations.readdir(resolve(root)); await checkDirectories(parents); return entries; }
  catch (error) { throw fixed(error); }
}
