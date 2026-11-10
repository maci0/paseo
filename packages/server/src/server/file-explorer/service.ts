import { promises as fs, type Stats } from "fs";
import type { FileHandle } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { expandUserPath, resolvePathFromBase } from "../path-utils.js";
import { runGitCommand } from "../../utils/run-git-command.js";
import {
  openNoFollowForRead,
  statHandleRevision,
  statPathRevision,
  type FileRevisionStats,
} from "./node-file-io.js";

export type ExplorerEntryKind = "file" | "directory";
export type ExplorerFileKind = "text" | "image" | "binary";
export type ExplorerEncoding = "utf-8" | "base64" | "none";

export interface ListDirectoryParams {
  root: string;
  relativePath?: string;
}

export interface ReadFileParams {
  root: string;
  relativePath: string;
}

export interface WriteFileParams extends ReadFileParams {
  content: string;
  /** `base64` writes the decoded bytes, so binary files can be written too. */
  contentEncoding?: "utf-8" | "base64";
  expectedModifiedAt: string;
  expectedRevision?: string;
}

export type ExplorerFileVersion =
  | {
      status: "ready";
      cwd: string;
      path: string;
      size: number;
      modifiedAt: string;
      revision: string;
      kind?: ExplorerFileKind;
      mimeType?: string;
    }
  | { status: "missing"; cwd: string; path: string }
  | { status: "error"; cwd: string; path: string; error: string };

export type ExplorerFileWriteResult =
  | { status: "written"; modifiedAt: string; size: number; revision: string }
  | { status: "conflict"; version: ExplorerFileVersion }
  | { status: "error"; error: string };

export interface FileExplorerEntry {
  name: string;
  path: string;
  kind: ExplorerEntryKind;
  size: number;
  modifiedAt: string;
}

export interface FileExplorerDirectory {
  path: string;
  entries: FileExplorerEntry[];
}

export interface FileExplorerFile {
  path: string;
  kind: ExplorerFileKind;
  encoding: ExplorerEncoding;
  content?: string;
  mimeType?: string;
  size: number;
  modifiedAt: string;
  revision: string;
}

export interface FileExplorerFileBytes {
  path: string;
  kind: ExplorerFileKind;
  encoding: "utf-8" | "binary";
  bytes: Uint8Array;
  mimeType: string;
  size: number;
  modifiedAt: string;
  revision: string;
}

export interface FileExplorerFileStream {
  path: string;
  kind: ExplorerFileKind;
  encoding: "utf-8" | "binary";
  mimeType: string;
  size: number;
  modifiedAt: string;
  revision: string;
  chunks: AsyncIterable<Uint8Array>;
}

const TEXT_MIME_TYPES: Record<string, string> = {
  ".json": "application/json",
};

const BINARY_MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
};

const DEFAULT_TEXT_MIME_TYPE = "text/plain";
const FILE_TYPE_SAMPLE_BYTES = 8192;
export const FILE_EXPLORER_STREAM_CHUNK_BYTES = 256 * 1024;
export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
const ACCESS_OUTSIDE_WORKSPACE_MESSAGE = "Access outside of workspace is not allowed";

