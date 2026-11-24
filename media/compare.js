// @ts-check
/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const ROW_H = 20;

  const $ = (id) => document.getElementById(id);

  const ARROW_LEFT =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3.5M7 4L3 8l4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  const ARROW_RIGHT =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9.5M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

  /** 当前语言的文案（由扩展端下发，缺失时回退到键名）。 */
  const strings = Object.create(null);

  /**
   * 取一条文案。
   *
   * @param {string} key 文案键
   * @param {string} [fallback] 没有下发这条文案时的备用文本
   * @param {Record<string, string | number>} [params] `{name}` 形式的占位符
   */
  function text(key, fallback, params) {
    let value = strings[key];
    if (value === undefined) {
      value = fallback === undefined ? key : fallback;
    }
    if (params) {
      value = value.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    }
    return value;
  }

  const ui = {
    leftTitle: $('title-left'),
    rightTitle: $('title-right'),
    leftRows: $('rows-left'),
    rightRows: $('rows-right'),
    leftBody: $('body-left'),
    rightBody: $('body-right'),
    gutterItems: $('gutter-items'),
    status: $('status'),
    searchBar: $('search-bar'),
    searchInput: $('search-input'),
    searchCount: $('search-count'),
    dropOverlay: $('drop-overlay'),
    btnNew: $('btn-new'),
    btnPick: $('btn-pick'),
    btnRefresh: $('btn-refresh'),
    btnSwap: $('btn-swap'),
    btnUndo: $('btn-undo'),
    btnClear: $('btn-clear'),
    btnFind: $('btn-find'),
    syncAllLeft: $('sync-all-left'),
    syncAllRight: $('sync-all-right'),
    modeButtons: Array.prototype.slice.call(document.querySelectorAll('.mode-btn')),
  };

  const state = {
    payload: null,
    viewMode: 'auto',
    hasLeft: false,
    hasRight: false,
    canUndo: false,
    /** @type {{left?: HTMLElement, right?: HTMLElement, leftText?: HTMLElement, rightText?: HTMLElement}[]} */
    rows: [],
    /** @type {{left: string, right: string}[]} */
    searchText: [],
    /** @type {{row: number, side: string, start: number, end: number}[]} */
    matches: [],
    matchIndex: -1,
    rowHeight: ROW_H,
    busy: false,
    /** 目录树里被折叠的目录（相对路径）。 */
    collapsed: new Set(),
    /** 已经出现过的目录，用来判断哪些目录是新出现的（默认折叠）。 */
    knownDirs: new Set(),
  };

  // ---------------------------------------------------------------- helpers

  function el(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (textContent !== undefined && textContent !== null) {
      node.textContent = textContent;
    }
    return node;
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(message, isError) {
    ui.status.textContent = message || text('status.ready', 'Ready');
    ui.status.classList.toggle('error', Boolean(isError));
  }

  function setBusy(busy) {
    state.busy = busy;
    ui.status.classList.toggle('busy', busy);
    updateButtons();
  }

  function updateButtons() {
    const both = state.hasLeft && state.hasRight;
    ui.syncAllLeft.disabled = !both || state.busy;
    ui.syncAllRight.disabled = !both || state.busy;
    ui.btnSwap.disabled = !(state.hasLeft || state.hasRight);
    ui.btnClear.disabled = !(state.hasLeft || state.hasRight);
    ui.btnUndo.disabled = !state.canUndo || state.busy;
  }

  function updateModeButtons() {
    ui.modeButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === state.viewMode);
    });
  }

  // ---------------------------------------------------------------- rendering

  function clearPanes() {
    ui.leftRows.textContent = '';
    ui.rightRows.textContent = '';
    ui.gutterItems.textContent = '';
    state.rows = [];
    state.searchText = [];
  }

  function sideClass(rowType, side) {
    if (rowType === 'eq') {
      return '';
    }
    if (side === 'left') {
      if (rowType === 'chg') {
        return 'r-chg left';
      }
      if (rowType === 'del') {
        return 'r-del';
      }
      return 'r-void';
    }
    if (rowType === 'chg') {
      return 'r-chg right';
    }
    if (rowType === 'ins') {
      return 'r-ins';
    }
    return 'r-void';
  }

  function renderEmpty() {
    const placeholder = el('div', 'empty');
    placeholder.innerHTML = text('status.empty', 'Drag a file, folder or editor tab into either column to start comparing.');
    ui.leftRows.appendChild(placeholder);
  }

  function renderNotice(notice) {
    const placeholder = el('div', 'empty');
    placeholder.textContent = notice || text('status.cannotCompare', 'These two targets cannot be compared.');
    ui.leftRows.appendChild(placeholder);
    setStatus(notice || '', true);
  }

  function renderText(payload) {
    const rows = payload.text.rows;
    const fragLeft = document.createDocumentFragment();
    const fragRight = document.createDocumentFragment();

    rows.forEach((row) => {
      const left = el('div', 'row ' + sideClass(row.t, 'left'));
      const right = el('div', 'row ' + sideClass(row.t, 'right'));

      const leftLine = el('span', 'ln' + (row.l ? '' : ' hidden'), row.l ? String(row.l[0]) : '');
      const leftText = el('span', 'tx', row.l ? row.l[1] : '');
      left.appendChild(leftLine);
      left.appendChild(leftText);

      const rightLine = el('span', 'ln' + (row.r ? '' : ' hidden'), row.r ? String(row.r[0]) : '');
      const rightText = el('span', 'tx', row.r ? row.r[1] : '');
      right.appendChild(rightLine);
      right.appendChild(rightText);

      fragLeft.appendChild(left);
      fragRight.appendChild(right);

      state.rows.push({ left: left, right: right, leftText: leftText, rightText: rightText });
      state.searchText.push({
        left: row.l ? row.l[1] : '',
        right: row.r ? row.r[1] : '',
      });
    });

    ui.leftRows.appendChild(fragLeft);
    ui.rightRows.appendChild(fragRight);
    measureRowHeight();

    payload.text.hunks.forEach((hunk) => {
      const left = arrowButton('left', { type: 'syncHunk', hunkId: hunk.id }, text('arrow.hunkLeft', 'Copy this difference to the left side'));
      const right = arrowButton('right', { type: 'syncHunk', hunkId: hunk.id }, text('arrow.hunkRight', 'Copy this difference to the right side'));
      const info =
        hunk.kind === 'insert'
          ? text('gutter.insert', 'Added')
          : hunk.kind === 'delete'
            ? text('gutter.delete', 'Removed')
            : text('gutter.change', 'Changed');
      addGutterItem(hunk.row, [left, right], info);
    });
  }

  function offsetHex(value) {
    return value.toString(16).toUpperCase().padStart(8, '0');
  }

  function asciiOf(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      const code = bytes.charCodeAt(i);
      out += code >= 32 && code < 127 ? bytes[i] : '.';
    }
    return out;
  }

  function hexRow(offset, hex, mask) {
    const row = el('div', 'row hex');
    row.appendChild(el('span', 'ln', offsetHex(offset)));
    const hexCell = el('span', 'tx hex');
    const bytes = hex ? hex.split(' ') : [];
    for (let i = 0; i < bytes.length; i += 1) {
      const differs = mask && mask.charAt(i) === '1';
      hexCell.appendChild(el('span', differs ? 'byte-diff' : 'byte-same', bytes[i]));
      hexCell.appendChild(document.createTextNode(' '));
    }
    row.appendChild(hexCell);
    row.appendChild(el('span', 'tx ascii', asciiOf(bytes.join(''))));
    return row;
  }

  function renderBinary(payload) {
    const binary = payload.binary;
    const isHex = payload.viewMode === 'hex';
    const rows = binary.rows;

    const affected = new Set();
    binary.ranges.forEach((range) => {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const leftHit = row.lo < range.lEnd && row.lo + 16 > range.lStart;
        const rightHit = row.ro < range.rEnd && row.ro + 16 > range.rStart;
        if (leftHit || rightHit) {
          affected.add(index);
        }
      }
    });

    const fragLeft = document.createDocumentFragment();
    const fragRight = document.createDocumentFragment();

    rows.forEach((row, index) => {
      if (!isHex && !affected.has(index)) {
        return;
      }
      const left = hexRow(row.lo, row.lb || '', row.mask);
      const right = hexRow(row.ro, row.rb || '', row.mask);
      fragLeft.appendChild(left);
      fragRight.appendChild(right);
      state.rows.push({ left: left, right: right });
      state.searchText.push({
        left: (row.lb || '') + ' ' + asciiOf(row.lb || ''),
        right: (row.rb || '') + ' ' + asciiOf(row.rb || ''),
      });
    });

    ui.leftRows.appendChild(fragLeft);
    ui.rightRows.appendChild(fragRight);
    measureRowHeight();

    binary.ranges.forEach((range) => {
      const left = arrowButton('left', { type: 'syncRange', rangeId: range.id }, text('arrow.rangeLeft', 'Copy these bytes to the left side'));
      const right = arrowButton('right', { type: 'syncRange', rangeId: range.id }, text('arrow.rangeRight', 'Copy these bytes to the right side'));
      const info = text('gutter.bytes', '{left} / {right} bytes', { left: range.lEnd - range.lStart, right: range.rEnd - range.rStart });
      addGutterItem(range.row, [left, right], info);
    });
  }

  // -------------------------------------------------------------- 目录树

  /**
   * 把扁平的条目列表变成目录树。
   *
   * @param {{path: string, type: string, status: string}[]} entries
   */
  function buildFolderTree(entries) {
    const root = { path: '', name: '', type: 'dir', status: 'same', entry: null, children: [], index: new Map() };
    root.index.set('', root);

    function ensureDir(dirPath) {
      const existing = root.index.get(dirPath);
      if (existing) {
        return existing;
      }
      const parts = dirPath.split('/');
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, parts.length - 1).join('/');
      const parent = ensureDir(parentPath);
      const dir = { path: dirPath, name: name, type: 'dir', status: 'same', entry: null, children: [] };
      parent.children.push(dir);
      root.index.set(dirPath, dir);
      return dir;
    }

    entries.forEach((entry) => {
      const parts = entry.path.split('/');
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, parts.length - 1).join('/');
      const parent = ensureDir(parentPath);
      if (entry.type === 'dir') {
        const dir = ensureDir(entry.path);
        dir.status = entry.status;
        dir.entry = entry;
      } else {
        parent.children.push({
          path: entry.path,
          name: name,
          type: entry.type,
          status: entry.status,
          entry: entry,
          children: [],
        });
      }
    });
    return root;
  }

  /** 展开后的可见条目（按顺序）。 */
  function visibleNodes(root) {
    const out = [];
    const walk = (node) => {
      node.children.forEach((child) => {
        out.push(child);
        if (child.type === 'dir' && !state.collapsed.has(child.path)) {
          walk(child);
        }
      });
    };
    walk(root);
    return out;
  }

  function collectDirPaths(root, out) {
    root.children.forEach((child) => {
      if (child.type === 'dir') {
        out.push(child.path);
        collectDirPaths(child, out);
      }
    });
    return out;
  }

  function renderFolder(payload) {
    const entries = payload.folder.entries;
    const root = buildFolderTree(entries);
    // 初始状态：新出现的目录默认折叠；用户手动展开过的目录保持展开。
    collectDirPaths(root, []).forEach((path) => {
      if (!state.knownDirs.has(path)) {
        state.knownDirs.add(path);
        state.collapsed.add(path);
      }
    });

    const nodes = visibleNodes(root);
    const fragLeft = document.createDocumentFragment();
    const fragRight = document.createDocumentFragment();

    nodes.forEach((node) => {
      const depth = node.path.split('/').length - 1;
      const isDir = node.type === 'dir';
      const collapsed = isDir && state.collapsed.has(node.path);

      let leftClass = 'row';
      let rightClass = 'row';
      if (node.status === 'only-right') {
        rightClass += ' r-ins';
        leftClass += ' r-void';
      } else if (node.status === 'only-left') {
        leftClass += ' r-del';
        rightClass += ' r-void';
      } else if (node.status === 'modified') {
        leftClass += ' r-chg left';
        rightClass += ' r-chg right';
      }
      if (isDir) {
        leftClass += ' r-dir';
        rightClass += ' r-dir';
      }

      const left = el('div', leftClass);
      const right = el('div', rightClass);
      const leftLabel = el('span', 'tx');
      const rightLabel = el('span', 'tx');
      const leftText = el('span', 'tree-name', node.name);
      const rightText = el('span', 'tree-name', node.name);

      const buildLabel = (label, target) => {
        const indent = el('span', 'indent', '');
        indent.style.width = depth * 14 + 'px';
        label.appendChild(indent);
        if (isDir) {
          const toggle = el('span', 'tree-toggle', collapsed ? '▶' : '▼');
          toggle.title = collapsed ? text('folder.expand', 'Expand') : text('folder.collapse', 'Collapse');
          toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleDirectory(node.path);
          });
          label.appendChild(toggle);
        }
        label.appendChild(target);
      };

      buildLabel(leftLabel, leftText);
      buildLabel(rightLabel, rightText);

      left.appendChild(el('span', 'ln hidden', ''));
      right.appendChild(el('span', 'ln hidden', ''));
      left.appendChild(leftLabel);
      right.appendChild(rightLabel);

      const entry = node.entry;
      if (entry && entry.leftUri) {
        left.classList.add('clickable');
        left.title = text('openInEditor', 'Click to open in the editor');
        left.addEventListener('click', () => vscode.postMessage({ type: 'openFile', uri: entry.leftUri }));
      }
      if (entry && entry.rightUri) {
        right.classList.add('clickable');
        right.title = text('openInEditor', 'Click to open in the editor');
        right.addEventListener('click', () => vscode.postMessage({ type: 'openFile', uri: entry.rightUri }));
      }

      fragLeft.appendChild(left);
      fragRight.appendChild(right);
      state.rows.push({ left: left, right: right, leftText: leftText, rightText: rightText });
      state.searchText.push({
        left: node.status === 'only-right' ? '' : node.name,
        right: node.status === 'only-left' ? '' : node.name,
      });
    });

    ui.leftRows.appendChild(fragLeft);
    ui.rightRows.appendChild(fragRight);
    measureRowHeight();

    nodes.forEach((node, index) => {
      if (node.status === 'same') {
        return;
      }
      const left = arrowButton('left', { type: 'syncEntry', path: node.path }, text('arrow.entryLeft', 'Copy this entry to the left side'));
      const right = arrowButton('right', { type: 'syncEntry', path: node.path }, text('arrow.entryRight', 'Copy this entry to the right side'));
      const statusText =
        node.status === 'only-right'
          ? text('gutter.onlyRight', 'Right only')
          : node.status === 'only-left'
            ? text('gutter.onlyLeft', 'Left only')
            : text('gutter.different', 'Different');
      addGutterItem(index, [left, right], statusText);
    });
  }

  /** 展开 / 折叠一个目录，然后重新渲染目录视图。 */
  function toggleDirectory(path) {
    if (state.collapsed.has(path)) {
      state.collapsed.delete(path);
    } else {
      state.collapsed.add(path);
    }
    if (state.payload && state.payload.kind === 'folder') {
      render(state.payload);
    }
  }

  function measureRowHeight() {
    const first = ui.leftRows.querySelector('.row');
    if (first) {
      const height = first.getBoundingClientRect().height;
      if (height > 0) {
        state.rowHeight = height;
      }
    }
  }

  function arrowButton(target, message, title) {
    const button = el('button', 'arrow');
    button.title = title;
    button.innerHTML = target === 'left' ? ARROW_LEFT : ARROW_RIGHT;
    button.addEventListener('click', () => {
      const payload = Object.assign({ target: target }, message);
      vscode.postMessage(payload);
    });
    return button;
  }

  function addGutterItem(rowIndex, buttons, info) {
    const item = el('div', 'gutter-item');
    item.style.top = rowIndex * state.rowHeight + 'px';
    if (info) {
      item.appendChild(el('span', 'gutter-info', info));
    }
    buttons.forEach((button) => item.appendChild(button));
    ui.gutterItems.appendChild(item);
  }

  function render(payload) {
    state.payload = payload;
    clearPanes();
    state.matches = [];
    state.matchIndex = -1;

    // 标题始终按当前两侧的内容更新（只有一侧时也能看到文件名）。
    ui.leftTitle.textContent =
      payload && payload.left
        ? payload.left.name + (payload.left.path ? ' · ' + payload.left.path : '')
        : text('pane.notSelected', 'Not selected');
    ui.leftTitle.title =
      payload && payload.left ? payload.left.path || payload.left.name : '';
    ui.rightTitle.textContent =
      payload && payload.right
        ? payload.right.name + (payload.right.path ? ' · ' + payload.right.path : '')
        : text('pane.notSelected', 'Not selected');
    ui.rightTitle.title =
      payload && payload.right ? payload.right.path || payload.right.name : '';

    if (!payload || payload.kind === 'none') {
      renderEmpty();
      updateSearchCount();
      return;
    }
    if (payload.kind === 'mismatch') {
      renderNotice(payload.notice);
      updateSearchCount();
      return;
    }
    if (payload.kind === 'folder') {
      renderFolder(payload);
    } else if (payload.viewMode === 'text' && payload.text) {
      renderText(payload);
    } else if (payload.binary) {
      renderBinary(payload);
    } else if (payload.text) {
      renderText(payload);
    }

    updateSearchCount();
  }

  // ---------------------------------------------------------------- scrolling

  let scrollLock = false;
  function linkScroll(source) {
    if (scrollLock) {
      return;
    }
    scrollLock = true;
    const top = source.scrollTop;
    if (source !== ui.leftBody) {
      ui.leftBody.scrollTop = top;
    }
    if (source !== ui.rightBody) {
      ui.rightBody.scrollTop = top;
    }
    ui.gutterItems.style.transform = 'translateY(' + -top + 'px)';
    window.requestAnimationFrame(() => {
      scrollLock = false;
    });
  }

  ui.leftBody.addEventListener('scroll', () => linkScroll(ui.leftBody));
  ui.rightBody.addEventListener('scroll', () => linkScroll(ui.rightBody));

  // ---------------------------------------------------------------- search

  function openSearch() {
    ui.searchBar.hidden = false;
    ui.searchInput.focus();
    ui.searchInput.select();
  }

  function closeSearch() {
    ui.searchBar.hidden = true;
    ui.searchInput.value = '';
    state.matches = [];
    state.matchIndex = -1;
    clearHighlights();
    updateSearchCount();
  }

  function updateSearchCount() {
    if (ui.searchBar.hidden) {
      ui.searchCount.textContent = '';
      return;
    }
    if (!state.matches.length) {
      ui.searchCount.textContent = ui.searchInput.value ? text('search.noResult', 'No results') : '';
      return;
    }
    ui.searchCount.textContent = `${state.matchIndex + 1} / ${state.matches.length}`;
  }

  function clearHighlights() {
    state.rows.forEach((row, index) => {
      const value = state.searchText[index] || { left: '', right: '' };
      if (row.leftText) {
        row.leftText.textContent = value.left;
      }
      if (row.rightText) {
        row.rightText.textContent = value.right;
      }
    });
  }

  function markUp(value, ranges) {
    let html = '';
    let cursor = 0;
    ranges.forEach((range) => {
      html += escapeHtml(value.slice(cursor, range.start));
      const isCurrent = state.matches[state.matchIndex] === range;
      html += '<mark' + (isCurrent ? ' class="current"' : '') + '>' + escapeHtml(value.slice(range.start, range.end)) + '</mark>';
      cursor = range.end;
    });
    html += escapeHtml(value.slice(cursor));
    return html;
  }

  function applyHighlights() {
    const byRow = new Map();
    state.matches.forEach((match) => {
      if (!byRow.has(match.row)) {
        byRow.set(match.row, []);
      }
      byRow.get(match.row).push(match);
    });
    byRow.forEach((list, rowIndex) => {
      const row = state.rows[rowIndex];
      const value = state.searchText[rowIndex];
      if (!row || !value) {
        return;
      }
      ['left', 'right'].forEach((side) => {
        const target = side === 'left' ? row.leftText : row.rightText;
        if (!target) {
          return;
        }
        const ranges = list.filter((match) => match.side === side);
        if (!ranges.length) {
          target.textContent = value[side];
          return;
        }
        target.innerHTML = markUp(value[side], ranges);
      });
    });
  }

  function runSearch() {
    const query = ui.searchInput.value;
    state.matches = [];
    state.matchIndex = -1;
    clearHighlights();
    if (!query) {
      updateSearchCount();
      return;
    }
    const needle = query.toLowerCase();
    state.searchText.forEach((row, index) => {
      ['left', 'right'].forEach((side) => {
        const value = row[side] || '';
        if (!value) {
          return;
        }
        const lower = value.toLowerCase();
        let pos = lower.indexOf(needle);
        while (pos !== -1) {
          state.matches.push({ row: index, side: side, start: pos, end: pos + needle.length });
          pos = lower.indexOf(needle, pos + needle.length);
        }
      });
    });
    applyHighlights();
    if (state.matches.length) {
      state.matchIndex = 0;
      applyHighlights();
      focusMatch();
    }
    updateSearchCount();
  }

  function focusMatch() {
    const match = state.matches[state.matchIndex];
    if (!match) {
      return;
    }
    const row = state.rows[match.row];
    if (!row) {
      return;
    }
    const target = match.side === 'left' ? row.left : row.right;
    const body = match.side === 'left' ? ui.leftBody : ui.rightBody;
    if (!target || !body) {
      return;
    }
    body.scrollTop = Math.max(0, target.offsetTop - body.clientHeight / 2 + target.offsetHeight / 2);
  }

  function nextMatch(delta) {
    if (!state.matches.length) {
      return;
    }
    state.matchIndex = (state.matchIndex + delta + state.matches.length) % state.matches.length;
    applyHighlights();
    focusMatch();
    updateSearchCount();
  }

  ui.searchInput.addEventListener('input', () => {
    window.clearTimeout(ui.searchInput._timer);
    ui.searchInput._timer = window.setTimeout(runSearch, 120);
  });
  ui.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      nextMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  });
  $('search-next').addEventListener('click', () => nextMatch(1));
  $('search-prev').addEventListener('click', () => nextMatch(-1));
  $('search-close').addEventListener('click', () => closeSearch());

  // ---------------------------------------------------------------- toolbar

  ui.btnNew.addEventListener('click', () => vscode.postMessage({ type: 'newPanel' }));
  ui.btnPick.addEventListener('click', () => vscode.postMessage({ type: 'pickTarget' }));
  ui.btnRefresh.addEventListener('click', () => {
    setStatus(text('status.reloading', 'Comparing again...'));
    vscode.postMessage({ type: 'refresh' });
  });
  ui.btnSwap.addEventListener('click', () => vscode.postMessage({ type: 'swap' }));
  ui.btnUndo.addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
  ui.btnClear.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  ui.btnFind.addEventListener('click', () => openSearch());
  ui.syncAllLeft.addEventListener('click', () => vscode.postMessage({ type: 'syncAll', target: 'left' }));
  ui.syncAllRight.addEventListener('click', () => vscode.postMessage({ type: 'syncAll', target: 'right' }));
  ui.modeButtons.forEach((button) => {
    button.addEventListener('click', () => vscode.postMessage({ type: 'setViewMode', mode: button.dataset.mode }));
  });

  Array.prototype.forEach.call(document.querySelectorAll('.mini'), (button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (action === 'pick-left') {
        vscode.postMessage({ type: 'pickTarget', side: 'left' });
      } else if (action === 'pick-right') {
        vscode.postMessage({ type: 'pickTarget', side: 'right' });
      } else if (action === 'clear-left') {
        vscode.postMessage({ type: 'clear', side: 'left' });
      } else if (action === 'clear-right') {
        vscode.postMessage({ type: 'clear', side: 'right' });
      }
    });
  });

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'f') {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === 'F3') {
      event.preventDefault();
      nextMatch(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Escape' && !ui.searchBar.hidden) {
      event.preventDefault();
      closeSearch();
    }
  });

  // ---------------------------------------------------------------- drag & drop

  function extractUris(dataTransfer) {
    const uris = [];
    try {
      const meta = dataTransfer.getData('application/vnd.code.copyMetadata');
      if (meta) {
        const parsed = JSON.parse(meta);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        list.forEach((item) => {
          if (item && typeof item.uri === 'string') {
            uris.push(item.uri);
          } else if (typeof item === 'string') {
            uris.push(item);
          }
        });
      }
    } catch (error) {
      // ignore malformed metadata
    }
    if (!uris.length) {
      const list = dataTransfer.getData('text/uri-list');
      if (list) {
        list.split(/\r?\n/).forEach((line) => {
          const value = line.trim();
          if (value && value.charAt(0) !== '#') {
            uris.push(value);
          }
        });
      }
    }
    return uris;
  }

  function wireDropTarget(body, side) {
    body.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      body.classList.add('drag-over');
    });
    body.addEventListener('dragleave', () => {
      body.classList.remove('drag-over');
    });
    body.addEventListener('drop', (event) => {
      event.preventDefault();
      body.classList.remove('drag-over');
      const uris = extractUris(event.dataTransfer || { getData: function () { return ''; } });
      if (!uris.length) {
        setStatus(text('status.dropFailed', 'Cannot read the dropped content.'), true);
        return;
      }
      vscode.postMessage({ type: 'drop', side: side, uris: uris });
    });
  }

  wireDropTarget(ui.leftBody, 'left');
  wireDropTarget(ui.rightBody, 'right');

  document.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
  });

  // ---------------------------------------------------------------- messages

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || !message.type) {
      return;
    }
    switch (message.type) {
      case 'comparison':
        render(message.payload);
        break;
      case 'state':
        if (message.strings) {
          Object.keys(message.strings).forEach((key) => {
            strings[key] = message.strings[key];
          });
        }
        state.viewMode = message.viewMode;
        state.hasLeft = message.hasLeft;
        state.hasRight = message.hasRight;
        state.canUndo = Boolean(message.canUndo);
        updateModeButtons();
        updateButtons();
        break;
      case 'error':
        setStatus(message.message, true);
        break;
      case 'info':
        setStatus(message.message);
        break;
      case 'busy':
        setBusy(message.busy);
        break;
      case 'focusSearch':
        openSearch();
        break;
      default:
        break;
    }
  });

  window.addEventListener('error', (event) => {
    const message = event && event.message ? event.message : 'unknown error';
    setStatus(text('status.uiError', 'Interface error').replace('{message}', message), true);
    vscode.postMessage({ type: 'log', message: `webview error: ${message}` });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason ? String(event.reason) : 'unknown error';
    setStatus(text('status.uiError', 'Interface error').replace('{message}', reason), true);
    vscode.postMessage({ type: 'log', message: `webview rejection: ${reason}` });
  });

  updateModeButtons();
  updateButtons();
  vscode.postMessage({ type: 'ready' });
})();
