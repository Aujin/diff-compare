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

class Uri {
  constructor(scheme, fsPath) {
    this.scheme = scheme;
    this.fsPath = fsPath;
    const posix = fsPath.replace(/\\/g, '/');
    this.path = posix.startsWith('/') ? posix : `/${posix}`;
  }

  toString() {
    const full = this.path;
    const encoded = full
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.scheme}://${encoded}`;
  }

  static file(fsPath) {
    return new Uri('file', fsPath);
  }

  static parse(raw) {
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
      return new Uri('file', fsPath.replace(/\//g, sep));
    }
    return new Uri(scheme, value);
  }

  static joinPath(base, ...parts) {
    return new Uri(base.scheme, join(base.fsPath, ...parts));
  }
}

// --------------------------------------------------------------- vscode stub

const state = {
  posted: [],
  receive: undefined,
  panel: undefined,
  panels: [],
  quickPickCalls: [],
  quickPickHandler: undefined,
  openDialogCalls: [],
  openDialogHandler: undefined,
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
  QuickPickItemKind: { Separator: -1, Default: 0 },
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
        messages: [],
        webview: {
          html: '',
          cspSource: 'vscode-webview:',
          asWebviewUri: (uri) => uri,
          postMessage: async (message) => {
            panel.messages.push(message);
            state.posted.push(message);
            return true;
          },
          onDidReceiveMessage: (handler) => {
            panel.receive = handler;
            state.receive = handler;
            return { dispose() {} };
          },
        },
        onDidChangeViewState: (handler) => {
          panel.viewStateHandler = handler;
          return { dispose() {} };
        },
        onDidDispose: (handler) => {
          panel.disposeHandler = handler;
          return { dispose() {} };
        },
        reveal: () => {
          state.revealed = panel;
        },
        dispose: () => {
          panel.disposeHandler?.();
        },
      };
      state.panels.push(panel);
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
    showQuickPick: async (items, options) => {
      state.quickPickCalls.push(items);
      if (state.quickPickHandler) {
        return state.quickPickHandler(items, options);
      }
      return undefined;
    },
    showOpenDialog: async (options) => {
      state.openDialogCalls.push(options);
      if (state.openDialogHandler) {
        return state.openDialogHandler(options);
      }
      return undefined;
    },
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
  env: { appName: 'Diff Compare Harness', language: 'zh-cn' },
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

