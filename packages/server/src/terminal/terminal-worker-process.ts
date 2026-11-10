import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRIVATE_FILE_MODE } from "../server/private-files.js";
import { TERMINAL_WORKER_MARKER_ARG, terminalWorkerLogPath } from "./terminal-worker-record.js";
import {
  LAUNCH_ARG,
  READY_TIMEOUT_MS,
  launcherResultForReadyLine,
  parseWorkerArgs,
  runTerminalWorker,
} from "./terminal-worker-main.js";

// The terminal worker owns every PTY. It runs detached from the daemon (re-parented by the
// launcher below) so a daemon restart, crash or forced kill of the daemon's process tree does
// not take the terminals down, and it talks to whichever daemon controls it over an
// owner-only socket authenticated by the secret in its record.
//
// `--launch` runs the launcher: it starts the real worker detached, waits for it to listen,
// prints `{ pid, socketPath }` and exits, which leaves the worker parented to init.
//
// This is the Node entry. A scriptc binary cannot compile the launcher's fd 3 pipe and runs
// terminal-worker-native-process.ts instead; both share terminal-worker-main.ts.

const READY_FD = 3;

// ---------------------------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------------------------

function runLauncher(argv: string[]): void {
  const args = parseWorkerArgs(argv, "--record-id");
  const logFd = openSync(terminalWorkerLogPath(args.paseoHome), "a", PRIVATE_FILE_MODE);
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      TERMINAL_WORKER_MARKER_ARG,
      args.recordId,
      "--paseo-home",
      args.paseoHome,
      "--paseo-version",
      args.paseoVersion,
      ...(args.runtime ? ["--runtime", args.runtime] : []),
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", logFd, "pipe"],
      env: process.env,
      windowsHide: true,
    },
  );
  closeSync(logFd);

  let settled = false;
  let buffered = "";
  const finish = (code: number, output: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0 && child.exitCode === null && child.pid) {
      // A worker that never reported ready must not be left behind.
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    child.unref();
    (child.stdio[READY_FD] as NodeJS.ReadableStream & { destroy(): void }).destroy();
    // Exit from the write callback: a pipe write can still be pending when process.exit runs.
    (code === 0 ? process.stdout : process.stderr).write(output, () => process.exit(code));
  };
  const timer = setTimeout(() => {
    finish(1, `Terminal worker did not report ready within ${READY_TIMEOUT_MS}ms\n`);
  }, READY_TIMEOUT_MS);

  const readyStream = child.stdio[READY_FD] as NodeJS.ReadableStream;
  readyStream.setEncoding("utf8");
  readyStream.on("data", (chunk: string) => {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline === -1) return;
    const result = launcherResultForReadyLine(buffered.slice(0, newline), child.pid);
    finish(result.code, result.output);
  });
  child.once("error", (error) => finish(1, `Cannot start terminal worker: ${error.message}\n`));
  child.once("exit", (code, signal) => {
    finish(1, `Terminal worker exited before it was ready (${signal ?? `code ${code}`})\n`);
  });
}

function reportReadyOnLauncherPipe(line: string): void {
  try {
    writeSync(READY_FD, `${line}\n`);
    closeSync(READY_FD);
  } catch {
    // Started without a launcher pipe (tests that spawn the worker directly).
  }
}

if (process.argv.includes(LAUNCH_ARG)) {
  runLauncher(process.argv.slice(2));
} else {
  runTerminalWorker(process.argv.slice(2), reportReadyOnLauncherPipe);
}
