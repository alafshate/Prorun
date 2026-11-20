import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Activity,
  ArrowUpRight,
  Bell,
  Check,
  Clock3,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import Modal from './Modal';
import {
  activeAlerts,
  chartData,
  compact,
  countdown,
  estimate,
  limitState,
  money,
  parsePrices,
  prices,
  providerName,
  totalTokens,
  type Breakdown,
  type Period,
  type UsageProvider,
  type UsageReport,
  type UsageSettings,
} from './usage';
import './usage.css';

type CaptureInfo = { enabled: boolean; existingStatusLine: boolean; settingsPath: string };
const colors = ['#a5ed9a', '#bba3ef', '#88baff', '#e6bb7a', '#ed98ae', '#6c788b'];
const dateTime = (value: number | null) =>
  value === null ? 'Never' : new Date(value).toLocaleString();

export default function UsageTab({
  active,
  onAlertCount,
}: {
  active: boolean;
  onAlertCount: (n: number) => void;
}) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [settings, setSettings] = useState<UsageSettings | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [now, setNow] = useState(Date.now()),
    [nextRefresh, setNextRefresh] = useState<number | null>(null);
  const [period, setPeriod] = useState<Period>('week'),
    [breakdown, setBreakdown] = useState<Breakdown>('provider');
  const [provider, setProvider] = useState('all'),
    [project, setProject] = useState('all'),
    [model, setModel] = useState('all');
  const [hover, setHover] = useState<number | null>(null);
  const [editing, setEditing] = useState(false),
    [capture, setCapture] = useState<CaptureInfo | null>(null);
  const [saving, setSaving] = useState(false),
    [settingsError, setSettingsError] = useState('');
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [priceText, setPriceText] = useState(
    () => localStorage.getItem('prorun-usage-prices') || '{}',
  );
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      setReport(await invoke<UsageReport>('usage_refresh'));
      setError('');
    } catch (e) {
      setError(`Usage refresh failed: ${String(e)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
      setNextRefresh(Date.now() + 120_000);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    void invoke<UsageSettings>('usage_settings')
      .then((value) => {
        if (!disposed) setSettings(value);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 120_000);
    const visibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const alerts = activeAlerts(report, settings?.alerts || [], now).filter(
    (a) => !dismissed.includes(a.id),
  );
  useEffect(() => {
    onAlertCount(alerts.length);
  }, [alerts.length, onAlertCount]);
  const buckets = useMemo(
    () =>
      (report?.buckets || []).filter(
        (b) =>
          (provider === 'all' || b.provider === provider) &&
          (project === 'all' || b.project === project) &&
          (model === 'all' || b.model === model),
      ),
    [report, provider, project, model],
  );
  const chartNow = Math.floor(now / 60_000) * 60_000;
  const chart = useMemo(
    () => chartData(buckets, period, breakdown, chartNow),
    [buckets, period, breakdown, chartNow],
  );
  const overrides = useMemo(() => {
    try {
      return parsePrices(priceText);
    } catch {
      return {};
    }
  }, [priceText]);
  const costs = estimate(chart.selected, overrides);
  const tokens = chart.selected.reduce((n, b) => n + totalTokens(b.tokens), 0);
  const max = Math.max(
    1,
    ...chart.points.map((p) => Object.values(p.values).reduce((n, v) => n + v, 0)),
  );
  const openSettings = async () => {
    setEditing(true);
    setSettingsError('');
    try {
      setCapture(await invoke<CaptureInfo>('usage_capture_info'));
    } catch (e) {
      setSettingsError(String(e));
    }
  };
  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setSettingsError('');
    const data = new FormData(event.currentTarget);
    try {
      const text = String(data.get('prices') || '{}');
      parsePrices(text);
      const value: UsageSettings = {
        codexExecutable: String(data.get('codexExecutable') || '').trim(),
        codexHome: String(data.get('codexHome') || '').trim(),
        claudeHome: String(data.get('claudeHome') || '').trim(),
        claudeSnapshot: String(data.get('claudeSnapshot') || '').trim(),
        alerts: [80, 90, 100].filter((n) => data.has(`alert${n}`)),
      };
      await invoke('usage_save_settings', { settings: value });
      localStorage.setItem('prorun-usage-prices', text);
      setPriceText(text);
      setSettings(await invoke<UsageSettings>('usage_settings'));
      setEditing(false);
      void refresh();
    } catch (e) {
      setSettingsError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const changeCapture = async (enable: boolean) => {
    setSaving(true);
    setSettingsError('');
    try {
      await invoke('usage_capture', { enable });
      setCapture(await invoke<CaptureInfo>('usage_capture_info'));
      void refresh();
    } catch (e) {
      setSettingsError(String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="usage-view" hidden={!active}>
      <div className="usage-heading">
        <div>
          <span className="eyebrow">GLOBAL WORKSPACE</span>
          <h1>
            AI Usage <span className="badge healthy">Local sources</span>
          </h1>
          <p>Your coding capacity and token activity, across every local project.</p>
        </div>
        <div className="usage-actions">
          <button onClick={() => void openSettings()}>
            <Settings2 size={15} /> Configure
          </button>
          <button className="primary" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={15} className={busy ? 'spin' : ''} />
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="usage-refresh">
        <span>
          <span className="tiny-dot" /> Auto-refresh · every 2 minutes while Prorun is open
        </span>
        <span title={dateTime(report?.refreshedAt ?? null)}>
          {report ? `Last scan ${dateTime(report.refreshedAt)}` : 'Waiting for first scan'}
          {nextRefresh && !busy
            ? ` · Next in ${Math.max(0, Math.ceil((nextRefresh - now) / 1000))}s`
            : ''}
        </span>
      </div>
      {error && (
        <div className="usage-notice" role="alert">
          {error}
        </div>
      )}
      {alerts.map((alert) => (
        <div className="usage-alert" role="alert" key={alert.id}>
          <Bell size={16} />
          <span>{alert.label}</span>
          <button
            className="icon-button"
            aria-label="Dismiss usage alert"
            onClick={() => setDismissed((old) => [...old, alert.id])}
          >
            <X size={15} />
          </button>
        </div>
      ))}
      <div className="usage-cards">
        {['codex', 'claude'].map((id) => (
          <ProviderCard
            key={id}
            provider={
              report?.providers.find((p) => p.id === id) || {
                id,
                fiveHour: null,
                weekly: null,
                refreshedAt: 0,
                observedAt: null,
                source: id === 'codex' ? 'Codex app-server' : 'Claude Code status line',
                message: busy ? 'Reading local sources…' : 'No source data yet.',
              }
            }
            now={now}
          />
        ))}
      </div>
      <section className="usage-history">
        <div className="usage-section-heading">
          <div>
            <h2>
              <Activity size={18} /> Token activity
            </h2>
            <p>Recorded local sessions, including those started outside Prorun.</p>
          </div>
          <div className="usage-period" role="group" aria-label="Chart period">
            {(['day', 'week', 'month'] as const).map((value) => (
              <button
                key={value}
                aria-pressed={period === value}
                className={period === value ? 'active' : ''}
                onClick={() => {
                  setPeriod(value);
                  setHover(null);
                }}
              >
                {value === 'day' ? 'Daily' : value === 'week' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
        </div>
        <div className="usage-filters">
          <label>
            Provider
            <select
              aria-label="Provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="all">All providers</option>
              <option value="codex">OpenAI Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label>
            Project
            <select
              aria-label="Project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="all">All projects</option>
              {[...new Set(report?.buckets.map((b) => b.project))].sort().map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="all">All models</option>
              {[...new Set(report?.buckets.map((b) => b.model))].sort().map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Break down by
            <select
              aria-label="Break down by"
              value={breakdown}
              onChange={(e) => {
                setBreakdown(e.target.value as Breakdown);
                setHover(null);
              }}
            >
              {(['provider', 'project', 'model', 'token'] as const).map((value) => (
                <option key={value} value={value}>
                  {value === 'token' ? 'Token type' : value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="usage-stats">
          <div>
            <small>RECORDED TOKENS</small>
            <strong>{report ? compact(tokens) : '—'}</strong>
            <span>
              {period === 'day'
                ? 'Last 24 hourly buckets'
                : period === 'week'
                  ? 'Last 7 calendar days'
                  : 'Last 30 calendar days'}
            </span>
          </div>
          <div>
            <small>ESTIMATED API-EQUIVALENT</small>
            <strong>
              {report && tokens > 0
                ? costs.unpriced === tokens
                  ? 'Unpriced'
                  : money(costs.cost)
                : '—'}
              <ArrowUpRight size={17} />
            </strong>
            <span>
              {costs.unpriced
                ? `${compact(costs.unpriced)} tokens unpriced · partial estimate`
                : 'USD · standard text list rates'}
            </span>
          </div>
          <div>
            <small>LOCAL COVERAGE · ALL HISTORY</small>
            <strong>
              {report?.sessions ?? '—'} <em>sessions</em>
            </strong>
            <span>{report?.files ?? 0} discovered session files</span>
          </div>
        </div>
        <div className="usage-chart-caption">
          <span>
            {breakdown === 'token' ? 'Non-overlapping token types' : `Tokens by ${breakdown}`} ·{' '}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
          <span>{compact(max)} max</span>
        </div>
        <div className="usage-chart" role="group" aria-label={`${period} token usage chart`}>
          {chart.points.map((point, i) => (
            <button
              className="usage-chart-column"
              key={point.timestamp}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onClick={() => setHover(hover === i ? null : i)}
              aria-label={`${dateTime(point.timestamp)}: ${
                Object.entries(point.values)
                  .map(([k, n]) => `${k}: ${n}`)
                  .join(', ') || 'No recorded tokens'
              }`}
            >
              <span className="usage-stack">
                {chart.series.map((key, j) => (
                  <span
                    key={key}
                    style={{ height: `${(point.values[key] / max) * 100}%`, background: colors[j] }}
                  />
                ))}
              </span>
              <small>
                {period === 'day'
                  ? new Date(point.timestamp).toLocaleTimeString([], { hour: 'numeric' })
                  : new Date(point.timestamp).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                    })}
              </small>
            </button>
          ))}
          {!tokens && (
            <div className="usage-chart-empty">
              {busy ? 'Indexing local token history…' : 'No recorded token usage in this period.'}
            </div>
          )}
        </div>
        <div className="usage-chart-detail" aria-live="polite">
          {hover !== null && chart.points[hover] ? (
            <>
              <strong>{dateTime(chart.points[hover].timestamp)}</strong>
              {Object.entries(chart.points[hover].values).map(([key, n], i) => (
                <span key={key}>
                  <i style={{ background: colors[i] }} />
                  {key}: {compact(n)}
                </span>
              ))}
            </>
          ) : (
            <span>Hover, focus, or select a bar to inspect usage.</span>
          )}
        </div>
        <div className="usage-breakdown">
          {chart.totals.map(([key, amount], i) => (
            <div key={key}>
              <span title={key}>
                <i style={{ background: colors[i < 5 ? i : 5] }} />
                {key}
              </span>
              <div className="usage-breakdown-track">
                <span
                  style={{
                    width: `${tokens ? (amount / tokens) * 100 : 0}%`,
                    background: colors[i < 5 ? i : 5],
                  }}
                />
              </div>
              <strong>{compact(amount)}</strong>
            </div>
          ))}
        </div>
        <p className="usage-cost-note">
          API-equivalent estimates are hypothetical token costs, separate from actual subscription
          charges. Rates checked Nov 20, 2026; excludes tools, regional premiums, fast mode, and
          long-context surcharges. Unknown models stay unpriced.{' '}
          <button className="subtle" onClick={() => void openSettings()}>
            View / override rates
          </button>
        </p>
      </section>
      {report?.warnings.length ? (
        <details className="usage-notice">
          <summary>Source notes · {report.warnings.length}</summary>
          <ul>
            {report.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <footer className="usage-footer">
        <ShieldCheck size={15} />
        <span>
          Only usage metadata is displayed. Limits come from provider reports; token counts never
          determine subscription percentages.
        </span>
      </footer>
      {editing && settings && (
        <Modal
          title="AI Usage settings"
          subtitle="Local sources, capacity alerts, and optional Claude capture."
          onClose={() => setEditing(false)}
          locked={saving}
        >
          <form className="usage-settings" onSubmit={saveSettings}>
            {settingsError && (
              <div className="form-error" role="alert">
                {settingsError}
              </div>
            )}
            <label>
              Codex executable <span>Native .exe; blank to detect PATH / npm</span>
              <input
                name="codexExecutable"
                defaultValue={settings.codexExecutable}
                placeholder="C:\Tools\codex.exe"
              />
            </label>
            <label>
              Codex home <span>CODEX_HOME / ~/.codex</span>
              <input name="codexHome" defaultValue={settings.codexHome} />
            </label>
            <label>
              Claude home <span>CLAUDE_CONFIG_DIR / ~/.claude</span>
              <input name="claudeHome" defaultValue={settings.claudeHome} />
            </label>
            <label>
              Claude status-line snapshot <span>JSON with documented rate_limits</span>
              <input name="claudeSnapshot" defaultValue={settings.claudeSnapshot} />
            </label>
            <p className="field-help">
              Use absolute Windows paths. Source homes contain sessions/ (Codex) or projects/
              (Claude). Save path changes before enabling capture.
            </p>
            <fieldset className="usage-thresholds">
              <legend>In-app capacity alerts</legend>
              {[80, 90, 100].map((n) => (
                <label key={n}>
                  <input
                    name={`alert${n}`}
                    type="checkbox"
                    defaultChecked={settings.alerts.includes(n)}
                  />
                  {n}% used
                </label>
              ))}
              <p>Alerts remain active across project navigation while Prorun is open.</p>
            </fieldset>
            <div className="usage-capture">
              <h3>
                {capture?.enabled ? <Check size={16} /> : <ShieldCheck size={16} />} Claude
                subscription limit capture
              </h3>
              <p>
                {capture?.enabled
                  ? 'Capture is enabled. Disable it to restore the original status-line configuration.'
                  : 'Opt in to add a local PowerShell capture script to Claude’s user status line. The current command and its output are preserved through Git Bash, with a backup for restoration. Only rate-limit fields and a timestamp are saved.'}
              </p>
              {capture && (
                <>
                  <code>{capture.settingsPath}</code>
                  <p>
                    {capture.existingStatusLine
                      ? 'An existing status line is configured.'
                      : 'No existing user status line.'}{' '}
                    Project-specific status lines may override capture. Limits appear after Claude
                    responds; snapshots expire after 5 minutes.
                  </p>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void changeCapture(!capture.enabled)}
                  >
                    {capture.enabled ? 'Disable capture & restore' : 'Enable capture (opt in)'}
                  </button>
                </>
              )}
            </div>
            <details className="usage-rates">
              <summary>API-equivalent prices · USD per million tokens</summary>
              <p>
                Standard text rates:{' '}
                <a
                  href="https://developers.openai.com/api/docs/pricing"
                  target="_blank"
                  rel="noreferrer"
                >
                  OpenAI
                </a>{' '}
                ·{' '}
                <a
                  href="https://platform.claude.com/docs/en/about-claude/pricing"
                  target="_blank"
                  rel="noreferrer"
                >
                  Anthropic
                </a>
                . Reasoning is included in output.
              </p>
              <pre>{JSON.stringify(prices, null, 2)}</pre>
              <label>
                Exact model overrides <span>Stored locally in this app</span>
                <textarea name="prices" rows={7} defaultValue={priceText} spellCheck={false} />
              </label>
              <p>
                Example:{' '}
                {JSON.stringify({
                  'my-model': {
                    input: 2,
                    cached: 0.2,
                    cacheWrite: 2.5,
                    cacheWriteHour: 4,
                    output: 10,
                  },
                })}
              </p>
            </details>
            <div className="modal-actions">
              <button type="button" disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary" disabled={saving} type="submit">
                {saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function ProviderCard({ provider, now }: { provider: UsageProvider; now: number }) {
  return (
    <article className={`usage-provider ${provider.id}`}>
      <div className="usage-provider-heading">
        <span className="usage-provider-mark">{provider.id === 'codex' ? '>_' : '✳'}</span>
        <div>
          <h2>{providerName(provider.id)}</h2>
          <span>{provider.source}</span>
        </div>
        <span className="usage-provider-tag">SUBSCRIPTION</span>
      </div>
      {(['fiveHour', 'weekly'] as const).map((key) => {
        const window = provider[key],
          state = limitState(provider, window, now),
          current = window !== null && state === 'current';
        return (
          <div className="usage-window" key={key}>
            <div>
              <strong>{key === 'fiveHour' ? '5-hour window' : 'Weekly window'}</strong>
              <span className={current && window.usedPercent >= 90 ? 'usage-high' : ''}>
                {current
                  ? `${window.usedPercent}% used`
                  : state === 'expired'
                    ? 'Snapshot expired'
                    : 'Unavailable'}
              </span>
            </div>
            <div
              className="usage-meter"
              role="progressbar"
              aria-label={`${providerName(provider.id)} ${key === 'fiveHour' ? '5-hour' : 'weekly'} usage`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={current ? window.usedPercent : undefined}
              aria-valuetext={current ? `${window.usedPercent}% used` : state}
            >
              <span style={{ width: `${current ? window.usedPercent : 0}%` }} />
            </div>
            <div className="usage-window-meta">
              <span>
                {current
                  ? `${Math.round((100 - window.usedPercent) * 10) / 10}% remaining`
                  : 'Remaining capacity unavailable'}
              </span>
              <span>
                <Clock3 size={11} />
                {current ? countdown(window.resetsAt, now) : 'Waiting for provider data'}
              </span>
            </div>
          </div>
        );
      })}
      {provider.message && <p className="usage-provider-message">{provider.message}</p>}
      <div className="usage-provider-foot">
        <span title={dateTime(provider.observedAt)}>
          Source updated {dateTime(provider.observedAt)}
        </span>
        <span title={dateTime(provider.refreshedAt || null)}>
          Checked {provider.refreshedAt ? new Date(provider.refreshedAt).toLocaleTimeString() : '—'}
        </span>
      </div>
    </article>
  );
}
