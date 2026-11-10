import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadNodeBuiltin } from "./node-builtin.js";

describe("loadNodeBuiltin", () => {
  it("returns the builtin module", () => {
    expect(loadNodeBuiltin("node:path")).toBe(path);
  });

  it("returns undefined for a builtin this Node does not have", () => {
    expect(loadNodeBuiltin("node:no-such-builtin")).toBeUndefined();
  });

  it("rethrows other load failures", () => {
    expect(() => loadNodeBuiltin("no-such-package-anywhere")).toThrow(/Cannot find module/);
  });
});
