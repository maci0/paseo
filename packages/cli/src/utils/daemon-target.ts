import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { resolvePaseoHome } from "@getpaseo/server/daemon-control";

export type DaemonTarget = { kind: "instance"; home: string } | { kind: "endpoint"; host: string };

export function selectDaemonTarget(
  options: { home?: string; host?: string },
  env: NodeJS.ProcessEnv = process.env,
  localOnly = false,
): DaemonTarget {
  for (const key of ["home", "host"] as const) {
    if (options[key] !== undefined && !options[key]!.trim())
      throw { code: "TARGET_INVALID", message: `--${key} requires a non-empty value.` };
  }
  if (options.home !== undefined && options.host !== undefined)
    throw { code: "TARGET_AMBIGUOUS", message: "Choose either --home or --host, not both." };
  if (localOnly) {
    if (options.host !== undefined)
      throw {
        code: "LOCAL_OPERATION",
        message: "This is a local operation; use --home. --host is not supported.",
      };
    return {
      kind: "instance",
      home: resolvePaseoHome({ PASEO_HOME: options.home ?? env.PASEO_HOME }),
    };
  }
  if (options.home !== undefined)
    return { kind: "instance", home: resolvePaseoHome({ PASEO_HOME: options.home }) };
  if (options.host !== undefined) return { kind: "endpoint", host: options.host };
  if (env.PASEO_HOME && env.PASEO_HOST)
    throw {
      code: "TARGET_AMBIGUOUS",
      message: "PASEO_HOME and PASEO_HOST are both set. Choose --home or --host explicitly.",
    };
  if (env.PASEO_HOST) return { kind: "endpoint", host: env.PASEO_HOST };
  return { kind: "instance", home: resolvePaseoHome({ PASEO_HOME: env.PASEO_HOME }) };
}

export function describeDaemonTarget(target: DaemonTarget): string {
  if (target.kind === "instance") return `home ${target.home}`;
  try {
    const input = target.host.trim();
    const parsed = parseHostTarget(input);
    // Discovery descriptions are display text; command hints must preserve the address syntax.
    // The kind is read from the same prefixes parseHostTarget uses, because scriptc
    // cannot read offer or socketPath off the HostTarget union.
    if (input.startsWith("ssh://")) return redactEndpoint(input, true);
    if (input.startsWith("relay://") || input.includes("#connect=")) return parsed.description;
    if (
      input.startsWith("unix://") ||
      input.startsWith("pipe://") ||
      input.startsWith("/") ||
      input.startsWith("~") ||
      input.startsWith("\\\\.\\pipe\\")
    ) {
      return input;
    }
    if (input.includes("://")) return redactEndpoint(input, false);
    return parsed.description;
  } catch {
    return "<invalid endpoint>";
  }
}

function redactEndpoint(input: string, ssh: boolean): string {
  const url = new URL(input);
  if (decodeURIComponent(url.username).includes(":")) url.username = "REDACTED";
  const keys: string[] = [];
  url.searchParams.forEach((_value, key) => {
    if (!keys.includes(key)) keys.push(key);
  });
  for (const key of keys) {
    const values = url.searchParams.getAll(key);
    const routingOption =
      (ssh && key === "daemonPort") ||
      (key === "ssl" && values.every((value) => value === "true" || value === "false"));
    if (!routingOption) url.searchParams.set(key, "REDACTED");
  }
  return url.toString();
}
