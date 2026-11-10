import { maxSecuredPlaintextByteLength } from "@getpaseo/relay";
import { MAX_RELAY_WEBSOCKET_MESSAGE_BYTES } from "@getpaseo/protocol/websocket-message-limit";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./physical-socket.js";

export interface EncryptedRelayChannel {
  send: (data: string | ArrayBuffer) => Promise<void>;
  outboundWireByteLength: (data: string | ArrayBuffer) => number;
  close: (code?: number, reason?: string) => void;
}

export interface EncryptedRelaySocket {
  readonly maxFrameBytes: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void | Promise<void>;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

type RelaySocketEvent = "message" | "close" | "error";
type RelaySocketListener = (...args: unknown[]) => void;

/** The EventEmitter members relay sockets use; node:events EventEmitter satisfies it. */
export interface RelaySocketEmitter {
  on(event: RelaySocketEvent, listener: RelaySocketListener): unknown;
  once(event: "close" | "error", listener: RelaySocketListener): unknown;
  emit(event: RelaySocketEvent, ...args: unknown[]): boolean;
}

interface RelaySocketListenerEntry {
  listener: RelaySocketListener;
  once: boolean;
}

// scriptc has no spread arguments; relay socket events carry at most two arguments.
function callRelaySocketListener(listener: RelaySocketListener, args: unknown[]): void {
  if (args.length === 0) listener();
  else if (args.length === 1) listener(args[0]);
  else if (args.length === 2) listener(args[0], args[1]);
  else throw new Error(`Relay socket events take at most two arguments, got ${args.length}`);
}

/**
 * EventEmitter semantics for the three relay socket events: listeners run in registration
 * order over a snapshot, `once` listeners are removed before they run, and an `error` with
 * no listener throws (the Error itself, as EventEmitter does).
 *
 * scriptc gives every literal EventEmitter event name one argument tuple across the whole
 * program, and "message" and "close" carry other payloads elsewhere in the daemon.
 */
export class RelaySocketEvents implements RelaySocketEmitter {
  private readonly message: RelaySocketListenerEntry[] = [];
  private readonly close: RelaySocketListenerEntry[] = [];
  private readonly error: RelaySocketListenerEntry[] = [];

  on(event: RelaySocketEvent, listener: RelaySocketListener): this {
    this.entries(event).push({ listener, once: false });
    return this;
  }

  once(event: "close" | "error", listener: RelaySocketListener): this {
    this.entries(event).push({ listener, once: true });
    return this;
  }

  emit(event: RelaySocketEvent, ...args: unknown[]): boolean {
    const entries = this.entries(event);
    if (entries.length === 0) {
      if (event === "error") {
        const error = args[0];
        throw error instanceof Error ? error : new Error(`Unhandled error. (${String(error)})`);
      }
      return false;
    }
    for (const entry of entries.slice()) {
      if (entry.once) {
        const index = entries.indexOf(entry);
        if (index !== -1) entries.splice(index, 1);
      }
      callRelaySocketListener(entry.listener, args);
    }
    return true;
  }

  private entries(event: RelaySocketEvent): RelaySocketListenerEntry[] {
    if (event === "message") return this.message;
    if (event === "close") return this.close;
    return this.error;
  }
}

export function createEncryptedRelaySocket(params: {
  channel: EncryptedRelayChannel;
  emitter: RelaySocketEmitter;
  getTransportBufferedAmount: () => number | undefined;
  terminateTransport: () => void;
}): EncryptedRelaySocket {
  const { channel, emitter, getTransportBufferedAmount, terminateTransport } = params;
  let readyState = 1;

  const terminate = () => {
    if (readyState === 3) return;
    readyState = 3;
    terminateTransport();
  };

  const close = (code?: number, reason?: string) => {
    if (readyState === 3) return;
    readyState = 3;
    channel.close(code, reason);
  };

  emitter.on("close", () => {
    readyState = 3;
  });

  return {
    maxFrameBytes: maxSecuredPlaintextByteLength(MAX_RELAY_WEBSOCKET_MESSAGE_BYTES),
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return getTransportBufferedAmount() ?? 0;
    },
    send: (data) => {
      if (readyState !== 1) {
        return Promise.reject(new Error("Encrypted relay socket is not open"));
      }
      const outbound = normalizeRelaySendPayload(data);
      const outboundBytes = channel.outboundWireByteLength(outbound);
      const queuedBytes = getTransportBufferedAmount() ?? 0;
      if (queuedBytes + outboundBytes > MAX_PHYSICAL_SOCKET_BUFFERED_BYTES) {
        terminate();
        return Promise.reject(
          new Error("Encrypted relay socket exceeded its outbound high-water mark"),
        );
      }
      return channel.send(outbound).catch((error) => {
        emitter.emit("error", error);
        throw error;
      });
    },
    close,
    terminate,
    on: (event, listener) => {
      emitter.on(event, listener);
    },
    once: (event, listener) => {
      emitter.once(event, listener);
    },
  };
}

function normalizeRelaySendPayload(data: string | Uint8Array | ArrayBuffer): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out.buffer;
}
