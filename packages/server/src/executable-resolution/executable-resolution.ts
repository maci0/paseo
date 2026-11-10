import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import { execCommand } from "../utils/spawn.js";
import { windowsExecutableResolution } from "./windows.js";

const PROBE_TIMEOUT_MS = 2000;

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function enumerateCandidates(name: string, env?: ProcessEnvRecord): Promise<string[]> {
  if (process.platform !== "win32" && existsSync("/usr/bin/which")) {
    return enumerateCandidatesViaSystemWhich(name, env);
  }
  return enumerateCandidatesViaPath(name, env);
}

async function enumerateCandidatesViaSystemWhich(
  name: string,
  env?: ProcessEnvRecord,
): Promise<string[]> {
  try {
    const { stdout } = await execCommand("/usr/bin/which", ["-a", name], {
      baseEnv: env,
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
  } catch (error) {
    // which exits 1 for a missing command. A failed lookup is not evidence of absence.
    if (error instanceof Error && "code" in error && error.code === 1) return [];
    throw error;
  }
}

function enumerateCandidatesViaPath(name: string, env?: ProcessEnvRecord): string[] {
  const pathValue = env?.PATH ?? process.env.PATH ?? "";
  const pathExt = (env?.PATHEXT ?? process.env.PATHEXT ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? ["", ...pathExt] : [""];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, name + extension);
      if (seen.has(candidate) || !existsSync(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export async function probeExecutable(
  executablePath: string,
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const { probeTimeoutMs: timeoutMs = PROBE_TIMEOUT_MS, env } =
    typeof options === "number" ? { probeTimeoutMs: options } : options;
  try {
    await execCommand(executablePath, ["--version"], {
      baseEnv: env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch (error) {
    return classifyProbeError(error);
  }
}

function classifyProbeError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & {
    killed?: boolean;
  };
  if (err.killed) {
    return true;
  }
  if (typeof err.code === "number") {
    return true;
  }
  if (
    err.code === "ENOENT" ||
    err.code === "EACCES" ||
    err.code === "ENOEXEC" ||
    err.code === "UNKNOWN"
  ) {
    return false;
  }
  return false;
}

/**
 * Check a literal executable path. PATH search is handled by findExecutable().
 */
export function executableExists(
  executablePath: string,
  exists: typeof existsSync = existsSync,
): string | null {
  if (process.platform === "win32") {
    return windowsExecutableResolution.exists(executablePath, { exists });
  }
  return exists(executablePath) ? executablePath : null;
}

// PATH lookup that never runs the candidate, unlike findExecutable which probes
// each one with `--version`. A terminal spawn path cannot afford that probe: it
// would execute the profile command once before the terminal even opens.
// `path` overrides the PATH to search, so a caller can resolve against the
// environment its child process will actually get rather than the daemon's own.
export async function findExecutableWithoutProbing(
  name: string,
  options: { path?: string; cwd: string },
): Promise<string | null> {
  if (!name) {
    return null;
  }
  const path =
    options.path === undefined
      ? undefined
      : options.path
          .split(delimiter)
          .map((entry) => resolve(options.cwd, entry))
          .join(delimiter);
  const candidates = enumerateCandidatesViaPath(name, path === undefined ? undefined : { PATH: path });
  return candidates[0] ?? null;
}

export interface ExecutableResolutionOptions {
  probeTimeoutMs?: number;
  env?: ProcessEnvRecord;
}

export async function findExecutable(
  name: string,
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const { probeTimeoutMs = PROBE_TIMEOUT_MS, env } =
    typeof options === "number" ? { probeTimeoutMs: options } : options;
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (process.platform === "win32") {
    return windowsExecutableResolution.find(trimmed, {
      enumeratePathCandidates: (command) => enumerateCandidates(command, env),
      probeExecutable: (command, timeout) =>
        probeExecutable(command, { probeTimeoutMs: timeout, env }),
      exists: existsSync,
      probeTimeoutMs,
    });
  }

  if (hasPathSeparator(trimmed)) {
    return (await probeExecutable(trimmed, { probeTimeoutMs, env })) ? trimmed : null;
  }

  const candidates = await enumerateCandidates(trimmed, env);
  for (const candidate of candidates) {
    if (await probeExecutable(candidate, { probeTimeoutMs, env })) {
      return candidate;
    }
  }
  return null;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
