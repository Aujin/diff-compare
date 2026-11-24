import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ByteRange, FolderEntry, Hunk, Side } from './types';
import { decodeText, joinLines, splitLines } from './text';

export interface TextFileContent {
  lines: string[];
  eol: string;
  trailingNewline: boolean;
}

export async function readTextFile(fsPath: string): Promise<TextFileContent> {
  const buffer = await fs.readFile(fsPath);
  const decoded = decodeText(buffer);
  const split = splitLines(decoded.text);
  return { lines: split.lines, eol: split.eol, trailingNewline: split.trailingNewline };
}

export async function writeTextFile(
  fsPath: string,
  lines: string[],
  eol: string,
  trailingNewline: boolean,
): Promise<void> {
  const text = joinLines(lines, eol, trailingNewline);
  await fs.writeFile(fsPath, text, 'utf8');
}

/**
 * Copies the content of one side of a hunk over to the other side.
 *
 * `target` is the side that receives the content, the opposite side is the
 * source: `target: 'left'` copies the right hand lines into the left file.
 */
export async function applyHunks(
  targetPath: string,
  sourcePath: string,
  hunks: Hunk[],
  target: Side,
): Promise<void> {
  if (hunks.length === 0) {
    return;
  }
  const targetFile = await readTextFile(targetPath);
  const sourceFile = await readTextFile(sourcePath);

  const ordered = [...hunks].sort((a, b) =>
    target === 'left' ? a.lBefore - b.lBefore : a.rBefore - b.rBefore,
  );

  const result: string[] = [];
  let cursor = 0;
  for (const hunk of ordered) {
    const sourceStart = target === 'left' ? hunk.rBefore : hunk.lBefore;
    const sourceCount = target === 'left' ? hunk.rCount : hunk.lCount;
    const targetStart = target === 'left' ? hunk.lBefore : hunk.rBefore;
    const targetCount = target === 'left' ? hunk.lCount : hunk.rCount;

    result.push(...targetFile.lines.slice(cursor, targetStart));
    result.push(...sourceFile.lines.slice(sourceStart, sourceStart + sourceCount));
    cursor = targetStart + targetCount;
  }
  result.push(...targetFile.lines.slice(cursor));

  await writeTextFile(targetPath, result, targetFile.eol, targetFile.trailingNewline);
}

/** True when the operation removes content from the target side. */
export function hunkIsDestructive(hunks: Hunk[], target: Side): boolean {
  return hunks.some((hunk) =>
    target === 'left'
      ? hunk.rCount === 0 && hunk.lCount > 0
      : hunk.lCount === 0 && hunk.rCount > 0,
  );
}

/** Copies the bytes of one side of a byte range over to the other side. */
export async function applyRanges(
  targetPath: string,
  sourcePath: string,
  ranges: ByteRange[],
  target: Side,
): Promise<void> {
  if (ranges.length === 0) {
    return;
  }
  const [targetBuffer, sourceBuffer] = await Promise.all([
    fs.readFile(targetPath),
    fs.readFile(sourcePath),
  ]);

  const ordered = [...ranges].sort((a, b) =>
    target === 'left' ? a.lStart - b.lStart : a.rStart - b.rStart,
  );

  const parts: Buffer[] = [];
  let cursor = 0;
  for (const range of ordered) {
    const sourceStart = target === 'left' ? range.rStart : range.lStart;
    const sourceEnd = target === 'left' ? range.rEnd : range.lEnd;
    const targetStart = target === 'left' ? range.lStart : range.rStart;
    const targetEnd = target === 'left' ? range.lEnd : range.rEnd;

    parts.push(targetBuffer.subarray(cursor, targetStart));
    parts.push(sourceBuffer.subarray(sourceStart, sourceEnd));
    cursor = targetEnd;
  }
  parts.push(targetBuffer.subarray(cursor));

  await fs.writeFile(targetPath, Buffer.concat(parts));
}

