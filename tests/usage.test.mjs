import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const usage = await import(
  'data:text/javascript;base64,' +
    Buffer.from(
      ts.transpileModule(readFileSync(new URL('../src/usage.ts', import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    ).toString('base64')
);
const { totalTokens, chartData, estimate, parsePrices, limitState, activeAlerts, countdown } =
  usage;
const now = Date.parse('2026-11-20T12:00:00Z');
const tokens = {
  input: 100,
  cached: 200,
  cacheWrite: 30,
  cacheWriteHour: 20,
  output: 50,
  reasoning: 10,
};
const bucket = (extra = {}) => ({
  timestamp: now,
  provider: 'codex',
  project: 'Demo',
  model: 'unknown-model',
  tokens,
  ...extra,
});
const provider = (extra = {}) => ({
  id: 'codex',
  observedAt: now,
  fiveHour: { usedPercent: 90, resetsAt: now + 100_000 },
  weekly: null,
  ...extra,
});

test('token types and reasoning produce non-overlapping totals', () => {
  assert.equal(totalTokens(tokens), 400);
  const chart = chartData([bucket()], 'day', 'token', now);
  assert.equal(
    chart.totals.reduce((n, [, amount]) => n + amount, 0),
    400,
  );
  assert.equal(chart.totals.find(([key]) => key === 'Reasoning')[1], 10);
  assert.equal(chart.totals.find(([key]) => key === 'Output')[1], 40);
});
test('all chart breakdowns preserve amounts and group excess series', () => {
  const buckets = Array.from({ length: 10 }, (_, i) =>
    bucket({ model: i === 0 ? 'Other' : `model-${i}`, project: `project-${i}` }),
  );
  for (const breakdown of ['provider', 'project', 'model', 'token']) {
    const chart = chartData(buckets, 'week', breakdown, now);
    assert.equal(chart.points.length, 7);
    assert.ok(chart.series.length <= 6);
    assert.equal(new Set(chart.series).size, chart.series.length);
    assert.equal(
      chart.points.reduce((n, p) => n + Object.values(p.values).reduce((a, b) => a + b, 0), 0),
      4000,
    );
  }
});
test('day/week/month periods exclude old history without losing current data', () => {
  for (const [period, count] of [
    ['day', 24],
    ['week', 7],
    ['month', 30],
  ]) {
    const chart = chartData(
      [bucket(), bucket({ timestamp: now - 40 * 86400_000 })],
      period,
      'provider',
      now,
    );
    assert.equal(chart.points.length, count);
    assert.equal(chart.selected.length, 1);
  }
});
test('24-hour charts preserve both occurrences of a daylight-saving hour', () => {
  const prior = process.env.TZ;
  process.env.TZ = 'America/Toronto';
  try {
    const end = Date.parse('2026-11-01T16:00:00Z');
    const chart = chartData(
      [
        bucket({ timestamp: Date.parse('2026-11-01T05:00:00Z') }),
        bucket({ timestamp: Date.parse('2026-11-01T06:00:00Z') }),
      ],
      'day',
      'provider',
      end,
    );
    assert.equal(new Set(chart.points.map((p) => p.timestamp)).size, 24);
    assert.equal(
      chart.points.reduce((n, p) => n + Object.values(p.values).reduce((a, b) => a + b, 0), 0),
      800,
    );
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
});
test('unknown models remain unpriced; estimates bill reasoning only as output', () => {
  assert.deepEqual(estimate([bucket()]), { cost: 0, unpriced: 400 });
  assert.deepEqual(estimate([bucket({ model: 'constructor' })]), { cost: 0, unpriced: 400 });
  const rates = { input: 2, cached: 0.2, cacheWrite: 2.5, cacheWriteHour: 4, output: 10 };
  assert.equal(
    estimate([bucket()], { 'unknown-model': rates }).cost,
    (100 * 2 + 200 * 0.2 + 30 * 2.5 + 20 * 4 + 50 * 10) / 1e6,
  );
  assert.equal(estimate([bucket({ model: 'claude-opus-5-5' })]).unpriced, 0);
});
test('override rates require all nonnegative numeric prices', () => {
  assert.deepEqual(parsePrices('{}'), {});
  for (const invalid of [
    '[]',
    'null',
    '{"model":{}}',
    '{"model":{"input":-1,"cached":0,"cacheWrite":0,"cacheWriteHour":0,"output":0}}',
  ])
    assert.throws(() => parsePrices(invalid));
});
test('absent, expired, future, and reset snapshots never present fresh percentages', () => {
  const p = provider();
  assert.equal(limitState(p, p.fiveHour, now), 'current');
  assert.equal(limitState(p, null, now), 'unavailable');
  assert.equal(limitState(provider({ observedAt: now - 301_000 }), p.fiveHour, now), 'expired');
  assert.equal(limitState(provider({ observedAt: now + 61_000 }), p.fiveHour, now), 'expired');
  assert.equal(limitState(p, { usedPercent: 100, resetsAt: now }, now), 'expired');
  assert.equal(limitState(p, { usedPercent: 0, resetsAt: null }, now), 'current');
  assert.equal(countdown(null, now), 'Reset time unavailable');
});
test('alerts honor enabled thresholds, missing data, and snapshot expiry', () => {
  const report = { providers: [provider()] };
  assert.equal(activeAlerts(report, [80, 90, 100], now)[0].label.includes('reached 90%'), true);
  assert.equal(activeAlerts(report, [100], now).length, 0);
  assert.equal(activeAlerts(report, [], now).length, 0);
  assert.equal(activeAlerts(report, [80], now + 301_000).length, 0);
  assert.equal(activeAlerts(null, [80], now).length, 0);
});
