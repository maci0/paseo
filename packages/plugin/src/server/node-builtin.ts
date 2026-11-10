import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Loads a Node builtin module by id, or returns `undefined` when this Node lacks it (for
 * example `node:sqlite` before Node 22.5), as `process.getBuiltinModule` does. A `require`,
 * because scriptc cannot compile `getBuiltinModule` into a program that also has native
 * callbacks from other threads. The daemon's native build compiles this package from dist
 * JavaScript, so the JSDoc types are the ones scriptc sees.
 *
 * @param {string} id
 * @returns {unknown}
 */
export function loadNodeBuiltin(id: string): unknown {
  try {
    return require(id);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_UNKNOWN_BUILTIN_MODULE") return undefined;
    throw error;
  }
}
