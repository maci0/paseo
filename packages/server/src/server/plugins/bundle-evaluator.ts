import * as pluginSharedRuntime from "@getpaseo/plugin";
import * as pluginProviderRuntime from "@getpaseo/plugin/server/provider";
import * as pluginAcpRuntime from "@getpaseo/plugin/server/acp";
import * as pluginUsageRuntime from "@getpaseo/plugin/server/usage";
import * as pluginServerRuntime from "@getpaseo/plugin/server";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import * as zod from "zod";
import { isPluginClientOnlySdkSpecifier } from "./plugin-sdk-specifiers.js";
import { requireNodeOnly } from "../node-only-require.js";

function runtimeRequire(name: string): unknown {
  if (isPluginClientOnlySdkSpecifier(name)) {
    throw new Error(`${name} is available only in plugin client code`);
  }
  if (name === "@getpaseo/plugin") return pluginSharedRuntime;
  if (name === "@getpaseo/plugin/server") return pluginServerRuntime;
  if (name === "@getpaseo/plugin/server/provider") return pluginProviderRuntime;
  if (name === "@getpaseo/plugin/server/acp") return pluginAcpRuntime;
  if (name === "@getpaseo/plugin/server/usage") return pluginUsageRuntime;
  if (name === "zod") return zod;
  if (name === "@getpaseo/plugin/client/host")
    throw new Error(`${name} is private to the app host`);
  return requireNodeOnly(name);
}

export function evaluateBundle(bundle: string): PluginServerContribution {
  // A scriptc binary has no JavaScript engine: its eval always throws EvalError.
  if (process.argv[0] === "scriptc") {
    throw new Error(
      "Plugin server code needs the Node.js daemon: the native binary cannot evaluate it",
    );
  }
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function") throw new Error("Plugin server bundle is not executable");
  const exports = factory(runtimeRequire);
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error("Plugin server bundle must default export a function");
  }
  return setup as PluginServerContribution;
}