/** True when the operation removes bytes from the target side. */
export function rangeIsDestructive(ranges: ByteRange[], target: Side): boolean {
  return ranges.some((range) =>
    target === 'left'
      ? range.rStart === range.rEnd && range.lEnd > range.lStart
      : range.lStart === range.lEnd && range.rEnd > range.rStart,
  );
}

/** Copies a file or a whole directory tree. */
export async function copyEntry(sourcePath: string, targetPath: string): Promise<void> {
  const stat = await fs.stat(sourcePath);
  if (stat.isDirectory()) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

/** Removes a file or a directory tree. */
export async function deleteEntry(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

function joinRelative(root: string, relative: string): string {
  return path.join(root, relative.split('/').join(path.sep));
}

/** What has to happen to bring one side in line with the other one. */
export type FolderAction = 'copy' | 'delete' | 'none';

/**
 * Computes the action for one folder entry.
 *
 * `only-right` entries exist on the right side only: copying them to the left
 * creates them there, the opposite direction removes them from the right.
 */
export function folderAction(entry: FolderEntry, target: Side): FolderAction {
  if (entry.status === 'same') {
    return 'none';
  }
  if (entry.status === 'modified') {
    return 'copy';
  }
  if (entry.status === 'only-right') {
    return target === 'left' ? 'copy' : 'delete';
  }
  // only-left
  return target === 'right' ? 'copy' : 'delete';
}

/** Applies the action of a single folder entry. */
export async function applyFolderAction(
  leftRoot: string,
  rightRoot: string,
  entry: FolderEntry,
  target: Side,
): Promise<void> {
  const action = folderAction(entry, target);
  if (action === 'none') {
    return;
  }
  const leftPath = joinRelative(leftRoot, entry.path);
  const rightPath = joinRelative(rightRoot, entry.path);

  if (action === 'copy') {
    if (target === 'left') {
      await copyEntry(rightPath, leftPath);
    } else {
      await copyEntry(leftPath, rightPath);
    }
    return;
  }
  await deleteEntry(target === 'left' ? leftPath : rightPath);
}

/** Applies every differing entry of a folder comparison in one go. */
export async function applyFolderAll(
  leftRoot: string,
  rightRoot: string,
  entries: FolderEntry[],
  target: Side,
): Promise<void> {
  for (const entry of entries) {
    await applyFolderAction(leftRoot, rightRoot, entry, target);
  }
}

// --------------------------------------------------------------- undo support

/** One file (or directory) captured before a sync, so the sync can be undone. */
export interface SnapshotEntry {
  /** Absolute path that was about to be changed. */
  path: string;
  /** Content before the change; `null` when the path did not exist yet. */
  content: Buffer | null;
  /** True when the path was a directory before the change. */
  directory: boolean;
}

/**
 * Captures the current state of a path (file or whole directory tree).
 *
 * The result can be handed to `restoreSnapshot` to roll a sync back.
 */
export async function snapshotPath(target: string): Promise<SnapshotEntry[]> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return [{ path: target, content: null, directory: false }];
  }
  if (!stat.isDirectory()) {
    return [{ path: target, content: await fs.readFile(target), directory: false }];
  }

  const entries: SnapshotEntry[] = [
    { path: target, content: null, directory: true },
  ];
  const walk = async (dir: string): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        entries.push({ path: full, content: await fs.readFile(full), directory: false });
      }
    }
  };
  await walk(target);
  return entries;
}

/** Restores a snapshot taken by `snapshotPath`. */
export async function restoreSnapshot(entries: SnapshotEntry[]): Promise<void> {
  // 先把目录整体删掉，再把文件写回去，保证目录结构与同步前一致。
  for (const entry of entries) {
    if (entry.directory) {
      await fs.rm(entry.path, { recursive: true, force: true });
    }
  }
  for (const entry of entries) {
    if (entry.directory) {
      continue;
    }
    if (entry.content === null) {
      await fs.rm(entry.path, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(entry.path), { recursive: true });
    await fs.writeFile(entry.path, entry.content);
  }
}

/** 把相对路径拼到根目录上（与 `applyFolderAction` 使用同样的规则）。 */
export function resolveRelative(root: string, relative: string): string {
  return joinRelative(root, relative);
}

