import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../../server/private-files.js";

export interface AgentHookEventDefinition {
  event: string;
}

export type AgentHookActivityState = "running" | "idle" | "needs-input";

export interface AgentHookActivityInput {
  isTTY?: boolean;
  read(): Promise<string | null>;
}

export interface AgentHookProvider<TConfig = unknown> {
  id: string;
  events: AgentHookEventDefinition[];
  resolveActivity(input: {
    event: string;
    input: AgentHookActivityInput;
  }): Promise<AgentHookActivityState | null>;
  install: AgentHookInstallStrategy<TConfig>;
}

export type AgentHookInstallStrategy<TConfig> =
  | AgentHookConfigFileInstallStrategy<TConfig>
  | AgentHookPluginFileInstallStrategy;

interface AgentHookInstallStrategyBase {
  kind: "config-file" | "plugin-file";
  configDir: string;
  configDirBase?: "home" | "xdg-config";
  configFile: string;
  configDirEnvOverride?: string;
  hookMarker: string;
}

export interface AgentHookConfigFileInstallStrategy<TConfig> extends AgentHookInstallStrategyBase {
  kind: "config-file";
  format: AgentHookConfigFormat<TConfig>;
}

export interface AgentHookPluginFileInstallStrategy extends AgentHookInstallStrategyBase {
  kind: "plugin-file";
  source: string;
}

/**
 * The provider fields a config format reads. Not `AgentHookProvider` itself: scriptc cannot lower
 * that type's recursion through `install.format`.
 */
export interface AgentHookFormatProvider {
  id: string;
  events: AgentHookEventDefinition[];
  install: { hookMarker: string };
}

export interface AgentHookConfigFormat<TConfig> {
  empty(): TConfig;
  parse(raw: string): TConfig;
  stringify(config: TConfig): string;
  install(config: TConfig, provider: AgentHookFormatProvider): TConfig;
  uninstall(config: TConfig, provider: AgentHookFormatProvider): TConfig;
  isInstalled(config: TConfig, provider: AgentHookFormatProvider): boolean;
}

export interface AgentHookInstallOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  configDir?: string;
}

export interface AgentHookInstallLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface AgentHookInstallResult {
  configPath: string;
  changed: boolean;
}

export function installAgentHooks<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): AgentHookInstallResult {
  const install: AgentHookInstallStrategy<TConfig> = provider.install;
  if (install.kind === "plugin-file") {
    return installAgentHookPluginFile(install, options);
  }

  const format = install.format;
  const formatProvider: AgentHookFormatProvider = {
    id: provider.id,
    events: provider.events,
    install: { hookMarker: install.hookMarker },
  };
  return updateAgentHookConfig(install, options, (config) =>
    format.install(config, formatProvider),
  );
}

export function uninstallAgentHooks<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): AgentHookInstallResult {
  const install: AgentHookInstallStrategy<TConfig> = provider.install;
  if (install.kind === "plugin-file") {
    return uninstallAgentHookPluginFile(install, options);
  }

  const format = install.format;
  const formatProvider: AgentHookFormatProvider = {
    id: provider.id,
    events: provider.events,
    install: { hookMarker: install.hookMarker },
  };
  return updateAgentHookConfig(install, options, (config) =>
    format.uninstall(config, formatProvider),
  );
}

export function agentHooksAreInstalled<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): boolean {
  const configPath = resolveAgentHookConfigPath(provider, options);
  if (!existsSync(configPath)) {
    return false;
  }
  const install: AgentHookInstallStrategy<TConfig> = provider.install;
  if (install.kind === "plugin-file") {
    const currentRaw = readFileSync(configPath, "utf8");
    return normalizeRawConfig(currentRaw) === normalizeRawConfig(install.source);
  }

  const config = install.format.parse(readFileSync(configPath, "utf8"));
  return install.format.isInstalled(config, {
    id: provider.id,
    events: provider.events,
    install: { hookMarker: install.hookMarker },
  });
}

export function resolveAgentHookConfigPath<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): string {
  return resolveAgentHookInstallPath(provider.install, options);
}

/** The install fields that locate the config file. */
interface AgentHookInstallLocation {
  configDir: string;
  configDirBase?: "home" | "xdg-config";
  configFile: string;
  configDirEnvOverride?: string;
}

