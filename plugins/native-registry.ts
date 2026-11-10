import type { PluginServerContribution } from "@getpaseo/plugin/server";
import antigravityProvider from "./antigravity-provider/index.server.js";
import claudeUsageSource from "./claude-usage-source/index.server.js";
import codexUsageSource from "./codex-usage-source/index.server.js";
import copilotUsageSource from "./copilot-usage-source/index.server.js";
import cursorUsageSource from "./cursor-usage-source/index.server.js";
import grokUsageSource from "./grok-usage-source/index.server.js";
import hopliteProvider from "./hoplite-provider/index.server.js";
import kimiUsageSource from "./kimi-usage-source/index.server.js";
import minimaxUsageSource from "./minimax-usage-source/index.server.js";
import museProvider from "./muse-provider/index.server.js";
import opencodeGoUsageSource from "./opencode-go-usage-source/index.server.js";
import worktreeInclude from "./worktree-include/index.server.js";
import zaiUsageSource from "./zai-usage-source/index.server.js";

/**
 * Server entries of the built-in plugins, compiled into the native daemon, which cannot bundle and
 * evaluate them at run time. The Node daemon never imports this module. Keys are plugin IDs and
 * must match the server's `builtinPlugins` list; `builtin/index.test.ts` checks both against the
 * directories here.
 */
export const builtinPluginContributions: Readonly<Record<string, PluginServerContribution>> = {
  "antigravity-provider": antigravityProvider,
  "claude-usage-source": claudeUsageSource,
  "codex-usage-source": codexUsageSource,
  "copilot-usage-source": copilotUsageSource,
  "cursor-usage-source": cursorUsageSource,
  "grok-usage-source": grokUsageSource,
  "hoplite-provider": hopliteProvider,
  "kimi-usage-source": kimiUsageSource,
  "minimax-usage-source": minimaxUsageSource,
  "muse-provider": museProvider,
  "opencode-go-usage-source": opencodeGoUsageSource,
  "worktree-include": worktreeInclude,
  "zai-usage-source": zaiUsageSource,
};
