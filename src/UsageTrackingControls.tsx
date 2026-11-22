import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { trackingEnabled, type UsageSettings } from './usage';

export default function UsageTrackingControls({
  settings,
  onChange,
  disabled = false,
  onPendingChange,
}: {
  settings: UsageSettings | null;
  onChange: (settings: UsageSettings) => void;
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return (
    <fieldset className="usage-thresholds usage-tracking">
      <legend>AI Usage Tracking</legend>
      <p>
        Track local usage independently for each provider. Changes save immediately.
        Saved history is preserved while tracking is off.
      </p>
      {!settings && <p>Loading tracking settings…</p>}
      {settings?.providers.map(({ id, name }) => (
        <label key={id}>
          <input
            type="checkbox"
            role="switch"
            aria-label={`Track ${name}`}
            checked={trackingEnabled(settings, id)}
            disabled={saving || disabled}
            onChange={async (event) => {
              const enabled = event.target.checked;
              setSaving(true);
              onPendingChange?.(true);
              setError('');
              try {
                onChange(await invoke<UsageSettings>('usage_set_tracking', { provider: id, enabled }));
              } catch (e) {
                setError(String(e));
              } finally {
                setSaving(false);
                onPendingChange?.(false);
              }
            }}
          />
          {name}
        </label>
      ))}
      {error && <p className="form-error" role="alert">{error}</p>}
    </fieldset>
  );
}
