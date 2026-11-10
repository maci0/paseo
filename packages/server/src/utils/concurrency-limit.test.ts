import pLimit from "p-limit";
import { describe, expect, it } from "vitest";

import { ConcurrencyLimit } from "./concurrency-limit.js";

interface Deferred {
  promise: Promise<string>;
  resolve: (value: string) => void;
}

function deferred(): Deferred {
  let resolve: (value: string) => void = () => {};
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Limiter {
  run: (task: () => Promise<string>) => Promise<string>;
  counts: () => [number, number];
  clearQueue: () => void;
}

function ours(rejectOnClear: boolean): Limiter {
  const limit = new ConcurrencyLimit(2, { rejectOnClear });
  return {
    run: (task) => limit.run(task),
    counts: () => [limit.activeCount, limit.pendingCount],
    clearQueue: () => limit.clearQueue(),
  };
}

function reference(rejectOnClear: boolean): Limiter {
  const limit = pLimit({ concurrency: 2, rejectOnClear });
  return {
    run: (task) => limit(task),
    counts: () => [limit.activeCount, limit.pendingCount],
    clearQueue: () => limit.clearQueue(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Runs one scenario and records counts and settlements, so both limiters can be compared. */
async function scenario(limiter: Limiter): Promise<string[]> {
  const log: string[] = [];
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const settled = gates.map((gate, index) =>
    limiter
      .run(async () => {
        log.push(`start ${index}`);
        return gate.promise;
      })
      .then(
        (value) => log.push(`resolved ${index} ${value}`),
        (error: unknown) =>
          log.push(`rejected ${index} ${error instanceof Error ? error.name : String(error)}`),
      ),
  );
  log.push(`sync counts ${limiter.counts().join("/")}`);
  await flush();
  log.push(`started counts ${limiter.counts().join("/")}`);
  limiter.clearQueue();
  log.push(`cleared counts ${limiter.counts().join("/")}`);
  await flush();
  gates[0]!.resolve("a");
  gates[1]!.resolve("b");
  await flush();
  log.push(`final counts ${limiter.counts().join("/")}`);
  await Promise.race([Promise.all(settled), flush()]);
  return log;
}

describe("ConcurrencyLimit", () => {
  it("counts active and pending tasks and rejects cleared tasks with an AbortError", async () => {
    const log = await scenario(ours(true));
    expect(log).toEqual([
      "sync counts 2/2",
      "start 0",
      "start 1",
      "started counts 2/2",
      "cleared counts 2/0",
      "rejected 2 AbortError",
      "rejected 3 AbortError",
      "resolved 0 a",
      "resolved 1 b",
      "final counts 0/0",
    ]);
  });

  it("leaves cleared tasks pending without rejectOnClear", async () => {
    const log = await scenario(ours(false));
    expect(log).toEqual([
      "sync counts 2/2",
      "start 0",
      "start 1",
      "started counts 2/2",
      "cleared counts 2/0",
      "resolved 0 a",
      "resolved 1 b",
      "final counts 0/0",
    ]);
  });

  it("matches p-limit 7", async () => {
    expect(await scenario(ours(true))).toEqual(await scenario(reference(true)));
    expect(await scenario(ours(false))).toEqual(await scenario(reference(false)));
  });

  it("rejects with the same reason as p-limit", async () => {
    const limit = new ConcurrencyLimit(1, { rejectOnClear: true });
    const gate = deferred();
    void limit.run(async () => gate.promise);
    const queued = limit.run(async () => "never");
    limit.clearQueue();
    const reason: unknown = await queued.catch((error: unknown) => error);
    const expected: unknown = AbortSignal.abort().reason;
    expect(reason).toBeInstanceOf(DOMException);
    expect((reason as DOMException).name).toBe((expected as DOMException).name);
    expect((reason as DOMException).message).toBe((expected as DOMException).message);
    gate.resolve("done");
  });

  it("starts the next queued task when a task throws synchronously", async () => {
    const limit = new ConcurrencyLimit(1);
    const failing = limit.run(() => {
      throw new Error("boom");
    });
    const next = limit.run(async () => "next");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("next");
    expect([limit.activeCount, limit.pendingCount]).toEqual([0, 0]);
  });
});
