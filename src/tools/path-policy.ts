import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class PathPolicy {
  readonly root: string;
  readonly #maxFileBytes: number;

  private constructor(root: string, maxFileBytes: number) {
    this.root = root;
    this.#maxFileBytes = maxFileBytes;
  }

  static async create(workspace: string, maxFileBytes: number): Promise<PathPolicy> {
    const root = await realpath(resolve(workspace));
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("Workspace must be a directory");
    return new PathPolicy(root, maxFileBytes);
  }

  #lexicalPath(input: string): string {
    if (!input || input.includes("\0")) throw new Error("Invalid workspace path");
    if (isAbsolute(input) || win32.isAbsolute(input)) throw new Error("Absolute paths are outside the workspace");
    const normalized = input.replace(/\\/gu, "/");
    if (normalized.split("/").some((part) => part === "..")) {
      throw new Error("Path traversal outside the workspace is not allowed");
    }
    const candidate = resolve(this.root, normalized);
    if (!within(this.root, candidate)) throw new Error("Path is outside the workspace");
    return candidate;
  }

  async existingPath(input: string): Promise<string> {
    const lexical = this.#lexicalPath(input);
    const resolved = await realpath(lexical);
    if (!within(this.root, resolved)) throw new Error("Resolved path is outside the workspace");
    return resolved;
  }

  async readPath(input: string): Promise<string> {
    const resolved = await this.existingPath(input);
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("Read target must be a file");
    if (info.size > this.#maxFileBytes) {
      throw new Error(`File exceeds byte limit of ${this.#maxFileBytes}`);
    }
    return resolved;
  }

  async writePath(input: string): Promise<string> {
    const lexical = this.#lexicalPath(input);
    if (await exists(lexical)) {
      const resolved = await realpath(lexical);
      if (!within(this.root, resolved)) throw new Error("Resolved write path is outside the workspace");
      const info = await lstat(lexical);
      if (info.isSymbolicLink()) throw new Error("Writing through a symbolic link is not allowed");
      return resolved;
    }

    let parent = dirname(lexical);
    while (!(await exists(parent))) {
      const next = dirname(parent);
      if (next === parent) throw new Error("Could not find a safe write parent inside workspace");
      parent = next;
    }
    const resolvedParent = await realpath(parent);
    if (!within(this.root, resolvedParent)) throw new Error("Resolved write parent is outside the workspace");
    return lexical;
  }
}
