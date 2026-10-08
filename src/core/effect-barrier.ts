/** Owns the exact effect promises independently of a guard's abort race. */
export class EffectBarrier {
  private readonly pending = new Set<Promise<unknown>>();

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(Array.from(this.pending));
  }
}
