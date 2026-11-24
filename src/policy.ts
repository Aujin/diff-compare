import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Outcome of an access check for a path that is about to be read or written. */
export type AccessDecision = 'allow' | 'deny';

const GRANT_KEY = 'diffCompare.outsideGrants';
const ALWAYS_KEY = 'diffCompare.allowOutsideAlways';

function normalize(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `child` is the same as `parent` or lives inside it. */
export function isInside(parent: string, child: string): boolean {
  const p = normalize(parent);
  const c = normalize(child);
  if (p === c) {
    return true;
  }
  const rel = path.relative(p, c);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Decides whether a path may be opened for comparison.
 *
 * Policy (the user asked us to pick a sensible default):
 *  - Inside the current workspace: always allowed.
 *  - Outside the workspace: allowed when the workspace is trusted and the user
 *    explicitly opted in, either through `diffCompare.allowOutsideWorkspace`
 *    or through the one-off prompt shown the first time the path is used.
 *  - Untrusted workspace: nothing outside the workspace is ever touched.
 */
export class PathGate {
  private readonly context: vscode.ExtensionContext;
  /** Paths the user allowed for this session only ("仅本次允许"). */
  private readonly sessionGrants = new Set<string>();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /** All workspace roots of the current window. */
  get roots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

  /** True when the path lives inside one of the workspace folders. */
  isInsideWorkspace(fsPath: string): boolean {
    return this.roots.some((root) => isInside(root, fsPath));
  }

  /** True when the user configured "everything is allowed". */
  private get allowAll(): boolean {
    const configured = vscode.workspace
      .getConfiguration('diffCompare')
      .get<boolean>('allowOutsideWorkspace', false);
    const granted = this.context.globalState.get<boolean>(ALWAYS_KEY, false);
    return configured || granted;
  }

  private isGranted(fsPath: string): boolean {
    const target = normalize(fsPath);
    if (this.sessionGrants.has(target)) {
      return true;
    }
    return this.context.globalState
      .get<string[]>(GRANT_KEY, [])
      .some((grant) => normalize(grant) === target);
  }

  /** Checks a path without showing any UI. */
  check(fsPath: string): AccessDecision {
    if (this.isInsideWorkspace(fsPath)) {
      return 'allow';
    }
    if (!vscode.workspace.isTrusted) {
      return 'deny';
    }
    if (this.allowAll || this.isGranted(fsPath)) {
      return 'allow';
    }
    return 'deny';
  }

  /**
   * Same as {@link check} but asks the user once when a path outside the
   * workspace is requested for the first time.
   */
  async authorize(fsPath: string): Promise<AccessDecision> {
    if (this.check(fsPath) === 'allow') {
      return 'allow';
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        '当前工作区未受信任，无法访问工作区之外的文件。',
      );
      return 'deny';
    }

    const choice = await vscode.window.showWarningMessage(
      `“${path.basename(fsPath) || fsPath}”不在当前工作区内，确定要比较它吗？`,
      { modal: false },
      '仅本次允许',
      '始终允许此路径',
      '允许所有外部路径',
      '取消',
    );

    if (choice === '仅本次允许') {
      this.sessionGrants.add(normalize(fsPath));
      return 'allow';
    }
    if (choice === '始终允许此路径') {
      const list = this.context.globalState.get<string[]>(GRANT_KEY, []);
      if (!list.some((grant) => normalize(grant) === normalize(fsPath))) {
        list.push(fsPath);
      }
      await this.context.globalState.update(GRANT_KEY, list);
      return 'allow';
    }
    if (choice === '允许所有外部路径') {
      await this.context.globalState.update(ALWAYS_KEY, true);
      return 'allow';
    }
    return 'deny';
  }

  /** Human readable explanation used in the UI. */
  describe(fsPath: string): string {
    if (this.isInsideWorkspace(fsPath)) {
      return '位于当前工作区内';
    }
    if (!vscode.workspace.isTrusted) {
      return '工作区未受信任，外部路径已被阻止';
    }
    if (this.allowAll) {
      return '已允许访问工作区之外的路径';
    }
    return '位于当前工作区之外';
  }

  /** Home directory, offered as a convenience target when picking a folder. */
  get homeDir(): string {
    return os.homedir();
  }
}
