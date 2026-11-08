import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalInputChunks } from './utils';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPane({ id, active }: { id: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const [initialized, setInitialized] = useState(active);
  const visible = useRef(active);
  visible.current = active;
  const [error, setError] = useState('');
  useEffect(() => {
    if (active) setInitialized(true);
  }, [active]);
  useEffect(() => {
    if (!host.current || !initialized) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>,
      cursor = 0,
      resizeTimer: ReturnType<typeof setTimeout>;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: '#101216',
        foreground: '#d6dce5',
        cursor: '#a5ed9a',
        selectionBackground: '#354439',
        black: '#1c2027',
        red: '#f08080',
        green: '#a5ed9a',
        yellow: '#e9c97d',
        blue: '#8ab4f8',
        magenta: '#c7a0ed',
        cyan: '#89d4df',
        white: '#d6dce5',
      },
    });
    terminal.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    setError('');
    const report = (e: unknown) => {
      if (!disposed) setError(String(e));
    };
    let input = Promise.resolve();
    const onData = term.onData((data) => {
      // Serialize writes, including large pastes, so input cannot arrive out of order.
      input = input
        .then(async () => {
          for (const chunk of terminalInputChunks(data)) {
            if (disposed) return;
            await invoke('terminal_write', { id, data: chunk });
          }
        })
        .catch(report);
    });
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || !host.current?.clientWidth || !host.current?.clientHeight) return;
        fit.fit();
        void invoke('terminal_resize', { id, cols: term.cols, rows: term.rows }).catch(report);
      }, 80);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    resize();
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
      if (event.code === 'KeyC') {
        event.preventDefault();
        if (term.hasSelection())
          void navigator.clipboard.writeText(term.getSelection()).catch(report);
        return false;
      }
      if (event.code === 'KeyV') {
        event.preventDefault();
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (!disposed) term.paste(text);
          })
          .catch(report);
        return false;
      }
      return true;
    });
    const decoder = new TextDecoder();
    const poll = async () => {
      try {
        const result = await invoke<{
          data: number[];
          cursor: number;
          truncated: boolean;
          alive: boolean;
        }>('terminal_read', { id, cursor });
        if (disposed) return;
        if (result.truncated) {
          term.reset();
          decoder.decode();
          term.writeln('\x1b[33m[Earlier output was trimmed from the bounded buffer]\x1b[0m');
        }
        cursor = result.cursor;
        const output = decoder.decode(new Uint8Array(result.data), { stream: true });
        if (output) await new Promise<void>((resolve) => term.write(output, resolve));
        if (disposed) return;
        if (!result.alive && result.data.length === 0) {
          term.write(decoder.decode());
          term.writeln(
            '\r\n\x1b[90m[Session exited. Close this tab or open a new terminal.]\x1b[0m',
          );
          return;
        }
        timer = setTimeout(poll, result.data.length === 32768 ? 0 : visible.current ? 70 : 250);
      } catch (e) {
        report(e);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      observer.disconnect();
      onData.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [id, initialized]);
  useEffect(() => {
    if (active) {
      const timer = setTimeout(() => terminal.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [active]);
  return (
    <div className="terminal-wrapper" hidden={!active}>
      {error && <div className="inline-error">{error}</div>}
      <div className="terminal-host" ref={host} />
    </div>
  );
}
