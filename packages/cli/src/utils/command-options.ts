import type { Command } from "commander";
import { selectDaemonTarget } from "./daemon-target.js";

const JSON_OPTION_DESCRIPTION = "Output in JSON format";
const DAEMON_HOST_OPTION_DESCRIPTION =
  "Explicit daemon endpoint: host:port, TCP, socket, SSH, or pairing URL (default: local home)";

const localCommands = new WeakSet<Command>();

export function addLocalDaemonOptions<T extends Command>(command: T): T {
  localCommands.add(command);
  command.option("--home <path>", "Local daemon home (default: ~/.paseo)");
  return command;
}

export function collectMultiple(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function addJsonOption<T extends Command>(command: T): T {
  command.option("--json", JSON_OPTION_DESCRIPTION);
  return command;
}

export function addDaemonHostOption<T extends Command>(command: T): T {
  command.option("--host <host>", DAEMON_HOST_OPTION_DESCRIPTION);
  const current = command.opts() as { home?: unknown };
  if (!("home" in current))
    command.option("--home <path>", "Select a local daemon home (default: ~/.paseo)");
  return command;
}

export function addJsonAndDaemonHostOptions<T extends Command>(command: T): T {
  return addDaemonHostOption(addJsonOption(command));
}

export function withGlobalOptions(
  handler: (a?: any, b?: any, c?: any, d?: any) => any,
): (a?: any, b?: any, c?: any, d?: any) => any {
  return (a?: any, b?: any, c?: any, d?: any) => {
    const command = (d !== undefined ? d : c !== undefined ? c : b) as Command;
    const options = command.optsWithGlobals() as Record<string, unknown>;
    const selectors = { home: [] as string[], host: [] as string[] };
    for (let current: Command | null = command; current; current = current.parent) {
      const currentOptions = current.opts() as Record<string, unknown>;
      const home = currentOptions.home;
      const host = currentOptions.host;
      if (typeof home === "string" && !selectors.home.includes(home)) selectors.home.push(home);
      if (typeof host === "string" && !selectors.host.includes(host)) selectors.host.push(host);
    }
    if (selectors.home.length > 1) {
      throw { code: "TARGET_AMBIGUOUS", message: "Conflicting duplicate --home selectors." };
    }
    if (selectors.host.length > 1) {
      throw { code: "TARGET_AMBIGUOUS", message: "Conflicting duplicate --host selectors." };
    }
    const localOnly = localCommands.has(command);
    options.daemonTarget = selectDaemonTarget(
      {
        home: typeof options.home === "string" ? options.home : undefined,
        host: typeof options.host === "string" ? options.host : undefined,
      },
      process.env,
      localOnly,
    );
    if (d !== undefined) return handler(a, b, options, d);
    if (c !== undefined) return handler(a, options, c, d);
    return handler(options, b, c, d);
  };
}
