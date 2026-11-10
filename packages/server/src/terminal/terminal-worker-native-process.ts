import { fork } from "node:child_process";
// `URL` from node:url, not the global: with the DOM lib in the program (xterm typings) scriptc
// does not see the global `new URL(...)` as a static fork path.
import { URL, fileURLToPath } from "node:url";
import { TERMINAL_WORKER_MARKER_ARG, terminalWorkerLogPath } from "./terminal-worker-record.js";
import {
  LAUNCH_ARG,
  READY_TIMEOUT_MS,
  launcherResultForReadyLine,
  parseWorkerArgs,
  runTerminalWorker,
} from "./terminal-worker-main.js";

// The terminal worker entry of a scriptc binary, which the daemon starts with fork()
// (terminal-worker-native-launch.ts). scriptc forks only a module named by a static
// `new URL()`, embedded in the binary, with no `detached` option and no fd beyond stdio and
// IPC. So, unlike terminal-worker-process.ts:
//
// - the launcher forks this module again for the worker, and the worker reports its ready
//   line over the IPC channel instead of fd 3;
// - the worker detaches itself first: a new session and process group, stderr appended to
//   $PASEO_HOME/terminal-worker.log (ptyDetachSession, native/pty/pty.c). Once the launcher
//   exits the worker is re-parented, as under Node.
//
// Under Node this file is never run.

declare function ptyDetachSession(logPath: string): number;

interface ReadyLineMessage {
  type: "terminal-worker-ready-line";
  line: string;
}

function isReadyLineMessage(message: unknown): message is ReadyLineMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "terminal-worker-ready-line" &&
    typeof (message as { line?: unknown }).line === "string"
  );
}

function runLauncher(argv: string[]): void {
  const args = parseWorkerArgs(argv, "--record-id");
  const child = fork(
    fileURLToPath(new URL("./terminal-worker-native-process.ts", import.meta.url)),
    [
      TERMINAL_WORKER_MARKER_ARG,
      args.recordId,
      "--paseo-home",
      args.paseoHome,
      "--paseo-version",
      args.paseoVersion,
      ...(args.runtime ? ["--runtime", args.runtime] : []),
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env },
  );

  let settled = false;
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
    if (child.connected) child.disconnect();
    child.unref();
    // Exit from the write callback: a pipe write can still be pending when process.exit runs.
    (code === 0 ? process.stdout : process.stderr).write(output, () => process.exit(code));
  };
  const timer = setTimeout(() => {
    finish(1, `Terminal worker did not report ready within ${READY_TIMEOUT_MS}ms\n`);
  }, READY_TIMEOUT_MS);

  child.on("message", (message: unknown) => {
    if (!isReadyLineMessage(message)) return;
    const result = launcherResultForReadyLine(message.line, child.pid);
    finish(result.code, result.output);
  });
  child.once("error", (error: Error) =>
    finish(1, `Cannot start terminal worker: ${error.message}\n`),
  );
  child.once("exit", (code: number | null, signal: string | null) => {
    finish(1, `Terminal worker exited before it was ready (${signal ?? `code ${code}`})\n`);
  });
}

// An `error` line is followed by process.exit, which can drop a message still queued on the
// channel; the launcher then reports the early exit, and the reason is in the log.
function reportReadyOverIpc(line: string): void {
  const message: ReadyLineMessage = { type: "terminal-worker-ready-line", line };
  process.send?.(message);
}

function runWorker(argv: string[]): void {
  const args = parseWorkerArgs(argv, TERMINAL_WORKER_MARKER_ARG);
  const detached = ptyDetachSession(terminalWorkerLogPath(args.paseoHome));
  if (detached < 0) {
    reportReadyOverIpc(`error Terminal worker cannot detach: errno ${-detached}`);
    process.exitCode = 1;
    return;
  }
  runTerminalWorker(argv, reportReadyOverIpc);
}

if (process.argv.includes(LAUNCH_ARG)) {
  runLauncher(process.argv.slice(2));
} else {
  runWorker(process.argv.slice(2));
}
