import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SkillTargets } from "./operations.js";

export function resolveBundledSkillsDir(moduleUrl: string | URL = import.meta.url): string {
  // In a scriptc binary (process.argv[0] "scriptc") import.meta.url is the source path on the
  // build machine, so the files ship beside the executable as skills/.
  if (process.argv[0] === "scriptc") return path.join(path.dirname(process.execPath), "skills");
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "..", "skills"),
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "..", "skills"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function resolveSkillTargets(home: string = os.homedir()): SkillTargets {
  return {
    sourceDir: resolveBundledSkillsDir(),
    agentsDir: path.join(home, ".agents", "skills"),
    claudeDir: path.join(home, ".claude", "skills"),
    codexDir: path.join(home, ".codex", "skills"),
  };
}
