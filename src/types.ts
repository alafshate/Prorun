export interface Service {
  id: string;
  name: string;
  directory: string;
  command: string;
}
export interface Project {
  id: string;
  name: string;
  root: string;
  services: Service[];
}
export interface Config {
  version: number;
  bashPath: string;
  projects: Project[];
}
export interface Runtime {
  id: string;
  status: 'running' | 'stopped' | 'failed';
  startedAt: number | null;
  exitCode: number | null;
  error: string | null;
}
export interface Snapshot {
  services: Runtime[];
  terminals: { id: string; projectId: string; alive: boolean }[];
  bashPath: string | null;
}
export interface LogEntry {
  seq: number;
  timestamp: number;
  stream: string;
  text: string;
}
export const uptime = (started: number | null, now = Date.now()) => {
  if (!started) return '—';
  const s = Math.max(0, Math.floor((now - started) / 1000));
  return s >= 3600
    ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    : s >= 60
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${s}s`;
};
