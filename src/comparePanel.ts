import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { buildHexRows, diffBytes } from './binary';
import { buildRows, diffLines } from './diff';
import { compareDirectories } from './dirs';
import { Logger } from './logger';
import { PathGate } from './policy';
import {
  applyFolderAction,
  applyFolderAll,
  applyHunks,
  applyRanges,
  folderAction,
  hunkIsDestructive,
  rangeIsDestructive,
} from './sync';
import { decodeText, isBinary, splitLines } from './text';
import { renderHtml } from './webviewHtml';
import type {
  BinaryPayload,
  ByteRange,
  ComparisonPayload,
  FolderEntry,
  FolderPayload,
  HostMessage,
  Hunk,
  PaneItem,
  Side,
  SideInfo,
  TextPayload,
  TextRow,
  ViewMode,
  ViewModeSetting,
  WebviewMessage,
} from './types';

const VIEW_MODE_KEY = 'diffCompare.viewMode';
const PANES_KEY = 'diffCompare.panes';
const MAX_FOLDER_ENTRIES = 20000;

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

function sideLabel(side: Side): string {
  return side === 'left' ? '左' : '右';
}

/** Owns the Diff Compare webview and all the comparison logic behind it. */
export class ComparePanel {
  public static readonly viewType = 'diffCompare.compare';

  private static instance: ComparePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly log: Logger;
  private readonly gate: PathGate;
  private readonly disposables: vscode.Disposable[] = [];

