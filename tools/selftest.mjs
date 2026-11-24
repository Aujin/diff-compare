/**
 * Self test for the pure engine parts (diff / text / binary / dirs / sync).
 *
 * Run after a build:  node tools/selftest.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { diffLines, buildRows } = require(join(root, 'dist', 'diff.js'));
const { decodeText, isBinary, splitLines, joinLines } = require(join(root, 'dist', 'text.js'));
const { diffBytes, buildHexRows } = require(join(root, 'dist', 'binary.js'));
const { compareDirectories } = require(join(root, 'dist', 'dirs.js'));
const { applyHunks, applyFolderAll, hunkIsDestructive } = require(join(root, 'dist', 'sync.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}
function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

console.log('diff');
{
  const left = ['a', 'b', 'c', 'd'];
  const right = ['a', 'x', 'c', 'd', 'e'];
  const ops = diffLines(left, right);
  equal('ops for replace+insert', ops.map((op) => op.type), ['equal', 'delete', 'insert', 'equal', 'insert']);
  const built = buildRows(left, right, ops);
  equal('row types', built.rows.map((row) => row.t), ['eq', 'chg', 'eq', 'eq', 'ins']);
  check('changed row has both sides', built.rows[1].l !== undefined && built.rows[1].r !== undefined);
  check('inserted row has no left side', built.rows[4].l === undefined && built.rows[4].r !== undefined);
  check('hunk count', built.hunks.length === 2, JSON.stringify(built.hunks));
  equal('hunk 1 shape', {
    kind: built.hunks[0].kind,
    lBefore: built.hunks[0].lBefore,
    lCount: built.hunks[0].lCount,
    rBefore: built.hunks[0].rBefore,
    rCount: built.hunks[0].rCount,
  }, { kind: 'change', lBefore: 1, lCount: 1, rBefore: 1, rCount: 1 });
}

console.log('text');
{
  const decoded = decodeText(Buffer.from('\uFEFFhello\r\nworld\r\n', 'utf8'));
  check('bom detected', decoded.bom);
  equal('eol detected', decoded.eol, '\r\n');
  equal('trailing newline', decoded.trailingNewline, true);
  const split = splitLines('a\nb\n');
  equal('split lines', split.lines, ['a', 'b']);
  equal('join round trip', joinLines(split.lines, split.eol, split.trailingNewline), 'a\nb\n');
  check('binary detected', isBinary(Buffer.from([0x00, 0x01, 0x02])));
  check('text not binary', !isBinary(Buffer.from('hello world', 'utf8')));
}

console.log('binary');
{
  const left = Buffer.from('ABCDEFGHIJKLMNOP');
  const right = Buffer.from('ABCDEFGXHIJKLMNOP');
  const changes = diffBytes(left, right);
  check('byte change found', changes.length >= 1, JSON.stringify(changes));
  const built = buildHexRows(left, right, changes);
  equal('row count', built.rows.length, 2);
  const mask = built.rows[0].mask ?? '';
  check('mask marks byte 7', mask[7] === '1', `mask=${mask}`);
  check('mask keeps other bytes', mask.slice(0, 7).split('').every((flag) => flag === '0'), `mask=${mask}`);
  check('range present', built.ranges.length >= 1);
}

const workdir = mkdtempSync(join(tmpdir(), 'diffcompare-'));
try {
  console.log('dirs');
  const leftRoot = join(workdir, 'left');
  const rightRoot = join(workdir, 'right');
  mkdirSync(join(leftRoot, 'sub'), { recursive: true });
  mkdirSync(join(rightRoot, 'sub'), { recursive: true });
  writeFileSync(join(leftRoot, 'same.txt'), 'same\n');
  writeFileSync(join(rightRoot, 'same.txt'), 'same\n');
  writeFileSync(join(leftRoot, 'only-left.txt'), 'left\n');
  writeFileSync(join(rightRoot, 'only-right.txt'), 'right\n');
  writeFileSync(join(leftRoot, 'sub', 'changed.txt'), 'one\n');
  writeFileSync(join(rightRoot, 'sub', 'changed.txt'), 'two\n');
  const result = await compareDirectories(leftRoot, rightRoot, {
    exclude: [],
    maxFileSize: 1024 * 1024,
    maxEntries: 1000,
  });
  const byPath = Object.fromEntries(result.entries.map((entry) => [entry.path, entry.status]));
  equal('same.txt', byPath['same.txt'], 'same');
  equal('only-left.txt', byPath['only-left.txt'], 'only-left');
  equal('only-right.txt', byPath['only-right.txt'], 'only-right');
  equal('sub/changed.txt', byPath['sub/changed.txt'], 'modified');
  equal('sub status propagated', byPath['sub'], 'modified');

  console.log('sync');
  const leftText = 'line1\nline2\nline3\n';
  const rightText = 'line1\nCHANGED\nline3\nline4\n';
  const leftFile = join(workdir, 'sync-left.txt');
  const rightFile = join(workdir, 'sync-right.txt');
  writeFileSync(leftFile, leftText);
  writeFileSync(rightFile, rightText);
  const lines = (text) => splitLines(text).lines;
  const ops = diffLines(lines(leftText), lines(rightText));
  const built = buildRows(lines(leftText), lines(rightText), ops);
  await applyHunks(leftFile, rightFile, built.hunks, 'left');
  equal('hunk sync result', readFileSync(leftFile, 'utf8'), 'line1\nCHANGED\nline3\nline4\n');

  const destructive = built.hunks.filter((hunk) => hunk.kind === 'delete');
  check('no delete hunk in this sample', destructive.length === 0, JSON.stringify(built.hunks));
  check('destructive detection works', typeof hunkIsDestructive(built.hunks, 'left') === 'boolean');

  // A real deletion must be reported as destructive.
  const delLeft = 'a\nb\nc\n';
  const delRight = 'a\nc\n';
  const delOps = diffLines(lines(delLeft), lines(delRight));
  const delBuilt = buildRows(lines(delLeft), lines(delRight), delOps);
  check('delete hunk detected', delBuilt.hunks.some((hunk) => hunk.kind === 'delete'), JSON.stringify(delBuilt.hunks));
  check('delete is destructive', hunkIsDestructive(delBuilt.hunks, 'left') === true);
  check('change is not destructive', hunkIsDestructive(built.hunks, 'left') === false);
  const delFile = join(workdir, 'delete-left.txt');
  writeFileSync(delFile, delLeft);
  await applyHunks(delFile, join(workdir, 'sync-right.txt'), delBuilt.hunks, 'left');
  equal('delete synced', readFileSync(delFile, 'utf8'), 'a\nc\n');

  console.log('folder sync');
  await applyFolderAll(leftRoot, rightRoot, result.entries, 'left');
  check('only-right copied to left', existsSync(join(leftRoot, 'only-right.txt')));
  check('only-left deleted from left', !existsSync(join(leftRoot, 'only-left.txt')));
  equal('modified file synced', readFileSync(join(leftRoot, 'sub', 'changed.txt'), 'utf8'), 'two\n');
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
