import type { ChildProcess } from "node:child_process";

export interface PluginNodeLaunch {
  entry: string;
  execArgv: string[];
}

export function forkPluginProcess(input: PluginNodeLaunch): ChildProcess;
