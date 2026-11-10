import { fork, type ChildProcess } from "node:child_process";
// `URL` from node:url, not the global: with the DOM lib in the program (xterm typings) scriptc
// does not see the global `new URL(...)` as a static fork path.
import { URL, fileURLToPath } from "node:url";

/**
 * Starts the terminal worker launcher in a scriptc binary. The launcher there is
 * terminal-worker-native-process.ts, embedded in the binary: scriptc's fork() re-executes the
 * binary into a module named by a static `new URL()`, and that is the only way to run it.
 * stdout and stderr are pipes, as with the Node launcher.
 */
export function forkNativeTerminalWorkerLauncher(
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  return fork(
    fileURLToPath(new URL("./terminal-worker-native-process.ts", import.meta.url)),
    args,
    { stdio: ["ignore", "pipe", "pipe", "ipc"], env },
  );
}