function matchesExpectedRevision(
  stats: FileRevisionStats,
  expectedModifiedAt: string,
  expectedRevision?: string,
): boolean {
  return expectedRevision
    ? stats.revision === expectedRevision
    : stats.mtime.toISOString() === expectedModifiedAt;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

interface ScopedPathParams {
  root: string;
  relativePath?: string;
}

interface ScopedPath {
  requestedPath: string;
  resolvedPath: string;
}

interface EntryPayloadParams {
  root: string;
  targetPath: string;
  name: string;
  kind: ExplorerEntryKind;
}

export async function listDirectoryEntries({
  root,
  relativePath = ".",
}: ListDirectoryParams): Promise<FileExplorerDirectory> {
  const directoryPath = await resolveScopedPath({ root, relativePath });
  const stats = await fs.stat(directoryPath.resolvedPath);

  if (!stats.isDirectory()) {
    throw new Error("Requested path is not a directory");
  }

  const dirents = await fs.readdir(directoryPath.resolvedPath, { withFileTypes: true });

  const entriesWithNulls = await Promise.all(
    dirents.map(async (dirent) => {
      const targetPath = path.join(directoryPath.requestedPath, dirent.name);
      const kind: ExplorerEntryKind = dirent.isDirectory() ? "directory" : "file";
      try {
        return await buildEntryPayload({
          root,
          targetPath,
          name: dirent.name,
          kind,
        });
      } catch (error) {
        // Directories can contain dangling links (e.g. AGENTS.md -> CLAUDE.md).
        // Skip entries whose targets disappeared instead of failing the whole listing.
        if (isMissingEntryError(error) || isOutsideWorkspaceError(error)) {
          return null;
        }
        throw error;
      }
    }),
  );
  const entries = entriesWithNulls.filter((entry): entry is FileExplorerEntry => entry !== null);

  entries.sort((a, b) => {
    const modifiedComparison = new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    if (modifiedComparison !== 0) {
      return modifiedComparison;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    path: normalizeRelativePath({ root, targetPath: directoryPath.requestedPath }),
    entries,
  };
}

export async function readExplorerFile({
  root,
  relativePath,
}: ReadFileParams): Promise<FileExplorerFile> {
  const file = await readExplorerFileBytes({ root, relativePath });

  if (file.kind === "image") {
    return {
      path: file.path,
      kind: file.kind,
      encoding: "base64",
      content: Buffer.from(file.bytes).toString("base64"),
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: file.modifiedAt,
      revision: file.revision,
    };
  }

  if (file.kind === "binary") {
    return {
      path: file.path,
      kind: file.kind,
      encoding: "none",
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: file.modifiedAt,
      revision: file.revision,
    };
  }

  return {
    path: file.path,
    kind: file.kind,
    encoding: "utf-8",
    content: Buffer.from(file.bytes).toString("utf-8"),
    mimeType: file.mimeType,
    size: file.size,
    modifiedAt: file.modifiedAt,
    revision: file.revision,
  };
}

export async function readExplorerFileBytes({
  root,
  relativePath,
}: ReadFileParams): Promise<FileExplorerFileBytes> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const handle = await openFileForRead(filePath.resolvedPath);

  try {
    const stats = await statHandle(handle);

    if (!stats.isFile) {
      throw new Error("Requested path is not a file");
    }

    const ext = path.extname(filePath.resolvedPath).toLowerCase();
    const basePayload = {
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      revision: stats.revision,
    };

    const buffer = await handle.readFile();
    if (ext in IMAGE_MIME_TYPES) {
      return {
        ...basePayload,
        kind: "image",
        encoding: "binary",
        bytes: buffer,
        mimeType: IMAGE_MIME_TYPES[ext],
      };
    }

    if (ext in BINARY_MIME_TYPES || isLikelyBinary(buffer) || !isValidUtf8(buffer)) {
      return {
        ...basePayload,
        kind: "binary",
        encoding: "binary",
        bytes: buffer,
        mimeType: BINARY_MIME_TYPES[ext] ?? "application/octet-stream",
      };
    }

    return {
      ...basePayload,
      kind: "text",
      encoding: "utf-8",
      bytes: buffer,
      mimeType: textMimeTypeForExtension(ext),
    };
  } finally {
    await handle.close();
  }
}

export async function streamExplorerFile(
  { root, relativePath }: ReadFileParams,
  consume: (file: FileExplorerFileStream) => Promise<void>,
): Promise<void> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const handle = await openFileForRead(filePath.resolvedPath);

  try {
    const stats = await statHandle(handle);
    if (!stats.isFile) {
      throw new Error("Requested path is not a file");
    }

    const advertisedSize = stats.size;
    const advertisedRevision = stats.revision;
    const ext = path.extname(filePath.resolvedPath).toLowerCase();
    const isImage = ext in IMAGE_MIME_TYPES;
    const isBinary =
      isImage || ext in BINARY_MIME_TYPES || (await isFileHandleBinary(handle, advertisedSize));
    let kind: ExplorerFileKind = "text";
    let mimeType = textMimeTypeForExtension(ext);
    if (isImage) {
      kind = "image";
      mimeType = IMAGE_MIME_TYPES[ext];
    } else if (isBinary) {
      kind = "binary";
      mimeType = BINARY_MIME_TYPES[ext] ?? "application/octet-stream";
    }

    await consume({
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      kind,
      encoding: isBinary ? "binary" : "utf-8",
      mimeType,
      size: advertisedSize,
      modifiedAt: stats.mtime.toISOString(),
      revision: advertisedRevision,
      chunks: readFileHandleChunks(handle, advertisedSize, advertisedRevision),
    });
  } finally {
    await handle.close();
  }
}

async function isFileHandleBinary(handle: FileHandle, advertisedSize: number): Promise<boolean> {
  if (advertisedSize === 0) return false;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let position = 0;
  let suspiciousBytes = 0;
  while (position < advertisedSize) {
    const block = Buffer.allocUnsafe(
      Math.min(FILE_EXPLORER_STREAM_CHUNK_BYTES, advertisedSize - position),
    );
    const { bytesRead } = await handle.read(block, 0, block.byteLength, position);
    if (bytesRead === 0) {
      throw new Error("File changed during transfer");
    }
    const bytes = block.subarray(0, bytesRead);
    for (const byte of bytes) {
      if (byte === 0) return true;
      const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
      if (isControl || byte === 127) suspiciousBytes += 1;
    }
    try {
      decoder.decode(bytes, { stream: true });
    } catch {
      return true;
    }
    position += bytesRead;
  }

  try {
    decoder.decode();
  } catch {
    return true;
  }
  return suspiciousBytes / advertisedSize > 0.3;
}

async function* readFileHandleChunks(
  handle: FileHandle,
  advertisedSize: number,
  advertisedRevision: string,
): AsyncIterable<Uint8Array> {
  let position = 0;
  while (position < advertisedSize) {
    const chunk = Buffer.allocUnsafe(
      Math.min(FILE_EXPLORER_STREAM_CHUNK_BYTES, advertisedSize - position),
    );
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) {
      throw new Error("File changed during transfer");
    }
    position += bytesRead;
    yield chunk.subarray(0, bytesRead);
  }

  const finalStats = await statHandle(handle);
  if (finalStats.revision !== advertisedRevision) {
    throw new Error("File changed during transfer");
  }
}

