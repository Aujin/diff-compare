import * as vscode from 'vscode';
import { ComparePanel } from './comparePanel';
import { detectLocale, t } from './i18n';
import type { Locale } from './i18n';
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

  const locale: Locale = detectLocale();
  const text = (key: string, params?: Record<string, string | number>): string =>
    t(locale, key, params);

  log.info(
    text('log.activated', {
      version: context.extension?.packageJSON?.version ?? text('common.unknown'),
    }),
  );

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
        text('warn.noContextSelection'),
      );
      return;
    }

    const items: PlaceItem[] = [];
    items.push({
      kind: vscode.QuickPickItemKind.Separator,
      label: text('menu.newPanelGroup'),
    });
    items.push({
      label: text('menu.addLeft'),
      description: text('menu.newPanelHint'),
      action: { mode: 'replace', side: 'left', createNew: true },
    });
    items.push({
      label: text('menu.addRight'),
      description: text('menu.newPanelHint'),
      action: { mode: 'replace', side: 'right', createNew: true },
    });

    ComparePanel.instances.forEach((panel, index) => {
      const title = text('menu.panelItem', {
        n: index + 1,
        summary: panel.summary(),
      });
      items.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: title,
      });
      items.push({
        label: text('menu.addLeft'),
        description: title,
        action: { mode: 'add', side: 'left', panel, createNew: false },
      });
      items.push({
        label: text('menu.addRight'),
        description: title,
        action: { mode: 'add', side: 'right', panel, createNew: false },
      });
      items.push({
        label: text('menu.replaceLeft'),
        description: title,
        action: { mode: 'replace', side: 'left', panel, createNew: false },
      });
      items.push({
        label: text('menu.replaceRight'),
        description: title,
        action: { mode: 'replace', side: 'right', panel, createNew: false },
      });
    });

    const picked = (await vscode.window.showQuickPick(items, {
      placeHolder: text('menu.pickPlaceholder'),
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
      ComparePanel.create(context, log, pathGate);
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
    vscode.commands.registerCommand('diffCompare.undo', async () => {
      await openPanel().undo();
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
        log.info(text('log.deepLink', { uri: uri.toString() }));
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
