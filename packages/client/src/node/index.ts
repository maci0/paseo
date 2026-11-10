export { createHostChannelTransport } from "../hosts/index.js";
import { HostTransportBudget } from "./buffering.js";
export { HostTransportBudget } from "./buffering.js";
import { homedir } from "node:os";
import type { Agent } from "node:http";
import { WebSocket } from "ws";
import { parseHostTarget, type HostTarget } from "@getpaseo/protocol/host-target";
import { createSshTunnel, type SshTunnel } from "./ssh-tunnel.js";
import { createWebSocketTransportFactory } from "../daemon-client-websocket-transport.js";
import { createRelayE2eeTransportFactory } from "../daemon-client-relay-e2ee-transport.js";
import type { SecurityMode } from "@getpaseo/relay/e2ee";
import type {
  DaemonTransport,
  DaemonTransportFactory,
  WebSocketLike,
} from "../daemon-client-transport-types.js";
import { DaemonClient, type DaemonClientConfig } from "../daemon-client.js";

export { parseHostTarget };
export type { SshTunnel } from "./ssh-tunnel.js";
export { createSshTunnel, resolveSshFailureDetail } from "./ssh-tunnel.js";

export interface HostTransportOptions {
  webSocketAgent?: (url: string) => Agent | undefined;
}

type SocketSendData = Parameters<WebSocket["send"]>[0];
type SocketSendCallback = (err?: Error) => void;
interface SocketSendOptions {
  mask?: boolean;
  binary?: boolean;
  compress?: boolean;
  fin?: boolean;
}

/**
 * A ws socket whose sends are charged to the host transport budget until ws
 * reports them written. A subclass, because scriptc cannot reassign `socket.send`.
 */
class BudgetedWebSocket extends WebSocket {
  assertCapacity: (bytes: number) => void = () => {};
  reserve: (bytes: number) => () => void = () => () => {};
  private readonly pendingReleases = new Set<() => void>();

  override send(data: SocketSendData, cb?: SocketSendCallback): void;
  override send(data: SocketSendData, options: SocketSendOptions, cb?: SocketSendCallback): void;
  override send(
    data: SocketSendData,
    optionsOrCallback?: SocketSendOptions | SocketSendCallback,
    cb?: SocketSendCallback,
  ): void {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : cb;
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    const bytes =
      typeof data === "string" ? Buffer.byteLength(data) : Buffer.byteLength(data as Uint8Array);
    this.assertCapacity(bytes);
    const release = this.reserve(bytes);
    this.pendingReleases.add(release);
    try {
      super.send(data, options ?? {}, (error) => {
        release();
        this.pendingReleases.delete(release);
        callback?.(error);
      });
    } catch (error) {
      release();
      this.pendingReleases.delete(release);
      throw error;
    }
  }

  /** terminate(), callable from a stored closure: scriptc rejects that call written outside the class (SC3004). */
  forceClose(): void {
    this.terminate();
  }

  releasePending(): void {
    for (const release of this.pendingReleases) release();
    this.pendingReleases.clear();
  }
}

/**
 * Registers a close listener through the loose socket interface: scriptc rejects
 * `.on()` called on the ws class itself (SC3004). The JSDoc types are for scriptc,
 * which compiles this file from dist JS where the TypeScript annotations are gone.
 * @param {import("../daemon-client-transport-types.js").WebSocketLike} socket
 * @param {() => void} listener
 * @returns {void}
 */
function onSocketClose(socket: WebSocketLike, listener: () => void): void {
  socket.on?.("close", listener);
}

