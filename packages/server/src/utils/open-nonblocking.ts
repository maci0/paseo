import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { requireNodeOnly } from "../server/node-only-require.js";

interface NodeFsPromises {
  open(path: string, flags: number): Promise<FileHandle>;
}

// scriptc lowers fs/promises open() only with string flags, so Node loads its own
// fs/promises through requireNodeOnly, which scriptc leaves to run time and only Node runs.
// A scriptc binary reports process.argv[0] as "scriptc".
function loadNodeFsPromises(): NodeFsPromises {
  return requireNodeOnly("node:fs/promises") as NodeFsPromises;
}

const nodeFsPromises = process.argv[0] === "scriptc" ? undefined : loadNodeFsPromises();

/**
 * Opens `path` read-only with O_NONBLOCK, so a FIFO is rejected by the caller's stat of the
 * handle instead of hanging open() until a writer appears.
 *
 * Native builds cannot pass O_NONBLOCK: they stat the path first and throw for a FIFO, which
 * leaves a window where a file replaced by a FIFO after that stat blocks open().
 */
export async function openReadNonBlocking(path: string): Promise<FileHandle> {
  if (nodeFsPromises !== undefined) {
    return nodeFsPromises.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  }
  if ((await stat(path)).isFIFO()) {
    throw new Error(`Refusing to open FIFO: ${path}`);
  }
  return open(path, "r");
}
