import { constants, promises as fs } from "node:fs";

// Node file I/O of the file explorer, as upstream. It is JavaScript because scriptc refuses
// numeric open flags and bigint Stats in TypeScript, and in JavaScript they only throw if they
// run; a scriptc binary takes the native paths in service.ts instead.

/**
 * @typedef {{ isFile: boolean; size: number; mode: number; mtime: Date; revision: string }} FileRevisionStats
 */

const READ_FILE_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

/**
 * Opens a file for reading, refusing a symbolic link at the final component (O_NOFOLLOW).
 * @param {string} filePath
 * @returns {Promise<import("node:fs/promises").FileHandle>}
 */
export function openNoFollowForRead(filePath) {
  return fs.open(filePath, READ_FILE_OPEN_FLAGS);
}

/**
 * @param {import("node:fs").BigIntStats} stats
 * @returns {FileRevisionStats}
 */
function revisionStats(stats) {
  return {
    isFile: stats.isFile(),
    size: Number(stats.size),
    mode: Number(stats.mode),
    mtime: stats.mtime,
    revision: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`,
  };
}

/**
 * @param {import("node:fs/promises").FileHandle} handle
 * @returns {Promise<FileRevisionStats>}
 */
export async function statHandleRevision(handle) {
  return revisionStats(await handle.stat({ bigint: true }));
}

/**
 * @param {string} filePath
 * @returns {Promise<FileRevisionStats>}
 */
export async function statPathRevision(filePath) {
  return revisionStats(await fs.stat(filePath, { bigint: true }));
}
