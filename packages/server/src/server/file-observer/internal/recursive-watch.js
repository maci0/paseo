import { watch } from "node:fs";

// Node path of the macOS and Windows backend, as upstream. It is JavaScript because scriptc has
// no lowering for fs.watch with the recursive option and refuses it in TypeScript; in JavaScript
// it only throws if it runs. native-recursive.ts never calls this in a scriptc binary.
/**
 * @param {string} root
 * @param {(eventType: string, filename: string | null) => void} listener
 * @returns {{ close(): void; on(event: "error", listener: (error: Error) => void): unknown }}
 */
export function watchRecursive(root, listener) {
  return watch(root, { recursive: true }, listener);
}
