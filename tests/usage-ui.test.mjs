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
const providers = [
  { id: 'codex', name: 'OpenAI Codex', source: 'Codex app-server' },
  { id: 'claude', name: 'Claude Code', source: 'Claude Code status line' },
  { id: 'future', name: 'Future Provider', source: 'Future source' },
];
const settings = { tracking: {}, providers, alerts: [80], codexExecutable: '', codexHome: '', claudeHome: '', claudeSnapshot: '' };
const report = () => ({
  refreshedAt: Date.now(),
  providers: providers.map(({ id, source }) => ({ id, source, message: '', refreshedAt: Date.now(), observedAt: Date.now(), fiveHour: { usedPercent: 90, resetsAt: Date.now() + 999999 }, weekly: null })),
  buckets: providers.map(({ id }, i) => ({ provider: id, project: `${id}-project`, model: `${id}-model`, timestamp: Date.now(), tokens: { input: (i + 1) * 100, cached: 0, cacheWrite: 0, cacheWriteHour: 0, output: 0, reasoning: 0 } })),
  sessions: 6, files: 9, warnings: providers.map(({ id }) => `${id}-note`),
  sources: Object.fromEntries(providers.map(({ id }, i) => [id, { sessions: i + 1, files: i + 2, warnings: [`${id}-note`] }])),
});

function loadComponent(filename, hooks, invoke) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.require = (id) => {
    if (id.endsWith('.css')) return {};
    if (id === '@tauri-apps/api/core') return { invoke };
    if (id === 'react' && filename.endsWith('UsageTab.tsx')) return hooks;
    if (!id.startsWith('.')) return require(id);
    const target = resolve(dirname(filename), id);
    return loadComponent(existsSync(`${target}.tsx`) ? `${target}.tsx` : `${target}.ts`, hooks, invoke);
  };
  mod._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}

