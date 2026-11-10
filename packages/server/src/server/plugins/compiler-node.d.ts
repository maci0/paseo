import type { CompilerTask } from "./compiler.js";

export interface NodePluginCompiler {
  run(
    task: CompilerTask,
    onLog: ((data: Record<string, unknown>, message: string) => void) | undefined,
  ): Promise<unknown>;
}

export function createNodePluginCompiler(compilerModuleUrl: string): NodePluginCompiler;
