// Sends a message to the parent over the IPC channel of a forked plugin process. It is
// JavaScript because scriptc refuses IPC messages that carry Uint8Array (paseo_frame) in
// TypeScript, and in JavaScript it only throws if it runs; a scriptc binary never forks a
// plugin process (see spawnPluginChild in runtime.ts).
/**
 * @param {import("./plugin-process-protocol.js").PluginProcessMessage} message
 * @param {(() => void) | undefined} callback
 * @returns {void}
 */
export function sendToParent(message, callback) {
  if (callback) process.send?.(message, () => callback());
  else process.send?.(message);
}
