import { fork, type ChildProcess } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
// URL comes from node:url, not the global: once a `/// <reference lib="dom" />` enters the
// program (the @xterm typings the terminal reaper reaches carry one), the global URL is the
// DOM declaration, and scriptc then calls the embedded worker's fork path runtime-valued.
import { URL, fileURLToPath } from "node:url";
import { signalProcessTree, treeKillTargetForChild } from "../src/utils/tree-kill.js";
import { launchNodeWorker, type WorkerSpawnSpec } from "./supervisor-node-launch.js";

const WORKER_HEARTBEAT_INTERVAL_MS = 1_000;
const WORKER_TERMINATION_GRACE_MS = 10_000;
const LOG_ROTATE_DEFAULT_UNIT = "M";
const LOG_ROTATE_UNIT_BYTES: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 * 1024,
  G: 1024 * 1024 * 1024,
};
const LOG_ROTATED_NAME_ATTEMPTS = 1000;

// A scriptc executable reports "scriptc" as argv[0]; Node reports its own path.
const RUNNING_AS_SCRIPTC_BINARY = process.argv[0] === "scriptc";

interface SupervisorLogFileOptions {
  path: string;
  rotate: {
    maxSize: string;
    maxFiles: number;
  };
}

type WorkerLifecycleMessage =
  | {
      type: "paseo:shutdown";
      reason?: string;
      keepTerminals: boolean;
    }
  | {
      type: "paseo:ready";
      listen: string;
      serverId: string;
    }
  | {
      type: "paseo:restart";
      reason?: string;
      keepTerminals: boolean;
    };

interface SupervisorHeartbeatMessage {
  type: "paseo:supervisor-heartbeat";
}

interface SupervisorGracefulShutdownMessage {
  type: "paseo:graceful-shutdown";
  reason: string;
  keepTerminals: boolean;
}

export type SupervisorLifecycleLog = (message: string, fields?: Record<string, unknown>) => void;

interface SupervisorOptions {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  resolveWorkerSpawnSpec?: (workerEntry: string) => WorkerSpawnSpec | null;
  onWorkerReady?: (message: { listen: string; serverId: string }) => Promise<void> | void;
  onWorkerExit?: () => Promise<void> | void;
  restartOnCrash?: boolean;
  onSupervisorExit?: () => Promise<void> | void;
  // Closes every terminal the worker left. Runs after a kill-intent restart or stop once the
  // worker has exited (also after a forced kill), before a respawn, and on any supervisor
  // exit except a keep-terminals stop. A crash restart keeps terminals and skips it.
  cleanupTerminals?: (log: SupervisorLifecycleLog) => Promise<void>;
  logFile?: SupervisorLogFileOptions;
}

export interface SupervisorController {
  requestShutdown(reason: string, options?: { keepTerminals?: boolean }): void;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "paseo:shutdown") {
    const { reason, keepTerminals } = msg as { reason?: unknown; keepTerminals?: unknown };
    return {
      type: "paseo:shutdown",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
      keepTerminals: keepTerminals === true,
    };
  }
  if (type === "paseo:ready") {
    const { listen, serverId } = msg as { listen?: unknown; serverId?: unknown };
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    if (typeof serverId !== "string" || serverId.trim().length === 0) {
      return null;
    }
    return { type: "paseo:ready", listen, serverId };
  }
  if (type === "paseo:restart") {
    const { reason, keepTerminals } = msg as { reason?: unknown; keepTerminals?: unknown };
    return {
      type: "paseo:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
      keepTerminals: keepTerminals === true,
    };
  }
  return null;
}

// daemon.log rotation reproduces rotating-file-stream 3.2.9 called with { size, maxFiles }
// (scriptc cannot compile that package): the same size grammar and errors, rotation after
// the write that reaches the size, rotated copies named YYYYMMDD-HHMM-NN-<name> in local
// time, and a <name>.txt history from which the oldest copies beyond maxFiles are deleted.
// Writes are synchronous where the package wrote asynchronously.

