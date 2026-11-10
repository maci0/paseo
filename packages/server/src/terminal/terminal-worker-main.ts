import { createTerminalReplayController } from "./terminal-replay.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { currentBootId } from "../server/pid-lock.js";
import { PRIVATE_FILE_MODE } from "../server/private-files.js";
import { createTerminalManager } from "./terminal-manager.js";
import {
  TERMINAL_OUTPUT_COALESCER_GLOBAL_TIMERS,
  TerminalOutputCoalescer,
} from "./terminal-output-coalescer.js";
import type { TerminalExitInfo, LocalTerminalSession } from "./terminal.js";
import { attachFramedSocket, type FramedSocket } from "./terminal-worker-frames.js";
import { createTerminalWorkerProcessInspector } from "./terminal-worker-processes.js";
import {
  TERMINAL_WORKER_MARKER_ARG,
  terminalWorkerRecordPath,
  writeTerminalWorkerRecord,
  type TerminalWorkerRecord,
} from "./terminal-worker-record.js";
import { createTerminalWorkerRecordPublisher } from "./terminal-worker-record-publisher.js";
import { resolveTerminalWorkerSocketPath } from "./terminal-worker-socket-path.js";
import {
  TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV,
  TERMINAL_WORKER_PROTOCOL_VERSION,
  decodeTerminalWorkerRequest,
  type TerminalWorkerHello,
  type TerminalWorkerHelloAck,
  type TerminalWorkerListResult,
  type TerminalWorkerRequest,
  type TerminalWorkerToParentMessage,
  type WorkerTerminalInfo,
} from "./terminal-worker-protocol.js";

// The terminal worker and the launcher arguments, shared by the two process entries:
// terminal-worker-process.ts under Node and terminal-worker-native-process.ts in a scriptc
// binary. Each entry starts the worker detached and passes how it reports readiness.

export const LAUNCH_ARG = "--launch";
export const READY_TIMEOUT_MS = 15_000;
const HELLO_TIMEOUT_MS = 5_000;
// A freshly launched worker waits this long for its first controller before giving up.
const FIRST_CONTROLLER_TIMEOUT_MS = 30_000;
// While nobody controls it, the worker checks that its record still exists. A deleted record
// (a removed $PASEO_HOME) means no daemon can ever find these terminals again.
const ORPHAN_CHECK_INTERVAL_MS = 10_000;

export interface WorkerArgs {
  recordId: string;
  paseoHome: string;
  paseoVersion: string;
  // The copy under terminal-worker/ this worker runs from; absent when it runs from source.
  runtime: string | null;
}

function readArg(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) {
    throw new Error(`Terminal worker requires ${name}`);
  }
  return value;
}

export function parseWorkerArgs(argv: string[], recordIdArg: string): WorkerArgs {
  return {
    recordId: readArg(argv, recordIdArg),
    paseoHome: readArg(argv, "--paseo-home"),
    paseoVersion: readArg(argv, "--paseo-version"),
    runtime: argv.includes("--runtime") ? readArg(argv, "--runtime") : null,
  };
}

