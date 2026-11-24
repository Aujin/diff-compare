#!/usr/bin/env node
// Integration harness for the webview side of the extension.
//
// It renders the real HTML shell (dist/webviewHtml.js) inside jsdom, runs the
// real media/compare.js and checks what the user would see: rows, gutter
// arrows for every difference, search highlighting and the toolbar buttons.
//
// Run: node tools/webview-harness.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ----------------------------------------------------------------- uri stub

function makeUri(scheme, fsPath) {
  const posix = fsPath.replace(/\\/g, '/');
  return {
    scheme,
    fsPath,
    path: posix.startsWith('/') ? posix : `/${posix}`,
    toString() {
      const full = posix.startsWith('/') ? posix : `/${posix}`;
      return `${scheme}://${full}`;
    },
  };
}

const vscode = {
  Uri: {
    file: (fsPath) => makeUri('file', fsPath),
    parse: (raw) => makeUri('file', raw.replace(/^file:\/\//, '')),
    joinPath: (base, ...parts) => makeUri(base.scheme, join(base.fsPath, ...parts)),
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, ...rest);
};

// ------------------------------------------------------------------- setup

const { renderHtml } = require(join(root, 'dist', 'webviewHtml.js'));
const compareJs = readFileSync(join(root, 'media', 'compare.js'), 'utf8');

const html = renderHtml({
  webview: {
    asWebviewUri: (uri) => uri.toString(),
    cspSource: 'vscode-webview:',
  },
  extensionUri: makeUri('file', root),
  nonce: 'harnessnonce',
});

const posted = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://file+.vscode-resource.test/index.html',
  beforeParse(window) {
    window.acquireVsCodeApi = () => ({
      postMessage: (message) => posted.push(message),
      getState: () => undefined,
      setState: () => {},
    });
  },
});

const { window } = dom;
const { document } = window;

window.eval(compareJs);

