import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDownToLine, Check, Copy, Trash2 } from 'lucide-react';
import type { LogEntry, Service } from './types';
import { stripAnsi, boundLogs } from './utils';

export default function LogsPane({
  services,
  selected,
  onSelect,
  onError,
}: {
  services: Service[];
  selected: string;
  onSelect: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const [logs, setLogs] = useState<LogEntry[]>([]),
    [follow, setFollow] = useState(true),
    [copied, setCopied] = useState(false);
  const viewport = useRef<HTMLDivElement>(null),
    cursor = useRef(0),
    generation = useRef(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    setLogs([]);
    cursor.current = 0;
    const current = ++generation.current;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!selected) return;
      const readGeneration = generation.current;
      try {
        const entries = await invoke<LogEntry[]>('service_logs', {
          id: selected,
          after: cursor.current,
        });
        if (disposed) return;
        if (readGeneration === generation.current && entries.length) {
          cursor.current = entries[entries.length - 1].seq;
          setLogs((old) => boundLogs([...old, ...entries]));
        }
      } catch (e) {
        if (!disposed) errorHandler.current(e);
        return;
      }
      if (!disposed) timer = setTimeout(poll, 200);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (generation.current === current) generation.current++;
    };
  }, [selected]);
  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [logs, follow]);
  const clear = async () => {
    try {
      await invoke('clear_logs', { id: selected });
      generation.current++;
      setLogs([]);
    } catch (e) {
      onError(e);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logs.map((l) => stripAnsi(l.text)).join(''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="logs-pane">
      <div className="panel-toolbar">
        <div className="toolbar-start">
          <span className="muted small">OUTPUT</span>
          <select
            aria-label="Service logs"
            value={selected}
            onChange={(e) => onSelect(e.target.value)}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="live-label">
            <i /> Live
          </span>
        </div>
        <div className="toolbar-actions">
          <button
            className={follow ? 'subtle selected' : 'subtle'}
            onClick={() => setFollow(!follow)}
            title="Automatically follow output"
          >
            <ArrowDownToLine size={14} /> Follow
          </button>
          <button className="icon-button" aria-label="Copy logs" onClick={copy}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button
            className="icon-button"
            aria-label="Clear logs"
            onClick={clear}
            disabled={!selected}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div
        className="log-viewport"
        ref={viewport}
        onScroll={() => {
          const v = viewport.current;
          if (v && v.scrollHeight - v.scrollTop - v.clientHeight > 60) setFollow(false);
        }}
      >
        {logs.length ? (
          logs.map((log) => (
            <div className={`log-entry ${log.stream}`} key={log.seq}>
              <time>{new Date(log.timestamp).toLocaleTimeString('en-GB')}</time>
              <span className="stream-name">
                {log.stream === 'stdout' ? 'OUT' : log.stream === 'stderr' ? 'ERR' : 'SYS'}
              </span>
              <pre>{stripAnsi(log.text)}</pre>
            </div>
          ))
        ) : (
          <div className="output-empty">
            <span className="prompt-symbol">›_</span>
            <p>Your output starts here</p>
            <span>Run a service to stream its logs in real time.</span>
          </div>
        )}
      </div>
      <div className="panel-footer">
        <span>{logs.length} output chunks · 512 KB retained per service</span>
        <span>{follow ? 'Following output' : 'Scroll paused'}</span>
      </div>
    </div>
  );
}
