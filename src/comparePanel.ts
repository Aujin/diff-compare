import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { buildHexRows, diffBytes } from './binary';
import { buildRows, diffLines } from './diff';
import { compareDirectories } from './dirs';
import { detectLocale, t, tableFor } from './i18n';
import type { Locale } from './i18n';
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
  restoreSnapshot,
  snapshotPath,
} from './sync';
import type { SnapshotEntry } from './sync';
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

/** 一个对比标签页存档下来的左右两侧。 */
interface SavedPane {
  id: string;
  /** 标签页序号（标题里的数字）。 */
  number?: number;
  left?: PaneItem;
  right?: PaneItem;
}

/** 一次同步操作的快照，用来撤销。 */
interface UndoRecord {
  label: string;
  entries: SnapshotEntry[];
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

/** Owns the Diff Compare webview and all the comparison logic behind it. */
export class ComparePanel {
  public static readonly viewType = 'diffCompare.compare';

  /** 所有打开的对比标签页。 */
  private static readonly panels = new Set<ComparePanel>();
  /** 最近获得焦点的对比标签页。 */
  private static activePanel: ComparePanel | undefined;
  private static counter = 0;
  /** 已经被某个标签页认领的存档条目。 */
  private static readonly claimed = new Set<string>();
  /** 已经用过的标签页序号。 */
  private static readonly usedNumbers = new Set<number>();

  private readonly id: string;
  /** 标签页序号（标题里的数字）。 */
  private readonly number: number;
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly log: Logger;
  private readonly gate: PathGate;
  private readonly locale: Locale;
  private readonly strings: Record<string, string>;
  private readonly disposables: vscode.Disposable[] = [];
  /** 可以撤销的同步操作（最后一次在最上面）。 */
  private readonly undoStack: UndoRecord[] = [];

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
    this.locale = detectLocale();
    this.strings = tableFor(this.locale);

    ComparePanel.counter += 1;
    this.id = `${Date.now().toString(36)}-${ComparePanel.counter}`;
    ComparePanel.claimed.add(this.id);

    this.viewMode = context.workspaceState.get<ViewModeSetting>(VIEW_MODE_KEY, 'auto');
    const saved = this.claimSavedPane();
    this.left = saved?.left;
    this.right = saved?.right;
    this.number = ComparePanel.claimNumber(saved?.number);

    ComparePanel.panels.add(this);
    ComparePanel.activePanel = this;

