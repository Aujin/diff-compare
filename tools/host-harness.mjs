#!/usr/bin/env node
// Integration harness for the host side of the extension.
//
// It loads the compiled extension (dist/extension.js) with a stubbed `vscode`
// module and drives the real panel pipeline: drop a file -> compare -> sync.
// Everything the webview would receive is captured, so the payload shapes are
// verified without launching VS Code.
//
// Run: node tools/host-harness.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import Module from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

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
      const encoded = full
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      return `${scheme}://${encoded}`;
    },
  };
}

function parseUri(raw) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/)?([^?#]*)/.exec(raw);
  const scheme = match ? match[1] : 'file';
  let value = match ? match[2] : raw;
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep the raw value */
  }
  if (scheme === 'file') {
    let fsPath = value;
    if (/^\/[a-zA-Z]:/.test(fsPath)) {
      fsPath = fsPath.slice(1);
    }
    return makeUri('file', fsPath.replace(/\//g, sep));
  }
  return makeUri(scheme, value);
}

const Uri = {
  file: (fsPath) => makeUri('file', fsPath),
  parse: (raw) => parseUri(raw),
  joinPath: (base, ...parts) => makeUri(base.scheme, join(base.fsPath, ...parts)),
};

// --------------------------------------------------------------- vscode stub

const state = {
  posted: [],
  receive: undefined,
  panel: undefined,
  commands: new Map(),
  logLines: [],
  warnings: [],
  infos: [],
  errors: [],
};

const workspaceFolders = [];

const configuration = {
  get: (key, fallback) => fallback,
};

const vscode = {
  Uri,
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  window: {
    createWebviewPanel(viewType, title, showOptions, options) {
      const panel = {
        viewType,
        title,
        showOptions,
        options,
        viewColumn: 1,
        active: true,
        visible: true,
        webview: {
          html: '',
          cspSource: 'vscode-webview:',
          asWebviewUri: (uri) => uri,
          postMessage: async (message) => {
            state.posted.push(message);
            return true;
          },
          onDidReceiveMessage: (handler) => {
            state.receive = handler;
            return { dispose() {} };
          },
        },
        onDidChangeViewState: () => ({ dispose() {} }),
        onDidDispose: () => ({ dispose() {} }),
        reveal: () => {},
        dispose: () => {},
      };
      state.panel = panel;
      return panel;
    },
    createOutputChannel: (name) => ({
      name,
      appendLine: (line) => state.logLines.push(line),
      append: () => {},
      show: () => {},
      clear: () => {},
      dispose: () => {},
    }),
    showWarningMessage: async (message, ...rest) => {
      state.warnings.push(message);
      const options = rest.filter((item) => typeof item === 'string');
      return options[0];
    },
    showInformationMessage: async (message) => {
      state.infos.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => {
      state.errors.push(message);
      return undefined;
    },
    showQuickPick: async () => undefined,
    showOpenDialog: async () => undefined,
    showTextDocument: async () => undefined,
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
    registerUriHandler: (handler) => {
      state.uriHandler = handler;
      return { dispose() {} };
    },
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders,
    isTrusted: true,
    getConfiguration: () => configuration,
  },
  commands: {
    registerCommand: (id, callback) => {
      state.commands.set(id, callback);
      return { dispose() {} };
    },
    executeCommand: async () => undefined,
  },
  env: { appName: 'Diff Compare Harness' },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, ...rest);
};

// ------------------------------------------------------------------ fixtures

const tmp = mkdtempSync(join(tmpdir(), 'diff-compare-harness-'));
const ws = join(tmp, 'ws');
const left = join(ws, 'left');
const right = join(ws, 'right');
mkdirSync(left, { recursive: true });
mkdirSync(right, { recursive: true });

writeFileSync(join(left, 'sample.txt'), 'alpha\nbravo\ncharlie\n', 'utf8');
writeFileSync(join(right, 'sample.txt'), 'alpha\nBRAVO!\ncharlie\n', 'utf8');
writeFileSync(join(left, 'other.txt'), 'same\n', 'utf8');
writeFileSync(join(right, 'other.txt'), 'same\n', 'utf8');
writeFileSync(join(left, 'data.bin'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
writeFileSync(join(right, 'data.bin'), Buffer.from([0, 1, 2, 3, 4, 99, 6, 7, 8, 9]));
mkdirSync(join(left, 'only-left-dir'), { recursive: true });
mkdirSync(join(right, 'only-right-dir'), { recursive: true });
writeFileSync(join(left, 'only-left-dir', 'a.txt'), 'left only\n', 'utf8');
writeFileSync(join(right, 'only-right-dir', 'b.txt'), 'right only\n', 'utf8');

// A dedicated pair of trees for the folder comparison.
const treeLeft = join(ws, 'tree-left');
const treeRight = join(ws, 'tree-right');
mkdirSync(join(treeLeft, 'only-left'), { recursive: true });
mkdirSync(join(treeRight, 'only-right'), { recursive: true });
writeFileSync(join(treeLeft, 'common.txt'), 'same\n', 'utf8');
writeFileSync(join(treeRight, 'common.txt'), 'same\n', 'utf8');
writeFileSync(join(treeLeft, 'changed.txt'), 'one\n', 'utf8');
writeFileSync(join(treeRight, 'changed.txt'), 'two\n', 'utf8');
writeFileSync(join(treeLeft, 'only-left', 'a.txt'), 'left only\n', 'utf8');
writeFileSync(join(treeRight, 'only-right', 'b.txt'), 'right only\n', 'utf8');

workspaceFolders.push({ name: 'ws', uri: Uri.file(ws), index: 0 });

// --------------------------------------------------------------------- utils

let failures = 0;
let group = '';

function section(title) {
  group = title;
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

function lastPayload() {
  for (let index = state.posted.length - 1; index >= 0; index -= 1) {
    if (state.posted[index].type === 'comparison') {
      return state.posted[index].payload;
    }
  }
  return undefined;
}

async function send(message) {
  state.posted = [];
  if (!state.receive) {
    throw new Error('webview 没有注册消息处理器');
  }
  state.receive(message);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return state.posted.slice();
}

function uriOf(fsPath) {
  return Uri.file(fsPath).toString();
}

// ---------------------------------------------------------------------- main

const extension = require(join(root, 'dist', 'extension.js'));
const context = {
  subscriptions: [],
  extensionUri: Uri.file(root),
  extension: { packageJSON: { version: '0.1.0' } },
  globalState: {
    store: new Map(),
    get(key, fallback) {
      return this.store.has(key) ? this.store.get(key) : fallback;
    },
    async update(key, value) {
      this.store.set(key, value);
    },
  },
  workspaceState: {
    store: new Map(),
    get(key, fallback) {
      return this.store.has(key) ? this.store.get(key) : fallback;
    },
    async update(key, value) {
      this.store.set(key, value);
    },
  },
};

extension.activate(context);

section('activation');
check('11 个命令已注册', state.commands.size === 11, `实际 ${state.commands.size}`);
check('激活日志已写入', state.logLines.some((line) => line.includes('已激活')));

await state.commands.get('diffCompare.open')();
check('面板已创建', Boolean(state.panel));
check('HTML 已注入', state.panel.webview.html.includes('Diff Compare'));
check(
  'HTML 含 CSP nonce',
  /<script nonce="[a-z0-9]+"/i.test(state.panel.webview.html),
);
check(
  'HTML 含工具栏按钮',
  ['btn-workspace', 'btn-pick', 'btn-swap', 'btn-clear', 'btn-find'].every((id) =>
    state.panel.webview.html.includes(`id="${id}"`),
  ),
);

await send({ type: 'ready' });
check('ready 后收到 state', state.posted.some((m) => m.type === 'state'));
check('ready 后比较结果为 none', lastPayload()?.kind === 'none', lastPayload()?.kind);

section('文本文件比较');
await send({
  type: 'drop',
  side: 'left',
  uris: [uriOf(join(left, 'sample.txt'))],
});
await send({
  type: 'drop',
  side: 'right',
  uris: [uriOf(join(right, 'sample.txt'))],
});
const textPayload = lastPayload();
check('比较结果为 file', textPayload?.kind === 'file', textPayload?.kind);
check('视图模式为 text', textPayload?.viewMode === 'text', textPayload?.viewMode);
check('存在差异块', (textPayload?.text?.hunks?.length ?? 0) >= 1);
check('行数一致', textPayload?.text?.leftLines === 3 && textPayload?.text?.rightLines === 3);
const hunk = textPayload?.text?.hunks?.[0];
check('差异块含左右行号', typeof hunk?.lBefore === 'number' && typeof hunk?.rBefore === 'number');

section('同步：右侧 → 左侧');
await send({ type: 'syncHunk', hunkId: hunk.id, target: 'left' });
check(
  '左文件已更新',
  readFileSync(join(left, 'sample.txt'), 'utf8') === 'alpha\nBRAVO!\ncharlie\n',
  JSON.stringify(readFileSync(join(left, 'sample.txt'), 'utf8')),
);
check(
  '右文件未被修改',
  readFileSync(join(right, 'sample.txt'), 'utf8') === 'alpha\nBRAVO!\ncharlie\n',
);
check('同步后提示信息已发送', state.posted.some((m) => m.type === 'info'));

section('同步：左侧 → 右侧');
writeFileSync(join(left, 'sample.txt'), 'alpha\nbravo\ncharlie\n', 'utf8');
await send({ type: 'refresh' });
const refreshed = lastPayload();
const rightHunk = refreshed?.text?.hunks?.[0];
check('刷新后重新发现差异', Boolean(rightHunk));
await send({ type: 'syncHunk', hunkId: rightHunk.id, target: 'right' });
check(
  '右文件已更新',
  readFileSync(join(right, 'sample.txt'), 'utf8') === 'alpha\nbravo\ncharlie\n',
  JSON.stringify(readFileSync(join(right, 'sample.txt'), 'utf8')),
);

section('二进制文件比较');
await send({ type: 'drop', side: 'left', uris: [uriOf(join(left, 'data.bin'))] });
await send({ type: 'drop', side: 'right', uris: [uriOf(join(right, 'data.bin'))] });
const binPayload = lastPayload();
check('比较结果为 file', binPayload?.kind === 'file', binPayload?.kind);
check('自动切换到十六进制', binPayload?.viewMode === 'hex', binPayload?.viewMode);
check('存在字节差异范围', (binPayload?.binary?.ranges?.length ?? 0) >= 1);
const range = binPayload?.binary?.ranges?.[0];
await send({ type: 'syncRange', rangeId: range.id, target: 'left' });
check(
  '左二进制文件已更新',
  readFileSync(join(left, 'data.bin')).equals(readFileSync(join(right, 'data.bin'))),
);

section('目录比较');
await send({ type: 'drop', side: 'left', uris: [uriOf(treeLeft)] });
await send({ type: 'drop', side: 'right', uris: [uriOf(treeRight)] });
const folderPayload = lastPayload();
check('比较结果为 folder', folderPayload?.kind === 'folder', folderPayload?.kind);
const entries = folderPayload?.folder?.entries ?? [];
check('条目数量大于 0', entries.length > 0);
const onlyRight = entries.find((entry) => entry.status === 'only-right');
const onlyLeft = entries.find((entry) => entry.status === 'only-left');
const modified = entries.find((entry) => entry.status === 'modified');
check('存在 only-right 条目', Boolean(onlyRight));
check('存在 only-left 条目', Boolean(onlyLeft));
check('存在 modified 条目', Boolean(modified));
check(
  '修改过的文件被标记',
  modified?.path === 'changed.txt',
  modified?.path,
);

if (onlyRight) {
  await send({ type: 'syncEntry', path: onlyRight.path, target: 'left' });
  check(
    'only-right 条目已复制到左侧',
    existsSync(join(treeLeft, onlyRight.path.split('/').join(sep))),
    onlyRight.path,
  );
}

section('类型不匹配');
await send({ type: 'drop', side: 'left', uris: [uriOf(join(left, 'sample.txt'))] });
await send({ type: 'drop', side: 'right', uris: [uriOf(right)] });
check('比较结果为 mismatch', lastPayload()?.kind === 'mismatch', lastPayload()?.kind);

section('URI 深链');
check('已注册 URI 处理器', typeof state.uriHandler?.handleUri === 'function');
if (typeof state.uriHandler?.handleUri === 'function') {
  const query = `left=${encodeURIComponent(join(left, 'sample.txt'))}&right=${encodeURIComponent(join(right, 'sample.txt'))}`;
  state.uriHandler.handleUri({ query });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const deepPayload = lastPayload();
  check('深链打开文件对比', deepPayload?.kind === 'file', deepPayload?.kind);
  check('深链两侧都是文本视图', deepPayload?.viewMode === 'text', deepPayload?.viewMode);

  const relQuery = `left=${encodeURIComponent('left/sample.txt')}&right=${encodeURIComponent('right/sample.txt')}`;
  state.uriHandler.handleUri({ query: relQuery });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const relPayload = lastPayload();
  check(
    '相对路径按工作区解析',
    relPayload?.left?.path === join(left, 'sample.txt'),
    relPayload?.left?.path,
  );
}

section('工作区之外的路径');
const outside = join(tmp, 'outside.txt');
writeFileSync(outside, 'outside\n', 'utf8');
const before = state.warnings.length;
await send({ type: 'drop', side: 'left', uris: [uriOf(outside)] });
check(
  '外部路径触发确认提示',
  state.warnings.length > before &&
    state.warnings[state.warnings.length - 1].includes('不在当前工作区内'),
  state.warnings[state.warnings.length - 1],
);

section('清理');
rmSync(tmp, { recursive: true, force: true });
check('临时目录已清理', !existsSync(tmp));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nhost harness: all checks passed');
