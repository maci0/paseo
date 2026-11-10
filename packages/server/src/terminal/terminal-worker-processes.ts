import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { execCommand } from "../utils/spawn.js";
import {
  createSystemManagedProcessTable,
  type ManagedProcessCommandRunner,
  type ManagedProcessInspection,
  windowsPowerShellPath,
} from "../server/managed-processes/managed-processes.js";

// Process inspection for terminal worker ownership. Birth times are compared as the strings
// `ps -o lstart` and Win32_Process.CreationDate print, so every reader must print them the same
// way: `ps` follows LC_TIME, and the worker, the daemon, the supervisor and the CLI can run
// under different locales. Every `ps` here runs under LC_ALL=C.

const PS_TIMEOUT_MS = 15_000;
const PS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
// process.argv[0] in a scriptc binary.
const SCRIPTC_ARGV0 = "scriptc";
const POSIX_LSTART_WIDTH = 24;

export interface ProcessTableEntry {
  pid: number;
  ppid: number;
  startedAt: string;
  // POSIX session id where `ps` reports one (Linux). macOS `ps` has no session column.
  sessionId: number | null;
}

export interface TerminalWorkerProcessInspector {
  /** True where the process table names each process's session (Linux). */
  readonly reportsSessions: boolean;
  inspect(pid: number): Promise<ManagedProcessInspection>;
  /** One snapshot of every process, for walking descendants. Throws when it cannot be read. */
  listProcesses(): Promise<ProcessTableEntry[]>;
  /**
   * The environment a process was started with, as NAME=value entries; null when the process
   * is gone. Throws when it cannot be read. Only called where `reportsSessions` is true.
   */
  readEnvironment(pid: number): Promise<string[] | null>;
}

const WindowsProcessListSchema = z.array(
  z.object({
    ProcessId: z.number().int(),
    ParentProcessId: z.number().int().nullable().optional(),
    CreationDate: z.string().nullable().optional(),
  }),
);

function createLocaleNeutralCommandRunner(): ManagedProcessCommandRunner {
  if (process.argv[0] === SCRIPTC_ARGV0) return createNativeLocaleNeutralCommandRunner();
  return {
    exec: (command, args) =>
      execCommand(command, args, {
        envMode: "internal",
        envOverlay: { LC_ALL: "C" },
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER_BYTES,
      }).then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) })),
  };
}

/** A command that ran and exited non-zero; `code` is numeric, as on execFile's error. */
class CommandExitError extends Error {
  readonly code: number;

  // No parameter property: the worker runs this file under --experimental-strip-types.
  constructor(message: string, code: number) {
    super(message);
    this.name = "CommandExitError";
    this.code = code;
  }
}

// execCommand goes through promisified execFile with `env` and `timeout`, which a scriptc
// binary cannot run. This runner keeps its contract for the inspector: LC_ALL=C over the
// daemon's environment, the timeout and output limit, and a numeric `code` on a non-zero exit.
function createNativeLocaleNeutralCommandRunner(): ManagedProcessCommandRunner {
  return {
    exec: (command, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          env: { ...process.env, LC_ALL: "C" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let failure: Error | null = null;
        const stop = (error: Error) => {
          failure ??= error;
          child.kill("SIGTERM");
        };
        const timer = setTimeout(
          () => stop(new Error(`${command} timed out after ${PS_TIMEOUT_MS}ms`)),
          PS_TIMEOUT_MS,
        );
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.length > PS_MAX_BUFFER_BYTES) stop(new Error(`${command} output too large`));
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code: number | null) => {
          clearTimeout(timer);
          if (failure) reject(failure);
          else if (code === 0) resolve({ stdout, stderr });
          else reject(new CommandExitError(`Command failed: ${command}\n${stderr}`, code ?? 1));
        });
      }),
  };
}

