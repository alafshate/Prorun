export interface UsageSettings {
  codexExecutable: string;
  codexHome: string;
  claudeHome: string;
  claudeSnapshot: string;
  alerts: number[];
}
export interface Tokens {
  input: number;
  cached: number;
  cacheWrite: number;
  cacheWriteHour: number;
  output: number;
  reasoning: number;
}
export interface Limit {
  usedPercent: number;
  resetsAt: number | null;
}
export interface UsageProvider {
  id: string;
  fiveHour: Limit | null;
  weekly: Limit | null;
  refreshedAt: number;
  observedAt: number | null;
  source: string;
  message: string;
}
export interface UsageBucket {
  timestamp: number;
  provider: string;
  project: string;
  model: string;
  tokens: Tokens;
}
export interface UsageReport {
  refreshedAt: number;
  providers: UsageProvider[];
  buckets: UsageBucket[];
  sessions: number;
  files: number;
  warnings: string[];
}
export type Period = 'day' | 'week' | 'month';
export type Breakdown = 'provider' | 'project' | 'model' | 'token';
export const tokenLabels = {
  input: 'Fresh input',
  cached: 'Cache read',
  cacheWrite: 'Cache write · 5m / unspecified',
  cacheWriteHour: 'Cache write · 1h',
  output: 'Output (includes reasoning)',
};
export const totalTokens = (tokens: Tokens) =>
  Object.keys(tokenLabels).reduce((n, k) => n + tokens[k as keyof typeof tokenLabels], 0);
