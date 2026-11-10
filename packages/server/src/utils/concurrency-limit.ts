/**
 * p-limit's queue for callers whose tasks resolve to class instances (Stats, Dirent[]).
 *
 * scriptc compiles p-limit as untyped JS and refuses to pass a function returning a value
 * that is not JSON-safe through its `unknown` slots (SC1101), and it has no generic function
 * values, so a typed p-limit stand-in cannot exist either. A class with a generic method
 * compiles. Same scheduling as p-limit 7: FIFO, and a task starts on a later microtask once
 * a slot is free. `activeCount`, `pendingCount`, `clearQueue()` and `rejectOnClear` behave
 * as in p-limit 7.
 */
export class ConcurrencyLimit {
  private active = 0;
  private readonly queue: Array<{ start: () => void; reject: (reason: Error) => void }> = [];
  private readonly rejectOnClear: boolean;

  constructor(
    private readonly concurrency: number,
    options: { rejectOnClear?: boolean } = {},
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError("Expected `concurrency` to be a number from 1 and up");
    }
    this.rejectOnClear = options.rejectOnClear === true;
  }

  /** Tasks that hold a slot: started, or dequeued and starting on the next microtask. */
  get activeCount(): number {
    return this.active;
  }

  /** Tasks waiting for a slot. */
  get pendingCount(): number {
    return this.queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    // The slot wait is a Promise<void>: scriptc's IR stage rejects a generic
    // `new Promise<T>` here in the daemon program (SC9001).
    await new Promise<void>((resolve, reject: (reason: Error) => void) => {
      this.queue.push({ start: resolve, reject });
      this.resumeNext();
    });
    try {
      return await task();
    } finally {
      this.next();
    }
  }

  /**
   * Drops the tasks waiting for a slot; running tasks are not affected. With `rejectOnClear`
   * their promises reject with `AbortSignal.abort().reason`, otherwise they never settle.
   */
  clearQueue(): void {
    const dropped = this.queue.splice(0);
    if (!this.rejectOnClear) return;
    // An `Error`: scriptc types promise rejections as `Error`. Node's reason is a DOMException.
    const reason: unknown = AbortSignal.abort().reason;
    const abortError = reason instanceof Error ? reason : new Error(String(reason));
    for (const entry of dropped) entry.reject(abortError);
  }

  private resumeNext(): void {
    if (this.active >= this.concurrency) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.active += 1;
    void Promise.resolve().then(entry.start);
  }

  private next(): void {
    this.active -= 1;
    this.resumeNext();
  }
}