// Drive the real component's effects with deterministic hook storage and clock,
// while rendering its actual JSX and child components through React DOM.
function harness(initialSettings, invoke) {
  const slots = [], timers = new Map(), listeners = new Map();
  let cursor = 0, pending = [], dirty = false, nextTimer = 0, html = '', alertCount = 0;
  let currentSettings = initialSettings;
  const original = Object.fromEntries(['document', 'localStorage', 'setInterval', 'clearInterval'].map((key) => [key, globalThis[key]]));
  globalThis.document = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  globalThis.localStorage = { getItem: () => null };
  globalThis.setInterval = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
  globalThis.clearInterval = (id) => timers.delete(id);
  const changed = (old, deps) => !old || deps.some((value, i) => !Object.is(value, old[i]));
  const hooks = {
    ...React,
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (next) => {
        const value = typeof next === 'function' ? next(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
      }];
    },
    useRef(value) { const i = cursor++; return slots[i] ||= { current: value }; },
    useMemo(fn, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) slots[i] = { value: fn(), deps };
      return slots[i].value;
    },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) {
        const cleanup = slots[i]?.cleanup;
        slots[i] = { deps };
        pending.push(() => { cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  const { default: UsageTab } = loadComponent(fileURLToPath(new URL('../src/UsageTab.tsx', import.meta.url)), hooks, invoke);
  const render = () => {
    let passes = 0;
    do {
      assert.ok(++passes < 10, 'component effects should settle');
      dirty = false; cursor = 0; pending = [];
      html = renderToStaticMarkup(React.createElement(UsageTab, { active: true, settings: currentSettings, onSettingsChange: (s) => { currentSettings = s; dirty = true; }, onAlertCount: (n) => { alertCount = n; } }));
      for (const effect of pending) effect();
    } while (dirty);
    return html;
  };
  return {
    render, timers, listeners,
    get alerts() { return alertCount; },
    update(value) { currentSettings = value; return render(); },
    async flush() { await new Promise(setImmediate); return render(); },
    dispose() {
      for (const slot of slots) slot?.cleanup?.();
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    },
  };
}

test('usage UI hides disabled provider details immediately and stops shared monitoring when all are off', async () => {
  const calls = [];
  const app = harness(null, async (command) => { if (command === 'usage_refresh') calls.push(command); return report(); });
  try {
    app.render();
    assert.equal(calls.length, 0);
    assert.equal(app.timers.size, 0);
    app.update(settings);
    let html = await app.flush();
    assert.equal(calls.length, 1);
    assert.equal(app.timers.size, 2);
    assert.ok(app.listeners.has('visibilitychange'));
    assert.equal(app.alerts, 3);
    assert.ok(html.includes('OpenAI Codex') && html.includes('Claude Code') && html.includes('Future Provider'));
    html = app.update({ ...settings, tracking: { codex: false } });
    assert.ok(!html.includes('OpenAI Codex') && !html.includes('codex-project') && !html.includes('codex-model') && !html.includes('codex-note'));
    assert.equal(app.alerts, 2);
    html = app.update({ ...settings, tracking: { codex: false, claude: false, future: false } });
    assert.ok(html.includes('AI Usage') && html.includes('AI usage tracking is off') && html.includes('Open Settings'));
    assert.ok(!html.includes('usage-cards') && !html.includes('usage-history') && !html.includes('Auto-refresh'));
    assert.match(html, /<button class="primary" disabled="">/);
    assert.equal(app.alerts, 0);
    assert.equal(app.timers.size, 0);
    assert.equal(app.listeners.size, 0);
    await app.flush();
    const count = calls.length;
    app.render();
    assert.equal(calls.length, count);
    app.update({ ...settings, tracking: { codex: false, claude: false } });
    html = await app.flush();
    assert.ok(html.includes('Future Provider') && !html.includes('OpenAI Codex') && !html.includes('Claude Code'));
    assert.equal(app.timers.size, 2);
    assert.equal(app.alerts, 1);
  } finally { app.dispose(); }
});

test('an in-flight refresh cannot resurrect disabled provider data or schedule more work', async () => {
  const requests = [];
  const app = harness(settings, (command) => command === 'usage_report' ? Promise.resolve(report()) : new Promise((resolve) => requests.push(resolve)));
  try {
    app.render();
    const cached = await app.flush();
    assert.ok(cached.includes('codex-project'), 'saved history is shown while a fresh request is pending');
    app.update({ ...settings, tracking: { codex: false } });
    await app.flush();
    assert.equal(requests.length, 2, 'settings changes can refresh enabled providers while older work is pending');
    requests[0](report());
    let html = await app.flush();
    assert.equal(requests.length, 2, 'stale completion does not start additional requests');
    assert.ok(!html.includes('codex-project'));
    app.update({ ...settings, tracking: { codex: false, claude: false, future: false } });
    requests[1](report());
    html = await app.flush();
    assert.equal(requests.length, 2);
    assert.equal(app.timers.size, 0);
    assert.ok(html.includes('AI usage tracking is off') && !html.includes('usage-history'));
    app.update({ ...settings, tracking: { codex: false, future: false } });
    const restored = await app.flush();
    assert.ok(restored.includes('claude-project'), 're-enabling restores history before collection finishes');
    assert.equal(requests.length, 3);
    requests[2](report());
    html = await app.flush();
    assert.ok(html.includes('claude-project') && !html.includes('codex-project') && !html.includes('future-project'));
  } finally { app.dispose(); }
});

test('unmount cancels queued refreshes even while a request is finishing', async () => {
  const requests = [];
  const app = harness(settings, (command) => command === 'usage_report' ? Promise.resolve(report()) : new Promise((resolve) => requests.push(resolve)));
  app.render();
  await app.flush();
  app.listeners.get('visibilitychange')();
  assert.equal(requests.length, 1);
  app.dispose();
  requests[0](report());
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
});

test('settings expose an independent persisted switch for each registered provider', () => {
  const { default: Controls } = loadComponent(fileURLToPath(new URL('../src/UsageTrackingControls.tsx', import.meta.url)), React, () => {});
  const html = renderToStaticMarkup(React.createElement(Controls, { settings: { ...settings, tracking: { codex: false } }, onChange: () => {} }));
  const switches = html.match(/<input[^>]+>/g);
  assert.equal(switches.length, 3);
  assert.ok(switches.every((s) => s.includes('role="switch"')));
  assert.ok(!switches.find((s) => s.includes('Track OpenAI Codex')).includes('checked'));
  assert.ok(switches.find((s) => s.includes('Track Claude Code')).includes('checked'));
  assert.ok(switches.find((s) => s.includes('Track Future Provider')).includes('checked'));
  assert.ok(html.includes('AI Usage Tracking') && html.includes('Changes save immediately'));
});
