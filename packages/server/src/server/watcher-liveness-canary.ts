import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange } from "./file-observer/index.js";

export const WATCHER_LIVENESS_CANARY_TIMEOUT_MS = 10_000;
const CANARY_CONTENTS = "paseo watcher liveness canary\n";

export interface WatcherLivenessCanary {
  readonly path: string;
  filterEvents(events: FileChange[]): FileChange[];
  verify(signal?: AbortSignal): Promise<void>;
}

export function createWatcherLivenessCanary(
  watchRoot: string,
  options: { timeoutMs?: number } = {},
): WatcherLivenessCanary {
  const canaryPath = join(watchRoot, `.paseo-watcher-canary-${randomUUID()}`);
  const timeoutMs = options.timeoutMs ?? WATCHER_LIVENESS_CANARY_TIMEOUT_MS;
  let reportCanary!: () => void;
  const reported = new Promise<void>((resolve) => {
    reportCanary = resolve;
  });

  return {
    path: canaryPath,
    filterEvents(events) {
      const filtered = events.filter((event) => event.path !== canaryPath);
      if (filtered.length !== events.length) {
        reportCanary();
      }
      return filtered;
    },
    async verify(signal) {
      await writeFile(canaryPath, CANARY_CONTENTS, { flag: "wx" });
      // Native registration can return before macOS starts its FSEvents stream.
      // Keep probing until an event round-trips instead of relying on the first write.
      const pulses = new AbortController();
      const pulsing = pulseCanary(canaryPath, pulses.signal);
      let timeout: NodeJS.Timeout | null = null;
      let removeAbortListener = () => {};
      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Watcher for ${watchRoot} did not report its liveness canary within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        });
        const abortPromise = new Promise<never>((_resolve, reject) => {
          if (!signal) return;
          const rejectForAbort = () => reject(signal.reason);
          if (signal.aborted) {
            rejectForAbort();
            return;
          }
          signal.addEventListener("abort", rejectForAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", rejectForAbort);
        });
        await Promise.race([reported, timeoutPromise, abortPromise, pulsing]);
      } finally {
        if (timeout) clearTimeout(timeout);
        removeAbortListener();
        pulses.abort();
        await Promise.allSettled([pulsing]);
        await rm(canaryPath, { force: true });
      }
    },
  };
}

const CANARY_PULSE_INTERVAL_MS = 100;

// scriptc's timers/promises setInterval takes no AbortSignal, so each pulse waits on a
// plain timer that an abort clears. Resolves false once the signal aborts.
function waitForNextPulse(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  let settle: (pulse: boolean) => void = () => {};
  const next = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const onAbort = () => {
    clearTimeout(timer);
    settle(false);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    settle(true);
  }, CANARY_PULSE_INTERVAL_MS);
  signal.addEventListener("abort", onAbort, { once: true });
  return next;
}

async function pulseCanary(path: string, signal: AbortSignal): Promise<void> {
  try {
    while (await waitForNextPulse(signal)) {
      await writeFile(path, CANARY_CONTENTS);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}
