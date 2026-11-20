import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
// Render the real components with the installed React packages. Effects and
// native IPC do not run during server rendering.
function loadComponent(filename) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.require = (id) => {
    if (!id.startsWith('.')) return require(id);
    const target = resolve(dirname(filename), id);
    return loadComponent(existsSync(`${target}.tsx`) ? `${target}.tsx` : `${target}.ts`);
  };
  mod._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}
const { default: ActionsPane } = loadComponent(fileURLToPath(new URL('../src/ActionsPane.tsx', import.meta.url)));
const noop = () => {};
const actions = ['Idle task', 'Running task', 'Success task', 'Failed task'].map((name, i) => ({
  id: `a${i}`, name, directory: '.', command: `printf '${name}'`,
}));
const props = {
  actions, selected: 'a1', now: 300000, busy: new Set(), configBusy: false, bashAvailable: true,
  runtimes: [
    { id: 'a1', status: 'running', startedAt: 1000, endedAt: null, exitCode: null, error: null },
    { id: 'a2', status: 'success', startedAt: 1000, endedAt: 62000, exitCode: 0, error: null },
    { id: 'a3', status: 'failed', startedAt: null, endedAt: 62000, exitCode: null, error: 'Directory does not exist' },
  ],
  onSelect: noop, onRun: noop, onStop: noop, onAdd: noop, onEdit: noop,
  onDuplicate: noop, onDelete: noop, onError: noop,
};
const render = (overrides = {}) => renderToStaticMarkup(React.createElement(ActionsPane, { ...props, ...overrides }));
const button = (html, label) => {
  const tag = html.match(/<button\b[^>]*>/g)?.find((s) => s.includes(`aria-label="${label}"`));
  assert.ok(tag, `Missing button: ${label}`);
  return tag;
};

test('actions expose all statuses, fixed completed elapsed time, exit code and errors', () => {
  const html = render();
  for (const status of ['Idle', 'Running', 'Success', 'Failed']) assert.ok(html.includes(`</i>${status}`));
  assert.ok(html.includes('1m 1s'), 'Completed elapsed time uses its end timestamp');
  assert.ok(html.includes('4m 59s'), 'Running elapsed time uses the current clock');
  assert.ok(html.includes('Exit 0'));
  assert.ok(html.includes('Directory does not exist'));
  assert.ok(html.includes('aria-label="Action output"'));
  assert.ok(html.includes('512 KB retained per action'));
});

test('running actions expose Stop, prevent editing and allow duplication', () => {
  const html = render();
  assert.ok(!html.includes('aria-label="Run Running task"'));
  assert.ok(!button(html, 'Stop Running task').includes('disabled'));
  assert.ok(button(html, 'Edit Running task').includes('disabled'));
  assert.ok(!button(html, 'Duplicate Running task').includes('disabled'));
  assert.ok(!button(html, 'Delete Running task').includes('disabled'));
  assert.ok(!button(html, 'Run Idle task').includes('disabled'));
});

test('Git Bash detection and pending operations gate launches without hiding saved actions', () => {
  assert.ok(button(render({ bashAvailable: false }), 'Run Idle task').includes('disabled'));
  assert.ok(!button(render({ bashAvailable: false }), 'Stop Running task').includes('disabled'));
  assert.ok(button(render({ busy: new Set(['a0']) }), 'Run Idle task').includes('disabled'));
  const html = render({ configBusy: true });
  assert.ok(button(html, 'Duplicate Idle task').includes('disabled'));
  assert.ok(button(html, 'Delete Idle task').includes('disabled'));
});

test('empty projects provide a direct path to save the first action', () => {
  const html = render({ actions: [], runtimes: [], selected: '' });
  assert.ok(html.includes('Add your first action'));
  assert.ok(!html.includes('aria-label="Action output"'));
});
