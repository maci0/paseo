import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildSelfNodeCommand } from "../server/paseo-env.js";
import { ensurePrivateDirectory } from "../server/private-files.js";
import {
  readTerminalWorkerRecord,
  terminalWorkerDirectory,
  terminalWorkerRecordPath,
  type TerminalWorkerRecord,
} from "./terminal-worker-record.js";
import { forkNativeTerminalWorkerLauncher } from "./terminal-worker-native-launch.js";
import { resolveTerminalWorkerEntry, type TerminalWorkerEntry } from "./terminal-worker-runtime.js";

const LAUNCH_TIMEOUT_MS = 20_000;
// What execFile's `timeout` sends.
const LAUNCH_TIMEOUT_SIGNAL = "SIGTERM";
// process.argv[0] in a scriptc binary.
const SCRIPTC_ARGV0 = "scriptc";

export class TerminalWorkerLaunchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalWorkerLaunchError";
  }
}

/**
 * Collects the launcher's output the way execFile does (utf8, settles on `close`, kills on
 * timeout, fails on a non-zero exit or a signal with execFile's "Command failed" message).
 * execFile itself is not used: scriptc lowers neither its `env` nor its `timeout` option.
 */
function collectLauncher(
  child: ChildProcess,
  input: { commandLine: string; timeoutMs: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (detail: string, cause: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new TerminalWorkerLaunchError(`Terminal worker failed to start: ${detail}`, { cause }),
      );
    };
    const timer = setTimeout(() => {
      child.kill(LAUNCH_TIMEOUT_SIGNAL);
    }, input.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: Error) => fail(stderr.trim() || error.message, error));
    child.once("close", (code: number | null, signal: string | null) => {
      if (code === 0 && signal === null) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(stdout);
        return;
      }
      const error = new Error(`Command failed: ${input.commandLine}\n${stderr}`);
      fail(stderr.trim() || error.message, error);
    });
  });
}

function launchWithNode(input: {
  entry: TerminalWorkerEntry;
  args: string[];
  timeoutMs: number;
}): Promise<string> {
  const launch = buildSelfNodeCommand([
    ...input.entry.execArgv,
    input.entry.scriptPath,
    ...input.args,
    ...(input.entry.runtime ? ["--runtime", input.entry.runtime] : []),
  ]);
  const child = spawn(launch.command, launch.args, { env: launch.env, windowsHide: true });
  return collectLauncher(child, {
    commandLine: [launch.command, ...launch.args].join(" "),
    timeoutMs: input.timeoutMs,
  });
}

// A scriptc binary embeds the worker and runs no copy of it (record `runtime` is null): the
// binary maps its own code, so replacing the installed file does not affect a running worker.
function launchNative(input: { args: string[]; timeoutMs: number }): Promise<string> {
  const child = forkNativeTerminalWorkerLauncher(input.args, buildSelfNodeCommand([]).env);
  return collectLauncher(child, {
    commandLine: [process.execPath, ...input.args].join(" "),
    timeoutMs: input.timeoutMs,
  });
}

/**
 * Starts a terminal worker outside this process's tree: the launcher spawns the worker
 * detached and exits once it listens, so the worker is re-parented and survives this daemon.
 * Resolves with the record the worker wrote; a failed start leaves no worker behind.
 */
export async function launchTerminalWorker(input: {
  paseoHome: string;
  paseoVersion: string;
  timeoutMs?: number;
  /** Defaults to the copy of this installation's bundle (source in dev). */
  entry?: TerminalWorkerEntry;
}): Promise<{ record: TerminalWorkerRecord; recordPath: string }> {
  const recordId = randomUUID();
  ensurePrivateDirectory(terminalWorkerDirectory(input.paseoHome));
  const launcherArgs = [
    "--launch",
    "--record-id",
    recordId,
    "--paseo-home",
    input.paseoHome,
    "--paseo-version",
    input.paseoVersion,
  ];
  const timeoutMs = input.timeoutMs ?? LAUNCH_TIMEOUT_MS;
  const stdout =
    process.argv[0] === SCRIPTC_ARGV0
      ? await launchNative({ args: launcherArgs, timeoutMs })
      : await launchWithNode({
          entry: input.entry ?? resolveTerminalWorkerEntry(input),
          args: launcherArgs,
          timeoutMs,
        });

  let pid: number;
  try {
    const parsed = JSON.parse(stdout.trim()) as { pid?: unknown };
    if (typeof parsed.pid !== "number") throw new Error("missing pid");
    pid = parsed.pid;
  } catch (error) {
    throw new TerminalWorkerLaunchError(
      `Terminal worker launcher printed an unexpected result: ${stdout.trim()}`,
      { cause: error },
    );
  }
  const recordPath = terminalWorkerRecordPath(input.paseoHome, pid);
  const record = await readTerminalWorkerRecord(recordPath);
  if (record.recordId !== recordId) {
    throw new TerminalWorkerLaunchError(
      `Terminal worker record ${recordPath} belongs to another launch`,
    );
  }
  return { record, recordPath };
}
