import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  query,
  type Options,
  type Query,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import {
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { buildSelfNodeCommand, createExternalProcessEnv } from "../../../paseo-env.js";
import { spawnProcess } from "../../../../utils/spawn.js";

// Keep the raw SDK query import in this module only. Claude process launch behavior
// must stay shared between production and tests so Windows .cmd/.bat handling cannot
// diverge from the daemon path.

export type ClaudeOptions = Options;
export type ClaudeQueryInput = Parameters<typeof query>[0] & { options: ClaudeOptions };
export type ClaudeQueryFactory = (input: ClaudeQueryInput) => Query;

export interface ClaudeQueryContext {
  runtimeSettings?: ProviderRuntimeSettings;
  launchEnv?: Record<string, string>;
  queryFactory?: ClaudeQueryFactory;
  /** Called with the spawned child process so the caller can tree-kill it on close. */
  onChildProcess?: (child: ChildProcess) => void;
}

function isChildProcessWithStreams(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/** The error Node's spawn() emits when its `signal` aborts the child. */
class SpawnAbortError extends Error {
  readonly code = "ABORT_ERR";

  constructor(cause: unknown) {
    super("The operation was aborted", { cause });
    this.name = "AbortError";
  }
}

/**
 * The child behind the SDK's SpawnedProcess interface, with spawn()'s `signal` option done
 * here: on abort a live child gets SIGTERM and an AbortError 'error', as Node does. scriptc
 * passes no ChildProcess where SpawnedProcess is declared (it fails at run time) and lowers
 * no spawn() `signal` option.
 */
class SpawnedClaudeProcess implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  private readonly events = new EventEmitter();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    signal: AbortSignal,
  ) {
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    child.on("exit", (code: number | null, exitSignal: NodeJS.Signals | null) =>
      this.events.emit("exit", code, exitSignal),
    );
    child.on("error", (error: Error) => this.events.emit("error", error));
    const onAbort = (): void => {
      if (child.kill("SIGTERM")) this.events.emit("error", new SpawnAbortError(signal.reason));
    };
    if (signal.aborted) {
      process.nextTick(onAbort);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("exit", () => signal.removeEventListener("abort", onAbort));
    }
  }

  get killed(): boolean {
    return this.child.killed;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.child.signalCode;
  }

  kill(signal: NodeJS.Signals): boolean {
    return this.child.kill(signal);
  }

  on(event: "exit", listener: ExitListener): void;
  on(event: "error", listener: ErrorListener): void;
  on(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    this.events.on(event, listener);
  }

  once(event: "exit", listener: ExitListener): void;
  once(event: "error", listener: ErrorListener): void;
  once(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    this.events.once(event, listener);
  }

  off(event: "exit", listener: ExitListener): void;
  off(event: "error", listener: ErrorListener): void;
  off(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    this.events.off(event, listener);
  }
}

function resolveClaudeSpawnCommand(
  spawnOptions: SpawnOptions,
  runtimeSettings?: ProviderRuntimeSettings,
): { command: string; args: string[] } {
  const commandConfig = runtimeSettings?.command;
  if (!commandConfig || commandConfig.mode === "default") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args],
    };
  }

  if (commandConfig.mode === "append") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args, ...(commandConfig.args ?? [])],
    };
  }

  return {
    command: commandConfig.argv[0],
    args: [...commandConfig.argv.slice(1), ...spawnOptions.args],
  };
}

function applyRuntimeSettingsToClaudeOptions(
  options: ClaudeOptions,
  context: ClaudeQueryContext,
): ClaudeOptions {
  const { runtimeSettings, launchEnv, onChildProcess } = context;
  return {
    ...options,
    spawnClaudeCodeProcess: (spawnOptions) => {
      const resolved = resolveClaudeSpawnCommand(spawnOptions, runtimeSettings);
      // When the SDK passes a default JS runtime ("node"/"bun"), replace it with
      // process.execPath — the actual node binary running the daemon. This avoids
      // PATH lookup failures in the managed runtime bundle.
      // When the SDK passes a native binary path (from pathToClaudeCodeExecutable)
      // or the user overrides the command via runtime settings, use that directly.
      const isDefaultRuntime = resolved.command === "node" || resolved.command === "bun";
      const providerEnvSpec = createProviderEnvSpec({
        baseEnv: spawnOptions.env,
        runtimeSettings,
        overlays: [launchEnv],
      });
      // Session-open hooks may explicitly supply a client identity. Keep inherited
      // SDK/parent identities cleared while honoring this launch-only contribution.
      providerEnvSpec.envOverlay.CLAUDE_CODE_ENTRYPOINT = launchEnv?.CLAUDE_CODE_ENTRYPOINT;
      const providerEnv = createExternalProcessEnv(spawnOptions.env, providerEnvSpec.envOverlay);
      const selfNodeCommand = isDefaultRuntime
        ? buildSelfNodeCommand(resolved.args, providerEnv)
        : null;
      const command = selfNodeCommand?.command ?? resolved.command;
      const args = selfNodeCommand?.args ?? resolved.args;
      const child = spawnProcess(command, args, {
        cwd: spawnOptions.cwd,
        ...(selfNodeCommand
          ? { env: selfNodeCommand.env, envMode: "internal" as const }
          : providerEnvSpec),
        stdio: ["pipe", "pipe", "pipe"],
        // Bypass cmd.exe on Windows: the SDK passes --mcp-config with inline JSON
        // containing double quotes, which cmd.exe mangles (strips quotes, breaks parsing).
        // The command is always a resolved binary path, so shell routing is unnecessary.
        shell: false,
      });
      onChildProcess?.(child);
      if (typeof options.stderr === "function") {
        child.stderr?.on("data", (chunk: Buffer | string) => {
          options.stderr?.(chunk.toString());
        });
      }
      if (!isChildProcessWithStreams(child)) {
        throw new Error("Claude process was spawned without stdio streams");
      }
      return new SpawnedClaudeProcess(child, spawnOptions.signal);
    },
  };
}

export function claudeQuery(input: ClaudeQueryInput, context: ClaudeQueryContext = {}): Query {
  const launchQuery = context.queryFactory ?? query;
  return launchQuery({
    ...input,
    options: applyRuntimeSettingsToClaudeOptions(input.options, context),
  });
}
