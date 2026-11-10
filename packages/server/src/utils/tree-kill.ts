import type { ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import treeKill from "tree-kill";

// A scriptc executable reports "scriptc" as argv[0]; Node reports its own path.
const RUNNING_AS_SCRIPTC_BINARY = process.argv[0] === "scriptc";
const PROC_ROOT = "/proc";
const NUMERIC_NAME = /^\d+$/;

export interface TreeKillTarget {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

// The TreeKillTarget view of a ChildProcess, which scriptc refuses to convert to the
// interface (SC2002). exitCode and signalCode follow the child: Node sets them just before
// emitting "exit", and this listener runs before any `once` registered through the target.
export function treeKillTargetForChild(child: ChildProcess): TreeKillTarget {
  const target: TreeKillTarget = {
    pid: child.pid,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    kill: (signal) => {
      // Narrowed per call: scriptc lowers kill only with a string or a number signal.
      if (typeof signal === "number") return child.kill(signal);
      if (typeof signal === "string") return child.kill(signal);
      return child.kill();
    },
    once: (event, listener) => child.once(event, listener),
  };
  child.once("exit", () => {
    target.exitCode = child.exitCode;
    target.signalCode = child.signalCode;
  });
  return target;
}

export interface TerminateWithTreeKillOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
}

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout";

// Injection seam: production wires terminateWithTreeKill; tests wire a fake that
// records which children were terminated as observable state.
export type ProcessTerminator = (
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
) => Promise<TerminateWithTreeKillResult>;

// The seam for callers that own a ChildProcess. Tests wire fakes that receive the child itself.
export type ChildProcessTerminator = (
  child: ChildProcess,
  options: TerminateWithTreeKillOptions,
) => Promise<TerminateWithTreeKillResult>;

export function terminateChildWithTreeKill(
  child: ChildProcess,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  return terminateWithTreeKill(treeKillTargetForChild(child), options);
}

export async function terminateWithTreeKill(
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  if (isProcessExited(child)) {
    return "already-exited";
  }

  const exitPromise = waitForProcessExit(child);
  await signalProcessTree(child, options.gracefulSignal ?? "SIGTERM");
  if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
    return "terminated";
  }

  options.onForceSignal?.();
  await signalProcessTree(child, options.forceSignal ?? "SIGKILL");
  if (options.forceTimeoutMs === undefined) {
    return "killed";
  }
  return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
    ? "killed"
    : "kill-timeout";
}

export function signalProcessTree(child: TreeKillTarget, signal: NodeJS.Signals): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  return killProcessTree(pid, signal).catch(() => {
    signalDirectChild(child, signal);
  });
}

// Signals pid and every descendant. Under Node this is the tree-kill package. tree-kill
// cannot run in a scriptc binary (it passes child_process.spawn as a value to list
// children with `ps`), so a binary on Linux reads the process tree from /proc instead and
// rejects on other platforms.
export function killProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (!RUNNING_AS_SCRIPTC_BINARY) {
    return new Promise((resolve, reject) => {
      treeKill(pid, signal, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  if (process.platform !== "linux") {
    return Promise.reject(
      new Error(`Process tree kill is not implemented for ${process.platform} binaries`),
    );
  }
  return killLinuxProcessTree(pid, signal);
}

async function killLinuxProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  // Snapshot the tree first: once the root dies its children are reparented.
  for (const target of [pid, ...(await listLinuxDescendants(pid))]) {
    signalIgnoringMissing(target, signal);
  }
}

async function listLinuxDescendants(rootPid: number): Promise<number[]> {
  const childrenByParent = new Map<number, number[]>();
  for (const name of await readdir(PROC_ROOT)) {
    if (!NUMERIC_NAME.test(name)) {
      continue;
    }
    const parentPid = await readLinuxParentPid(name);
    if (parentPid === null) {
      continue;
    }
    const siblings = childrenByParent.get(parentPid);
    if (siblings) {
      siblings.push(Number(name));
    } else {
      childrenByParent.set(parentPid, [Number(name)]);
    }
  }
  const descendants: number[] = [];
  const pending = [rootPid];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const childPid of childrenByParent.get(next) ?? []) {
      descendants.push(childPid);
      pending.push(childPid);
    }
  }
  return descendants;
}

// The fourth field of /proc/<pid>/stat, after the parenthesized command name, which may
// itself contain spaces and parentheses. Null when the process exited after readdir.
async function readLinuxParentPid(pidName: string): Promise<number | null> {
  let stat: string;
  try {
    stat = await readFile(`${PROC_ROOT}/${pidName}/stat`, "utf8");
  } catch (error) {
    if (isMissingProcessError(error)) {
      return null;
    }
    throw error;
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const parentPid = Number.parseInt(fields[1] ?? "", 10);
  if (Number.isNaN(parentPid)) {
    throw new Error(`Unexpected ${PROC_ROOT}/${pidName}/stat format`);
  }
  return parentPid;
}

function signalIgnoringMissing(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

function isMissingProcessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ESRCH" || code === "ENOENT";
}

function signalDirectChild(child: TreeKillTarget, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup races.
  }
}

function isProcessExited(child: TreeKillTarget): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForProcessExit(child: TreeKillTarget): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }
  if (!child.once) {
    return new Promise(() => undefined);
  }

  return new Promise((resolve) => {
    child.once?.("exit", resolve);
  });
}

async function waitForExitOrTimeout(
  exitPromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
