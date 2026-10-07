export type RunStopKind = "aborted" | "deadline";

export class RunStoppedError extends Error {
  readonly kind: RunStopKind;

  constructor(kind: RunStopKind) {
    super(kind === "deadline" ? "Run elapsed-time deadline reached" : "Run aborted");
    this.name = "RunStoppedError";
    this.kind = kind;
  }
}

export function isRunStoppedError(error: unknown): error is RunStoppedError {
  return error instanceof RunStoppedError;
}

/** A single signal and deadline shared by every externally awaited run phase. */
export class RunGuard {
  readonly #controller = new AbortController();
  readonly #external: AbortSignal | undefined;
  readonly #startedAt: number;
  readonly #maxElapsedMs: number;
  readonly #now: () => number;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #onExternalAbort: () => void;
  #kind: RunStopKind | undefined;

  constructor(options: {
    startedAt: number;
    maxElapsedMs: number;
    now: () => number;
    signal?: AbortSignal;
  }) {
    this.#startedAt = options.startedAt;
    this.#maxElapsedMs = options.maxElapsedMs;
    this.#now = options.now;
    this.#external = options.signal;
    this.#onExternalAbort = () => { this.#stop("aborted"); };
    if (this.#external?.aborted) this.#stop("aborted");
    else this.#external?.addEventListener("abort", this.#onExternalAbort, { once: true });

    this.#timer = setTimeout(() => { this.#stop("deadline"); }, this.#maxElapsedMs);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get kind(): RunStopKind | undefined {
    return this.#kind;
  }

  elapsedMs(): number {
    return Math.max(0, this.#now() - this.#startedAt);
  }

  checkpoint(): void {
    if (this.#external?.aborted) this.#stop("aborted");
    if (!this.#kind && this.elapsedMs() >= this.#maxElapsedMs) this.#stop("deadline");
    if (this.#kind) throw new RunStoppedError(this.#kind);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.checkpoint();
    let rejectOnAbort: ((error: RunStoppedError) => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const onAbort = () => {
      rejectOnAbort?.(new RunStoppedError(this.#kind ?? "aborted"));
    };
    this.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const value = await Promise.race([operation(), stopped]);
      this.checkpoint();
      return value;
    } catch (error) {
      this.checkpoint();
      throw error;
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#external?.removeEventListener("abort", this.#onExternalAbort);
  }

  #stop(kind: RunStopKind): void {
    if (this.#kind) return;
    this.#kind = kind;
    this.#controller.abort(new RunStoppedError(kind));
  }
}