/** 某个标签页最后一次收到的比较结果。 */
function lastPayloadOf(panel) {
  const messages = panel.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === 'comparison') {
      return messages[index].payload;
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
check('14 个命令已注册', state.commands.size === 14, `实际 ${state.commands.size}`);
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
  [
    'btn-new',
    'btn-pick',
    'btn-refresh',
    'btn-swap',
    'btn-undo',
    'btn-clear',
    'btn-find',
  ].every((id) => state.panel.webview.html.includes(`id="${id}"`)),
);
check(
  'HTML 不再包含已删除的工作区文件夹按钮',
  !state.panel.webview.html.includes('btn-workspace'),
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

section('多标签页');
await state.commands.get('diffCompare.newPanel')();
check('新建了第二个对比标签页', state.panels.length === 2, `实际 ${state.panels.length}`);
const firstPanel = state.panels[0];
const secondPanel = state.panels[1];
check(
  '标签页标题带上了序号',
  /^Diff Compare \d+$/.test(String(firstPanel.title)),
  firstPanel.title,
);
check(
  '两个标签页的序号不同',
  firstPanel.title !== secondPanel.title,
  `${firstPanel.title} / ${secondPanel.title}`,
);
await state.commands.get('diffCompare.open')();
check(
  '打开对比面板会新增一个标签页',
  state.panels.length === 3,
  `实际 ${state.panels.length}`,
);
check(
  '新增的标签页序号继续递增',
  /^Diff Compare 3$/.test(String(state.panels[2].title)),
  state.panels[2].title,
);
state.panels[2].dispose?.();
state.panels.pop();
state.receive = secondPanel.receive;
await send({ type: 'ready' }); // state.receive 现在指向第二个标签页
check(
  '第二个标签页初始为空',
  lastPayloadOf(secondPanel)?.kind === 'none',
  lastPayloadOf(secondPanel)?.kind,
);

section('右键加入对比');
// 1) 加入第 1 个标签的左侧（该栏已有内容 → 询问后替换）
state.quickPickHandler = async (items) =>
  items.find(
    (item) => item.label === '加入左侧' && (item.description ?? '').includes('第 1 个标签'),
  );
await state.commands.get('diffCompare.addFromContext')(Uri.file(join(left, 'other.txt')));
await new Promise((resolve) => setTimeout(resolve, 250));
check(
  '第 1 个标签的左栏已更新',
  lastPayloadOf(firstPanel)?.left?.path === join(left, 'other.txt'),
  lastPayloadOf(firstPanel)?.left?.path,
);
check(
  '标签页标题带上了序号',
  /^Diff Compare \d+$/.test(String(firstPanel.title)),
  firstPanel.title,
);
check(
  '第 2 个标签不受影响',
  lastPayloadOf(secondPanel)?.kind === 'none',
  lastPayloadOf(secondPanel)?.kind,
);

// 2) 替换第 2 个标签的右侧
state.quickPickHandler = async (items) =>
  items.find(
    (item) => item.label === '替换右侧' && (item.description ?? '').includes('第 2 个标签'),
  );
await state.commands.get('diffCompare.addFromContext')(Uri.file(join(right, 'sample.txt')));
await new Promise((resolve) => setTimeout(resolve, 250));
check(
  '第 2 个标签的右栏已设置',
  lastPayloadOf(secondPanel)?.right?.path === join(right, 'sample.txt'),
  lastPayloadOf(secondPanel)?.right?.path,
);

// 3) 新建标签页并加入右侧
state.quickPickHandler = async (items) =>
  items.find(
    (item) =>
      item.label === '加入右侧' && (item.description ?? '').includes('新建一个对比标签'),
  );
await state.commands.get('diffCompare.addFromContext')(Uri.file(join(left, 'data.bin')));
await new Promise((resolve) => setTimeout(resolve, 250));
check('新建了第三个对比标签页', state.panels.length === 3, `实际 ${state.panels.length}`);
const thirdPanel = state.panels[2];
check(
  '新标签页右栏已设置',
  lastPayloadOf(thirdPanel)?.right?.path === join(left, 'data.bin'),
  lastPayloadOf(thirdPanel)?.right?.path,
);
check(
  '菜单里列出了已有标签页',
  state.quickPickCalls.some((items) =>
    items.some((item) => (item.description ?? '').includes('第 2 个标签')),
  ),
);

// 4) 面板工具栏里的「新建标签」按钮
const panelsBefore = state.panels.length;
await state.panels[0].receive({ type: 'newPanel' });
await new Promise((resolve) => setTimeout(resolve, 150));
check(
  '工具栏新建按钮可以再开一个标签页',
  state.panels.length === panelsBefore + 1,
  `实际 ${state.panels.length}`,
);
check(
  '每个标签页的序号不同',
  new Set(state.panels.map((panel) => panel.title)).size === state.panels.length,
  state.panels.map((panel) => panel.title).join(' / '),
);

section('撤销上一次同步');
// 在第 2 个标签页上做一次同步，然后撤销。
await state.panels[1].receive({ type: 'ready' });
const undoTarget = join(right, 'sample.txt');
writeFileSync(undoTarget, 'alpha\nBRAVO!\ncharlie\n', 'utf8');
await state.panels[1].receive({
  type: 'drop',
  side: 'left',
  uris: [uriOf(join(left, 'sample.txt'))],
});
await state.panels[1].receive({
  type: 'drop',
  side: 'right',
  uris: [uriOf(undoTarget)],
});
await new Promise((resolve) => setTimeout(resolve, 200));
const undoPayload = lastPayloadOf(state.panels[1]);
const undoHunk = undoPayload?.text?.hunks?.[0];
check('撤销前存在差异块', Boolean(undoHunk));
if (undoHunk) {
  await state.panels[1].receive({
    type: 'syncHunk',
    hunkId: undoHunk.id,
    target: 'right',
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    '同步后右文件被改写',
    readFileSync(undoTarget, 'utf8') === 'alpha\nbravo\ncharlie\n',
    JSON.stringify(readFileSync(undoTarget, 'utf8')),
  );
  await state.panels[1].receive({ type: 'undo' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    '撤销后文件恢复原样',
    readFileSync(undoTarget, 'utf8') === 'alpha\nBRAVO!\ncharlie\n',
    JSON.stringify(readFileSync(undoTarget, 'utf8')),
  );
  check(
    '撤销后重新比较仍然显示差异',
    (lastPayloadOf(state.panels[1])?.text?.hunks?.length ?? 0) === 1,
    lastPayloadOf(state.panels[1])?.text?.hunks?.length,
  );
}

section('选择文件只加入一侧');
const pickPanel = state.panels[state.panels.length - 1];
await pickPanel.receive({ type: 'ready' });
state.openDialogHandler = () => [Uri.file(join(left, 'other.txt'))];
state.quickPickHandler = async (items) =>
  items.find((item) => item.label === '左侧' || item.label === 'Left');
await state.commands.get('diffCompare.pickTarget')();
await new Promise((resolve) => setTimeout(resolve, 200));
const pickPayload = lastPayloadOf(pickPanel);
check('选择对话框默认打开在工作区', state.openDialogCalls.length > 0);
check(
  '文件只加入了一侧',
  Boolean(pickPayload?.left?.path) !== Boolean(pickPayload?.right?.path),
  JSON.stringify({
    left: pickPayload?.left?.path,
    right: pickPayload?.right?.path,
  }),
);
state.openDialogHandler = undefined;
state.quickPickHandler = undefined;

section('双语资源');
const i18n = require(join(root, 'dist', 'i18n.js'));
const zh = i18n.tableFor('zh-cn');
const en = i18n.tableFor('en');
const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();
check(
  '中英文词条数量一致',
  zhKeys.length === enKeys.length,
  `中文 ${zhKeys.length} / 英文 ${enKeys.length}`,
);
check(
  '中英文词条完全对应',
  zhKeys.join('|') === enKeys.join('|'),
  zhKeys.filter((key) => !enKeys.includes(key)).join(', '),
);
check(
  '英文词条确实是英文',
  /^[A-Za-z]/.test(en['cmd.open']) && zh['cmd.open'] !== en['cmd.open'],
  en['cmd.open'],
);
check(
  '占位符可以替换',
  i18n.t('zh-cn', 'menu.panelItem', { n: 3, summary: 'a ↔ b' }).includes('3'),
  i18n.t('zh-cn', 'menu.panelItem', { n: 3, summary: 'a ↔ b' }),
);

section('清理');
rmSync(tmp, { recursive: true, force: true });
check('临时目录已清理', !existsSync(tmp));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nhost harness: all checks passed');
