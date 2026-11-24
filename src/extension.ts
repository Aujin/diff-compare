import * as vscode from 'vscode';
import { ComparePanel } from './comparePanel';
import { Logger } from './logger';
import { PathGate } from './policy';
import type { Side } from './types';

let logger: Logger | undefined;

/** 右键菜单里的一个选项：加入/替换某个标签页的某一栏。 */
interface PlaceAction {
  mode: 'add' | 'replace';
  side: Side;
  panel?: ComparePanel;
  createNew: boolean;
}

interface PlaceItem extends vscode.QuickPickItem {
  action?: PlaceAction;
}

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger('Diff Compare');
  const pathGate = new PathGate(context);
  logger = log;
  context.subscriptions.push(log);
  log.info(`Diff Compare 已激活（版本 ${context.extension?.packageJSON?.version ?? '未知'}）。`);

  const openPanel = (): ComparePanel => {
    const existing = ComparePanel.current;
    if (existing) {
      existing.reveal();
      return existing;
    }
    return ComparePanel.create(context, log, pathGate);
  };

  /**
   * 右键（资源管理器 / 文件标签页）里的「Diff Compare」入口：
   * 选择新建标签页，还是加入/替换第 N 个标签页的左栏或右栏。
   */
  const placeFromContext = async (source?: vscode.Uri): Promise<void> => {
    const uri = source ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void vscode.window.showWarningMessage(
        '请先在资源管理器或编辑器标签页里选中一个文件或文件夹。',
      );
      return;
    }

    const items: PlaceItem[] = [];
    items.push({
      kind: vscode.QuickPickItemKind.Separator,
      label: '新建对比标签',
    });
    items.push({
      label: '加入左侧',
      description: '新建一个对比标签并放入左栏',
      action: { mode: 'replace', side: 'left', createNew: true },
    });
    items.push({
      label: '加入右侧',
      description: '新建一个对比标签并放入右栏',
      action: { mode: 'replace', side: 'right', createNew: true },
    });

    ComparePanel.instances.forEach((panel, index) => {
      const title = `第 ${index + 1} 个标签 · ${panel.summary()}`;
      items.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: title,
      });
      items.push({
        label: '加入左侧',
        description: title,
        action: { mode: 'add', side: 'left', panel, createNew: false },
      });
      items.push({
        label: '加入右侧',
        description: title,
        action: { mode: 'add', side: 'right', panel, createNew: false },
      });
      items.push({
        label: '替换左侧',
        description: title,
        action: { mode: 'replace', side: 'left', panel, createNew: false },
      });
      items.push({
        label: '替换右侧',
        description: title,
        action: { mode: 'replace', side: 'right', panel, createNew: false },
      });
    });

    const picked = (await vscode.window.showQuickPick(items, {
      placeHolder: '选择要加入对比的位置',
      matchOnDescription: true,
    })) as PlaceItem | undefined;
    const action = picked?.action;
    if (!action) {
      return;
    }

    if (action.createNew || !action.panel) {
      const panel = ComparePanel.create(context, log, pathGate);
      await panel.placeItem(uri, action.side, 'replace');
      panel.reveal();
      return;
    }
    await action.panel.placeItem(uri, action.side, action.mode);
    action.panel.reveal();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('diffCompare.open', () => {
      openPanel();
    }),
    vscode.commands.registerCommand('diffCompare.newPanel', () => {
      ComparePanel.create(context, log, pathGate);
    }),
    vscode.commands.registerCommand('diffCompare.addFromContext', async (uri?: vscode.Uri) => {
      await placeFromContext(uri instanceof vscode.Uri ? uri : undefined);
    }),
    vscode.commands.registerCommand('diffCompare.addWorkspaceFolder', async () => {
      await openPanel().addWorkspaceFolder();
    }),
    vscode.commands.registerCommand('diffCompare.pickTarget', async () => {
      await openPanel().pickTarget();
    }),
    vscode.commands.registerCommand('diffCompare.swap', () => {
      openPanel().swap();
    }),
    vscode.commands.registerCommand('diffCompare.clear', () => {
      openPanel().clear();
    }),
    vscode.commands.registerCommand('diffCompare.addActiveToLeft', async () => {
      await openPanel().addActiveEditor('left');
    }),
    vscode.commands.registerCommand('diffCompare.addActiveToRight', async () => {
      await openPanel().addActiveEditor('right');
    }),
    vscode.commands.registerCommand('diffCompare.syncAllToLeft', async () => {
      await openPanel().syncAll('left');
    }),
    vscode.commands.registerCommand('diffCompare.syncAllToRight', async () => {
      await openPanel().syncAll('right');
    }),
    vscode.commands.registerCommand('diffCompare.find', () => {
      openPanel().focusSearch();
    }),
    vscode.commands.registerCommand('diffCompare.showLogs', () => {
      log.show();
    }),
  );

  // Restore the panel after a window reload.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(ComparePanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        ComparePanel.revive(panel, context, log, pathGate);
      },
    }),
  );

  // 深链：vscode://Aurumjin.diff-compare/open?left=<路径>&right=<路径>
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        log.info(`收到深链：${uri.toString()}`);
        const params = new URLSearchParams(uri.query);
        const left = params.get('left') ?? undefined;
        const right = params.get('right') ?? undefined;
        void openPanel().openPaths(left, right);
      },
    }),
  );
}

export function deactivate(): void {
  logger?.dispose();
  logger = undefined;
}
