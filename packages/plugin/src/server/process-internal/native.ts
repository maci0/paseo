import { type ChildProcess, spawn, type SpawnOptions, type StdioOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSystemErrorName } from "node:util";

// Child processes for a scriptc binary, whose spawn() takes only literal stdio and shell
// values, no `signal`, `timeout` or `killSignal`, and no options spread, and whose execFile()
// lacks most options. These functions do in code what Node's spawn() and execFile() do with
// those options. The Node daemon never calls them.
//
// The JSDoc types are for scriptc: a native build compiles this package from its dist
// JavaScript, which keeps comments and loses the TypeScript types.

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const DEFAULT_KILL_SIGNAL: NodeJS.Signals = "SIGTERM";
const POSIX_SHELL = "/bin/sh";

type NativeStdio = "pipe" | "ignore" | "inherit";

export interface NativeExecOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface NativeExecResult {
  stdout: string;
  stderr: string;
}

/** The error Node's spawn() emits when its `signal` aborts the child. */
class NativeAbortError extends Error {
  readonly code = "ABORT_ERR";

  /** @param {unknown} cause */
  constructor(cause: unknown) {
    super("The operation was aborted", { cause });
    this.name = "AbortError";
  }
}

/** Node's ERR_CHILD_PROCESS_STDIO_MAXBUFFER. */
class NativeMaxBufferError extends RangeError {
  readonly code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

  /** @param {"stdout" | "stderr"} stream */
  constructor(stream: "stdout" | "stderr") {
    super(`${stream} maxBuffer length exceeded`);
  }
}

/** The error execFile() reports for a non-zero exit or a signal. */
class NativeCommandFailedError extends Error {
  /**
   * @param {string} message
   * @param {number | string | null} code
   * @param {boolean} killed
   * @param {NodeJS.Signals | null} signal
   */
  constructor(
    message: string,
    readonly code: number | string | null,
    readonly killed: boolean,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(message);
  }
}

/**
 * @param {unknown} value
 * @returns {value is "pipe" | "ignore" | "inherit"}
 */
function isNativeStdio(value: unknown): value is NativeStdio {
  return value === "pipe" || value === "ignore" || value === "inherit";
}

/**
 * @param {string} option
 * @returns {Error}
 */
function unsupported(option: string): Error {
  return new Error(`spawn option ${option} is not supported in the native Paseo daemon`);
}

/**
 * @param {unknown} value
 * @returns {"pipe" | "ignore" | "inherit"}
 */
function nativeStdioSlot(value: unknown): NativeStdio {
  if (value === undefined || value === null) return "pipe";
  if (isNativeStdio(value)) return value;
  throw unsupported(`stdio ${String(value)}`);
}

/**
 * @param {import("node:child_process").StdioOptions | undefined} stdio
 * @returns {["pipe" | "ignore" | "inherit", "pipe" | "ignore" | "inherit", "pipe" | "ignore" | "inherit"]}
 */
function nativeStdio(stdio: StdioOptions | undefined): [NativeStdio, NativeStdio, NativeStdio] {
  if (stdio === undefined) return ["pipe", "pipe", "pipe"];
  if (typeof stdio === "string") {
    if (isNativeStdio(stdio)) return [stdio, stdio, stdio];
    throw unsupported(`stdio ${stdio}`);
  }
  if (stdio.length > 3) throw unsupported("stdio with more than three entries");
  return [nativeStdioSlot(stdio[0]), nativeStdioSlot(stdio[1]), nativeStdioSlot(stdio[2])];
}

/**
 * @param {import("node:child_process").SpawnOptions} options
 * @returns {string | undefined}
 */
function unsupportedSpawnOption(options: SpawnOptions): string | undefined {
  if (options.argv0 !== undefined) return "argv0";
  if (options.uid !== undefined) return "uid";
  if (options.gid !== undefined) return "gid";
  if (options.timeout !== undefined) return "timeout";
  if (options.killSignal !== undefined) return "killSignal";
  if (options.serialization !== undefined) return "serialization";
  if (options.windowsVerbatimArguments !== undefined) return "windowsVerbatimArguments";
  return undefined;
}

/**
 * Node's spawn() `signal` handling: SIGTERM on abort, then `onAbort` where Node emits an
 * AbortError 'error' event. A native ChildProcess has no emit(), so spawnNative() only kills.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {AbortSignal} signal
 * @param {(error: Error) => void} onAbort
 * @returns {void}
 */
function abortOnSignal(
  child: ChildProcess,
  signal: AbortSignal,
  onAbort: (error: Error) => void,
): void {
  const abort = (): void => {
    if (child.kill(DEFAULT_KILL_SIGNAL)) onAbort(new NativeAbortError(signal.reason));
  };
  if (signal.aborted) {
    process.nextTick(abort);
    return;
  }
  signal.addEventListener("abort", abort, { once: true });
  child.once("exit", () => signal.removeEventListener("abort", abort));
}

