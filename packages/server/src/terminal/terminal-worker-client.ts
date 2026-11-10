import { createConnection } from "node:net";
import { attachFramedSocket, type FramedSocket } from "./terminal-worker-frames.js";
import {
  TERMINAL_WORKER_PROTOCOL_VERSION,
  decodeTerminalWorkerToParentMessage,
  type TerminalWorkerHello,
  type TerminalWorkerHelloAck,
  type TerminalWorkerRequest,
  type TerminalWorkerToParentMessage,
} from "./terminal-worker-protocol.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** The daemon's (or cleanup's) authenticated connection to one terminal worker. */
export interface TerminalWorkerConnection {
  readonly connected: boolean;
  readonly workerPid: number;
  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean;
  /** Closes the socket. The worker keeps running and keeps its terminals. */
  disconnect(): void;
  onMessage(listener: (message: TerminalWorkerToParentMessage) => void): void;
  onClose(listener: () => void): void;
}

export class TerminalWorkerConnectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalWorkerConnectError";
  }
}

// Keeps its own listener lists: a scriptc binary does not reach EventEmitter methods through
// an interface the subclass implements.
class SocketTerminalWorkerConnection implements TerminalWorkerConnection {
  readonly workerPid: number;
  private readonly framed: FramedSocket;
  private closed = false;
  private readonly messageListeners: Array<(message: TerminalWorkerToParentMessage) => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  constructor(framed: FramedSocket, workerPid: number) {
    this.framed = framed;
    this.workerPid = workerPid;
    framed.socket.once("close", () => {
      this.closed = true;
      for (const listener of this.closeListeners.slice()) listener();
    });
  }

  onMessage(listener: (message: TerminalWorkerToParentMessage) => void): void {
    this.messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  get connected(): boolean {
    return !this.closed && !this.framed.socket.destroyed;
  }

  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean {
    return this.framed.send(message, callback);
  }

  disconnect(): void {
    this.framed.close();
  }

  deliver(message: TerminalWorkerToParentMessage): void {
    for (const listener of this.messageListeners.slice()) listener(message);
  }
}

function isHelloAck(message: unknown): message is TerminalWorkerHelloAck {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "helloAck" &&
    typeof (message as { pid?: unknown }).pid === "number"
  );
}

/**
 * Connects to a worker's socket and authenticates with the record's secret. The worker closes
 * the socket on a wrong secret, so a rejected hello surfaces as a connect error.
 */
export function connectTerminalWorker(input: {
  socketPath: string;
  secret: string;
  timeoutMs?: number;
}): Promise<TerminalWorkerConnection> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = createConnection(input.socketPath);
    let connection: SocketTerminalWorkerConnection | null = null;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(
        new TerminalWorkerConnectError(
          `Terminal worker at ${input.socketPath} did not answer within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    const onSocketError = (error: Error): void => {
      fail(
        new TerminalWorkerConnectError(
          `Cannot connect to terminal worker at ${input.socketPath}: ${error.message}`,
          { cause: error },
        ),
      );
    };
    const framed = attachFramedSocket(
      socket,
      (message) => {
        if (connection) {
          connection.deliver(decodeTerminalWorkerToParentMessage(message));
          return;
        }
        if (!isHelloAck(message)) {
          fail(new TerminalWorkerConnectError("Terminal worker sent an unexpected first frame"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        connection = new SocketTerminalWorkerConnection(framed, message.pid);
        resolve(connection);
      },
      onSocketError,
    );
    // `on`, not `once`: an error after authentication must not go unhandled. `close`
    // follows every socket error and ends the connection.
    socket.on("error", onSocketError);
    socket.once("close", () => {
      fail(
        new TerminalWorkerConnectError(
          `Terminal worker at ${input.socketPath} closed the connection during authentication`,
        ),
      );
    });
    socket.once("connect", () => {
      const hello: TerminalWorkerHello = {
        type: "hello",
        secret: input.secret,
        protocolVersion: TERMINAL_WORKER_PROTOCOL_VERSION,
      };
      framed.send(hello);
    });
  });
}