/** A factory owns one attempt, including a fresh SSH process and its teardown. */
export function createHostTransportFactory(
  connection: string,
  budget = new HostTransportBudget(),
  options: HostTransportOptions = {},
): DaemonTransportFactory {
  const target: HostTarget = parseHostTarget(connection);
  // Rises to "protected" once the daemon negotiates it, so a later attempt
  // cannot be downgraded to legacy endpoint security.
  let securityFloor: SecurityMode | undefined;
  if (target.kind === "socket" && target.offer) securityFloor = target.offer.minimumSecurityMode;
  return (attemptOptions) => {
    const opens = new Set<() => void>();
    const closes = new Set<(event?: unknown) => void>();
    const errors = new Set<(event?: unknown) => void>();
    const messages = new Set<(data: unknown, binary: boolean) => void>();
    let closed = false;
    let closeEvent: unknown;
    let transport: DaemonTransport | undefined;
    let teardown = () => {};
    let disposeSocket = () => {};
    let assertOutboundCapacity = (bytes: number) => budget.assertCapacity(bytes);
    let sshTunnel: SshTunnel | null = null;
    const close = (code?: number, reason?: string) => {
      if (closed) return;
      closed = true;
      try {
        transport?.close(code, reason);
      } finally {
        try {
          disposeSocket();
          teardown();
        } finally {
          for (const handler of closes) handler(closeEvent);
        }
      }
    };
    const wrapper: DaemonTransport = {
      supportsDrain: undefined,
      maxFrameBytes: undefined,
      send(data) {
        if (closed || !transport) throw new Error("Host transport is unavailable");
        return transport.send(data);
      },
      close,
      onOpen(handler) {
        opens.add(handler);
        return () => opens.delete(handler);
      },
      onClose(handler) {
        closes.add(handler);
        return () => closes.delete(handler);
      },
      onError(handler) {
        errors.add(handler);
        return () => errors.delete(handler);
      },
      onMessage(handler) {
        messages.add(handler);
        return () => messages.delete(handler);
      },
    };
    void (async () => {
      let socketTarget: Extract<HostTarget, { kind: "socket" }>;
      if (target.kind === "ssh") {
        const tunnel = await createSshTunnel(target.ssh);
        sshTunnel = tunnel;
        teardown = () => tunnel.close();
        const tunnelTarget: HostTarget = parseHostTarget(tunnel.endpoint);
        if (tunnelTarget.kind !== "socket") throw new Error("SSH tunnel endpoint is not a socket");
        socketTarget = tunnelTarget;
      } else socketTarget = target;
      if (closed) {
        teardown();
        return;
      }
      const socketPath = socketTarget.socketPath?.replace(/^~(?=\/)/, homedir());
      let factory = createWebSocketTransportFactory((url, socketOptions) => {
        const socket = new BudgetedWebSocket(
          socketPath && url.startsWith("ws+unix:") ? `ws+unix://${socketPath}:/ws` : url,
          socketOptions?.protocols,
          {
            headers: socketOptions?.headers,
            agent: socketPath ? undefined : options.webSocketAgent?.(url),
            ...(socketPath ? { socketPath } : {}),
            maxPayload: 100 * 1024 * 1024,
          },
        );
        disposeSocket = () => socket.forceClose();
        assertOutboundCapacity = (bytes) => {
          if (socket.bufferedAmount + bytes > 128 * 1024 * 1024) {
            throw Object.assign(new Error("Host socket buffer limit reached"), {
              code: "resource_limit",
            });
          }
          budget.assertCapacity(bytes);
        };
        socket.assertCapacity = (bytes) => assertOutboundCapacity(bytes);
        socket.reserve = (bytes) => budget.reserve(bytes);
        const socketLike = socket as unknown as WebSocketLike;
        onSocketClose(socketLike, () => socket.releasePending());
        return socketLike;
      });
      if (socketTarget.offer)
        factory = createRelayE2eeTransportFactory({
          baseFactory: factory,
          daemonPublicKeyB64: socketTarget.offer.daemonPublicKeyB64,
          ...(securityFloor ? { minimumMode: securityFloor } : {}),
          onSecurityMode: (mode) => {
            if (mode === "protected") securityFloor = "protected";
          },
          logger: { warn() {} },
          assertOutboundCapacity: (bytes) => assertOutboundCapacity(bytes),
        });
      transport = factory({ ...attemptOptions, url: socketTarget.url });
      wrapper.supportsDrain = transport.supportsDrain;
      wrapper.maxFrameBytes = transport.maxFrameBytes;
      transport.onOpen(() => {
        if (!closed) for (const handler of opens) handler();
      });
      transport.onClose((event) => {
        closeEvent = event;
        close();
      });
      transport.onError((error) => {
        if (closed) return;
        const detail = sshTunnel?.failureDetail() ?? "";
        const failure =
          /permission denied|authentication failed|host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
            detail,
          )
            ? Object.assign(
                new Error(
                  "SSH authentication or host verification failed. Check the SSH configuration on this daemon.",
                ),
                { code: "authentication_failed" },
              )
            : error;
        for (const handler of errors) handler(failure);
        close();
      });
      transport.onMessage((data, binary) => {
        if (!closed) for (const handler of messages) handler(data, binary);
      });
    })().catch(() => {
      for (const handler of errors) handler(new Error("Host transport failed"));
      close();
    });
    return wrapper;
  };
}
export function createHostClient(
  connection: string,
  config: Omit<DaemonClientConfig, "url" | "transportFactory"> & HostTransportOptions,
  budget?: HostTransportBudget,
): DaemonClient {
  const target: HostTarget = parseHostTarget(connection);
  // scriptc cannot pack a rest binding of this type, so config is spread whole;
  // DaemonClient ignores the extra webSocketAgent key.
  const { webSocketAgent } = config;
  return new DaemonClient({
    ...config,
    url: "ws://host-connector/ws",
    ...(target.password ? { password: target.password } : {}),
    transportFactory: createHostTransportFactory(connection, budget, { webSocketAgent }),
  });
}
