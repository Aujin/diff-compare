import * as vscode from 'vscode';
import { ComparePanel } from './comparePanel';
import { Logger } from './logger';
import { PathGate } from './policy';

let logger: Logger | undefined;

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

  context.subscriptions.push(
    vscode.commands.registerCommand('diffCompare.open', () => {
      openPanel();
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