export async function getExplorerFileVersion({
  root,
  relativePath,
}: ReadFileParams): Promise<ExplorerFileVersion> {
  const cwd = expandUserPath(root);
  try {
    const filePath = await resolveScopedPath({ root, relativePath });
    const handle = await openFileForRead(filePath.resolvedPath);
    try {
      const stats = await statHandle(handle);
      if (!stats.isFile) {
        return { status: "error", cwd, path: relativePath, error: "Requested path is not a file" };
      }
      const type = await sniffFileType(handle, path.extname(filePath.resolvedPath).toLowerCase());
      return {
        status: "ready",
        cwd,
        path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        revision: stats.revision,
        kind: type.kind,
        mimeType: type.mimeType,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { status: "missing", cwd, path: relativePath };
    }
    return {
      status: "error",
      cwd,
      path: relativePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveExplorerFilePath({
  root,
  relativePath,
}: ReadFileParams): Promise<string> {
  return (await resolveScopedPath({ root, relativePath })).resolvedPath;
}

export async function writeExplorerFile({
  root,
  relativePath,
  content,
  contentEncoding = "utf-8",
  expectedModifiedAt,
  expectedRevision,
}: WriteFileParams): Promise<ExplorerFileWriteResult> {
  const encoded = Buffer.from(content, contentEncoding === "base64" ? "base64" : "utf8");
  if (encoded.byteLength > MAX_EDITABLE_FILE_BYTES) {
    return { status: "error", error: "File is too large to edit" };
  }

  let filePath: ScopedPath;
  let currentMode = 0o600;
  try {
    filePath = await resolveScopedPath({ root, relativePath });
    const handle = await openFileForRead(filePath.resolvedPath);
    try {
      const stats = await statHandle(handle);
      if (!stats.isFile) {
        return { status: "error", error: "Requested path is not a file" };
      }
      if (stats.size > MAX_EDITABLE_FILE_BYTES) {
        return { status: "error", error: "File is too large to edit" };
      }
      if (contentEncoding === "utf-8") {
        const current = await handle.readFile();
        if (isLikelyBinary(current) || !isValidUtf8(current)) {
          return { status: "error", error: "Binary files cannot be edited" };
        }
      }
      currentMode = stats.mode;
      const modifiedAt = stats.mtime.toISOString();
      if (!matchesExpectedRevision(stats, expectedModifiedAt, expectedRevision)) {
        return {
          status: "conflict",
          version: {
            status: "ready",
            cwd: expandUserPath(root),
            path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
            size: stats.size,
            modifiedAt,
            revision: stats.revision,
          },
        };
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingEntryError(error)) {
      return {
        status: "conflict",
        version: { status: "missing", cwd: expandUserPath(root), path: relativePath },
      };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }

  const temporaryPath = path.join(
    path.dirname(filePath.resolvedPath),
    `.paseo-${randomUUID()}.tmp`,
  );
  let temporaryHandle: FileHandle | null = null;
  try {
    temporaryHandle = await fs.open(temporaryPath, "wx", currentMode);
    if (process.platform !== "win32") {
      await temporaryHandle.chmod(currentMode & 0o7777);
    }
    await temporaryHandle.writeFile(encoded);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    const latestStats = await statPath(filePath.resolvedPath);
    if (!matchesExpectedRevision(latestStats, expectedModifiedAt, expectedRevision)) {
      return {
        status: "conflict",
        version: {
          status: "ready",
          cwd: expandUserPath(root),
          path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
          size: latestStats.size,
          modifiedAt: latestStats.mtime.toISOString(),
          revision: latestStats.revision,
        },
      };
    }
    await fs.rename(temporaryPath, filePath.resolvedPath);
    const stats = await statPath(filePath.resolvedPath);
    return {
      status: "written",
      modifiedAt: stats.mtime.toISOString(),
      size: stats.size,
      revision: stats.revision,
    };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

export async function getDownloadableFileInfo({ root, relativePath }: ReadFileParams): Promise<{
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const handle = await openFileForRead(filePath.resolvedPath);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error("Requested path is not a file");
    }

    const { mimeType } = await sniffFileType(
      handle,
      path.extname(filePath.resolvedPath).toLowerCase(),
    );

    return {
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      absolutePath: filePath.resolvedPath,
      fileName: path.basename(filePath.requestedPath),
      mimeType,
      size: stats.size,
    };
  } finally {
    await handle.close();
  }
}

export interface ExplorerCreateEntryParams {
  root: string;
  parentPath: string;
  name: string;
  kind: ExplorerEntryKind;
}

export interface ExplorerRenameEntryParams {
  root: string;
  relativePath: string;
  name: string;
}

export type ExplorerEntryMutationResult =
  | { status: "ok"; path: string }
  | { status: "error"; error: string };

export async function createExplorerEntry({
  root,
  parentPath,
  name,
  kind,
}: ExplorerCreateEntryParams): Promise<ExplorerEntryMutationResult> {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName === "." || trimmedName === "..") {
    return { status: "error", error: "Invalid name" };
  }
  if (trimmedName.includes("/") || trimmedName.includes("\\")) {
    return { status: "error", error: "Name cannot contain path separators" };
  }

  try {
    const parent = await resolveScopedPath({ root, relativePath: parentPath });
    const parentStats = await fs.stat(parent.resolvedPath);
    if (!parentStats.isDirectory()) {
      return { status: "error", error: "Parent path is not a directory" };
    }
    const targetPath = path.join(parent.resolvedPath, trimmedName);
    if (kind === "directory") {
      await fs.mkdir(targetPath);
    } else {
      const handle = await fs.open(targetPath, "wx", 0o644);
      await handle.close();
    }
    return {
      status: "ok",
      path: normalizeRelativePath({
        root,
        targetPath: path.join(parent.requestedPath, trimmedName),
      }),
    };
  } catch (error) {
    if (isEntryExistsError(error)) {
      return { status: "error", error: `"${trimmedName}" already exists` };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function duplicateExplorerEntry({
  root,
  relativePath,
}: ReadFileParams): Promise<ExplorerEntryMutationResult> {
  try {
    const source = await resolveScopedPath({ root, relativePath });
    const realRoot = await fs.realpath(expandUserPath(root));
    if (source.resolvedPath === realRoot) {
      return { status: "error", error: "Cannot duplicate the workspace root" };
    }

    const stats = await fs.lstat(source.requestedPath);
    const sourceName = path.basename(source.requestedPath);
    const extension = stats.isDirectory() ? "" : path.extname(sourceName);
    const baseName = extension ? sourceName.slice(0, -extension.length) : sourceName;
    let targetPath = "";
    for (let copyNumber = 1; ; copyNumber += 1) {
      const suffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`;
      targetPath = path.join(
        path.dirname(source.requestedPath),
        `${baseName}${suffix}${extension}`,
      );
      try {
        await fs.lstat(targetPath);
      } catch (error) {
        if (isMissingEntryError(error)) {
          break;
        }
        throw error;
      }
    }

    await fs.cp(source.requestedPath, targetPath, {
      recursive: stats.isDirectory(),
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    return { status: "ok", path: normalizeRelativePath({ root, targetPath }) };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { status: "error", error: "File or folder no longer exists" };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function renameExplorerEntry({
  root,
  relativePath,
  name,
}: ExplorerRenameEntryParams): Promise<ExplorerEntryMutationResult> {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName === "." || trimmedName === "..") {
    return { status: "error", error: "Invalid name" };
  }
  if (trimmedName.includes("/") || trimmedName.includes("\\")) {
    return { status: "error", error: "Name cannot contain path separators" };
  }

  try {
    const source = await resolveScopedPath({ root, relativePath });
    const realRoot = await fs.realpath(expandUserPath(root));
    if (source.resolvedPath === realRoot) {
      return { status: "error", error: "Cannot rename the workspace root" };
    }

    const targetPath = path.join(path.dirname(source.requestedPath), trimmedName);
    const sourceStats = await fs.lstat(source.requestedPath);
    const targetStats = await fs.lstat(targetPath).catch((error: unknown) => {
      if (isMissingEntryError(error)) {
        return null;
      }
      throw error;
    });
    if (targetStats) {
      if (!(await isCaseOnlyRename(source, targetPath, sourceStats, targetStats))) {
        return { status: "error", error: `"${trimmedName}" already exists` };
      }
    }

    const sourcePath = normalizeRelativePath({ root, targetPath: source.requestedPath });
    const renamedPath = normalizeRelativePath({ root, targetPath });
    if (sourcePath === renamedPath) {
      return { status: "ok", path: renamedPath };
    }
    const repository = await runGitCommand(["rev-parse", "--is-inside-work-tree"], {
      cwd: realRoot,
      acceptExitCodes: [0, 128],
    });
    const tracked =
      repository.exitCode === 0
        ? await runGitCommand(["ls-files", "-z", "--", `:(literal)${sourcePath}`], {
            cwd: realRoot,
            // Inherited literal mode disables the :(literal) pathspec magic.
            envOverlay: { GIT_LITERAL_PATHSPECS: undefined },
          })
        : null;
    if (tracked?.stdout) {
      await runGitCommand(["mv", "--", sourcePath, renamedPath], { cwd: realRoot });
    } else {
      await fs.rename(source.requestedPath, targetPath);
    }
    return { status: "ok", path: renamedPath };
  } catch (error) {
    if (isEntryExistsError(error)) {
      return { status: "error", error: `"${trimmedName}" already exists` };
    }
    if (isMissingEntryError(error)) {
      return { status: "error", error: "File or folder no longer exists" };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteExplorerEntry({
  root,
  relativePath,
}: ReadFileParams): Promise<ExplorerEntryMutationResult> {
  try {
    const scoped = await resolveScopedPath({ root, relativePath });
    const realRoot = await fs.realpath(expandUserPath(root));
    if (scoped.resolvedPath === realRoot) {
      return { status: "error", error: "Cannot delete the workspace root" };
    }
    // Remove the requested path, not the realpath: deleting a symlink must
    // remove the link, never its target. lstat keeps the same guarantee.
    const stats = await fs.lstat(scoped.requestedPath);
    // Literal options: scriptc lowers rm only with boolean-literal flags.
    if (stats.isDirectory()) await fs.rm(scoped.requestedPath, { recursive: true, force: false });
    else await fs.rm(scoped.requestedPath, { recursive: false, force: false });
    return {
      status: "ok",
      path: normalizeRelativePath({ root, targetPath: scoped.requestedPath }),
    };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { status: "error", error: "File or folder no longer exists" };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

function isEntryExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function isCaseOnlyRename(
  source: ScopedPath,
  targetPath: string,
  sourceStats: Stats,
  targetStats: Stats,
): Promise<boolean> {
  const hasStableFileIds =
    sourceStats.dev !== 0 ||
    sourceStats.ino !== 0 ||
    targetStats.dev !== 0 ||
    targetStats.ino !== 0;
  const isSameEntry = hasStableFileIds
    ? targetStats.dev === sourceStats.dev && targetStats.ino === sourceStats.ino
    : !sourceStats.isSymbolicLink() &&
      !targetStats.isSymbolicLink() &&
      (await fs.realpath(targetPath)) === source.resolvedPath;
  return isSameEntry && source.requestedPath.toLowerCase() === targetPath.toLowerCase();
}

async function resolveScopedPath({
  root,
  relativePath = ".",
}: ScopedPathParams): Promise<ScopedPath> {
  const workspacePath = expandUserPath(root);
  const requestedPath = resolvePathFromBase(workspacePath, relativePath);
  assertWithinWorkspace(workspacePath, requestedPath);
  const canonicalRoot = await fs.realpath(workspacePath);
  try {
    const canonicalPath = await fs.realpath(requestedPath);
    assertWithinWorkspace(canonicalRoot, canonicalPath);
    return { requestedPath, resolvedPath: canonicalPath };
  } catch (error) {
    if (isMissingEntryError(error)) return { requestedPath, resolvedPath: requestedPath };
    throw error;
  }
}

function assertWithinWorkspace(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  const isOutsideWorkspace =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (isOutsideWorkspace) throw new Error(ACCESS_OUTSIDE_WORKSPACE_MESSAGE);
}

// A scriptc executable reports "scriptc" as argv[0]; Node reports its own path. scriptc has no
// numeric open flags (O_NOFOLLOW) and no bigint Stats, so a native binary takes the paths below.
const RUNNING_AS_SCRIPTC_BINARY = process.argv[0] === "scriptc";

/** The error Node raises when O_NOFOLLOW meets a symbolic link. */
class SymbolicLinkRefusedError extends Error {
  readonly code = "ELOOP";
  readonly syscall = "open";
  constructor(readonly path: string) {
    super(`ELOOP: too many symbolic links encountered, open '${path}'`);
  }
}

/**
 * Opens `filePath` for reading and refuses a symbolic link at its final component. Native
 * binaries cannot pass O_NOFOLLOW, so they lstat the path, open it, and refuse the handle unless
 * it is the same file (device and inode) that lstat saw: a link swapped in between fails the
 * comparison. A file replaced by a link to that same file after the lstat is still opened.
 */
export async function openFileForRead(filePath: string): Promise<FileHandle> {
  if (!RUNNING_AS_SCRIPTC_BINARY) return openNoFollowForRead(filePath);
  if (process.platform === "win32") return fs.open(filePath, "r");
  const linkStats = await fs.lstat(filePath);
  if (linkStats.isSymbolicLink()) throw new SymbolicLinkRefusedError(filePath);
  const handle = await fs.open(filePath, "r");
  try {
    const openedStats = await handle.stat();
    if (openedStats.dev !== linkStats.dev || openedStats.ino !== linkStats.ino) {
      throw new SymbolicLinkRefusedError(filePath);
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

// Native revisions use mtimeMs, which is coarser than Node's mtimeNs.
function nativeRevisionStats(stats: Stats): FileRevisionStats {
  return {
    isFile: stats.isFile(),
    size: stats.size,
    mode: stats.mode,
    mtime: stats.mtime,
    revision: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`,
  };
}

async function statHandle(handle: FileHandle): Promise<FileRevisionStats> {
  if (!RUNNING_AS_SCRIPTC_BINARY) return statHandleRevision(handle);
  return nativeRevisionStats(await handle.stat());
}

async function statPath(filePath: string): Promise<FileRevisionStats> {
  if (!RUNNING_AS_SCRIPTC_BINARY) return statPathRevision(filePath);
  return nativeRevisionStats(await fs.stat(filePath));
}

async function buildEntryPayload({
  root,
  targetPath,
  name,
  kind,
}: EntryPayloadParams): Promise<FileExplorerEntry> {
  const entryPath = await resolveScopedPath({
    root,
    relativePath: normalizeRelativePath({ root, targetPath }),
  });
  const stats = await fs.stat(entryPath.resolvedPath);
  return {
    name,
    path: normalizeRelativePath({ root, targetPath }),
    kind,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function isOutsideWorkspaceError(error: unknown): boolean {
  return error instanceof Error && error.message === ACCESS_OUTSIDE_WORKSPACE_MESSAGE;
}

function normalizeRelativePath({ root, targetPath }: { root: string; targetPath: string }): string {
  const normalizedRoot = expandUserPath(root);
  const normalizedTarget = expandUserPath(targetPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function textMimeTypeForExtension(ext: string): string {
  return TEXT_MIME_TYPES[ext] ?? DEFAULT_TEXT_MIME_TYPE;
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  let suspicious = 0;
  for (let idx = 0; idx < buffer.length; idx += 1) {
    const byte = buffer[idx];
    if (byte === 0) {
      return true;
    }

    const isControl =
      byte < 32 &&
      byte !== 9 && // tab
      byte !== 10 && // newline
      byte !== 13; // carriage return

    if (isControl || byte === 127) {
      suspicious += 1;
    }
  }

  return suspicious / buffer.length > 0.3;
}

/** Classifies a file from its extension and first bytes, without reading the rest of it. */
async function sniffFileType(
  handle: FileHandle,
  ext: string,
): Promise<{ kind: ExplorerFileKind; mimeType: string }> {
  if (ext in IMAGE_MIME_TYPES) return { kind: "image", mimeType: IMAGE_MIME_TYPES[ext] };
  const binary = {
    kind: "binary" as const,
    mimeType: BINARY_MIME_TYPES[ext] ?? "application/octet-stream",
  };
  if (ext in BINARY_MIME_TYPES) return binary;
  const sample = Buffer.alloc(FILE_TYPE_SAMPLE_BYTES);
  const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
  const chunk = sample.subarray(0, bytesRead);
  if (isLikelyBinary(chunk) || !isValidUtf8Prefix(chunk)) return binary;
  return { kind: "text", mimeType: textMimeTypeForExtension(ext) };
}

/** A sample can end inside a multi-byte character, so only a complete invalid sequence fails. */
function isValidUtf8Prefix(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
