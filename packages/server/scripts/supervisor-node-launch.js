import { fork, spawn } from "node:child_process";

// Node path of the supervisor, as upstream. It is JavaScript because scriptc refuses both
// calls in TypeScript (fork() of a runtime path, an "ipc" entry in spawn() stdio) and in
// JavaScript only throws if they run; a scriptc binary never calls this.
/**
 * @param {import("./supervisor-node-launch.js").NodeWorkerLaunch} input
 * @returns {import("node:child_process").ChildProcess}
 */
export function launchNodeWorker(input) {
  if (input.spawnSpec) {
    return spawn(input.spawnSpec.command, input.spawnSpec.args, {
      stdio: ["inherit", "pipe", "pipe", "ipc"],
      env: input.spawnSpec.env ?? input.workerEnv,
    });
  }
  return fork(input.workerEntry, input.workerArgs, {
    stdio: ["inherit", "pipe", "pipe", "ipc"],
    env: input.workerEnv,
    execArgv: input.workerExecArgv,
  });
}
