import type { PluginProcessMessage } from "./plugin-process-protocol.js";

export function sendToParent(
  message: PluginProcessMessage,
  callback: (() => void) | undefined,
): void;
