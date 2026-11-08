import type { LogEntry } from './types';
export const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path;
// Remove CSI, OSC (including links), and common single-character VT escapes.
export const stripAnsi = (text: string) =>
  text
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-2A-Z]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r/g, '');
export function boundLogs(logs: LogEntry[]): LogEntry[] {
  let bytes = 0,
    start = logs.length;
  while (start > 0 && logs.length - start < 4000) {
    const size = logs[start - 1].text.length * 2;
    if (bytes + size > 512 * 1024) break;
    bytes += size;
    start--;
  }
  return logs.slice(start);
}

// Stay below the IPC byte limit without splitting a UTF-16 surrogate pair.
export function* terminalInputChunks(data: string): Generator<string> {
  for (let start = 0; start < data.length; ) {
    let end = Math.min(start + 16000, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield data.slice(start, end);
    start = end;
  }
}