function hostMessage(message) {
  window.dispatchEvent(new window.MessageEvent('message', { data: message }));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function section(title) {
  console.log(title);
}

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function lastPosted(type) {
  for (let index = posted.length - 1; index >= 0; index -= 1) {
    if (posted[index].type === type) {
      return posted[index];
    }
  }
  return undefined;
}

// ------------------------------------------------------------------- tests

section('初始化');
check('脚本已发送 ready', Boolean(lastPosted('ready')));
hostMessage({ type: 'comparison', payload: { kind: 'none', viewMode: 'text' } });
check('左栏为空时显示提示', document.querySelectorAll('#rows-left .empty').length === 1);
check(
  '工具栏按钮齐全',
  ['btn-workspace', 'btn-pick', 'btn-refresh', 'btn-swap', 'btn-clear', 'btn-find'].every(
    (id) => document.getElementById(id),
  ),
);

const textPayload = {
  kind: 'file',
  viewMode: 'text',
  left: { kind: 'file', uri: 'file:///left.txt', name: 'left.txt' },
  right: { kind: 'file', uri: 'file:///right.txt', name: 'right.txt' },
  text: {
    rows: [
      { t: 'eq', l: [1, 'alpha'], r: [1, 'alpha'] },
      { t: 'chg', l: [2, 'bravo'], r: [2, 'BRAVO!'] },
      { t: 'ins', r: [3, 'charlie'] },
    ],
    hunks: [
      { id: 0, kind: 'change', lBefore: 1, lCount: 1, rBefore: 1, rCount: 1, row: 1 },
      { id: 1, kind: 'insert', lBefore: 2, lCount: 0, rBefore: 2, rCount: 1, row: 2 },
    ],
    leftLines: 2,
    rightLines: 3,
  },
};

section('文本差异渲染');
hostMessage({ type: 'comparison', payload: textPayload });
check('左栏行数', document.querySelectorAll('#rows-left .row').length === 3);
check('右栏行数', document.querySelectorAll('#rows-right .row').length === 3);
check(
  '每处差异都有两个箭头',
  document.querySelectorAll('#gutter-items button.arrow').length === 4,
  String(document.querySelectorAll('#gutter-items button.arrow').length),
);
check('差异说明存在', document.querySelectorAll('#gutter-items .gutter-info').length === 2);
check(
  '左栏显示修改行',
  document.querySelector('#rows-left .row.r-chg .tx').textContent === 'bravo',
);
check(
  '右栏显示修改行',
  document.querySelector('#rows-right .row.r-chg .tx').textContent === 'BRAVO!',
);
check(
  '插入行左栏为空',
  document.querySelectorAll('#rows-left .row.r-void').length === 1,
);

section('箭头点击');
const arrows = Array.from(document.querySelectorAll('#gutter-items button.arrow'));
arrows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(
  '左箭头同步到左侧',
  JSON.stringify(lastPosted('syncHunk')) ===
    JSON.stringify({ target: 'left', type: 'syncHunk', hunkId: 0 }),
  JSON.stringify(lastPosted('syncHunk')),
);
arrows[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(
  '右箭头同步到右侧',
  JSON.stringify(lastPosted('syncHunk')) ===
    JSON.stringify({ target: 'right', type: 'syncHunk', hunkId: 0 }),
  JSON.stringify(lastPosted('syncHunk')),
);

section('查找');
document.getElementById('btn-find').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('查找栏已展开', document.getElementById('search-bar').hidden === false);
const input = document.getElementById('search-input');
input.value = 'bravo';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(250);
check(
  '找到 2 处（左右各一处）',
  document.getElementById('search-count').textContent === '1 / 2',
  document.getElementById('search-count').textContent,
);
check('存在高亮标记', document.querySelectorAll('#rows-left mark').length === 1);
check(
  '高亮内容正确',
  document.querySelector('#rows-left mark').textContent === 'bravo',
);
input.value = 'zzz';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(250);
check('无结果提示', document.getElementById('search-count').textContent === '无结果');

section('工具栏');
document.getElementById('btn-refresh').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('刷新按钮', Boolean(lastPosted('refresh')));
document.getElementById('btn-swap').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('交换按钮', Boolean(lastPosted('swap')));
document.getElementById('btn-clear').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('清空按钮', Boolean(lastPosted('clear')));
document
  .querySelector('.mode-btn[data-mode="hex"]')
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(
  '切换视图模式',
  JSON.stringify(lastPosted('setViewMode')) ===
    JSON.stringify({ type: 'setViewMode', mode: 'hex' }),
  JSON.stringify(lastPosted('setViewMode')),
);

section('目录比较渲染');
hostMessage({
  type: 'comparison',
  payload: {
    kind: 'folder',
    viewMode: 'text',
    folder: {
      entries: [
        { path: 'changed.txt', type: 'file', status: 'modified' },
        { path: 'only-right.txt', type: 'file', status: 'only-right' },
        { path: 'only-left.txt', type: 'file', status: 'only-left' },
      ],
      leftCount: 2,
      rightCount: 2,
    },
  },
});
check('目录行数', document.querySelectorAll('#rows-left .row').length === 3);
check('每个条目两个箭头', document.querySelectorAll('#gutter-items button.arrow').length === 6);
const folderArrows = Array.from(document.querySelectorAll('#gutter-items button.arrow'));
folderArrows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(
  '目录条目同步消息',
  JSON.stringify(lastPosted('syncEntry')) ===
    JSON.stringify({ target: 'left', type: 'syncEntry', path: 'changed.txt' }),
  JSON.stringify(lastPosted('syncEntry')),
);

section('二进制比较渲染');
hostMessage({
  type: 'comparison',
  payload: {
    kind: 'file',
    viewMode: 'hex',
    binary: {
      rows: [
        { lo: 0, ro: 0, lb: '00 01 02', rb: '00 01 02', mask: '000' },
        { lo: 16, ro: 16, lb: '03 04 05', rb: '03 99 05', mask: '010' },
      ],
      ranges: [{ id: 0, lStart: 17, lEnd: 18, rStart: 17, rEnd: 18, row: 1 }],
      leftSize: 32,
      rightSize: 32,
    },
  },
});
check('二进制行数', document.querySelectorAll('#rows-left .row.hex').length === 2);
check('差异字节被标记', document.querySelectorAll('#rows-left .byte-diff').length === 1);
check('二进制箭头数量', document.querySelectorAll('#gutter-items button.arrow').length === 2);
const binArrows = Array.from(document.querySelectorAll('#gutter-items button.arrow'));
binArrows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(
  '二进制同步消息',
  JSON.stringify(lastPosted('syncRange')) ===
    JSON.stringify({ target: 'left', type: 'syncRange', rangeId: 0 }),
  JSON.stringify(lastPosted('syncRange')),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nwebview harness: all checks passed');
