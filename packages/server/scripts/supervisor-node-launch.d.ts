import type { ChildProcess } from "node:child_process";

export interface WorkerSpawnSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface NodeWorkerLaunch {
  workerEntry: string;
  workerArgs: string[];
  workerEnv: NodeJS.ProcessEnv;
  workerExecArgv: string[];
  spawnSpec: WorkerSpawnSpec | null;
}

export function launchNodeWorker(input: NodeWorkerLaunch): ChildProcess;