export function createTerminalWorkerProcessInspector(
  options: { platform?: NodeJS.Platform; commandRunner?: ManagedProcessCommandRunner } = {},
): TerminalWorkerProcessInspector {
  const platform = options.platform ?? process.platform;
  const commandRunner = options.commandRunner ?? createLocaleNeutralCommandRunner();
  const table = createSystemManagedProcessTable({ platform, commandRunner });
  return {
    reportsSessions: platform === "linux",
    inspect: (pid) => table.inspect(pid),
    listProcesses: () =>
      platform === "win32"
        ? listWindowsProcesses(commandRunner)
        : listPosixProcesses(commandRunner, platform),
    readEnvironment: (pid) => readLinuxEnvironment(platform, pid),
  };
}

async function readLinuxEnvironment(
  platform: NodeJS.Platform,
  pid: number,
): Promise<string[] | null> {
  if (platform !== "linux") {
    throw new Error(`reading a process environment is not supported on ${platform}`);
  }
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/environ`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return raw.split("\0").filter((entry) => entry.length > 0);
}

async function listPosixProcesses(
  commandRunner: ManagedProcessCommandRunner,
  platform: NodeJS.Platform,
): Promise<ProcessTableEntry[]> {
  const withSession = platform === "linux";
  const columns = withSession
    ? ["-o", "pid=", "-o", "ppid=", "-o", "sid=", "-o", "lstart="]
    : ["-o", "pid=", "-o", "ppid=", "-o", "lstart="];
  const { stdout } = await commandRunner.exec("ps", ["-A", "-ww", ...columns]);
  const entries: ProcessTableEntry[] = [];
  const leadingInts = withSession ? 3 : 2;
  for (const line of stdout.split("\n")) {
    const match = line.match(
      withSession ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/ : /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/,
    );
    if (!match) continue;
    const startedAt = match[leadingInts + 1].slice(0, POSIX_LSTART_WIDTH).trim();
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      sessionId: withSession ? Number(match[3]) : null,
      startedAt,
    });
  }
  if (entries.length === 0) {
    throw new Error("ps returned no processes");
  }
  return entries;
}

async function listWindowsProcesses(
  commandRunner: ManagedProcessCommandRunner,
): Promise<ProcessTableEntry[]> {
  const command =
    "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress";
  const { stdout } = await commandRunner.exec(windowsPowerShellPath(), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ]);
  const parsed: unknown = JSON.parse(stdout.trim());
  const rows = WindowsProcessListSchema.parse(Array.isArray(parsed) ? parsed : [parsed]);
  return rows.flatMap((row) =>
    row.CreationDate
      ? [
          {
            pid: row.ProcessId,
            ppid: row.ParentProcessId ?? 0,
            startedAt: row.CreationDate,
            sessionId: null,
          },
        ]
      : [],
  );
}

/**
 * Every process below `rootPid` in the snapshot, plus (where the platform reports sessions)
 * every member of the session `rootPid` led and everything below those members. A PTY program
 * is a session leader, and the kernel keeps its pid reserved as the session id while any member
 * lives, so the session still names a HUP-ignoring job after the shell exits and the job is
 * reparented.
 */
export function collectDescendants(
  snapshot: ProcessTableEntry[],
  rootPid: number,
): ProcessTableEntry[] {
  const childrenByParent = new Map<number, ProcessTableEntry[]>();
  for (const entry of snapshot) {
    const siblings = childrenByParent.get(entry.ppid) ?? [];
    siblings.push(entry);
    childrenByParent.set(entry.ppid, siblings);
  }
  const found = new Map<number, ProcessTableEntry>();
  const queue = [rootPid];
  for (const entry of snapshot) {
    if (entry.sessionId === rootPid && entry.pid !== rootPid) {
      found.set(entry.pid, entry);
      queue.push(entry.pid);
    }
  }
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (child.pid === rootPid || found.has(child.pid)) continue;
      found.set(child.pid, child);
      queue.push(child.pid);
    }
  }
  return Array.from(found.values());
}
