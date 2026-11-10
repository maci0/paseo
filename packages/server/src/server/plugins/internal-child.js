import { PassThrough } from "node:stream";
import { createPluginWorker } from "./plugin-process.js";

// The in-process child of a built-in plugin, with the parts of a forked ChildProcess the runtime
// uses. It keeps its own listener lists instead of extending EventEmitter: a scriptc binary
// cannot call an EventEmitter subclass written in JavaScript, and in TypeScript scriptc requires
// every emit of one event name to agree on its arguments across the program, which this "close"
// (code, signal) and the streams' argument-less "close" do not. Listeners run synchronously in
// registration order, and a throwing listener stops the rest, as with EventEmitter.
export class InternalPluginChild {
  /** @param {import("@getpaseo/plugin/server").PluginServerContribution} contribute */
  constructor(contribute) {
    /** @type {boolean} */
    this.connected = true;
    /** @type {boolean} */
    this.killed = false;
    /** @type {PassThrough} */
    this.stdout = new PassThrough();
    /** @type {PassThrough} */
    this.stderr = new PassThrough();
    /** @type {Array<(message: unknown) => void>} */
    this.messageListeners = [];
    /** @type {Array<(code: number | null, signal: NodeJS.Signals | null) => void>} */
    this.closeListeners = [];
    /** @type {Set<(message: import("./plugin-process-protocol.js").PluginProcessRequest) => void>} */
    this.workerMessages = new Set();
    /** @type {Promise<void> | null} */
    this.closing = null;
    // Each parameter carries its own JSDoc type: scriptc does not type them from the channel's.
    /** @type {import("./plugin-process.js").PluginWorkerChannel} */
    const channel = {
      send: (
        /** @type {import("./plugin-process-protocol.js").PluginProcessMessage} */ message,
        /** @type {(() => void) | undefined} */ callback,
      ) => {
        const copy = structuredClone(message);
        queueMicrotask(() => {
          if (this.connected) {
            for (const listener of this.messageListeners.slice()) listener(copy);
          }
          callback?.();
        });
      },
      onMessage: (
        /** @type {(message: import("./plugin-process-protocol.js").PluginProcessRequest) => void} */ handler,
      ) => {
        this.workerMessages.add(handler);
        return () => this.workerMessages.delete(handler);
      },
      disconnect: () => this.disconnect(),
    };
    this.worker = createPluginWorker({ channel, contribute });
  }

  /**
   * @param {"message" | "close"} event
   * @param {((message: unknown) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)} listener
   * @returns {this}
   */
  on(event, listener) {
    if (event === "message") this.messageListeners.push(listener);
    else this.closeListeners.push(listener);
    return this;
  }

  /**
   * @param {import("./plugin-process-protocol.js").PluginProcessRequest} message
   * @param {(error: Error | null) => void} [callback]
   * @returns {boolean}
   */
  send(message, callback) {
    if (!this.connected) {
      callback?.(new Error("Plugin child is disconnected"));
      return false;
    }
    const copy = structuredClone(message);
    queueMicrotask(() => {
      for (const handler of this.workerMessages) handler(copy);
      callback?.(null);
    });
    return true;
  }

  /** @returns {boolean} */
  kill() {
    if (this.killed) return false;
    this.killed = true;
    this.disconnect();
    return true;
  }

  /** @returns {void} */
  disconnect() {
    if (this.closing) return;
    this.closing = Promise.resolve()
      .then(() => this.worker.shutdown())
      .finally(() => {
        this.connected = false;
        this.stdout.end();
        this.stderr.end();
        for (const listener of this.closeListeners.slice()) listener(0, null);
      });
  }
}