function parseLogRotateSize(size: string): number {
  const trimmed = size.trim();
  const shorthand = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  const value = shorthand
    ? `${shorthand[1]}${(shorthand[2] ?? LOG_ROTATE_DEFAULT_UNIT).toUpperCase()}`
    : trimmed;
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) {
    throw new Error(`Unknown 'options.size' format: ${value}`);
  }
  if (num <= 0) {
    throw new Error("A positive integer number is expected for 'options.size'");
  }
  const digits = String(num).length;
  const unit = value.replace(/^[ 0]*/g, "").slice(digits, digits + 1);
  if (unit.length === 0) {
    throw new Error("Missing unit for 'options.size'");
  }
  const bytes = LOG_ROTATE_UNIT_BYTES[unit];
  if (bytes === undefined) {
    throw new Error(`Unknown 'options.size' unit: ${unit}`);
  }
  return num * bytes;
}

function checkLogRotateMaxFiles(maxFiles: number): void {
  if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("'maxFiles' option must be a positive integer number");
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function padTwo(value: number): string {
  return (value > 9 ? "" : "0") + String(value);
}

function rotatedLogPath(logPath: string, time: Date, index: number): string {
  const stamp =
    `${time.getFullYear()}${padTwo(time.getMonth() + 1)}${padTwo(time.getDate())}` +
    `-${padTwo(time.getHours())}${padTwo(time.getMinutes())}`;
  return `${path.dirname(logPath)}${path.sep}${stamp}-${padTwo(index)}-${path.basename(logPath)}`;
}

function pruneRotatedLogs(logPath: string, rotatedPath: string, maxFiles: number): void {
  const historyPath = `${logPath}.txt`;
  let names = [rotatedPath];
  try {
    names = [...readFileSync(historyPath, "utf8").split("\n"), rotatedPath];
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  const kept: { name: string; time: number }[] = [];
  for (const name of names) {
    if (!name) {
      continue;
    }
    try {
      const stats = statSync(name);
      if (stats.isFile()) {
        kept.push({ name, time: stats.mtime.getTime() });
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }
  kept.sort((a, b) => a.time - b.time);
  while (kept.length > maxFiles) {
    const oldest = kept.shift();
    if (oldest) {
      unlinkQuietly(oldest.name);
    }
  }
  writeFileSync(historyPath, `${kept.map((entry) => entry.name).join("\n")}\n`, "utf8");
}

function unlinkQuietly(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function rotateLogFile(logPath: string, maxFiles: number): void {
  const rotation = new Date();
  for (let index = 1; index < LOG_ROTATED_NAME_ATTEMPTS; index += 1) {
    const rotatedPath = rotatedLogPath(logPath, rotation, index);
    if (existsSync(rotatedPath)) {
      continue;
    }
    closeSync(openSync(rotatedPath, "a"));
    unlinkQuietly(rotatedPath);
    renameSync(logPath, rotatedPath);
    pruneRotatedLogs(logPath, rotatedPath, maxFiles);
    return;
  }
  throw new Error("Too many destination file attempts");
}

interface OpenLogFile {
  fd: number;
  size: number;
}

// daemon.log is best effort: a full disk or a replaced log path must not take the
// supervisor, and with it the worker, down. A failed file is dropped and opened again on
// the next write, so logging resumes once the file is writable again. An invalid rotate
// size or maxFiles throws from the first write, as rotating-file-stream did.
function createDurableLog(
  options: SupervisorLogFileOptions | undefined,
  reportFailure: (message: string) => void,
) {
  let file: OpenLogFile | null = null;
  let failing = false;

  const open = (logPath: string, sizeLimit: number, maxFiles: number): OpenLogFile => {
    mkdirSync(path.dirname(logPath), { recursive: true });
    let size = 0;
    try {
      const stats = statSync(logPath);
      if (!stats.isFile()) {
        throw new Error(`Can't write on: ${logPath} (it is not a file)`);
      }
      size = stats.size;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    if (size >= sizeLimit) {
      rotateLogFile(logPath, maxFiles);
      size = 0;
    }
    return { fd: openSync(logPath, "a"), size };
  };

  const closeQuietly = (): void => {
    if (!file) {
      return;
    }
    const { fd } = file;
    file = null;
    try {
      closeSync(fd);
    } catch {
      // The descriptor is already unusable; the next write opens a new one.
    }
  };

  return {
    write(chunk: string | Buffer): void {
      if (!options) {
        return;
      }
      const sizeLimit = parseLogRotateSize(options.rotate.maxSize);
      checkLogRotateMaxFiles(options.rotate.maxFiles);
      try {
        file ??= open(options.path, sizeLimit, options.rotate.maxFiles);
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        file.size += bytes.length;
        writeSync(file.fd, bytes);
        if (file.size >= sizeLimit) {
          closeQuietly();
          rotateLogFile(options.path, options.rotate.maxFiles);
          file = open(options.path, sizeLimit, options.rotate.maxFiles);
        }
        failing = false;
      } catch (error) {
        closeQuietly();
        if (!failing) {
          failing = true;
          const message = error instanceof Error ? error.message : String(error);
          reportFailure(
            `Cannot write ${options.path}, will retry on the next log line: ${message}`,
          );
        }
      }
    },
    close(): Promise<void> {
      closeQuietly();
      return Promise.resolve();
    },
  };
}

// The program that started the daemon can close its end of stdout or stderr, as
// `paseo daemon run | head -1` does. Drop the output nobody reads and keep supervising
// the worker; daemon.log still records it.
function ignoreClosedOutput(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") {
    throw error;
  }
}

// Native path. scriptc embeds the module a build-time fork() path names and starts it by
// re-executing the binary, with the same newline-delimited JSON IPC channel the worker
// already uses. Worker resolution, execArgv and the Electron runner do not apply.
function launchEmbeddedWorker(workerArgs: string[], workerEnv: NodeJS.ProcessEnv): ChildProcess {
  return fork(
    fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url)),
    workerArgs,
    {
      stdio: ["inherit", "pipe", "pipe", "ipc"],
      env: workerEnv,
    },
  );
}

export function runSupervisor(options: SupervisorOptions): SupervisorController {
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];
  const resolveWorkerSpawnSpec = options.resolveWorkerSpawnSpec;

  let child: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  // The resolved terminal decision of the pending restart or stop. It survives the force-kill
  // path, so a hung kill restart still closes terminals before the respawn.
  let pendingKeepTerminals = false;
  let exiting = false;
  let lifecycleFailed = false;
  let publication = Promise.resolve();
  let forceKillTimer: NodeJS.Timeout | null = null;
  const durableLog = createDurableLog(options.logFile, (message) => {
    process.stderr.write(`[${options.name}] ${message}\n`);
  });

  const writeDurableChunk = (chunk: string | Buffer): void => {
    durableLog.write(chunk);
  };

  const writeLifecycleLog = (message: string, fields: Record<string, unknown> = {}): void => {
    writeDurableChunk(
      `${JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        pid: process.pid,
        name: options.name,
        msg: message,
        ...fields,
      })}\n`,
    );
  };

  const log = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    writeLifecycleLog(message);
  };

  const closeLogStream = (): Promise<void> => durableLog.close();

  const runTerminalCleanup = async (when: string): Promise<void> => {
    if (!options.cleanupTerminals) {
      return;
    }
    writeLifecycleLog("Closing terminals", { when });
    try {
      await options.cleanupTerminals(writeLifecycleLog);
      writeLifecycleLog("Terminal cleanup finished", { when });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Terminal cleanup not confirmed (${when}): ${message}`);
    }
  };

  const exitSupervisor = (code: number, exitOptions: { keepTerminals?: boolean } = {}): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    const cleanup =
      exitOptions.keepTerminals === true
        ? Promise.resolve()
        : runTerminalCleanup("supervisor_exit");
    cleanup
      .then(() => options.onSupervisorExit?.())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor exit cleanup failed: ${message}`);
      })
      .then(closeLogStream)
      .finally(() => {
        process.exit(code);
      });
  };

  const clearForceKillTimer = (): void => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const scheduleForceKill = (reason: string): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    clearForceKillTimer();
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      if (child !== currentChild) {
        return;
      }
      writeLifecycleLog(
        "Worker did not exit after graceful shutdown request; forcing process tree kill",
        {
          reason,
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        },
      );
      void signalProcessTree(treeKillTargetForChild(currentChild), "SIGKILL").catch((error) => {
        writeLifecycleLog("Failed to force-kill worker process tree", {
          error: error instanceof Error ? error.message : String(error),
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      });
    }, WORKER_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  };

  const spawnWorker = () => {
    let workerEntry: string;
    try {
      // Resolve at spawn time so restarts pick up current filesystem state.
      workerEntry = options.resolveWorkerEntry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Failed to resolve worker entry: ${message}`);
      exitSupervisor(1);
      return;
    }

    if (RUNNING_AS_SCRIPTC_BINARY) {
      writeLifecycleLog("Spawning worker", { workerEntry: "embedded daemon-worker" });
      child = launchEmbeddedWorker(workerArgs, workerEnv);
    } else {
      const spawnSpec = resolveWorkerSpawnSpec?.(workerEntry) ?? null;
      writeLifecycleLog("Spawning worker", { workerEntry });
      child = launchNodeWorker({ workerEntry, workerArgs, workerEnv, workerExecArgv, spawnSpec });
    }

    const currentChild = child;
    let reachedReady = false;
    // Serialize endpoint writes with exit/clear before allowing another worker to spawn.
    const heartbeat = setInterval(() => {
      const message: SupervisorHeartbeatMessage = { type: "paseo:supervisor-heartbeat" };
      if (currentChild.connected) {
        currentChild.send?.(message, (error) => {
          if (error) {
            writeLifecycleLog("Worker heartbeat IPC send failed", { error: error.message });
          }
        });
      } else {
        writeLifecycleLog("Worker heartbeat skipped because IPC channel is disconnected");
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    child.on("disconnect", () => {
      writeLifecycleLog("Worker IPC channel disconnected");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      writeDurableChunk(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      writeDurableChunk(chunk);
    });

    child.on("message", (msg: unknown) => {
      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage || child !== currentChild) {
        return;
      }

      if (lifecycleMessage.type === "paseo:ready") {
        reachedReady = true;
        writeLifecycleLog("Worker ready", { listen: lifecycleMessage.listen });
        publication = publication
          .then(() =>
            options.onWorkerReady?.({
              listen: lifecycleMessage.listen,
              serverId: lifecycleMessage.serverId,
            }),
          )
          .catch((error) => {
            lifecycleFailed = true;
            const message = error instanceof Error ? error.message : String(error);
            log(`Worker ready callback failed: ${message}`);
            requestShutdown("endpoint_publication_failed");
          });
        return;
      }

      if (lifecycleMessage.type === "paseo:shutdown") {
        const reason = lifecycleMessage.reason ?? "worker_requested_shutdown";
        writeLifecycleLog("Worker requested shutdown", {
          reason,
          keepTerminals: lifecycleMessage.keepTerminals,
        });
        requestShutdown(reason, { keepTerminals: lifecycleMessage.keepTerminals });
        return;
      }

      const reason = lifecycleMessage.reason ?? "worker_requested_restart";
      writeLifecycleLog("Worker requested restart", {
        reason,
        keepTerminals: lifecycleMessage.keepTerminals,
      });
      requestRestart(reason, lifecycleMessage.keepTerminals);
    });

    child.on("error", (error) => {
      lifecycleFailed = true;
      log(`Worker spawn failed: ${error.message}`);
      exitSupervisor(1);
    });

    child.on("exit", (code, signal) => {
      clearInterval(heartbeat);
      clearForceKillTimer();
      child = null;
      publication = publication
        .then(() => options.onWorkerExit?.())
        .catch((error) => {
          lifecycleFailed = true;
          log(`Worker exit callback failed: ${String(error)}`);
        });
      void publication.then(() => {
        const exitDescriptor = describeExit(code, signal);
        writeLifecycleLog("Worker exited", { code, signal, exit: exitDescriptor });

        if (lifecycleFailed || (!reachedReady && !shuttingDown)) {
          log(`Worker exited before successful readiness (${exitDescriptor}). Supervisor exiting.`);
          exitSupervisor(1);
          return;
        }

        if (shuttingDown) {
          log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
          exitSupervisor(0, { keepTerminals: pendingKeepTerminals });
          return;
        }

        const crashed =
          restartOnCrash &&
          ((code !== 0 && code !== null) || (signal !== null && signal !== "SIGTERM"));

        if (restarting || crashed) {
          const closeTerminals = restarting && !pendingKeepTerminals;
          restarting = false;
          pendingKeepTerminals = false;
          log(
            crashed && !closeTerminals
              ? `Worker crashed (${exitDescriptor}). Restarting worker...`
              : `Worker exited (${exitDescriptor}). Restarting worker...`,
          );
          if (!closeTerminals) {
            spawnWorker();
            return;
          }
          // The replacement daemon must never adopt terminals the user asked to close.
          void runTerminalCleanup("before_respawn").then(() => {
            if (!shuttingDown) {
              spawnWorker();
            }
            return;
          });
          return;
        }

        log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
        exitSupervisor(typeof code === "number" ? code : 1);
        return;
      });
    });
  };

  const requestWorkerShutdown = (reason: string): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    const message: SupervisorGracefulShutdownMessage = {
      type: "paseo:graceful-shutdown",
      reason,
      keepTerminals: pendingKeepTerminals,
    };
    writeLifecycleLog("Supervisor requesting graceful worker shutdown", {
      reason,
      keepTerminals: pendingKeepTerminals,
      supervisorPid: process.pid,
      workerPid: currentChild.pid ?? null,
    });
    if (!currentChild.connected) {
      writeLifecycleLog("Graceful worker shutdown IPC unavailable", {
        reason,
        supervisorPid: process.pid,
        workerPid: currentChild.pid ?? null,
      });
      return;
    }
    currentChild.send?.(message, (error) => {
      if (error) {
        writeLifecycleLog("Graceful worker shutdown IPC send failed", {
          error: error.message,
          reason,
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      }
    });
  };

  const requestRestart = (reason: string, keepTerminals: boolean) => {
    if (!child || restarting || shuttingDown) {
      return;
    }
    restarting = true;
    pendingKeepTerminals = keepTerminals;
    writeLifecycleLog("Restart requested", { reason, keepTerminals });
    log(`${reason}. Stopping worker for restart...`);
    requestWorkerShutdown(reason);
    scheduleForceKill(reason);
  };

  const requestShutdown = (reason: string, shutdownOptions: { keepTerminals?: boolean } = {}) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    restarting = false;
    pendingKeepTerminals = shutdownOptions.keepTerminals === true;
    writeLifecycleLog("Supervisor shutdown requested", {
      reason,
      keepTerminals: pendingKeepTerminals,
    });
    log(`${reason}. Stopping worker...`);
    if (!child) {
      void publication.then(() => {
        exitSupervisor(lifecycleFailed ? 1 : 0, { keepTerminals: pendingKeepTerminals });
        return;
      });
      return;
    }
    requestWorkerShutdown(reason);
    scheduleForceKill(reason);
  };

  const forwardSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`supervisor_received_${signal}`);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.stdout.on("error", ignoreClosedOutput);
  process.stderr.on("error", ignoreClosedOutput);

  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  writeLifecycleLog(options.startupMessage);
  spawnWorker();

  return { requestShutdown };
}