    this.panel.webview.html = renderHtml({
      webview: this.panel.webview,
      extensionUri: context.extensionUri,
      nonce: createNonce(),
      locale: this.locale,
    });

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: HostMessage) => {
        void this.onMessage(message);
      }),
    );
    this.disposables.push(
      this.panel.onDidChangeViewState(() => {
        if (this.panel.active) {
          ComparePanel.activePanel = this;
        }
        const focused = ComparePanel.activePanel?.panel.active === true;
        void vscode.commands.executeCommand('setContext', 'diffCompare.focused', focused);
      }),
    );
    this.panel.onDidDispose(() => this.dispose());
    this.updateTitle();
  }

  // ------------------------------------------------------------- lifecycle

  /** 新建一个对比标签页（不会复用已经打开的标签页）。 */
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
    return new ComparePanel(panel, context, log, gate);
  }

  static revive(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    log: Logger,
    gate: PathGate,
  ): ComparePanel {
    return new ComparePanel(panel, context, log, gate);
  }

  /** 当前打开的全部对比标签页。 */
  static get instances(): ComparePanel[] {
    return [...ComparePanel.panels];
  }

  /** 最近获得焦点的对比标签页。 */
  static get current(): ComparePanel | undefined {
    const panels = ComparePanel.instances;
    return ComparePanel.activePanel ?? panels[panels.length - 1];
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
    ComparePanel.panels.delete(this);
    if (ComparePanel.activePanel === this) {
      const panels = ComparePanel.instances;
      ComparePanel.activePanel = panels[panels.length - 1];
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
      canUndo: this.undoStack.length > 0,
      locale: this.locale,
      strings: this.strings,
    });
  }

  private saveState(): void {
    // 自己的存档永远不再被别人认领（否则新建标签页会复制已有标签页的内容）。
    ComparePanel.claimed.add(this.id);
    const saved = this.readSavedPanes().filter((entry) => entry.id !== this.id);
    saved.push({
      id: this.id,
      number: this.number,
      left: this.left,
      right: this.right,
    });
    void this.context.workspaceState.update(PANES_KEY, saved);
  }

  /** 读取存档的标签页内容（兼容旧版本保存的对象格式）。 */
  private readSavedPanes(): SavedPane[] {
    const raw = this.context.workspaceState.get<SavedPane[] | undefined>(PANES_KEY, undefined);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(
      (entry): entry is SavedPane => Boolean(entry) && typeof entry.id === 'string',
    );
  }

  /**
   * 认领一条存档：窗口重载后恢复标签页时，每个标签页认领一条自己的内容，
   * 这样可以同时恢复多个对比标签页。
   */
  private claimSavedPane(): SavedPane | undefined {
    for (const entry of this.readSavedPanes()) {
      if (!ComparePanel.claimed.has(entry.id)) {
        ComparePanel.claimed.add(entry.id);
        return entry;
      }
    }
    return undefined;
  }

  /** 领取标签页序号（标题里的数字），优先使用存档里的序号。 */
  private static claimNumber(saved?: number): number {
    if (saved && !ComparePanel.usedNumbers.has(saved)) {
      ComparePanel.usedNumbers.add(saved);
      return saved;
    }
    let candidate = 1;
    while (ComparePanel.usedNumbers.has(candidate)) {
      candidate += 1;
    }
    ComparePanel.usedNumbers.add(candidate);
    return candidate;
  }

  private async onMessage(message: HostMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.refresh();
          break;
        case 'refresh':
          await this.refresh(this.text('info.refreshed'));
          break;
        case 'newPanel': {
          const created = ComparePanel.create(this.context, this.log, this.gate);
          created.reveal();
          break;
        }
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
        case 'undo':
          await this.undo();
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
      this.log.error(this.text('log.messageFailed'), error);
      const text = error instanceof Error ? error.message : String(error);
      this.post({ type: 'error', message: text });
    }
  }

  // ------------------------------------------------------------- commands

  async addWorkspaceFolder(side?: Side): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showWarningMessage(this.text('warn.noWorkspace'));
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
        { placeHolder: this.text('warn.workspacePick') },
      );
      if (!picked) {
        return;
      }
      folder = picked.folder;
    }
    const target = side ?? (await this.chooseSide(folder.name));
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

  /**
   * 选择要比较的文件或文件夹。
   *
   * 没有指定某一栏时，先弹出文件选择框；选完之后再问放进左边还是右边，
   * 这样「添加文件」不会一次把同一个文件塞进两栏。
   */
  async pickTarget(side?: Side): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      openLabel: this.text('dialog.pickButton'),
      title: this.text('dialog.pickTitle'),
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const item = await this.resolveTarget(picked[0]);
    if (!item) {
      return;
    }
    const target = side ?? (await this.chooseSide(item.name));
    if (!target) {
      return;
    }
    this.setSide(target, item);
    await this.refresh();
  }

  async addActiveEditor(side: Side): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(this.text('warn.noActiveEditor'));
      return;
    }
    const uri = editor.document.uri;
    if (uri.scheme !== 'file') {
      void vscode.window.showInformationMessage(this.text('warn.notSaved'));
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
    this.updateTitle();
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
    this.updateTitle();
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

  /** 某一栏当前的内容。 */
  sideItem(side: Side): PaneItem | undefined {
    return side === 'left' ? this.left : this.right;
  }

  /** 菜单里用来区分多个对比标签页的说明文字。 */
  summary(): string {
    const left = this.left?.name;
    const right = this.right?.name;
    if (left && right) {
      return `${left} ↔ ${right}`;
    }
    return left ?? right ?? this.text('pane.notSelected');
  }

  /**
   * 把一个文件或文件夹放进某一栏。
   *
   * mode='add' 时如果该栏已经有内容，会先问是替换还是新建标签；
   * mode='replace' 直接覆盖。
   */
  async placeItem(
    uri: vscode.Uri,
    side: Side,
    mode: 'add' | 'replace' = 'replace',
  ): Promise<boolean> {
    const item = await this.resolveTarget(uri);
    if (!item) {
      return false;
    }
    const existing = this.sideItem(side);
    if (mode === 'add' && existing) {
      const picked = await vscode.window.showWarningMessage(
        this.text('dialog.replaceQuestion', {
          side: this.sideLabelLong(side),
          name: existing.name,
        }),
        { modal: true },
        this.text('dialog.replace'),
        this.text('dialog.newTab'),
        this.text('dialog.cancel'),
      );
      if (picked === this.text('dialog.newTab')) {
        const created = ComparePanel.create(this.context, this.log, this.gate);
        await created.placeItem(uri, side, 'replace');
        created.reveal();
        return true;
      }
      if (picked !== this.text('dialog.replace')) {
        return false;
      }
    }
    this.setSide(side, item);
    await this.refresh();
    return true;
  }

  /**
   * 直接指定左右两侧的路径，供 URI 深链使用：
   * `vscode://Aurumjin.diff-compare/open?left=<路径>&right=<路径>`
   *
   * 路径可以是绝对路径，也可以是相对于当前工作区第一个文件夹的相对路径。
   */
  async openPaths(leftPath?: string, rightPath?: string): Promise<void> {
    this.log.info(
      this.text('log.deepLink', {
        uri: `left=${leftPath ?? '-'} right=${rightPath ?? '-'}`,
      }),
    );
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
        this.log.warn(this.text('log.deepLinkFailed', { path: target }));
      }
    }
    await this.refresh(this.text('info.deepLink'));
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

  /** 取当前语言下的文案。 */
  private text(key: string, params?: Record<string, string | number>): string {
    return t(this.locale, key, params);
  }

  /** 某一侧的长名称（左侧 / 右侧）。 */
  private sideLabelLong(side: Side): string {
    return this.text(side === 'left' ? 'side.leftLong' : 'side.rightLong');
  }

  /** 另一侧（同步来源）。 */
  private otherSide(side: Side): Side {
    return side === 'left' ? 'right' : 'left';
  }

  private setSide(side: Side, item: PaneItem): void {
    if (side === 'left') {
      this.left = item;
    } else {
      this.right = item;
    }
    this.saveState();
    this.updateTitle();
  }

  /** 标签页标题：Diff Compare 1、Diff Compare 2 … */
  private updateTitle(): void {
    this.panel.title = `Diff Compare ${this.number}`;
  }

  private async chooseSide(name?: string): Promise<Side | undefined> {
    if (!this.left) {
      return 'left';
    }
    if (!this.right) {
      return 'right';
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: this.text('menu.sideLeft'), side: 'left' as Side },
        { label: this.text('menu.sideRight'), side: 'right' as Side },
      ],
      {
        placeHolder: name
          ? this.text('dialog.sideQuestionWithName', { name })
          : this.text('dialog.sideQuestion'),
      },
    );
    return picked?.side;
  }

  private async resolveTarget(uri: vscode.Uri): Promise<PaneItem | undefined> {
    if (uri.scheme !== 'file') {
      void vscode.window.showWarningMessage(this.text('warn.unsupportedScheme'));
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
      void vscode.window.showErrorMessage(
        this.text('warn.readFailed', { path: fsPath }),
      );
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
        this.text('warn.droppedMultiple', { n: items.length, name: chosen.name }),
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
      this.log.error(this.text('log.openFailed'), error);
    }
  }

  // ------------------------------------------------------------- comparison

  private async refresh(info?: string): Promise<void> {
    this.postState();
    const left = this.left;
    const right = this.right;
    if (!left || !right) {
      // 只填了一栏时也要把这一栏的信息带出去，面板标题才能显示文件名。
      this.payload = {
        kind: 'none',
        viewMode: 'text',
        left: left ? this.describe(left) : undefined,
        right: right ? this.describe(right) : undefined,
      };
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
      this.log.error(this.text('log.compareFailed', {
        message: error instanceof Error ? error.message : String(error),
      }));
      const text = error instanceof Error ? error.message : String(error);
      this.post({
        type: 'error',
        message: this.text('log.compareFailed', { message: text }),
      });
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
        notice: this.text('warn.mismatch'),
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
        notice: this.text('warn.tooLarge', {
          size: Math.round(maxFileSize / 1024 / 1024),
        }),
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
      notice = this.text('warn.binarySwitch');
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
      ? this.text('info.folderTruncated', { n: entries.length })
      : this.text('info.folderDiff', { n: differing });

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
        this.text('warn.destroyFolderItem', {
          path: entryPath,
          other: this.sideLabelLong(this.otherSide(target)),
          side: this.sideLabelLong(target),
        }),
        { modal: true },
        this.text('dialog.continue'),
      );
      if (confirmed !== this.text('dialog.continue')) {
        return;
      }
    }
    const targetRoot = target === 'left' ? left.path : right.path;
    const snapshot = await snapshotPath(path.join(targetRoot, entry.path));
    await applyFolderAction(left.path, right.path, entry, target);
    this.pushUndo(entry.path, snapshot);
    await this.refresh(
      this.text('info.syncedSide', {
        other: this.sideLabelLong(this.otherSide(target)),
        side: this.sideLabelLong(target),
      }),
    );
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
      const changed = payload.folder.entries.filter(
        (entry) => folderAction(entry, target) !== 'none',
      );
      const destructive = changed.some(
        (entry) => folderAction(entry, target) === 'delete',
      );
      if (destructive) {
        const confirmed = await vscode.window.showWarningMessage(
          this.text('warn.destroyFolderAll', {
            side: this.sideLabelLong(target),
          }),
          { modal: true },
          this.text('dialog.continue'),
        );
        if (confirmed !== this.text('dialog.continue')) {
          return;
        }
      }
      const targetRoot = target === 'left' ? left.path : right.path;
      const snapshot: SnapshotEntry[] = [];
      for (const entry of changed) {
        snapshot.push(...(await snapshotPath(path.join(targetRoot, entry.path))));
      }
      await applyFolderAll(left.path, right.path, payload.folder.entries, target);
      this.pushUndo(this.text('info.syncedAll', { side: this.sideLabelLong(target) }), snapshot);
      await this.refresh(
        this.text('info.syncedAll', { side: this.sideLabelLong(target) }),
      );
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
      this.post({ type: 'error', message: this.text('warn.needBoth') });
      return;
    }
    if (hunkIsDestructive(hunks, target)) {
      const confirmed = await vscode.window.showWarningMessage(
        this.text('warn.destroyText', { side: this.sideLabelLong(target) }),
        { modal: true },
        this.text('dialog.continue'),
      );
      if (confirmed !== this.text('dialog.continue')) {
        return;
      }
    }
    const snapshot = await snapshotPath(targetItem.path);
    await applyHunks(targetItem.path, sourceItem.path, hunks, target);
    this.pushUndo(targetItem.path, snapshot);
    await this.refresh(
      this.text('info.syncedSide', {
        other: this.sideLabelLong(this.otherSide(target)),
        side: this.sideLabelLong(target),
      }),
    );
  }

  private async applyBinaryRanges(ranges: ByteRange[], target: Side): Promise<void> {
    const targetItem = target === 'left' ? this.left : this.right;
    const sourceItem = target === 'left' ? this.right : this.left;
    if (!targetItem || !sourceItem) {
      this.post({ type: 'error', message: this.text('warn.needBoth') });
      return;
    }
    if (rangeIsDestructive(ranges, target)) {
      const confirmed = await vscode.window.showWarningMessage(
        this.text('warn.destroyBytes', { side: this.sideLabelLong(target) }),
        { modal: true },
        this.text('dialog.continue'),
      );
      if (confirmed !== this.text('dialog.continue')) {
        return;
      }
    }
    const snapshot = await snapshotPath(targetItem.path);
    await applyRanges(targetItem.path, sourceItem.path, ranges, target);
    this.pushUndo(targetItem.path, snapshot);
    await this.refresh(
      this.text('info.syncedBytes', {
        other: this.sideLabelLong(this.otherSide(target)),
        side: this.sideLabelLong(target),
      }),
    );
  }

  // ------------------------------------------------------------- undo

  /** 记录一次同步前的快照，之后可以撤销。 */
  private pushUndo(label: string, entries: SnapshotEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    this.undoStack.push({ label, entries });
    if (this.undoStack.length > 20) {
      this.undoStack.shift();
    }
  }

  /** 撤销上一次同步。 */
  async undo(): Promise<void> {
    const record = this.undoStack.pop();
    if (!record) {
      this.post({ type: 'info', message: this.text('info.nothingToUndo') });
      return;
    }
    try {
      await restoreSnapshot(record.entries);
    } catch (error) {
      this.log.error(this.text('log.messageFailed'), error);
      this.post({ type: 'error', message: this.text('log.compareFailed', {
        message: error instanceof Error ? error.message : String(error),
      }) });
      return;
    }
    await this.refresh(this.text('info.undone'));
  }
}