export const compact = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const money = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
export const providerName = (id: string) => (id === 'codex' ? 'OpenAI Codex' : 'Claude Code');
export function limitState(provider: UsageProvider, window: Limit | null, now: number) {
  if (!window || provider.observedAt === null) return 'unavailable';
  if (
    now - provider.observedAt > 5 * 60_000 ||
    provider.observedAt > now + 60_000 ||
    (window.resetsAt !== null && window.resetsAt <= now)
  )
    return 'expired';
  return 'current';
}
export function countdown(reset: number | null, now: number) {
  if (reset === null) return 'Reset time unavailable';
  if (reset <= now) return 'Awaiting a new snapshot';
  const minutes = Math.ceil((reset - now) / 60_000);
  return `Resets in ${minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ` : ''}${minutes >= 60 ? `${Math.floor((minutes % 1440) / 60)}h ` : ''}${minutes % 60}m`;
}
export function periodStart(period: Period, now: number) {
  if (period === 'day') return Math.floor(now / 3_600_000) * 3_600_000 - 23 * 3_600_000;
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  date.setHours(0);
  date.setDate(date.getDate() - (period === 'week' ? 6 : 29));
  return date.getTime();
}
export function chartData(
  buckets: UsageBucket[],
  period: Period,
  breakdown: Breakdown,
  now: number,
) {
  const start = periodStart(period, now);
  const selected = buckets.filter((b) => b.timestamp >= start && b.timestamp <= now);
  const totals = new Map<string, number>();
  const entries = (b: UsageBucket): [string, number][] =>
    breakdown === 'token'
      ? [
          ...Object.entries(tokenLabels)
            .filter(([k]) => k !== 'output')
            .map(([k, label]): [string, number] => [
              label,
              b.tokens[k as keyof typeof tokenLabels],
            ]),
          ['Output', Math.max(0, b.tokens.output - b.tokens.reasoning)],
          ['Reasoning', Math.min(b.tokens.output, b.tokens.reasoning)],
        ]
      : [
          [
            breakdown === 'provider' ? providerName(b.provider) : b[breakdown],
            totalTokens(b.tokens),
          ],
        ];
  for (const b of selected)
    for (const [key, amount] of entries(b)) totals.set(key, (totals.get(key) || 0) + amount);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const keys = ranked.slice(0, 5).map(([key]) => key);
  const others = ranked.length > 5;
  let rest = 'Other';
  while (keys.includes(rest)) rest += ' (remaining)';
  const series = others ? [...keys, rest] : keys;
  const count = period === 'day' ? 24 : period === 'week' ? 7 : 30;
  const points = Array.from({ length: count }, (_, i) => {
    const date = new Date(start);
    if (period === 'day') date.setTime(start + i * 3_600_000);
    else date.setDate(date.getDate() + i);
    return {
      timestamp: date.getTime(),
      values: Object.fromEntries(series.map((k) => [k, 0])) as Record<string, number>,
    };
  });
  for (const b of selected) {
    const date = new Date(b.timestamp);
    if (period !== 'day') date.setHours(0, 0, 0, 0);
    else date.setTime(Math.floor(b.timestamp / 3_600_000) * 3_600_000);
    const point = points.find((p) => p.timestamp === date.getTime());
    if (!point) continue;
    for (const [key, amount] of entries(b)) {
      const label = keys.includes(key) ? key : rest;
      point.values[label] = (point.values[label] || 0) + amount;
    }
  }
  return { points, series, totals: ranked, selected };
}

// USD / million tokens, standard text list rates checked 2026-11-20.
// Exact model IDs only: unknown models remain unpriced, never guessed.
// Sources: https://developers.openai.com/api/docs/pricing
// https://platform.claude.com/docs/en/about-claude/pricing
export interface Price {
  input: number;
  cached: number;
  cacheWrite: number;
  cacheWriteHour: number;
  output: number;
}
const price = (
  input: number,
  output: number,
  cached: number,
  cacheWrite = input * 1.25,
  cacheWriteHour = input * 2,
): Price => ({ input, output, cached, cacheWrite, cacheWriteHour });
export const prices: Record<string, Price> = {
  'gpt-6.2-astra': price(8, 40, 0.4),
  'gpt-6.2-sol': price(2, 10, 0.1),
  'gpt-6-astra': price(10, 50, 1),
  'gpt-6.1-sol': price(2, 10, 0.1),
  'gpt-6.1-terra': price(0.5, 2.5, 0.025),
  'gpt-6-luna': price(0.05, 0.25, 0.005),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-sonnet-5-5': price(2, 10, 0.1),
  'claude-fable-5-2': price(8, 40, 0.2),
  'claude-opus-4-6': price(5, 25, 0.5),
  'claude-opus-4-5': price(5, 25, 0.5),
  'claude-sonnet-4-6': price(3, 15, 0.3),
  'claude-sonnet-4-5': price(3, 15, 0.3),
  'claude-haiku-4-5': price(1, 5, 0.1),
};
export function estimate(buckets: UsageBucket[], overrides: Record<string, Price> = {}) {
  let cost = 0,
    unpriced = 0;
  for (const b of buckets) {
    const rates = Object.hasOwn(overrides, b.model)
      ? overrides[b.model]
      : Object.hasOwn(prices, b.model)
        ? prices[b.model]
        : undefined;
    if (!rates) {
      unpriced += totalTokens(b.tokens);
      continue;
    }
    cost += Object.keys(tokenLabels).reduce(
      (n, key) => n + (b.tokens[key as keyof Price] * rates[key as keyof Price]) / 1_000_000,
      0,
    );
  }
  return { cost, unpriced };
}
export function parsePrices(text: string): Record<string, Price> {
  const result: unknown = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Prices must be an object keyed by exact model ID.');
  for (const value of Object.values(result)) {
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(tokenLabels).some(
        (k) => typeof value[k] !== 'number' || !Number.isFinite(value[k]) || value[k] < 0,
      )
    )
      throw new Error(
        'Each model needs nonnegative input, cached, cacheWrite, cacheWriteHour, and output rates.',
      );
  }
  return result as Record<string, Price>;
}

export function activeAlerts(report: UsageReport | null, thresholds: number[], now: number) {
  return (report?.providers || []).flatMap((provider) =>
    (['fiveHour', 'weekly'] as const).flatMap((key) => {
      const window = provider[key];
      if (!window || limitState(provider, window, now) !== 'current') return [];
      const threshold = thresholds.filter((t) => window.usedPercent >= t).sort((a, b) => b - a)[0];
      return threshold === undefined
        ? []
        : [
            {
              id: `${provider.id}:${key}:${window.resetsAt}:${threshold}`,
              label: `${providerName(provider.id)} · ${key === 'fiveHour' ? '5-hour' : 'weekly'} usage reached ${threshold}% (${window.usedPercent}% used).`,
            },
          ];
    }),
  );
}
