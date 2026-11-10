import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { type PluginManifest, readPluginManifest } from "../manifest.js";

export const builtinPlugins = [
  "antigravity-provider",
  "claude-usage-source",
  "codex-usage-source",
  "copilot-usage-source",
  "cursor-usage-source",
  "grok-usage-source",
  "hoplite-provider",
  "kimi-usage-source",
  "minimax-usage-source",
  "muse-provider",
  "opencode-go-usage-source",
  "worktree-include",
  "zai-usage-source",
] as const;

export function resolveBuiltinPluginsRoot(moduleUrl: string | URL = import.meta.url): string {
  // In a scriptc binary (process.argv[0] "scriptc") import.meta.url is the source path on the
  // build machine, so the files ship beside the executable as builtin-plugins/.
  if (process.argv[0] === "scriptc") return path.join(path.dirname(process.execPath), "builtin-plugins");
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const archiveSegment = `${path.sep}app.asar${path.sep}`;
  const archiveIndex = moduleDir.indexOf(archiveSegment);
  if (archiveIndex !== -1) {
    // esbuild runs outside Electron's filesystem shim and cannot read archive entries.
    return path.join(moduleDir.slice(0, archiveIndex), "builtin-plugins");
  }
  const candidates = [
    path.resolve(moduleDir, "..", "..", "..", "builtin-plugins"),
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "..", "plugins"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export interface BuiltinPlugin {
  id: string;
  directory: string;
}

export class BuiltinPluginLoader {
  readonly ids: ReadonlySet<string>;

  constructor(
    private readonly root = resolveBuiltinPluginsRoot(),
    private readonly list: readonly string[] = builtinPlugins,
  ) {
    this.ids = new Set(list);
  }

  async load(start: (plugin: BuiltinPlugin) => Promise<void>): Promise<void> {
    for (const id of this.list) {
      await start({ id, directory: path.join(this.root, id) });
    }
  }
}

/** Relative path of the module that statically imports every built-in's server entry. */
const NATIVE_REGISTRY_SPECIFIER = "../../../../../../plugins/native-registry.ts";

export interface LoadedBuiltinPlugin {
  manifest: PluginManifest;
  contribute: PluginServerContribution;
  clientBundle: string;
}

interface NativeBuiltinRegistry {
  builtinPluginContributions: Readonly<Record<string, PluginServerContribution>>;
}

/**
 * Loads a built-in plugin in a scriptc binary, which can neither bundle nor evaluate plugin code:
 * the server entry comes compiled into the binary instead. Performs the same manifest checks as
 * compiling the plugin directory. Built-ins have no client entry (`index.test.ts` checks).
 */
export async function loadNativeBuiltinPlugin(input: {
  id: string;
  directory: string;
  daemonVersion: string;
}): Promise<LoadedBuiltinPlugin> {
  const manifest = await readPluginManifest(input.directory);
  if (manifest.id !== input.id) {
    throw new Error(`Built-in plugin ${input.id} has manifest ID ${manifest.id}`);
  }
  assertPluginCompatibility({ ...manifest, version: input.daemonVersion, runtime: "daemon" });
  // A const specifier: scriptc compiles the module it names into the binary, while the server's
  // tsc build and the Node daemon never load the plugin sources.
  const registry: NativeBuiltinRegistry = await import(NATIVE_REGISTRY_SPECIFIER);
  const contribute = registry.builtinPluginContributions[input.id];
  if (!contribute) throw new Error(`Built-in plugin ${input.id} is not in the native registry`);
  return { manifest, contribute, clientBundle: "" };
}
