import type * as build from "./compiler-build.js";
import type { PluginManifest } from "./manifest.js";
import { createNodePluginCompiler } from "./compiler-node.js";

export {
  SERVER_HOST_MODULES,
  resolveExistingAsarUnpackedEsbuildBinary,
  unpackedEsbuildBinaryFromPackageDir,
} from "./compiler-esbuild.js";

export type CompilerTask =
  | { kind: "entries"; entries: Parameters<typeof build.compilePlugin>[0] }
  | { kind: "directory"; directory: string; version: string; builtinId?: string }
  | {
      kind: "prepare";
      directory: string;
      commands: PluginManifest["build"];
      environment: NodeJS.ProcessEnv;
    };

interface TaskResult {
  entries: Awaited<ReturnType<typeof build.compilePlugin>>;
  directory: Awaited<ReturnType<typeof build.compileDirectoryPlugin>>;
  prepare: void;
}

// The compiler runs esbuild and the TypeScript API in a worker thread. A scriptc binary has
// neither package nor a JavaScript engine to evaluate the bundles, so it compiles nothing.
const compiler = process.argv[0] === "scriptc" ? null : createNodePluginCompiler(import.meta.url);

export function runCompilerTask<T extends CompilerTask>(
  task: T,
  onLog?: (data: Record<string, unknown>, message: string) => void,
): Promise<TaskResult[T["kind"]]> {
  if (!compiler) {
    return Promise.reject(
      new Error("Plugins need the Node.js daemon: the native binary cannot compile plugins"),
    );
  }
  return compiler.run(task, onLog) as Promise<TaskResult[T["kind"]]>;
}

export function compilePlugin(entries: Parameters<typeof build.compilePlugin>[0]) {
  return runCompilerTask({ kind: "entries", entries });
}

export function compileDirectoryPlugin(directory: string, version: string, builtinId?: string) {
  return runCompilerTask({ kind: "directory", directory, version, builtinId });
}