// The protocol version this worker reports in its record and hello. Tests override it to stand
// up older and newer workers from one build.
function reportedProtocolVersion(): number {
  const override = process.env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV];
  if (override === undefined || override === "") return TERMINAL_WORKER_PROTOCOL_VERSION;
  const parsed = Number(override);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV} is not an integer: ${override}`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the launcher prints and its exit code for the worker's first ready-channel line. */
export function launcherResultForReadyLine(
  line: string,
  workerPid: number | undefined,
): { code: number; output: string } {
  if (line.startsWith("ready ")) {
    return {
      code: 0,
      output: `${JSON.stringify({ pid: workerPid, socketPath: line.slice("ready ".length) })}\n`,
    };
  }
  return { code: 1, output: `${line.startsWith("error ") ? line.slice("error ".length) : line}\n` };
}

type TerminalCreateRequest = Extract<TerminalWorkerRequest, { type: "createTerminal" }>;

/**
 * Runs the worker. `reportReady` receives `ready <socketPath>` once it listens, or
 * `error <message>` when it cannot start, and must deliver it before returning: the error
 * report is followed by process.exit.
 */
export function runTerminalWorker(argv: string[], reportReady: (line: string) => void): void {
  const args = parseWorkerArgs(argv, TERMINAL_WORKER_MARKER_ARG);
  const protocolVersion = reportedProtocolVersion();
  const manager = createTerminalManager();
  const inspector = createTerminalWorkerProcessInspector();
  const sessionsById = new Map<string, LocalTerminalSession>();
  const unsubscribeByTerminalId = new Map<string, Array<() => void>>();
  const outputCoalescerByTerminalId = new Map<string, TerminalOutputCoalescer>();
  // A terminal is published (terminalCreated) only once its program is recorded. An exit that
  // arrives before then is held here and sent after the creation, so the controller never
  // receives an exit for a terminal it does not know yet.
  const exitsHeldDuringCreation = new Map<string, TerminalExitInfo | null>();
  const secret = randomBytes(32).toString("base64url");
  let record: TerminalWorkerRecord | null = null;
  let server: Server | null = null;
  let controller: FramedSocket | null = null;
  let everControlled = false;
  let exiting = false;

  interface InFlightTerminalCreateRequest {
    requestId: string;
    errorReported: boolean;
  }

  let inFlightTerminalCreateRequest: InFlightTerminalCreateRequest | null = null;

  // The conpty failure signal is process-scoped, not request-scoped. Serializing
  // creates keeps an async spawn failure attributable to exactly one request.
  let createTerminalQueue: Promise<void> = Promise.resolve();

  // node-pty completes its Windows conpty spawn asynchronously on a separate
  // conout worker thread. When that spawn fails (bad cwd, missing command, etc.)
  // it throws an exception there that cannot be caught at the call site and would
  // otherwise crash this worker process and sever every existing terminal.
  // `unknown`: scriptc logs an `Error`-typed value only through an `unknown` slot.
  process.on("uncaughtException", (error: unknown) => {
    console.error("Terminal worker uncaught exception (kept alive):", error);
    reportInFlightTerminalCreateFailure(error);
  });

  const replayController = createTerminalReplayController({
    getSession: (id) => sessionsById.get(id),
    flushOutput: (id) => outputCoalescerByTerminalId.get(id)?.flush(),
  });
  function sendToController(message: TerminalWorkerToParentMessage): void {
    replayController.send(message);
  }

  const recordPublisher = createTerminalWorkerRecordPublisher((state) => {
    writeTerminalWorkerRecord(args.paseoHome, state);
  });

  async function persistRecord(): Promise<void> {
    if (!record || exiting) return;
    record = {
      ...record,
      terminals: record.terminals.filter((entry) => sessionsById.has(entry.id)),
    };
    await recordPublisher.publish(record);
  }

  function removeOwnFiles(): void {
    rmSync(terminalWorkerRecordPath(args.paseoHome, process.pid), { force: true });
    if (record && process.platform !== "win32") {
      rmSync(record.socketPath, { force: true });
    }
  }

  function exitWorker(code: number): void {
    if (exiting) return;
    exiting = true;
    recordPublisher.stop();
    removeOwnFiles();
    server?.close();
    process.exit(code);
  }

  async function killEveryTerminalAndExit(): Promise<void> {
    const sessions = Array.from(sessionsById.values());
    await Promise.all(
      sessions.map((session) =>
        session.killAndWait().catch((error: unknown) => {
          console.error(`Terminal worker could not kill terminal ${session.id}:`, error);
        }),
      ),
    );
    exitWorker(0);
  }

  function exitIfIdle(): void {
    if (!controller && everControlled && sessionsById.size === 0) {
      exitWorker(0);
    }
  }

  function terminalMetadata(session: LocalTerminalSession) {
    return { ...session.getSize(), hasOutput: session.hasOutput(), title: session.getTitle() };
  }

  function toTerminalInfo(session: LocalTerminalSession): WorkerTerminalInfo {
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      workspaceId: session.workspaceId,
      ...(session.getTitle() ? { title: session.getTitle() } : {}),
      activity: session.getActivity(),
    };
  }

  function terminalWorkerErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Terminal worker request failed";
  }

  function reportInFlightTerminalCreateFailure(error: unknown): void {
    if (!inFlightTerminalCreateRequest || inFlightTerminalCreateRequest.errorReported) {
      return;
    }
    inFlightTerminalCreateRequest.errorReported = true;
    sendToController({
      type: "response",
      requestId: inFlightTerminalCreateRequest.requestId,
      ok: false,
      error: terminalWorkerErrorMessage(error),
    });
  }

  function clearTerminalSubscriptions(terminalId: string): void {
    const subscriptions = unsubscribeByTerminalId.get(terminalId);
    if (subscriptions) {
      for (const unsubscribe of subscriptions) {
        try {
          unsubscribe();
        } catch {
          // no-op
        }
      }
    }
    unsubscribeByTerminalId.delete(terminalId);
    const coalescer = outputCoalescerByTerminalId.get(terminalId);
    if (coalescer) {
      coalescer.dispose();
      outputCoalescerByTerminalId.delete(terminalId);
    }
  }

  function watchTerminal(session: LocalTerminalSession): void {
    clearTerminalSubscriptions(session.id);

    // Coalesce pty output chunks into a single frame per ~5ms window so a burst of small
    // chunks no longer costs one socket write each. The batch carries the LAST chunk's
    // revision (the highest) so downstream snapshot replay dedup stays correct.
    let pendingOutputRevision: number | undefined;
    const outputCoalescer = new TerminalOutputCoalescer({
      timers: TERMINAL_OUTPUT_COALESCER_GLOBAL_TIMERS,
      onFlush: ({ payload }) => {
        const revision = pendingOutputRevision;
        pendingOutputRevision = undefined;
        sendToController({
          type: "terminalMessage",
          terminalId: session.id,
          message: { type: "output", data: payload.toString("utf8"), revision },
          replayPreamble: session.getReplayPreamble(),
        });
      },
    });
    outputCoalescerByTerminalId.set(session.id, outputCoalescer);

    const unsubscribeMessage = session.subscribe((message) => {
      if (message.type === "output") {
        pendingOutputRevision = message.revision;
        outputCoalescer.handle(message.data);
        return;
      }
      // Non-output messages (snapshotReady/titleChange) must not jump
      // ahead of buffered output: flush the coalescer first, then forward.
      outputCoalescer.flush();
      sendToController({
        type: "terminalMessage",
        terminalId: session.id,
        message,
        replayPreamble: session.getReplayPreamble(),
      });
    });
    const unsubscribeExit = session.onExit((info) => {
      outputCoalescer.flush();
      clearTerminalSubscriptions(session.id);
      sessionsById.delete(session.id);
      void persistRecord().catch((error) => {
        if (!exiting) console.error("Cannot publish terminal exit:", error);
      });
      if (exitsHeldDuringCreation.has(session.id)) {
        exitsHeldDuringCreation.set(session.id, info);
        return;
      }
      sendToController({
        type: "terminalExit",
        terminalId: session.id,
        info,
      });
      exitIfIdle();
    });
    const unsubscribeTitle = session.onTitleChange((title) => {
      outputCoalescer.flush();
      sendToController({
        type: "terminalTitleChange",
        terminalId: session.id,
        title,
      });
    });
    const unsubscribeCommandFinished = session.onCommandFinished((info) => {
      outputCoalescer.flush();
      sendToController({
        type: "terminalCommandFinished",
        terminalId: session.id,
        info,
      });
    });
    const unsubscribeActivity = session.onActivityChange((transition) => {
      sendToController({
        type: "terminalActivityChange",
        terminalId: session.id,
        activity: transition.activity,
        previous: transition.previous,
      });
    });

    unsubscribeByTerminalId.set(session.id, [
      unsubscribeMessage,
      unsubscribeExit,
      unsubscribeTitle,
      unsubscribeCommandFinished,
      unsubscribeActivity,
    ]);
  }

  // A terminal enters the record only with its program's birth time, so cleanup can always
  // tell the program from a later process that reuses its pid. A program that already exited
  // needs no entry; one whose birth time cannot be read is killed and the create fails.
  async function recordTerminalProgram(session: LocalTerminalSession): Promise<void> {
    if (session.getExitInfo()) return;
    // The manager drops a session as soon as its program exits, so only a live one has a pid.
    const pid = manager.getTerminalProcessId(session.id);
    if (pid === null) {
      throw new Error(`Terminal ${session.id} has no program pid`);
    }
    const inspection = await inspector.inspect(pid);
    if (inspection.status === "not-found" || session.getExitInfo()) {
      return;
    }
    if (inspection.status === "error" || !inspection.snapshot.startedAt) {
      const reason =
        inspection.status === "error" ? errorMessage(inspection.error) : "no birth time reported";
      throw new Error(`Cannot identify terminal program ${pid}: ${reason}`);
    }
    if (!record) {
      throw new Error("Terminal worker record is not written yet");
    }
    record = {
      ...record,
      terminals: [
        ...record.terminals.filter((entry) => entry.id !== session.id),
        { id: session.id, pid, startedAt: inspection.snapshot.startedAt },
      ],
    };
    await persistRecord();
  }

  function enqueueCreateTerminalRequest(message: TerminalCreateRequest): Promise<void> {
    const nextRequest = createTerminalQueue.then(() => handleCreateTerminalRequest(message));
    createTerminalQueue = nextRequest.catch(() => {});
    return nextRequest;
  }

  async function handleCreateTerminalRequest(message: TerminalCreateRequest): Promise<void> {
    const request: InFlightTerminalCreateRequest = {
      requestId: message.requestId,
      errorReported: false,
    };
    inFlightTerminalCreateRequest = request;
    try {
      const { workspaceId } = message.options;
      if (!workspaceId) {
        throw new Error("workspaceId is required");
      }
      const session = await manager.createTerminal({ ...message.options, workspaceId });
      if (request.errorReported) {
        session.kill();
        return;
      }
      sessionsById.set(session.id, session);
      exitsHeldDuringCreation.set(session.id, null);
      watchTerminal(session);
      try {
        await recordTerminalProgram(session);
      } catch (error) {
        exitsHeldDuringCreation.delete(session.id);
        clearTerminalSubscriptions(session.id);
        sessionsById.delete(session.id);
        await session.killAndWait().catch(() => undefined);
        throw error;
      }
      const state = terminalMetadata(session);
      sendToController({
        type: "terminalCreated",
        terminal: toTerminalInfo(session),
        state,
      });
      // Startup output/readiness may have arrived while recording the program,
      // before the daemon knew this terminal. Publish its current modes after creation.
      sendToController({
        type: "terminalMessage",
        terminalId: session.id,
        message: { type: "snapshotReady" },
        replayPreamble: session.getReplayPreamble(),
      });
      sendToController({
        type: "response",
        requestId: message.requestId,
        ok: true,
        result: {
          terminal: toTerminalInfo(session),
          state,
        },
      });
      const heldExit = exitsHeldDuringCreation.get(session.id);
      exitsHeldDuringCreation.delete(session.id);
      if (heldExit) {
        sendToController({ type: "terminalExit", terminalId: session.id, info: heldExit });
        exitIfIdle();
      }
    } catch (error) {
      reportInFlightTerminalCreateFailure(error);
    } finally {
      if (inFlightTerminalCreateRequest === request) {
        inFlightTerminalCreateRequest = null;
      }
    }
  }

  function listTerminals(): TerminalWorkerListResult {
    return Array.from(sessionsById.values()).map((session) => {
      // Buffered output is already in the headless state; flushing first keeps a later
      // batch from carrying bytes the snapshot already shows.
      outputCoalescerByTerminalId.get(session.id)?.flush();
      return {
        terminal: toTerminalInfo(session),
        state: terminalMetadata(session),
        activityToken: manager.getTerminalActivityToken(session.id),
        replayPreamble: session.getReplayPreamble(),
      };
    });
  }

  async function handleRequest(message: TerminalWorkerRequest): Promise<void> {
    switch (message.type) {
      case "createTerminal": {
        await enqueueCreateTerminalRequest(message);
        return;
      }

      case "registerCwdEnv": {
        manager.registerCwdEnv({ cwd: message.cwd, env: message.env });
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "setActivity": {
        await manager.setTerminalActivity(message.terminalId, message.state);
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "clearAttention": {
        await manager.clearTerminalAttention(message.terminalId);
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "killTerminal": {
        manager.killTerminal(message.terminalId);
        // Removal is owned by session.onExit -> terminalExit; the parent mirror
        // clears contribution and emits terminalsChanged from that single path.
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "killTerminalAndWait": {
        await manager.killTerminalAndWait(message.terminalId, message.options);
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }

      case "replayTerminal": {
        await replayController.replay(message);
        return;
      }

      case "captureTerminal": {
        const session = manager.getTerminal(message.terminalId);
        const result = session
          ? session.captureLines({
              start: message.start,
              end: message.end,
              stripAnsi: message.stripAnsi,
            })
          : { lines: [], totalLines: 0 };
        sendToController({
          type: "response",
          requestId: message.requestId,
          ok: true,
          result,
        });
        return;
      }

      case "listTerminals": {
        sendToController({
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: listTerminals(),
        });
        return;
      }

      case "shutdown": {
        const sessions = Array.from(sessionsById.values());
        await Promise.all(sessions.map((session) => session.killAndWait().catch(() => undefined)));
        // Exit once the response frame is flushed, so the requester sees the confirmation.
        const requester = controller;
        if (!requester) {
          exitWorker(0);
          return;
        }
        requester.send({ type: "response", requestId: message.requestId, ok: true }, () =>
          exitWorker(0),
        );
        return;
      }

      case "send": {
        const session = manager.getTerminal(message.terminalId);
        session?.send(message.message);
        sendToController({ type: "response", requestId: message.requestId, ok: true });
        return;
      }
    }
  }

  function isHello(message: unknown): message is TerminalWorkerHello {
    return (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "hello" &&
      typeof (message as { secret?: unknown }).secret === "string"
    );
  }

  function secretMatches(candidate: string): boolean {
    const expected = Buffer.from(secret, "utf8");
    const actual = Buffer.from(candidate, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function handleConnection(socket: Socket): void {
    let authenticated = false;
    // `close` follows; a broken controller socket only means no controller.
    const ignoreSocketError = (): void => {};
    socket.on("error", ignoreSocketError);
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const framed = attachFramedSocket(
      socket,
      (message) => {
        if (!authenticated) {
          clearTimeout(helloTimer);
          if (!isHello(message) || !secretMatches(message.secret)) {
            socket.destroy();
            return;
          }
          authenticated = true;
          // One controller at a time: a new authenticated connection replaces the old one.
          controller = framed;
          replayController.setConnection(framed);
          everControlled = true;
          const ack: TerminalWorkerHelloAck = {
            type: "helloAck",
            pid: process.pid,
            protocolVersion,
          };
          framed.send(ack);
          return;
        }
        if (framed !== controller) {
          return;
        }
        const request = decodeTerminalWorkerRequest(message);
        void handleRequest(request).catch((error: unknown) => {
          sendToController({
            type: "response",
            requestId: request.requestId,
            ok: false,
            error: terminalWorkerErrorMessage(error),
          });
        });
      },
      ignoreSocketError,
    );
    socket.once("close", () => {
      clearTimeout(helloTimer);
      if (controller === framed) {
        controller = null;
        replayController.setConnection(null);
        exitIfIdle();
      }
    });
  }

  async function start(): Promise<void> {
    const socketPath = resolveTerminalWorkerSocketPath({
      paseoHome: args.paseoHome,
      workerPid: process.pid,
    });
    if (process.platform !== "win32") {
      rmSync(socketPath, { force: true });
    }
    const listening = createServer(handleConnection);
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(socketPath, () => {
        listening.off("error", reject);
        resolve();
      });
    });
    server = listening;
    if (process.platform !== "win32") {
      chmodSync(socketPath, PRIVATE_FILE_MODE);
    }

    const self = await inspector.inspect(process.pid);
    if (
      self.status !== "alive" ||
      !self.snapshot.startedAt ||
      !self.snapshot.commandLine?.includes(args.recordId)
    ) {
      const reason = self.status === "error" ? errorMessage(self.error) : "no usable snapshot";
      throw new Error(`Terminal worker cannot read its own process identity: ${reason}`);
    }
    record = {
      recordId: args.recordId,
      pid: process.pid,
      bootId: currentBootId(),
      createdAt: new Date().toISOString(),
      identity: { startedAt: self.snapshot.startedAt, commandLine: self.snapshot.commandLine },
      protocolVersion,
      paseoVersion: args.paseoVersion,
      socketPath,
      secret,
      runtime: args.runtime,
      terminals: [],
    };
    writeTerminalWorkerRecord(args.paseoHome, record);
    reportReady(`ready ${socketPath}`);

    setTimeout(() => {
      if (!everControlled && sessionsById.size === 0) exitWorker(0);
    }, FIRST_CONTROLLER_TIMEOUT_MS).unref();
    setInterval(() => {
      if (!controller && !existsSync(terminalWorkerRecordPath(args.paseoHome, process.pid))) {
        void killEveryTerminalAndExit();
      }
    }, ORPHAN_CHECK_INTERVAL_MS);
  }

  process.on("SIGTERM", () => {
    void killEveryTerminalAndExit();
  });

  start().catch((error: unknown) => {
    const message = errorMessage(error).replace(/\n/g, " | ");
    console.error(`Terminal worker failed to start: ${errorMessage(error)}`);
    reportReady(`error ${message}`);
    exitWorker(1);
  });
}
