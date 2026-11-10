import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import pLimit from "p-limit";
import { ZodError } from "zod";

// Node path of the plugin compiler, as upstream. It is JavaScript because scriptc refuses its
// Worker (an eval entry point, a computed URL), the p-limit queue and the indexed result type
// in TypeScript, and in JavaScript they only throw if they run; a scriptc binary never calls
// this. compiler.ts declares the task and result types.

const IDLE_TIMEOUT_MS = 1_000;

/**
 * The members of worker_threads' Worker this file uses. Not the real type: naming
 * node:worker_threads, even in JSDoc, puts a worker into the scriptc program.
 * @typedef {import("node:events").EventEmitter & {
 *   ref(): void,
 *   unref(): void,
 *   terminate(): Promise<number>,
 *   postMessage(value: unknown, transferList: unknown[]): void,
 * }} Worker
 */

// Loaded when the first worker starts, with a specifier scriptc cannot fold: a program that
// contains worker_threads cannot also use native callbacks from other threads, which the
// native terminal and speech shims need.
const WORKER_THREADS_MODULE = ["node", "worker_threads"].join(":");
const require = createRequire(import.meta.url);

// Reuse the isolate during a build batch (notably daemon bootstrap), then release
// TypeScript's heap when idle. Only this owner admits work or stops the worker.
class PluginCompiler {
  /** @param {string | URL} workerEntrypoint @param {boolean} source */
  constructor(workerEntrypoint, source) {
    this.workerEntrypoint = workerEntrypoint;
    this.source = source;
    this.queue = pLimit(1);
    /** @type {Worker | null} */
    this.worker = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.idleTimer = null;
    /** @type {Promise<unknown>} */
    this.stopping = Promise.resolve();
  }

  /**
   * @param {import("./compiler.js").CompilerTask} task
   * @param {((data: Record<string, unknown>, message: string) => void) | undefined} onLog
   * @returns {Promise<unknown>}
   */
  run(task, onLog) {
    return this.queue(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      await this.stopping;
      const worker = this.worker ?? this.startWorker();
      worker.ref();
      try {
        return await this.request(worker, task, onLog);
      } finally {
        if (this.worker === worker) {
          worker.unref();
          this.idleTimer = setTimeout(() => this.stopWorker(worker), IDLE_TIMEOUT_MS);
          this.idleTimer.unref();
        } else {
          await this.stopping;
        }
      }
    });
  }

  /** @returns {Worker} */
  startWorker() {
    /** @type {{ Worker: new (entry: string | URL, options: { eval: boolean, execArgv: string[] }) => Worker }} */
    const workerThreads = require(WORKER_THREADS_MODULE);
    const worker = new workerThreads.Worker(this.workerEntrypoint, {
      eval: this.source,
      execArgv: [],
    });
    this.worker = worker;
    // Keep error/exit ownership while idle too. The next caller gets a fresh
    // isolate after a crash; author build commands are never retried.
    worker.on("error", () => this.stopWorker(worker));
    worker.on("exit", () => {
      if (this.worker === worker) this.stopWorker(worker);
    });
    return worker;
  }

  /** @param {Worker} worker */
  stopWorker(worker) {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.stopping = worker.terminate();
  }

  /**
   * @param {Worker} worker
   * @param {import("./compiler.js").CompilerTask} task
   * @param {((data: Record<string, unknown>, message: string) => void) | undefined} onLog
   * @returns {Promise<unknown>}
   */
  async request(worker, task, onLog) {
    /** @type {(reply: import("./compiler-worker.js").CompilerReply) => void} */
    let onMessage = () => undefined;
    /** @type {(error: Error) => void} */
    let onError = () => undefined;
    /** @type {(code: number) => void} */
    let onExit = () => undefined;
    try {
      return await new Promise((resolve, reject) => {
        onError = reject;
        onExit = (code) => reject(new Error(`Plugin compiler worker exited (code ${code})`));
        onMessage = (reply) => {
          if (reply.kind === "log") {
            onLog?.(reply.data, reply.message);
          } else if (reply.kind === "result") {
            resolve(reply.value);
          } else {
            const error = reply.issues ? new ZodError(reply.issues) : reply.error;
            Object.assign(error, reply.properties);
            if (reply.errors) Object.assign(error, { errors: reply.errors });
            if (reply.warnings) Object.assign(error, { warnings: reply.warnings });
            // Promise.all can reject while the other target is still compiling.
            // Retire the isolate before another request can enter it.
            this.stopWorker(worker);
            reject(error);
          }
        };
        worker.on("error", onError);
        worker.on("exit", onExit);
        worker.on("message", onMessage);
        worker.postMessage(task, []);
      });
    } finally {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    }
  }
}

/**
 * @param {string} compilerModuleUrl
 */
export function createNodePluginCompiler(compilerModuleUrl) {
  const source = compilerModuleUrl.endsWith(".ts");
  const workerUrl = new URL(
    source ? "./compiler-worker.ts" : "./compiler-worker.js",
    compilerModuleUrl,
  );
  // Resolve the development loader once at module initialization, never during a
  // compile request. Packaged workers execute ordinary JavaScript without tsx.
  const workerEntrypoint = source
    ? `import(${JSON.stringify(pathToFileURL(createRequire(compilerModuleUrl).resolve("tsx/esm/api")).href)}).then(({ register }) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`
    : workerUrl;
  return new PluginCompiler(workerEntrypoint, source);
}
