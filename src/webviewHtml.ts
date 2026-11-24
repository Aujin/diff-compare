import * as vscode from 'vscode';
import { tableFor } from './i18n';
import type { Locale } from './i18n';

const ICONS = {
  folder:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.5 2H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  file:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h5L12.5 5.5v9h-9v-13z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8.5 1.5v4h4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  swap:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h10l-2.5-2.5M14 11H4l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  refresh:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.7-4M13 2v3h-3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  newTab:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="4.5" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9.5" y="3" width="4.5" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.2a1 1 0 0 0 1 .8h3.6a1 1 0 0 0 1-.8l.7-8.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  undo:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h7a3 3 0 0 1 0 6H7M3 8l3-3M3 8l3 3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  search:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.2"/></svg>',
  plus:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.3"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3"/></svg>',
  arrowLeft:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3.5M7 4L3 8l4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  arrowRight:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9.5M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  prev:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3l-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  next:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};

export interface HtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  nonce: string;
  locale: Locale;
}

export function renderHtml(options: HtmlOptions): string {
  const { webview, extensionUri, nonce, locale } = options;
  const s = tableFor(locale);
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'compare.css'),
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'compare.js'),
  );

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Diff Compare</title>
</head>
<body>
  <div class="toolbar" role="toolbar" aria-label="Diff Compare">
    <div class="tb-group">
      <button id="btn-new" class="tb-btn" title="${s['toolbar.newTabTitle']}">
        ${ICONS.newTab}<span class="tb-label">${s['toolbar.newTab']}</span>
      </button>
      <button id="btn-pick" class="tb-btn" title="${s['toolbar.addFileTitle']}">
        ${ICONS.plus}<span class="tb-label">${s['toolbar.addFile']}</span>
      </button>
      <button id="btn-refresh" class="tb-btn" title="${s['toolbar.refreshTitle']}">
        ${ICONS.refresh}<span class="tb-label">${s['toolbar.refresh']}</span>
      </button>
      <button id="btn-swap" class="tb-btn" title="${s['toolbar.swapTitle']}">
        ${ICONS.swap}<span class="tb-label">${s['toolbar.swap']}</span>
      </button>
      <button id="btn-undo" class="tb-btn" title="${s['toolbar.undoTitle']}">
        ${ICONS.undo}<span class="tb-label">${s['toolbar.undo']}</span>
      </button>
      <button id="btn-clear" class="tb-btn" title="${s['toolbar.clearTitle']}">
        ${ICONS.trash}<span class="tb-label">${s['toolbar.clear']}</span>
      </button>
    </div>
    <div class="tb-group tb-modes" role="group" aria-label="view mode">
      <button class="mode-btn" data-mode="auto">${s['mode.auto']}</button>
      <button class="mode-btn" data-mode="text">${s['mode.text']}</button>
      <button class="mode-btn" data-mode="hex">${s['mode.hex']}</button>
      <button class="mode-btn" data-mode="binary">${s['mode.binary']}</button>
    </div>
    <div class="tb-group tb-right">
      <button id="btn-find" class="tb-btn" title="${s['toolbar.findTitle']}">
        ${ICONS.search}<span class="tb-label">${s['toolbar.find']}</span>
      </button>
    </div>
  </div>

  <div id="search-bar" class="search-bar" hidden>
    <input id="search-input" type="text" placeholder="${s['search.placeholder']}" spellcheck="false" />
    <span id="search-count" class="search-count">${s['search.noResult']}</span>
    <button id="search-prev" class="tb-btn icon-only" title="${s['search.prevTitle']}">${ICONS.prev}</button>
    <button id="search-next" class="tb-btn icon-only" title="${s['search.nextTitle']}">${ICONS.next}</button>
    <button id="search-close" class="tb-btn icon-only" title="${s['search.closeTitle']}">${ICONS.close}</button>
  </div>

  <main id="columns" class="columns">
    <section class="pane" data-side="left">
      <header class="pane-head" id="head-left">
        <span class="pane-badge">${s['side.left']}</span>
        <span class="pane-title" id="title-left">${s['pane.notSelected']}</span>
        <span class="pane-actions">
          <button class="mini" data-action="pick-left" title="${s['pane.pickTitle']}">${ICONS.plus}</button>
          <button class="mini" data-action="clear-left" title="${s['pane.clearLeftTitle']}">${ICONS.close}</button>
        </span>
      </header>
      <div class="pane-body" id="body-left">
        <div class="rows" id="rows-left"></div>
      </div>
    </section>

    <div class="gutter" id="gutter">
      <div class="gutter-head" id="gutter-head">
        <button id="sync-all-left" class="tb-btn icon-only" title="${s['gutter.syncAllLeftTitle']}">${ICONS.arrowLeft}</button>
        <button id="sync-all-right" class="tb-btn icon-only" title="${s['gutter.syncAllRightTitle']}">${ICONS.arrowRight}</button>
      </div>
      <div class="gutter-body" id="gutter-body">
        <div class="gutter-items" id="gutter-items"></div>
      </div>
    </div>

    <section class="pane" data-side="right">
      <header class="pane-head" id="head-right">
        <span class="pane-badge">${s['side.right']}</span>
        <span class="pane-title" id="title-right">${s['pane.notSelected']}</span>
        <span class="pane-actions">
          <button class="mini" data-action="pick-right" title="${s['pane.pickTitle']}">${ICONS.plus}</button>
          <button class="mini" data-action="clear-right" title="${s['pane.clearRightTitle']}">${ICONS.close}</button>
        </span>
      </header>
      <div class="pane-body" id="body-right">
        <div class="rows" id="rows-right"></div>
      </div>
    </section>
  </main>

  <footer id="status" class="status">${s['status.ready']}</footer>
  <div id="drop-overlay" class="drop-overlay" hidden><span>${s['status.dropFailed']}</span></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export { ICONS };