/**
 * promisify(execFile) adds the command and its output to the error it rejects with.
 *
 * @param {Error} error
 * @param {string} cmd
 * @param {string} stdout
 * @param {string} stderr
 * @returns {Error}
 */
function withOutput(error: Error, cmd: string, stdout: string, stderr: string): Error {
  return Object.assign(error, { cmd, stdout, stderr });
}

/** @returns {void} */
function ignoreAbort(): void {}

/**
 * @param {string | URL | undefined} cwd
 * @returns {string}
 */
function nativeCwd(cwd: string | URL | undefined): string {
  if (cwd === undefined) return process.cwd();
  if (typeof cwd === "string") return cwd;
  return fileURLToPath(cwd);
}

/**
 * spawn() for a scriptc binary, for the options its spawn() lowers.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} options
 * @param {boolean | string} shell
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnNative(
  command: string,
  args: string[],
  options: SpawnOptions,
  shell: boolean | string,
): ChildProcess {
  const option = unsupportedSpawnOption(options);
  if (option) throw unsupported(option);
  if (typeof shell === "string") throw unsupported("shell with a shell path");
  const stdio = nativeStdio(options.stdio);
  // The native spawn() needs a cwd and an env: these are Node's defaults for absent ones.
  /** @type {string} */
  const cwd: string = nativeCwd(options.cwd);
  /** @type {NodeJS.ProcessEnv} */
  const env: NodeJS.ProcessEnv = options.env ?? process.env;
  // shell: true is `/bin/sh -c "<command> <args>"`, as Node runs it on Linux and macOS.
  /** @type {string} */
  const file: string = shell ? POSIX_SHELL : command;
  /** @type {string[]} */
  const argv: string[] = shell ? ["-c", [command, ...args].join(" ")] : args;
  const child = spawn(file, argv, {
    cwd,
    env,
    stdio: [stdio[0], stdio[1], stdio[2]],
    ...(options.detached === true ? { detached: true } : {}),
    shell: false,
    windowsHide: true,
  });
  if (options.signal) abortOnSignal(child, options.signal, ignoreAbort);
  return child;
}

/**
 * promisify(execFile)() for a scriptc binary, with the same results and errors.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {NativeExecOptions} options
 * @param {boolean | string} shell
 * @returns {Promise<{ stdout: string; stderr: string }>}
 */
export function execNative(
  command: string,
  args: string[],
  options: NativeExecOptions,
  shell: boolean | string,
): Promise<NativeExecResult> {
  const encoding = options.encoding ?? "utf8";
  if (encoding !== "utf8" && encoding !== "utf-8") {
    return Promise.reject(unsupported(`encoding ${encoding}`));
  }
  /** @type {NodeJS.Signals} */
  const killSignal: NodeJS.Signals = options.killSignal ?? DEFAULT_KILL_SIGNAL;
  /** @type {number} */
  const maxBuffer: number = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const cmd = args.length > 0 ? `${command} ${args.join(" ")}` : command;
  return new Promise((resolve, reject) => {
    const child = spawnNative(
      command,
      args,
      { cwd: options.cwd, env: options.env, stdio: "pipe" },
      shell,
    );
    let stdout = "";
    let stderr = "";
    let stdoutLength = 0;
    let stderrLength = 0;
    /** @type {Error | null} */
    let failure: Error | null = null;
    let killed = false;
    let exited = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    /**
     * @param {number | null} code
     * @param {NodeJS.Signals | null} signal
     * @returns {void}
     */
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exited) return;
      exited = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (!failure && code === 0 && signal === null) {
        resolve({ stdout, stderr });
        return;
      }
      /** @type {Error} */
      const error: Error =
        failure ??
        new NativeCommandFailedError(
          `Command failed: ${cmd}\n${stderr}`,
          code !== null && code < 0 ? getSystemErrorName(code) : code,
          child.killed || killed,
          signal,
        );
      reject(withOutput(error, cmd, stdout, stderr));
    };
    /** @returns {void} */
    const kill = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      killed = true;
      try {
        child.kill(killSignal);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        settle(null, null);
      }
    };
    /**
     * @param {Error} error
     * @returns {void}
     */
    const fail = (error: Error): void => {
      failure = error;
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(null, null);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const length = Buffer.byteLength(chunk, "utf8");
      stdoutLength += length;
      if (stdoutLength > maxBuffer) {
        stdout += chunk.slice(0, maxBuffer - (stdoutLength - length));
        failure = new NativeMaxBufferError("stdout");
        kill();
      } else {
        stdout += chunk;
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const length = Buffer.byteLength(chunk, "utf8");
      stderrLength += length;
      if (stderrLength > maxBuffer) {
        stderr += chunk.slice(0, maxBuffer - (stderrLength - length));
        failure = new NativeMaxBufferError("stderr");
        kill();
      } else {
        stderr += chunk;
      }
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => settle(code, signal));
    child.on("error", fail);
    if (options.signal) abortOnSignal(child, options.signal, fail);
    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        kill();
        timeoutId = null;
      }, options.timeout);
    }
  });
}
