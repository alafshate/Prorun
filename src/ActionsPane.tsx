import { Copy, Folder, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import type { Action, ActionRuntime } from './types';
import { uptime } from './types';
import LogsPane from './LogsPane';

export default function ActionsPane({
  actions,
  runtimes,
  selected,
  now,
  busy,
  configBusy,
  bashAvailable,
  onSelect,
  onRun,
  onStop,
  onAdd,
  onEdit,
  onDuplicate,
  onDelete,
  onError,
}: {
  actions: Action[];
  runtimes: ActionRuntime[];
  selected: string;
  now: number;
  busy: Set<string>;
  configBusy: boolean;
  bashAvailable: boolean;
  onSelect: (id: string) => void;
  onRun: (action: Action) => void;
  onStop: (action: Action) => void;
  onAdd: () => void;
  onEdit: (action: Action) => void;
  onDuplicate: (action: Action) => void;
  onDelete: (action: Action) => void;
  onError: (error: unknown) => void;
}) {
  const states = new Map(runtimes.map((r) => [r.id, r]));
  return (
    <div className="actions-pane">
      <div className="panel-toolbar">
        <span className="muted small">Saved commands · Run on demand</span>
        <button className="subtle" onClick={onAdd} disabled={configBusy}>
          <Plus size={14} /> Add action
        </button>
      </div>
      {actions.length ? (
        <div className="action-list" aria-label="Saved actions">
          {actions.map((a) => {
            const r = states.get(a.id);
            const status = r?.status || 'idle';
            const running = status === 'running';
            const pending = busy.has(a.id) || configBusy;
            return (
              <div className={`action-row ${selected === a.id ? 'active' : ''}`} key={a.id}>
                <button
                  className="action-details"
                  onClick={() => onSelect(a.id)}
                  aria-label={`View ${a.name} output`}
                  aria-pressed={selected === a.id}
                >
                  <strong>{a.name}</strong>
                  <code title={a.command}>$ {a.command}</code>
                  <span className="action-metadata">
                    <span className={`service-status ${status}`}>
                      <i />{status[0].toUpperCase() + status.slice(1)}
                    </span>
                    <span title={a.directory}>
                      <Folder size={11} /> {a.directory || '.'}
                    </span>
                    {r?.startedAt != null && (
                      <span>{uptime(r.startedAt, running ? now : r.endedAt ?? now)}</span>
                    )}
                    {r?.exitCode != null && <span>Exit {r.exitCode}</span>}
                  </span>
                  {r?.error && <span className="action-error">{r.error}</span>}
                </button>
                <div className="action-controls">
                  <button
                    className={running ? 'stop-service' : 'run-service'}
                    disabled={pending || (!running && !bashAvailable)}
                    aria-label={`${running ? 'Stop' : 'Run'} ${a.name}`}
                    onClick={() => running ? onStop(a) : onRun(a)}
                  >
                    {running ? <Square size={12} /> : <Play size={13} />}
                    {running ? 'Stop' : 'Run'}
                  </button>
                  <button
                    className="icon-button"
                    title="Edit action"
                    aria-label={`Edit ${a.name}`}
                    disabled={pending || running}
                    onClick={() => onEdit(a)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-button"
                    title="Duplicate action"
                    aria-label={`Duplicate ${a.name}`}
                    disabled={pending}
                    onClick={() => onDuplicate(a)}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    className="icon-button"
                    title="Delete action"
                    aria-label={`Delete ${a.name}`}
                    disabled={pending}
                    onClick={() => onDelete(a)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="terminal-empty">
          <Play size={28} />
          <h3>Your commands, ready when you need them.</h3>
          <p>Save builds, tests, and other tasks for this project.</p>
          <button onClick={onAdd} disabled={configBusy}>
            <Plus size={14} /> Add your first action
          </button>
        </div>
      )}
      {!!actions.length && (
        <LogsPane
          kind="action"
          services={actions}
          selected={selected}
          onSelect={onSelect}
          onError={onError}
        />
      )}
    </div>
  );
}
