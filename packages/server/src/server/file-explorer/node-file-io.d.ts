import type { FileHandle } from "node:fs/promises";

/** The Stats fields the file explorer reads, with its revision of the file's content. */
export interface FileRevisionStats {
  isFile: boolean;
  size: number;
  mode: number;
  mtime: Date;
  /** `dev:ino:size:mtimeNs` from bigint Stats. */
  revision: string;
}

export function openNoFollowForRead(filePath: string): Promise<FileHandle>;
export function statHandleRevision(handle: FileHandle): Promise<FileRevisionStats>;
export function statPathRevision(filePath: string): Promise<FileRevisionStats>;
