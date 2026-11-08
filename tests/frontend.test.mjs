import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const load = async (file) =>
  import(
    'data:text/javascript;base64,' +
      Buffer.from(
        ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      ).toString('base64')
  );
const { folderName, stripAnsi, boundLogs, terminalInputChunks } = await load('../src/utils.ts');
const { uptime } = await load('../src/types.ts');
test('Windows and Unix folder names, including roots and trailing separators', () => {
  assert.equal(folderName('C:\\Projects\\my app\\'), 'my app');
  assert.equal(folderName('/c/projects/api/'), 'api');
  assert.equal(folderName('C:\\'), 'C:');
});
test('ANSI text excludes color, OSC hyperlinks, and CR controls', () => {
  assert.equal(stripAnsi('\x1b[32mready\x1b[0m\r\n'), 'ready\n');
  assert.equal(stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), 'link');
  assert.equal(stripAnsi('\x1b]0;title\x1b\\output'), 'output');
  assert.equal(stripAnsi('\x1b]0;first\x1b\\keep me\x1b]0;second\x1b\\'), 'keep me');
});

test('large terminal pastes preserve Unicode at IPC boundaries', () => {
  const input = 'x'.repeat(15999) + '🚀' + '你好'.repeat(20000);
  const chunks = [...terminalInputChunks(input)];
  assert.equal(chunks.join(''), input);
  for (const chunk of chunks) {
    assert.ok(new TextEncoder().encode(chunk).length <= 65536);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk));
  }
});
test('retains newest service logs within memory and entry budgets', () => {
  const logs = Array.from({ length: 5000 }, (_, seq) => ({
    seq,
    timestamp: 0,
    stream: 'stdout',
    text: 'a'.repeat(512),
  }));
  const bounded = boundLogs(logs);
  assert.equal(bounded.at(-1).seq, 4999);
  assert.ok(bounded.length <= 4000);
  assert.ok(bounded.reduce((n, l) => n + l.text.length * 2, 0) <= 512 * 1024);
});
test('uptime handles stopped services, clocks, minutes, and hours', () => {
  assert.equal(uptime(null, 10000), '—');
  assert.equal(uptime(2000, 1000), '0s');
  assert.equal(uptime(1000, 62000), '1m 1s');
  assert.equal(uptime(1000, 3662000), '1h 1m');
});
