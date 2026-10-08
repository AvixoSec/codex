import { randomUUID } from "node:crypto";
import { open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Internal Node-only operation seam; callers normally use atomicReplace. */
export const atomicFileOperations = { open, realpath, rename, stat, unlink, randomUUID };

export async function atomicReplace(path: string, bytes: Uint8Array): Promise<void> {
  const fs = atomicFileOperations;
  const parent = await fs.realpath(dirname(resolve(path)));
  if (!(await fs.stat(parent)).isDirectory()) throw new Error("Invalid destination directory.");
  const destination = join(parent, basename(path));
  const temporary = join(parent, ".jevh-" + fs.randomUUID() + ".tmp");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let renamed = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600); created = true;
    await handle.writeFile(bytes); await handle.chmod(0o600);
    await handle.sync(); await handle.close(); handle = undefined;
    await fs.rename(temporary, destination); renamed = true;
    let directory: Awaited<ReturnType<typeof open>> | undefined;
    try { directory = await fs.open(parent, "r"); await directory.sync(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Linux/macOS reject directory fsync with EINVAL/ENOTSUP. Windows
      // additionally does not allow opening directories with ordinary open.
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && !(process.platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES"))) throw error;
    } finally { await directory?.close(); }
  } finally {
    try { await handle?.close(); }
    finally { if (created && !renamed) await fs.unlink(temporary); }
  }
}
