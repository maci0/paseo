import { PassThrough } from "node:stream";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import type { PluginProcessRequest } from "./plugin-process-protocol.js";

export class InternalPluginChild {
  connected: boolean;
  killed: boolean;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  constructor(contribute: PluginServerContribution);
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean;
  kill(): boolean;
  disconnect(): void;
}