  private left: PaneItem | undefined;
  private right: PaneItem | undefined;
  private viewMode: ViewModeSetting;
  private payload: ComparisonPayload | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    log: Logger,
    gate: PathGate,
  ) {
    this.panel = panel;
    this.context = context;
    this.log = log;
    this.gate = gate;

    this.viewMode = context.workspaceState.get<ViewModeSetting>(VIEW_MODE_KEY, 'auto');
    const saved = context.workspaceState.get<{ left?: PaneItem; right?: PaneItem }>(
      PANES_KEY,
      {},
    );
    this.left = saved.left;
    this.right = saved.right;

    this.panel.webview.html = renderHtml({
      webview: this.panel.webview,
      extensionUri: context.extensionUri,
      nonce: createNonce(),
    });

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: HostMessage) => {
        void this.onMessage(message);
      }),
    );
    this.disposables.push(
      this.panel.onDidChangeViewState(() => {
        void vscode.commands.executeCommand(
          'setContext',
          'diffCompare.focused',
          this.panel.active,
        );
      }),
    );
    this.panel.onDidDispose(() => this.dispose());
  }

  // ------------------------------------------------------------- lifecycle

  static create(
    context: vscode.ExtensionContext,
    log: Logger,
    gate: PathGate,
  ): ComparePanel {
    const panel = vscode.window.createWebviewPanel(
      ComparePanel.viewType,
      'Diff Compare',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    ComparePanel.instance = new ComparePanel(panel, context, log, gate);
    return ComparePanel.instance;
  }

  static revive(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    log: Logger,
    gate: PathGate,
  ): ComparePanel {
    ComparePanel.instance = new ComparePanel(panel, context, log, gate);
    return ComparePanel.instance;
  }

  static get current(): ComparePanel | undefined {
    return ComparePanel.instance;
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn, true);
  }

  dispose(): void {
    this.saveState();
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
    if (ComparePanel.instance === this) {
      ComparePanel.instance = undefined;
    }
  }

  // ------------------------------------------------------------- messaging

  private post(message: WebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private postState(): void {
    this.post({
      type: 'state',
      viewMode: this.viewMode,
      hasLeft: Boolean(this.left),
      hasRight: Boolean(this.right),
    });
  }

  private saveState(): void {
    void this.context.workspaceState.update(PANES_KEY, {
      left: this.left,
      right: this.right,
    });
  }

  private async onMessage(message: HostMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.refresh();
          break;
        case 'refresh':
          await this.refresh('已重新比较两侧内容。');
          break;
        case 'drop':
          await this.handleDrop(message.side, message.uris);
          break;
        case 'addWorkspaceFolder':
          await this.addWorkspaceFolder(message.side);
          break;
        case 'pickTarget':
          await this.pickTarget(message.side);
          break;
        case 'addActiveEditor':
          await this.addActiveEditor(message.side);
          break;
        case 'swap':
          this.swap();
          break;
        case 'clear':
          this.clear(message.side);
          break;
        case 'setViewMode':
          this.setViewMode(message.mode);
          break;
        case 'syncHunk':
          await this.syncHunk(message.hunkId, message.target);
          break;
        case 'syncRange':
          await this.syncRange(message.rangeId, message.target);
          break;
        case 'syncEntry':
          await this.syncEntry(message.path, message.target);
          break;
        case 'syncAll':
          await this.syncAll(message.target);
          break;
        case 'openFile':
          await this.openFile(message.uri);
          break;
        case 'focusSearch':
          this.post({ type: 'focusSearch' });
          break;
        case 'log':
          this.log.info(message.message);
          break;
        default:
          break;
      }
    } catch (error) {
      this.log.error('处理消息失败', error);
      const text = error instanceof Error ? error.message : String(error);
      this.post({ type: 'error', message: text });
    }
  }

  // ------------------------------------------------------------- commands

  async addWorkspaceFolder(side?: Side): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showWarningMessage('当前没有打开的工作区文件夹。');
      return;
    }
    let folder = folders[0];
    if (folders.length > 1) {
      const picked = await vscode.window.showQuickPick(
        folders.map((item) => ({
          label: item.name,
          description: item.uri.fsPath,
          folder: item,
        })),
        { placeHolder: '选择要加入比较的工作区文件夹' },
      );
      if (!picked) {
        return;
      }
      folder = picked.folder;
    }
    const target = side ?? (await this.chooseSide());
    if (!target) {
      return;
    }
    this.setSide(target, {
      kind: 'folder',
      uri: folder.uri.toString(),
      name: folder.name,
      path: folder.uri.fsPath,
    });
    await this.refresh();
  }

  async pickTarget(side?: Side): Promise<void> {
    const target = side ?? (await this.chooseSide());
    if (!target) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      openLabel: '加入比较',
      title: '选择要比较的文件或文件夹',
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const item = await this.resolveTarget(picked[0]);
    if (!item) {
      return;
    }
    this.setSide(target, item);
    await this.refresh();
  }

  async addActiveEditor(side: Side): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('当前没有活动的编辑器。');
      return;
    }
    const uri = editor.document.uri;
    if (uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('只能比较已经保存到磁盘的文件。');
      return;
    }
    const item = await this.resolveTarget(uri);
    if (!item) {
      return;
    }
    this.setSide(side, item);
    await this.refresh();
  }

  swap(): void {
    const previous = this.left;
    this.left = this.right;
    this.right = previous;
    this.saveState();
    void this.refresh();
  }

  clear(side?: Side): void {
    if (side === 'left' || !side) {
      this.left = undefined;
    }
    if (side === 'right' || !side) {
      this.right = undefined;
    }
    this.saveState();
    void this.refresh();
  }

  setViewMode(mode: ViewModeSetting): void {
    this.viewMode = mode;
    void this.context.workspaceState.update(VIEW_MODE_KEY, mode);
    void this.refresh();
  }

  focusSearch(): void {
    this.reveal();
    this.post({ type: 'focusSearch' });
  }

  /**
   * 直接指定左右两侧的路径，供 URI 深链使用：
   * `vscode://Aurumjin.diff-compare/open?left=<路径>&right=<路径>`
   *
   * 路径可以是绝对路径，也可以是相对于当前工作区第一个文件夹的相对路径。
   */
  async openPaths(leftPath?: string, rightPath?: string): Promise<void> {
    this.log.info(`深链打开对比：left=${leftPath ?? '-'} right=${rightPath ?? '-'}`);
    const targets: Array<[Side, string | undefined]> = [
      ['left', leftPath],
      ['right', rightPath],
    ];
    for (const [side, target] of targets) {
      if (!target) {
        continue;
      }
      const item = await this.resolveTarget(this.toUri(target));
      if (item) {
        this.setSide(side, item);
      } else {
        this.log.warn(`深链路径无法使用：${target}`);
      }
    }
    await this.refresh('已按链接打开对比。');
  }

  /** 绝对路径直接用；相对路径按工作区第一个文件夹解析。 */
  private toUri(target: string): vscode.Uri {
    if (path.isAbsolute(target)) {
      return vscode.Uri.file(target);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      return vscode.Uri.file(path.resolve(folder.uri.fsPath, target));
    }
    return vscode.Uri.file(path.resolve(target));
  }

  // ------------------------------------------------------------- internals

  private setSide(side: Side, item: PaneItem): void {
    if (side === 'left') {
      this.left = item;
    } else {
      this.right = item;
    }
    this.saveState();
  }

  private async chooseSide(): Promise<Side | undefined> {
    if (!this.left) {
      return 'left';
    }
    if (!this.right) {
      return 'right';
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: '左侧', side: 'left' as Side },
        { label: '右侧', side: 'right' as Side },
      ],
      { placeHolder: '选择要加入哪一侧' },
    );
    return picked?.side;
  }

  private async resolveTarget(uri: vscode.Uri): Promise<PaneItem | undefined> {
    if (uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('目前只支持比较本地文件。');
      return undefined;
    }
    const fsPath = uri.fsPath;
    if ((await this.gate.authorize(fsPath)) === 'deny') {
      return undefined;
    }
    let stat: Stats;
    try {
      stat = await fs.stat(fsPath);
    } catch {
      void vscode.window.showErrorMessage(`无法读取：${fsPath}`);
      return undefined;
    }
    return {
      kind: stat.isDirectory() ? 'folder' : 'file',
      uri: uri.toString(),
      name: path.basename(fsPath) || fsPath,
      path: fsPath,
    };
  }

  private async handleDrop(side: Side, uris: string[]): Promise<void> {
    const items: PaneItem[] = [];
    for (const raw of uris) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(raw, true);
      } catch {
        continue;
      }
      const item = await this.resolveTarget(uri);
      if (item) {
        items.push(item);
      }
    }
    if (items.length === 0) {
      return;
    }
    const folder = items.find((item) => item.kind === 'folder');
    const chosen = folder ?? items[0];
    if (!folder && items.length > 1) {
      void vscode.window.showInformationMessage(
        `拖入了 ${items.length} 个文件，已使用第一个：${chosen.name}`,
      );
    }
    this.setSide(side, chosen);
    await this.refresh();
  }

  private async openFile(uriText: string): Promise<void> {
    try {
      const uri = vscode.Uri.parse(uriText, true);
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch (error) {
      this.log.error('打开文件失败', error);
    }
  }

  // ------------------------------------------------------------- comparison

  private async refresh(info?: string): Promise<void> {
    this.postState();
    const left = this.left;
    const right = this.right;
    if (!left || !right) {
      this.payload = { kind: 'none', viewMode: 'text' };
      this.post({ type: 'comparison', payload: this.payload });
      if (info) {
        this.post({ type: 'info', message: info });
      }
      return;
    }

    this.post({ type: 'busy', busy: true });
    try {
      this.payload = await this.compute(left, right);
      this.post({ type: 'comparison', payload: this.payload });
      if (this.payload.notice) {
        this.post({ type: 'info', message: this.payload.notice });
      } else if (info) {
        this.post({ type: 'info', message: info });
      }
    } catch (error) {
      this.log.error('比较失败', error);
      const text = error instanceof Error ? error.message : String(error);
      this.post({ type: 'error', message: `比较失败：${text}` });
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private async compute(left: PaneItem, right: PaneItem): Promise<ComparisonPayload> {
    if (left.kind !== right.kind) {
      return {
        kind: 'mismatch',
        viewMode: 'text',
        left: this.describe(left),
        right: this.describe(right),
        notice: '一侧是文件、另一侧是目录，无法直接比较。',
      };
    }
    if (left.kind === 'folder') {
      return this.compareFolders(left, right);
    }
    return this.compareFiles(left, right);
  }

  private describe(item: PaneItem): SideInfo {
    return {
      kind: item.kind,
      uri: item.uri,
      name: item.name,
      path: item.path,
    };
  }

  private async compareFiles(
    left: PaneItem,
    right: PaneItem,
  ): Promise<ComparisonPayload> {
    const config = vscode.workspace.getConfiguration('diffCompare');
    const maxFileSize = config.get<number>('maxFileSize', 32) * 1024 * 1024;

    const [leftStat, rightStat] = await Promise.all([
      fs.stat(left.path),
      fs.stat(right.path),
    ]);

    const leftInfo: SideInfo = {
      ...this.describe(left),
      size: leftStat.size,
    };
    const rightInfo: SideInfo = {
      ...this.describe(right),
      size: rightStat.size,
    };

    if (leftStat.size > maxFileSize || rightStat.size > maxFileSize) {
      return {
        kind: 'file',
        viewMode: 'text',
        left: leftInfo,
        right: rightInfo,
        notice: `文件超过 ${Math.round(maxFileSize / 1024 / 1024)} MB 上限，未进行比较。`,
      };
    }

    const [leftBuffer, rightBuffer] = await Promise.all([
      fs.readFile(left.path),
      fs.readFile(right.path),
    ]);

    const binaryFile = isBinary(leftBuffer) || isBinary(rightBuffer);
    let viewMode: ViewMode =
      this.viewMode === 'auto' ? (binaryFile ? 'hex' : 'text') : this.viewMode;
    let notice: string | undefined;

    if (viewMode === 'text' && binaryFile) {
      viewMode = 'hex';
      notice = '检测到二进制内容，已自动切换到十六进制视图。';
    }

    const base: ComparisonPayload = {
      kind: 'file',
      viewMode,
      left: { ...leftInfo, binary: binaryFile },
      right: { ...rightInfo, binary: binaryFile },
      notice,
    };

    if (viewMode === 'text') {
      return { ...base, text: this.buildTextPayload(leftBuffer, rightBuffer) };
    }
    return { ...base, binary: this.buildBinaryPayload(leftBuffer, rightBuffer) };
  }

  private buildTextPayload(leftBuffer: Buffer, rightBuffer: Buffer): TextPayload {
    const leftLines = splitLines(decodeText(leftBuffer).text).lines;
    const rightLines = splitLines(decodeText(rightBuffer).text).lines;
    const ops = diffLines(leftLines, rightLines);
    const built = buildRows(leftLines, rightLines, ops);
    const rows: TextRow[] = built.rows;
    return {
      rows,
      hunks: built.hunks,
      leftLines: leftLines.length,
      rightLines: rightLines.length,
    };
  }

  private buildBinaryPayload(leftBuffer: Buffer, rightBuffer: Buffer): BinaryPayload {
    const changes = diffBytes(leftBuffer, rightBuffer);
    const built = buildHexRows(leftBuffer, rightBuffer, changes);
    return {
      rows: built.rows,
      ranges: built.ranges,
      leftSize: leftBuffer.length,
      rightSize: rightBuffer.length,
    };
  }

  private async compareFolders(
    left: PaneItem,
    right: PaneItem,
  ): Promise<ComparisonPayload> {
    const config = vscode.workspace.getConfiguration('diffCompare');
    const exclude = config.get<string[]>('exclude', [
      '**/node_modules/**',
      '**/.git/**',
      '**/.hg/**',
      '**/.svn/**',
    ]);
    const maxFileSize = config.get<number>('maxFileSize', 32) * 1024 * 1024;

    const result = await compareDirectories(left.path, right.path, {
      exclude,
      maxFileSize,
      maxEntries: MAX_FOLDER_ENTRIES,
    });

    const entries: FolderEntry[] = result.entries.map((entry) => {
      const relative = entry.path.split('/').join(path.sep);
      const leftExists = entry.status !== 'only-right';
      const rightExists = entry.status !== 'only-left';
      return {
        ...entry,
        leftUri: leftExists
          ? vscode.Uri.file(path.join(left.path, relative)).toString()
          : undefined,
        rightUri: rightExists
          ? vscode.Uri.file(path.join(right.path, relative)).toString()
          : undefined,
      };
    });

    const folder: FolderPayload = {
      entries,
      leftCount: result.leftCount,
      rightCount: result.rightCount,
      truncated: result.truncated,
    };

    const differing = entries.filter((entry) => entry.status !== 'same').length;
    const notice = result.truncated
      ? `条目过多，仅显示前 ${entries.length} 条。`
      : `共 ${differing} 处差异。`;

    return {
      kind: 'folder',
      viewMode: 'text',
      left: this.describe(left),
      right: this.describe(right),
      folder,
      notice,
    };
  }

  // ------------------------------------------------------------- sync

  private async syncHunk(hunkId: number, target: Side): Promise<void> {
    const hunk = this.payload?.text?.hunks.find((item) => item.id === hunkId);
    if (!hunk) {
      return;
    }
    await this.applyTextHunks([hunk], target);
  }

  private async syncRange(rangeId: number, target: Side): Promise<void> {
    const range = this.payload?.binary?.ranges.find((item) => item.id === rangeId);
    if (!range) {
      return;
    }
    await this.applyBinaryRanges([range], target);
  }

  private async syncEntry(entryPath: string, target: Side): Promise<void> {
    const entry = this.payload?.folder?.entries.find((item) => item.path === entryPath);
    const left = this.left;
    const right = this.right;
    if (!entry || !left || !right) {
      return;
    }
    const action = folderAction(entry, target);
    if (action === 'none') {
      return;
    }
    if (action === 'delete') {
      const confirmed = await vscode.window.showWarningMessage(
        `${sideLabel(target === 'left' ? 'right' : 'left')}侧没有「${entryPath}」，同步将删除${sideLabel(target)}侧的该文件，确定继续吗？`,
        { modal: true },
        '继续',
      );
      if (confirmed !== '继续') {
        return;
      }
    }
    await applyFolderAction(left.path, right.path, entry, target);
    await this.refresh(`已把${sideLabel(target === 'left' ? 'right' : 'left')}侧的内容同步到${sideLabel(target)}侧。`);
  }

  async syncAll(target: Side): Promise<void> {
    const payload = this.payload;
    if (!payload) {
      return;
    }
    if (payload.kind === 'folder' && payload.folder) {
      const left = this.left;
      const right = this.right;
      if (!left || !right) {
        return;
      }
      const destructive = payload.folder.entries.some(
        (entry) => folderAction(entry, target) === 'delete',
      );
      if (destructive) {
        const confirmed = await vscode.window.showWarningMessage(
          `同步会删除${sideLabel(target)}侧仅存在的文件，确定继续吗？`,
          { modal: true },
          '继续',
        );
        if (confirmed !== '继续') {
          return;
        }
      }
      await applyFolderAll(left.path, right.path, payload.folder.entries, target);
      await this.refresh(`已把所有差异同步到${sideLabel(target)}侧。`);
      return;
    }
    if (payload.kind === 'file' && payload.text) {
      await this.applyTextHunks(payload.text.hunks, target);
      return;
    }
    if (payload.binary) {
      await this.applyBinaryRanges(payload.binary.ranges, target);
    }
  }

  private async applyTextHunks(hunks: Hunk[], target: Side): Promise<void> {
    const targetItem = target === 'left' ? this.left : this.right;
    const sourceItem = target === 'left' ? this.right : this.left;
    if (!targetItem || !sourceItem) {
      this.post({ type: 'error', message: '请先在两侧都选择要比较的内容。' });
      return;
    }
    if (hunkIsDestructive(hunks, target)) {
      const confirmed = await vscode.window.showWarningMessage(
        `该操作会删除${sideLabel(target)}侧的部分内容，确定继续吗？`,
        { modal: true },
        '继续',
      );
      if (confirmed !== '继续') {
        return;
      }
    }
    await applyHunks(targetItem.path, sourceItem.path, hunks, target);
    await this.refresh(
      `已把${sideLabel(target === 'left' ? 'right' : 'left')}侧的内容同步到${sideLabel(target)}侧。`,
    );
  }

  private async applyBinaryRanges(ranges: ByteRange[], target: Side): Promise<void> {
    const targetItem = target === 'left' ? this.left : this.right;
    const sourceItem = target === 'left' ? this.right : this.left;
    if (!targetItem || !sourceItem) {
      this.post({ type: 'error', message: '请先在两侧都选择要比较的内容。' });
      return;
    }
    if (rangeIsDestructive(ranges, target)) {
      const confirmed = await vscode.window.showWarningMessage(
        `该操作会删除${sideLabel(target)}侧的部分字节，确定继续吗？`,
        { modal: true },
        '继续',
      );
      if (confirmed !== '继续') {
        return;
      }
    }
    await applyRanges(targetItem.path, sourceItem.path, ranges, target);
    await this.refresh(
      `已把${sideLabel(target === 'left' ? 'right' : 'left')}侧的字节同步到${sideLabel(target)}侧。`,
    );
  }
}
