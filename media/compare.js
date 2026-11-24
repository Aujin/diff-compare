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
    btnWorkspace: $('btn-workspace'),
    btnPick: $('btn-pick'),
    btnRefresh: $('btn-refresh'),
    btnSwap: $('btn-swap'),
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
    /** @type {{left?: HTMLElement, right?: HTMLElement, leftText?: HTMLElement, rightText?: HTMLElement}[]} */
    rows: [],
    /** @type {{left: string, right: string}[]} */
    searchText: [],
    /** @type {{row: number, side: string, start: number, end: number}[]} */
    matches: [],
    matchIndex: -1,
    rowHeight: ROW_H,
    busy: false,
  };

  // ---------------------------------------------------------------- helpers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
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
    ui.status.textContent = message || '就绪';
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
    placeholder.innerHTML =
      '把文件、目录或编辑器标签页拖到左右两栏即可开始比较。<br />' +
      '也可以使用工具栏的「工作区文件夹」「添加文件」按钮。';
    ui.leftRows.appendChild(placeholder);
  }

  function renderNotice(notice) {
    const placeholder = el('div', 'empty');
    placeholder.textContent = notice || '无法比较这两个目标。';
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
      const left = arrowButton('left', { type: 'syncHunk', hunkId: hunk.id }, '把右侧这一处同步到左侧');
      const right = arrowButton('right', { type: 'syncHunk', hunkId: hunk.id }, '把左侧这一处同步到右侧');
      addGutterItem(hunk.row, [left, right], hunk.kind === 'insert' ? '新增' : hunk.kind === 'delete' ? '删除' : '修改');
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

  function hexRow(node, offset, hex, mask) {
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
      const left = hexRow(null, row.lo, row.lb || '', row.mask);
      const right = hexRow(null, row.ro, row.rb || '', row.mask);
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
      const left = arrowButton('left', { type: 'syncRange', rangeId: range.id }, '把右侧这一段同步到左侧');
      const right = arrowButton('right', { type: 'syncRange', rangeId: range.id }, '把左侧这一段同步到右侧');
      const info = `${range.lEnd - range.lStart} / ${range.rEnd - range.rStart} 字节`;
      addGutterItem(range.row, [left, right], info);
    });
  }

  function renderFolder(payload) {
    const entries = payload.folder.entries;
    const fragLeft = document.createDocumentFragment();
    const fragRight = document.createDocumentFragment();

    entries.forEach((entry) => {
      const depth = entry.path.split('/').length - 1;
      const indent = '  '.repeat(depth);
      const label = indent + entry.path.split('/').pop() + (entry.type === 'dir' ? '/' : '');

      let leftClass = 'row';
      let rightClass = 'row';
      if (entry.status === 'only-right') {
        rightClass += ' r-ins';
        leftClass += ' r-void';
      } else if (entry.status === 'only-left') {
        leftClass += ' r-del';
        rightClass += ' r-void';
      } else if (entry.status === 'modified') {
        leftClass += ' r-chg left';
        rightClass += ' r-chg right';
      }
      if (entry.type === 'dir') {
        leftClass += ' r-dir';
        rightClass += ' r-dir';
      }

      const left = el('div', leftClass);
      const right = el('div', rightClass);
      const leftText = el('span', 'tx', entry.status === 'only-right' ? '' : label);
      const rightText = el('span', 'tx', entry.status === 'only-left' ? '' : label);
      left.appendChild(el('span', 'ln hidden', ''));
      right.appendChild(el('span', 'ln hidden', ''));
      left.appendChild(leftText);
      right.appendChild(rightText);

      if (entry.leftUri) {
        left.classList.add('clickable');
        left.title = '点击在编辑器中打开';
        left.addEventListener('click', () => vscode.postMessage({ type: 'openFile', uri: entry.leftUri }));
      }
      if (entry.rightUri) {
        right.classList.add('clickable');
        right.title = '点击在编辑器中打开';
        right.addEventListener('click', () => vscode.postMessage({ type: 'openFile', uri: entry.rightUri }));
      }

      fragLeft.appendChild(left);
      fragRight.appendChild(right);
      state.rows.push({ left: left, right: right, leftText: leftText, rightText: rightText });
      state.searchText.push({
        left: entry.status === 'only-right' ? '' : entry.path,
        right: entry.status === 'only-left' ? '' : entry.path,
      });
    });

    ui.leftRows.appendChild(fragLeft);
    ui.rightRows.appendChild(fragRight);
    measureRowHeight();

    entries.forEach((entry, index) => {
      if (entry.status === 'same') {
        return;
      }
      const left = arrowButton('left', { type: 'syncEntry', path: entry.path }, '把右侧这一项同步到左侧');
      const right = arrowButton('right', { type: 'syncEntry', path: entry.path }, '把左侧这一项同步到右侧');
      const statusText =
        entry.status === 'only-right' ? '仅右侧' : entry.status === 'only-left' ? '仅左侧' : '内容不同';
      addGutterItem(index, [left, right], statusText);
    });
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

    if (payload.left) {
      ui.leftTitle.textContent = payload.left.name + (payload.left.path ? ' · ' + payload.left.path : '');
      ui.leftTitle.title = payload.left.path || payload.left.name;
    }
    if (payload.right) {
      ui.rightTitle.textContent = payload.right.name + (payload.right.path ? ' · ' + payload.right.path : '');
      ui.rightTitle.title = payload.right.path || payload.right.name;
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
      ui.searchCount.textContent = ui.searchInput.value ? '无结果' : '';
      return;
    }
    ui.searchCount.textContent = `${state.matchIndex + 1} / ${state.matches.length}`;
  }

  function clearHighlights() {
    state.rows.forEach((row, index) => {
      const text = state.searchText[index] || { left: '', right: '' };
      if (row.leftText) {
        row.leftText.textContent = text.left;
      }
      if (row.rightText) {
        row.rightText.textContent = text.right;
      }
    });
  }

  function markUp(text, ranges) {
    let html = '';
    let cursor = 0;
    ranges.forEach((range) => {
      html += escapeHtml(text.slice(cursor, range.start));
      const isCurrent = state.matches[state.matchIndex] === range;
      html += '<mark' + (isCurrent ? ' class="current"' : '') + '>' + escapeHtml(text.slice(range.start, range.end)) + '</mark>';
      cursor = range.end;
    });
    html += escapeHtml(text.slice(cursor));
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
      const text = state.searchText[rowIndex];
      if (!row || !text) {
        return;
      }
      ['left', 'right'].forEach((side) => {
        const target = side === 'left' ? row.leftText : row.rightText;
        if (!target) {
          return;
        }
        const ranges = list.filter((match) => match.side === side);
        if (!ranges.length) {
          target.textContent = text[side];
          return;
        }
        target.innerHTML = markUp(text[side], ranges);
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
        const text = row[side] || '';
        if (!text) {
          return;
        }
        const lower = text.toLowerCase();
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

  ui.btnWorkspace.addEventListener('click', () => vscode.postMessage({ type: 'addWorkspaceFolder' }));
  ui.btnPick.addEventListener('click', () => vscode.postMessage({ type: 'pickTarget' }));
  ui.btnRefresh.addEventListener('click', () => {
    setStatus('正在重新比较…');
    vscode.postMessage({ type: 'refresh' });
  });
  ui.btnSwap.addEventListener('click', () => vscode.postMessage({ type: 'swap' }));
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
      if (action === 'active-left') {
        vscode.postMessage({ type: 'addActiveEditor', side: 'left' });
      } else if (action === 'active-right') {
        vscode.postMessage({ type: 'addActiveEditor', side: 'right' });
      } else if (action === 'pick-left') {
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
        setStatus('无法识别拖入的内容，请改用工具栏的「添加文件」按钮。', true);
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
        state.viewMode = message.viewMode;
        state.hasLeft = message.hasLeft;
        state.hasRight = message.hasRight;
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
    const message = event && event.message ? event.message : '未知错误';
    setStatus(`界面错误：${message}`, true);
    vscode.postMessage({ type: 'log', message: `webview error: ${message}` });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason ? String(event.reason) : '未知错误';
    setStatus(`界面错误：${reason}`, true);
    vscode.postMessage({ type: 'log', message: `webview rejection: ${reason}` });
  });

  updateModeButtons();
  updateButtons();
  vscode.postMessage({ type: 'ready' });
})();
