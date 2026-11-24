#!/usr/bin/env node
// Cross-checks the host <-> webview contract:
//   1. every message type the webview posts exists in the HostMessage union;
//   2. every message type the host posts exists in the WebviewMessage union;
//   3. every element id the webview looks up exists in the generated HTML.
//
// Run: node tools/check-protocol.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel) => readFileSync(join(root, rel), 'utf8');

const types = read('src/types.ts');
const webviewJs = read('media/compare.js');
const panelTs = read('src/comparePanel.ts');
const htmlTs = read('src/webviewHtml.ts');
const css = read('media/compare.css');

const failures = [];

function unionTypes(name) {
  const start = types.indexOf(`export type ${name} =`);
  if (start < 0) {
    failures.push(`types.ts: cannot find union ${name}`);
    return new Set();
  }
  const end = types.indexOf('\n\nexport ', start);
  const body = types.slice(start, end < 0 ? undefined : end);
  const found = new Set();
  for (const match of body.matchAll(/type:\s*'([a-zA-Z]+)'/g)) {
    found.add(match[1]);
  }
  return found;
}

const hostTypes = unionTypes('HostMessage');
const webviewTypes = unionTypes('WebviewMessage');

function postedTypes(source) {
  const found = new Set();
  for (const match of source.matchAll(/postMessage\(\{\s*type:\s*'([a-zA-Z]+)'/g)) {
    found.add(match[1]);
  }
  return found;
}

for (const type of postedTypes(webviewJs)) {
  if (!hostTypes.has(type)) {
    failures.push(`compare.js posts "${type}" but HostMessage has no such member`);
  }
}

for (const type of postedTypes(panelTs)) {
  if (!webviewTypes.has(type)) {
    failures.push(`comparePanel.ts posts "${type}" but WebviewMessage has no such member`);
  }
}

// Every id the webview queries must exist in the HTML shell.
const htmlIds = new Set();
for (const match of htmlTs.matchAll(/\bid="([^"]+)"/g)) {
  htmlIds.add(match[1]);
}
for (const match of htmlTs.matchAll(/data-mode="([^"]+)"/g)) {
  htmlIds.add(`[data-mode=${match[1]}]`);
}
for (const match of htmlTs.matchAll(/data-action="([^"]+)"/g)) {
  htmlIds.add(`[data-action=${match[1]}]`);
}

const usedIds = new Set();
for (const match of webviewJs.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
  usedIds.add(match[1]);
}
for (const match of webviewJs.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'\s*\)/g)) {
  usedIds.add(match[1]);
}
for (const match of webviewJs.matchAll(/querySelectorAll\(\s*'\.([A-Za-z0-9_-]+)'\s*\)/g)) {
  usedIds.add(`.${match[1]}`);
}
for (const match of webviewJs.matchAll(/querySelector\(\s*'\.([A-Za-z0-9_-]+)'\s*\)/g)) {
  usedIds.add(`.${match[1]}`);
}

const classToId = new Set();
for (const id of htmlIds) {
  if (!id.startsWith('[')) {
    classToId.add(id);
  }
}
for (const id of usedIds) {
  if (id.startsWith('.')) {
    // Class selectors may target nodes the webview creates at runtime (`el('div', 'row …')`),
    // so accept a match in the HTML shell, in the script, or in the stylesheet.
    const name = id.slice(1);
    const pattern = new RegExp(`['"\`][^'"\`]*\\b${name}\\b[^'"\`]*['"\`]`);
    if (!pattern.test(htmlTs) && !pattern.test(webviewJs) && !pattern.test(css)) {
      failures.push(`compare.js uses ".${name}" but neither the HTML, the script nor the CSS defines it`);
    }
    continue;
  }
  if (id.startsWith('[')) {
    if (!htmlIds.has(id)) {
      failures.push(`compare.js uses "${id}" but the HTML has no such element`);
    }
    continue;
  }
  if (!htmlIds.has(id)) {
    failures.push(`compare.js uses #${id} but the HTML has no such id`);
  }
}

// ---------------------------------------------------------------- i18n

const packageJson = JSON.parse(read('package.json'));
const nlsDefault = JSON.parse(read('package.nls.json'));
const nlsZh = JSON.parse(read('package.nls.zh-cn.json'));

// Every "%key%" placeholder in package.json needs an entry in both nls files.
const nlsRefs = new Set();
for (const match of JSON.stringify(packageJson).matchAll(/"%([a-zA-Z][a-zA-Z0-9_.]*)%"/g)) {
  nlsRefs.add(match[1]);
}
for (const key of nlsRefs) {
  if (!(key in nlsDefault)) {
    failures.push(`package.json references %${key}% but package.nls.json has no such key`);
  }
  if (!(key in nlsZh)) {
    failures.push(`package.json references %${key}% but package.nls.zh-cn.json has no such key`);
  }
}
const nlsDefaultKeys = Object.keys(nlsDefault).sort();
const nlsZhKeys = Object.keys(nlsZh).sort();
if (nlsDefaultKeys.join('|') !== nlsZhKeys.join('|')) {
  failures.push('package.nls.json and package.nls.zh-cn.json do not have the same keys');
}

// Every key used in the code must exist in the i18n tables.
const i18nSource = read('src/i18n.ts');
const definedKeys = new Set();
for (const match of i18nSource.matchAll(/'([a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*)'\s*:/g)) {
  definedKeys.add(match[1]);
}
const usedKeys = new Set();
for (const source of [panelTs, read('src/extension.ts'), webviewJs]) {
  for (const match of source.matchAll(/\btext\(\s*'([a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*)'/g)) {
    usedKeys.add(match[1]);
  }
}
for (const key of usedKeys) {
  if (!definedKeys.has(key)) {
    failures.push(`the code uses the i18n key "${key}" but src/i18n.ts does not define it`);
  }
}

if (failures.length > 0) {
  console.error('protocol check failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('protocol check ok');
console.log(`  host messages : ${[...hostTypes].join(', ')}`);
console.log(`  webview messages: ${[...webviewTypes].join(', ')}`);
console.log(`  html ids checked: ${htmlIds.size}`);
console.log(`  nls keys checked: ${nlsRefs.size} (package.json) / ${definedKeys.size} (src/i18n.ts)`);
