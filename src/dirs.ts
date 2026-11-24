import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EntryStatus, FolderEntry } from './types';

export interface DirCompareOptions {
  /** Glob patterns of paths that must be ignored. */
  exclude: string[];
  /** Files bigger than this are compared by size only. */
  maxFileSize: number;
  /** Upper bound of reported entries. */
  maxEntries: number;
}

export interface DirCompareResult {
  entries: FolderEntry[];
  leftCount: number;
  rightCount: number;
  truncated: boolean;
}

interface WalkEntry {
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  /** Link target for symbolic links, compared as plain text. */
  linkTarget?: string;
}

const HASH_LIMIT = 64 * 1024 * 1024;

/** Translates a glob such as `**\/node_modules/**` into a regular expression. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

async function walk(root: string, exclude: RegExp[]): Promise<Map<string, WalkEntry>> {
  const result = new Map<string, WalkEntry>();
  const stack: string[] = [''];

  const isExcluded = (relative: string): boolean => {
    const probe = `${relative}/~`;
    return exclude.some((regex) => regex.test(relative) || regex.test(probe));
  };

  while (stack.length > 0) {
    const relative = stack.pop() as string;
    const absolute = path.join(root, relative);
    let items: DirEntry[];
    try {
      items = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const childRelative = relative ? `${relative}/${item.name}` : item.name;
      if (isExcluded(childRelative)) {
        continue;
      }
      const childAbsolute = path.join(absolute, item.name);
      if (item.isDirectory()) {
        result.set(childRelative, { type: 'dir', size: 0, mtimeMs: 0 });
        stack.push(childRelative);
      } else if (item.isFile()) {
        const stat = await fs.stat(childAbsolute);
        result.set(childRelative, { type: 'file', size: stat.size, mtimeMs: stat.mtimeMs });
      } else if (item.isSymbolicLink()) {
        let target = '';
        try {
          target = await fs.readlink(childAbsolute);
        } catch {
          target = '';
        }
        result.set(childRelative, { type: 'file', size: 0, mtimeMs: 0, linkTarget: target });
      }
    }
  }
  return result;
}

async function hashFile(absolute: string): Promise<string> {
  const hash = crypto.createHash('md5');
  const handle = await fs.open(absolute, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest('hex');
}

/** Compares two directory trees and returns a flat list of relative entries. */
export async function compareDirectories(
  leftRoot: string,
  rightRoot: string,
  options: DirCompareOptions,
): Promise<DirCompareResult> {
  const exclude = options.exclude.map((glob) => globToRegExp(glob));
  const [leftMap, rightMap] = await Promise.all([
    walk(leftRoot, exclude),
    walk(rightRoot, exclude),
  ]);

  const paths = new Set<string>([...leftMap.keys(), ...rightMap.keys()]);
  const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const entries: FolderEntry[] = [];
  let leftCount = 0;
  let rightCount = 0;
  let truncated = false;

  const hashCache = new Map<string, string>();
  const hashOf = async (absolute: string, entry: WalkEntry): Promise<string> => {
    const key = `${absolute}:${entry.size}:${entry.mtimeMs}`;
    const cached = hashCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const digest = await hashFile(absolute);
    hashCache.set(key, digest);
    return digest;
  };

  const dirStatus = new Map<string, EntryStatus>();

  for (const relative of sorted) {
    const left = leftMap.get(relative);
    const right = rightMap.get(relative);
    if (left) {
      leftCount += 1;
    }
    if (right) {
      rightCount += 1;
    }

    let status: EntryStatus;
    let leftType: string | undefined;
    let rightType: string | undefined;

    if (!left && right) {
      status = 'only-right';
      rightType = right.type;
    } else if (left && !right) {
      status = 'only-left';
      leftType = left.type;
    } else if (left && right) {
      leftType = left.type;
      rightType = right.type;
      if (left.type !== right.type) {
        status = 'modified';
      } else if (left.type === 'dir') {
        status = 'same';
        dirStatus.set(relative, 'same');
      } else if (left.linkTarget !== undefined || right.linkTarget !== undefined) {
        status = left.linkTarget === right.linkTarget ? 'same' : 'modified';
      } else if (left.size !== right.size) {
        status = 'modified';
      } else if (left.size > options.maxFileSize || left.size > HASH_LIMIT) {
        status = 'same';
      } else {
        const [leftHash, rightHash] = await Promise.all([
          hashOf(path.join(leftRoot, relative), left),
          hashOf(path.join(rightRoot, relative), right),
        ]);
        status = leftHash === rightHash ? 'same' : 'modified';
      }
    } else {
      continue;
    }

    if (entries.length >= options.maxEntries) {
      truncated = true;
      break;
    }

    entries.push({
      path: toPosix(relative),
      type: (right ?? left)?.type ?? 'file',
      status,
      leftSize: left?.type === 'file' ? left.size : undefined,
      rightSize: right?.type === 'file' ? right.size : undefined,
      leftType,
      rightType,
    });
  }

  // Propagate differences from the deepest entries up to their parent folders.
  const byDepth = [...entries].sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length,
  );
  for (const entry of byDepth) {
    if (entry.status === 'same') {
      continue;
    }
    const segments = entry.path.split('/');
    for (let depth = segments.length - 1; depth > 0; depth -= 1) {
      const parentPath = segments.slice(0, depth).join('/');
      const parent = entries.find((item) => item.path === parentPath && item.type === 'dir');
      if (!parent) {
        break;
      }
      if (parent.status === 'same') {
        parent.status = 'modified';
      }
    }
  }

  const differing = entries.filter((entry) => entry.status !== 'same').length;
  if (differing === 0) {
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  return { entries, leftCount, rightCount, truncated };
}
