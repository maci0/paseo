import { fork } from "node:child_process";

// Node path of the plugin process, as upstream. It is JavaScript because scriptc refuses a
// fork() of a runtime path with advanced serialization in TypeScript, and in JavaScript it only
// throws if it runs; a scriptc binary never calls this.
/**
 * @param {{ entry: string; execArgv: string[] }} input
 * @returns {import("node:child_process").ChildProcess}
 */
export function forkPluginProcess(input) {
  return fork(input.entry, [], {
    execArgv: input.execArgv,
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}
