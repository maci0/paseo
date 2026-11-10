import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Loads a package that only Node can run. A scriptc build compiles every package it can
 * see statically; a request made here is resolved when it runs, so the package stays out
 * of a native binary. This file is JavaScript because scriptc accepts a computed
 * specifier from JavaScript, both in source and in dist, and not from TypeScript.
 * Callers check `process.argv[0] !== "scriptc"` first.
 *
 * @param {string} specifier
 * @returns {unknown}
 */
export function requireNodeOnly(specifier) {
  return require(specifier);
}