function resolveAgentHookInstallPath<TConfig>(
  install: AgentHookInstallStrategy<TConfig>,
  options: AgentHookInstallOptions,
): string {
  // A record of only the location fields: scriptc cannot pass the strategy union, whose
  // config-file arm carries `TConfig`, on to non-generic code.
  const location: AgentHookInstallLocation = {
    configDir: install.configDir,
    configDirBase: install.configDirBase,
    configFile: install.configFile,
    configDirEnvOverride: install.configDirEnvOverride,
  };
  const configDir =
    options.configDir ??
    resolveConfiguredDirectory({
      location,
      env: options.env ?? process.env,
      homeDir: options.homeDir ?? homedir(),
    });
  return path.join(configDir, location.configFile);
}

export function buildAgentHookShellCommand(
  provider: AgentHookFormatProvider,
  event: AgentHookEventDefinition,
): string {
  const hookCommand = `"\${PASEO_HOOK_CLI:-paseo}" hooks ${shellToken(provider.id)} ${shellToken(event.event)}`;
  return `if [ -n "$PASEO_TERMINAL_ID" ]; then ${hookCommand}; fi`;
}

export function buildAgentHookWindowsCommand(
  provider: AgentHookFormatProvider,
  event: AgentHookEventDefinition,
): string {
  const hookArgs = `hooks ${windowsToken(provider.id)} ${windowsToken(event.event)}`;
  return `if defined PASEO_TERMINAL_ID (if defined PASEO_HOOK_CLI ("%PASEO_HOOK_CLI%" ${hookArgs}) else (paseo ${hookArgs})) else (exit /b 0)`;
}

function installAgentHookPluginFile(
  install: AgentHookPluginFileInstallStrategy,
  options: AgentHookInstallOptions,
): AgentHookInstallResult {
  const configPath = resolveAgentHookInstallPath(install, options);
  const currentRaw = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const nextRaw = normalizeRawConfig(install.source);

  if (currentRaw === null || normalizeRawConfig(currentRaw) !== nextRaw) {
    writePrivateFileAtomicSync(configPath, nextRaw);
    return { configPath, changed: true };
  }

  return { configPath, changed: false };
}

function uninstallAgentHookPluginFile(
  install: AgentHookPluginFileInstallStrategy,
  options: AgentHookInstallOptions,
): AgentHookInstallResult {
  const configPath = resolveAgentHookInstallPath(install, options);
  if (!existsSync(configPath)) {
    return { configPath, changed: false };
  }

  rmSync(configPath, { force: true });
  return { configPath, changed: true };
}

function updateAgentHookConfig<TConfig>(
  install: AgentHookConfigFileInstallStrategy<TConfig>,
  options: AgentHookInstallOptions,
  update: (config: TConfig) => TConfig,
): AgentHookInstallResult {
  const configPath = resolveAgentHookInstallPath(install, options);
  const currentRaw = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const currentConfig =
    currentRaw === null ? install.format.empty() : install.format.parse(currentRaw);
  const nextConfig = update(currentConfig);
  const nextRaw = install.format.stringify(nextConfig);

  if (currentRaw === null || nextRaw !== normalizeRawConfig(currentRaw)) {
    writePrivateFileAtomicSync(configPath, nextRaw);
    return { configPath, changed: true };
  }

  return { configPath, changed: false };
}

function resolveConfiguredDirectory(input: {
  location: AgentHookInstallLocation;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string {
  const overrideName = input.location.configDirEnvOverride;
  const override = overrideName ? input.env[overrideName] : undefined;
  if (override) {
    return override;
  }

  if (input.location.configDirBase === "xdg-config") {
    return path.join(resolveXdgConfigHome(input), input.location.configDir);
  }

  return path.join(input.homeDir, input.location.configDir);
}

function resolveXdgConfigHome(input: { env: NodeJS.ProcessEnv; homeDir: string }): string {
  if (input.env.XDG_CONFIG_HOME) {
    return input.env.XDG_CONFIG_HOME;
  }

  return path.join(input.homeDir, ".config");
}

function normalizeRawConfig(raw: string): string {
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsToken(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
