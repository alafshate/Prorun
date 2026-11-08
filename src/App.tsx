import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Activity,
  ArrowRight,
  ChevronRight,
  Clock3,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Search,
  Server,
  Settings2,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { Config, Project, Runtime, Service, Snapshot } from './types';
import { uptime } from './types';
import { folderName } from './utils';
import Modal from './Modal';
import LogsPane from './LogsPane';
import TerminalPane from './TerminalPane';

type Editor =
  | { kind: 'service'; projectId: string; service: Service }
  | { kind: 'project'; project: Project }
  | { kind: 'settings' }
  | { kind: 'remove-project'; project: Project }
  | { kind: 'remove-service'; projectId: string; service: Service };
const initialSnapshot: Snapshot = { services: [], terminals: [], bashPath: null };
const newId = () => crypto.randomUUID();
export default function App() {
  const [config, setConfig] = useState<Config | null>(null),
    [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot),
    [selected, setSelected] = useState(''),
    [search, setSearch] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null),
    [error, setError] = useState(''),
    [fatal, setFatal] = useState(''),
    [busy, setBusy] = useState<Set<string>>(new Set()),
    [panel, setPanel] = useState<'logs' | 'terminal'>('logs');
  const [logSelections, setLogSelections] = useState<Record<string, string>>({}),
    [terminalSelections, setTerminalSelections] = useState<Record<string, string>>({}),
    [now, setNow] = useState(Date.now());
  const configRef = useRef(config),
    busyRef = useRef(new Set<string>());
  configRef.current = config;
  const showError = useCallback((e: unknown) => setError(String(e)), []);
  const refresh = useCallback(async () => setSnapshot(await invoke<Snapshot>('snapshot')), []);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await invoke<Snapshot>('snapshot');
        if (!disposed) {
          setSnapshot(value);
          setNow(Date.now());
        }
      } catch (e) {
        if (!disposed) setError(`Connection to the desktop backend failed: ${String(e)}`);
      }
      if (!disposed) timer = setTimeout(poll, 800);
    };
    void invoke<Config>('get_config')
      .then((value) => {
        if (disposed) return;
        setConfig(value);
        setSelected(value.projects[0]?.id || '');
        void poll();
      })
      .catch((e) => {
        if (!disposed) setFatal(String(e));
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  const perform = async (key: string, work: () => Promise<void>) => {
    if (busyRef.current.has(key)) return false;
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    try {
      setError('');
      await work();
      return true;
    } catch (e) {
      showError(e);
      return false;
    } finally {
      busyRef.current.delete(key);
      setBusy(new Set(busyRef.current));
    }
  };
  const save = async (value: Config) => {
    await invoke('save_config', { config: value });
    configRef.current = value;
    setConfig(value);
  };
  const project = config?.projects.find((p) => p.id === selected);
  const runtimes = new Map(snapshot.services.map((r) => [r.id, r]));
  const running = snapshot.services.filter((s) => s.status === 'running').length;
  const projectRunning =
    project?.services.filter((s) => runtimes.get(s.id)?.status === 'running').length || 0;
  const terminals = snapshot.terminals.filter((t) => t.projectId === selected);
  const activeTerminal =
    terminals.find((t) => t.id === terminalSelections[selected])?.id || terminals[0]?.id;
  const selectedLog =
    project?.services.find((s) => s.id === logSelections[selected])?.id ||
    project?.services[0]?.id ||
    '';
  const addProject = () =>
    void perform('config', async () => {
      const root = await open({ directory: true, multiple: false, title: 'Choose a project root' });
      if (!root || Array.isArray(root)) return;
      const canonical = await invoke<string>('validate_directory', { path: root });
      const existing = configRef.current!.projects.find(
        (p) => p.root.toLowerCase() === canonical.toLowerCase(),
      );
      if (existing) {
        setSelected(existing.id);
        return;
      }
      const added: Project = {
        id: newId(),
        name: folderName(canonical),
        root: canonical,
        services: [],
      };
      await save({ ...configRef.current!, projects: [...configRef.current!.projects, added] });
      setSelected(added.id);
      setPanel('logs');
    });
  const action = (service: Service, action: string) =>
    void perform(service.id, async () => {
      await invoke('service_action', { id: service.id, action });
      await refresh();
    });
  const projectAction = (action: string) =>
    project &&
    void perform(project.id, async () => {
      await invoke('project_action', { id: project.id, action });
      await refresh();
    });
  const createTerminal = () =>
    project &&
    void perform('terminal-create', async () => {
      const id = await invoke<string>('terminal_create', {
        projectId: project.id,
        cols: 100,
        rows: 24,
      });
      await refresh();
      setTerminalSelections((old) => ({ ...old, [project.id]: id }));
      setPanel('terminal');
    });
  const closeTerminal = (id: string) =>
    void perform(id, async () => {
      await invoke('terminal_close', { id });
      await refresh();
    });
  const submitEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await perform('config', async () => {
      const current = configRef.current!;
      if (editor?.kind === 'settings')
        await save({ ...current, bashPath: String(data.get('bashPath') || '').trim() });
      if (editor?.kind === 'project') {
        const root = await invoke<string>('validate_directory', {
          path: String(data.get('root')).trim(),
        });
        await save({
          ...current,
          projects: current.projects.map((p) =>
            p.id === editor.project.id ? { ...p, name: String(data.get('name')).trim(), root } : p,
          ),
        });
      }
      if (editor?.kind === 'service') {
        const updated: Service = {
          id: editor.service.id,
          name: String(data.get('name')).trim(),
          directory: String(data.get('directory')).trim() || '.',
          command: String(data.get('command')).trim(),
        };
        await save({
          ...current,
          projects: current.projects.map((p) =>
            p.id === editor.projectId
              ? {
                  ...p,
                  services: p.services.some((s) => s.id === updated.id)
                    ? p.services.map((s) => (s.id === updated.id ? updated : s))
                    : [...p.services, updated],
                }
              : p,
          ),
        });
        setLogSelections((old) => ({ ...old, [editor.projectId]: updated.id }));
      }
      if (editor?.kind === 'remove-project') {
        await invoke('project_action', { id: editor.project.id, action: 'stop' });
        const sessions = snapshot.terminals.filter((t) => t.projectId === editor.project.id);
        for (const t of sessions) await invoke('terminal_close', { id: t.id });
        const projects = current.projects.filter((p) => p.id !== editor.project.id);
        await save({ ...current, projects });
        setSelected(projects[0]?.id || '');
        await refresh();
      }
      if (editor?.kind === 'remove-service') {
        await invoke('service_action', { id: editor.service.id, action: 'stop' });
        await save({
          ...current,
          projects: current.projects.map((p) =>
            p.id === editor.projectId
              ? { ...p, services: p.services.filter((s) => s.id !== editor.service.id) }
              : p,
          ),
        });
        await refresh();
      }
      setEditor(null);
    });
  };
  const addService = () =>
    project &&
    setEditor({
      kind: 'service',
      projectId: project.id,
      service: { id: newId(), name: '', directory: '.', command: '' },
    });
  if (!config)
    return (
      <div className="launch-screen">
        <div className="brand-mark">
          <Zap size={24} />
        </div>
        <h1>ProRun</h1>
        {fatal ? (
          <>
            <p className="fatal-error">{fatal}</p>
            <button onClick={() => location.reload()}>Try again</button>
          </>
        ) : (
          <>
            <Loader2 className="spin" size={20} />
            <p>Opening your workspace…</p>
          </>
        )}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Zap size={20} />
          </div>
          <span>
            ProRun<span className="brand-dot">.</span>
          </span>
          <span className="version-tag">DESKTOP</span>
        </div>
        <div className="workspace-label">
          <span className="workspace-avatar">L</span>
          <div>
            <strong>Local workspace</strong>
            <span>Your development, together</span>
          </div>
          <span className="local-dot" />
        </div>
        <div className="sidebar-heading">
          <span>
            PROJECTS <b>{config.projects.length}</b>
          </span>
          <button
            className="icon-button"
            onClick={addProject}
            disabled={busy.has('config')}
            aria-label="Add project"
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="search-box">
          <Search size={14} />
          <input
            aria-label="Find projects"
            placeholder="Find a project…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <nav className="project-list" aria-label="Projects">
          {config.projects
            .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
            .map((p, index) => {
              const count = p.services.filter(
                (s) => runtimes.get(s.id)?.status === 'running',
              ).length;
              return (
                <button
                  key={p.id}
                  className={`project-link ${p.id === selected ? 'active' : ''}`}
                  onClick={() => {
                    setSelected(p.id);
                    setError('');
                  }}
                >
                  <span className={`project-avatar color-${index % 4}`}>
                    {p.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="project-link-text">
                    <strong>{p.name}</strong>
                    <small>
                      {p.services.length} service{p.services.length === 1 ? '' : 's'}
                    </small>
                  </span>
                  {count > 0 ? (
                    <span className="project-running">
                      {count}
                      <i />
                    </span>
                  ) : (
                    <span className="inactive-dot" />
                  )}
                </button>
              );
            })}
          {search &&
            !config.projects.some((p) => p.name.toLowerCase().includes(search.toLowerCase())) && (
              <p className="no-results">No matching projects</p>
            )}
        </nav>
        <button className="add-project" onClick={addProject} disabled={busy.has('config')}>
          <Plus size={16} /> Add project
        </button>
        <div className="sidebar-bottom">
          <div className="global-status">
            <span className={running ? 'signal running' : 'signal'} />
            <span>
              {running
                ? `${running} service${running === 1 ? '' : 's'} running`
                : 'All services stopped'}
            </span>
          </div>
          <button
            className="settings-link"
            onClick={() => {
              setError('');
              setEditor({ kind: 'settings' });
            }}
          >
            <Settings2 size={17} /> Settings <span>Git Bash</span>
          </button>
          <div className="sidebar-footnote">
            <span>LOCAL FIRST. ALWAYS.</span>
            <span>v1.0.0</span>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div>
            <LayoutGrid size={15} />
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{project?.name || 'Overview'}</strong>
          </div>
          <span className="environment-badge">
            <span /> Local environment
          </span>
        </header>
        {error && !editor && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {!project ? (
          <div className="welcome">
            <div className="welcome-art">
              <FolderOpen size={48} />
              <span>
                <TerminalIcon size={21} />
              </span>
            </div>
            <span className="eyebrow">LESS SETUP. MORE BUILDING.</span>
            <h1>A home for your projects.</h1>
            <p>
              Bring your services, logs, and terminals into one calm workspace. Everything runs
              locally, right where you build.
            </p>
            <button className="primary" onClick={addProject} disabled={busy.has('config')}>
              <FolderPlus size={17} /> Add your first project <ArrowRight size={16} />
            </button>
            <div className="welcome-features">
              <span>
                <Server size={15} /> Multiple services
              </span>
              <span>
                <GitBranch size={15} /> Git Bash terminals
              </span>
              <span>
                <Activity size={15} /> Live output
              </span>
            </div>
          </div>
        ) : (
          <div className="project-content">
            <section className="project-header">
              <div className="project-title">
                <span className="eyebrow">PROJECT WORKSPACE</span>
                <h1>
                  {project.name}
                  <span className={projectRunning ? 'badge healthy' : 'badge'}>
                    {projectRunning ? 'Running' : 'Idle'}
                  </span>
                </h1>
                <div className="project-path" title={project.root}>
                  <Folder size={14} />
                  <span>{project.root}</span>
                  <button
                    className="icon-button"
                    aria-label="Edit project"
                    onClick={() => setEditor({ kind: 'project', project })}
                  >
                    <Pencil size={13} />
                  </button>
                </div>
              </div>
              <div className="project-controls">
                <button
                  onClick={() => projectAction('stop')}
                  disabled={!projectRunning || busy.has(project.id)}
                >
                  <Square size={13} /> Stop all
                </button>
                <button
                  className="primary"
                  onClick={() => projectAction('start')}
                  disabled={
                    !snapshot.bashPath ||
                    !project.services.length ||
                    projectRunning === project.services.length ||
                    busy.has(project.id)
                  }
                >
                  {busy.has(project.id) ? (
                    <Loader2 size={15} className="spin" />
                  ) : (
                    <Play size={15} />
                  )}{' '}
                  Run all
                </button>
              </div>
            </section>
            {!snapshot.bashPath && (
              <div className="bash-warning">
                <TerminalIcon size={19} />
                <div>
                  <strong>Connect Git Bash to get started</strong>
                  <span>Install Git for Windows, or choose bash.exe in Settings.</span>
                </div>
                <button onClick={() => setEditor({ kind: 'settings' })}>
                  Open settings <ArrowRight size={14} />
                </button>
              </div>
            )}
            <section className="metrics">
              <div className="metric">
                <span className="metric-icon green">
                  <Activity size={18} />
                </span>
                <div>
                  <span>Services running</span>
                  <strong>
                    {projectRunning}
                    <small>/ {project.services.length}</small>
                  </strong>
                </div>
                <span className={`metric-note ${projectRunning ? 'green-text' : ''}`}>
                  {projectRunning ? 'Active now' : 'Ready to run'}
                </span>
              </div>
              <div className="metric">
                <span className="metric-icon violet">
                  <TerminalIcon size={18} />
                </span>
                <div>
                  <span>Open terminals</span>
                  <strong>
                    {terminals.length}
                    <small>sessions</small>
                  </strong>
                </div>
                <span className="metric-note">Git Bash</span>
              </div>
              <div className="metric">
                <span className="metric-icon blue">
                  <Clock3 size={18} />
                </span>
                <div>
                  <span>Longest uptime</span>
                  <strong className="uptime-metric">
                    {uptime(
                      project.services.reduce<number | null>((earliest, s) => {
                        const r = runtimes.get(s.id);
                        return r?.status === 'running' && r.startedAt
                          ? Math.min(earliest || r.startedAt, r.startedAt)
                          : earliest;
                      }, null),
                      now,
                    )}
                  </strong>
                </div>
                <span className="metric-note">This project</span>
              </div>
            </section>
            <section className="services-section">
              <div className="section-heading">
                <h2>
                  Services <span>{project.services.length}</span>
                </h2>
                <button className="subtle" onClick={addService}>
                  <Plus size={15} /> Add service
                </button>
              </div>
              <div className="service-grid">
                {project.services.map((s, index) => (
                  <ServiceCard
                    key={s.id}
                    service={s}
                    runtime={runtimes.get(s.id)}
                    now={now}
                    index={index}
                    busy={busy.has(s.id) || busy.has(project.id)}
                    bashAvailable={!!snapshot.bashPath}
                    onAction={(a) => action(s, a)}
                    onEdit={() => setEditor({ kind: 'service', projectId: project.id, service: s })}
                    onDelete={() =>
                      setEditor({ kind: 'remove-service', projectId: project.id, service: s })
                    }
                    onLogs={() => {
                      setLogSelections((old) => ({ ...old, [project.id]: s.id }));
                      setPanel('logs');
                    }}
                  />
                ))}
                {!project.services.length && (
                  <button className="empty-service" onClick={addService}>
                    <span>
                      <Plus size={23} />
                    </span>
                    <strong>Add your first service</strong>
                    <small>Frontend, backend, or anything you run.</small>
                  </button>
                )}
              </div>
            </section>
            <section className="output-panel">
              <div className="panel-tabs">
                <div role="tablist" aria-label="Project output">
                  <button
                    role="tab"
                    aria-selected={panel === 'logs'}
                    className={panel === 'logs' ? 'active' : ''}
                    onClick={() => setPanel('logs')}
                  >
                    <Activity size={15} /> Service logs
                  </button>
                  <button
                    role="tab"
                    aria-selected={panel === 'terminal'}
                    className={panel === 'terminal' ? 'active' : ''}
                    onClick={() => setPanel('terminal')}
                  >
                    <TerminalIcon size={15} /> Terminals{' '}
                    {terminals.length > 0 && <span>{terminals.length}</span>}
                  </button>
                </div>
                <span className="panel-shell">
                  <GitBranch size={13} /> Git Bash
                </span>
              </div>
              {panel === 'logs' && (
                <LogsPane
                  key={project.id}
                  services={project.services}
                  selected={selectedLog}
                  onSelect={(id) => setLogSelections((old) => ({ ...old, [project.id]: id }))}
                  onError={showError}
                />
              )}
              <div className="terminals-pane" hidden={panel !== 'terminal'}>
                <div className="terminal-tabs">
                  {terminals.map((t, index) => (
                    <div
                      key={t.id}
                      className={activeTerminal === t.id ? 'terminal-tab active' : 'terminal-tab'}
                    >
                      <button
                        onClick={() =>
                          setTerminalSelections((old) => ({ ...old, [project.id]: t.id }))
                        }
                      >
                        <span className={t.alive ? 'terminal-live' : 'inactive-dot'} />
                        <span>bash {index + 1}</span>
                        {!t.alive && <small>exited</small>}
                      </button>
                      <button
                        className="close-terminal"
                        aria-label={`Close terminal ${index + 1}`}
                        disabled={busy.has(t.id)}
                        onClick={() => closeTerminal(t.id)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="new-terminal"
                    onClick={createTerminal}
                    disabled={!snapshot.bashPath || busy.has('terminal-create')}
                  >
                    <Plus size={14} /> New terminal
                  </button>
                </div>
                {snapshot.terminals.map((t) => (
                  <TerminalPane
                    id={t.id}
                    key={t.id}
                    active={panel === 'terminal' && activeTerminal === t.id}
                  />
                ))}
                {!activeTerminal && (
                  <div className="terminal-empty">
                    <TerminalIcon size={32} />
                    <h3>Your project. Your shell.</h3>
                    <p>Open an interactive Git Bash session in this project's root.</p>
                    <button
                      onClick={createTerminal}
                      disabled={!snapshot.bashPath || busy.has('terminal-create')}
                    >
                      <Plus size={15} /> Open terminal
                    </button>
                  </div>
                )}
                <div className="panel-footer">
                  <span>ConPTY · xterm-256color</span>
                  <span>Ctrl+C interrupt · Ctrl+Shift+C copy · Ctrl+Shift+V paste</span>
                </div>
              </div>
            </section>
            <footer className="workspace-footer">
              <span>
                <span className="tiny-dot" /> Changes saved automatically
              </span>
              <span>Built for your local workflow.</span>
            </footer>
          </div>
        )}
      </main>
      {editor && (
        <Modal
          title={
            editor.kind === 'settings'
              ? 'Workspace settings'
              : editor.kind === 'project'
                ? 'Edit project'
                : editor.kind === 'service'
                  ? project?.services.some((s) => s.id === editor.service.id)
                    ? 'Edit service'
                    : 'Add a service'
                  : editor.kind === 'remove-project'
                    ? 'Remove project?'
                    : 'Remove service?'
          }
          subtitle={
            editor.kind === 'service'
              ? 'Give your process a name and a Git Bash startup command.'
              : editor.kind === 'settings'
                ? 'Your shell, on your machine.'
                : 'Manage your local workspace.'
          }
          onClose={() => {
            setEditor(null);
            setError('');
          }}
          locked={busy.has('config')}
        >
          <form onSubmit={submitEditor}>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            {editor.kind === 'settings' && (
              <>
                <div className="settings-status">
                  <TerminalIcon size={22} />
                  <div>
                    <strong>
                      {snapshot.bashPath ? 'Git Bash detected' : 'Git Bash not found'}
                    </strong>
                    <span>
                      {snapshot.bashPath ||
                        'Install Git for Windows to run services and terminals.'}
                    </span>
                  </div>
                  <span className={snapshot.bashPath ? 'signal running' : 'signal'} />
                </div>
                <label>
                  Git Bash executable <span>Optional override</span>
                  <div className="path-input">
                    <input
                      name="bashPath"
                      defaultValue={config.bashPath}
                      placeholder="Automatic detection"
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Choose Git Bash executable"
                      onClick={async (e) => {
                        const input = e.currentTarget.parentElement!.querySelector('input')!;
                        try {
                          const path = await open({
                            multiple: false,
                            filters: [{ name: 'Git Bash', extensions: ['exe'] }],
                            title: 'Select Git for Windows bash.exe',
                          });
                          if (typeof path === 'string') input.value = path;
                        } catch (e) {
                          showError(e);
                        }
                      }}
                    >
                      <FolderOpen size={17} />
                    </button>
                  </div>
                </label>
                <p className="field-help">
                  Usually C:\Program Files\Git\bin\bash.exe. Leave empty to detect automatically.
                  Changes apply to new processes and sessions.
                </p>
                <div className="settings-info">
                  <strong>Everything stays local</strong>
                  <p>
                    Project settings are saved in your Windows app data folder. Logs and terminal
                    output stay in memory and are bounded. Closing ProRun stops its services and
                    terminals.
                  </p>
                  <p>
                    Interactive sessions start with a clean Git Bash environment; run{' '}
                    <code>source ~/.bashrc</code> if you want your personal shell configuration.
                  </p>
                </div>
              </>
            )}
            {editor.kind === 'project' && (
              <>
                <label>
                  Project name
                  <input name="name" required maxLength={100} defaultValue={editor.project.name} />
                </label>
                <label>
                  Root directory
                  <div className="path-input">
                    <input name="root" required defaultValue={editor.project.root} />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Choose project root"
                      onClick={async (e) => {
                        const input = e.currentTarget.parentElement!.querySelector('input')!;
                        try {
                          const path = await open({ directory: true, multiple: false });
                          if (typeof path === 'string') input.value = path;
                        } catch (e) {
                          showError(e);
                        }
                      }}
                    >
                      <FolderOpen size={17} />
                    </button>
                  </div>
                </label>
                <p className="field-help">
                  Stop the project's services and close its terminals before changing its root.
                </p>
                <button
                  type="button"
                  className="danger-link"
                  onClick={() => setEditor({ kind: 'remove-project', project: editor.project })}
                >
                  <Trash2 size={14} /> Remove this project
                </button>
              </>
            )}
            {editor.kind === 'service' && (
              <>
                <label>
                  Service name
                  <input
                    autoComplete="off"
                    name="name"
                    required
                    maxLength={80}
                    placeholder="e.g. Frontend"
                    defaultValue={editor.service.name}
                  />
                </label>
                <div className="name-presets">
                  {['Frontend', 'Backend', 'Worker', 'Database'].map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={(e) => {
                        const input = e.currentTarget.form!.elements.namedItem(
                          'name',
                        ) as HTMLInputElement;
                        input.value = name;
                        input.focus();
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <label>
                  Working directory
                  <div className="path-input">
                    <input
                      name="directory"
                      defaultValue={editor.service.directory}
                      placeholder=". or ./frontend"
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Choose service directory"
                      onClick={async (e) => {
                        const input = e.currentTarget.parentElement!.querySelector('input')!;
                        try {
                          const path = await open({
                            directory: true,
                            multiple: false,
                            defaultPath: project?.root,
                          });
                          if (typeof path === 'string') input.value = path;
                        } catch (e) {
                          showError(e);
                        }
                      }}
                    >
                      <FolderOpen size={17} />
                    </button>
                  </div>
                </label>
                <p className="field-help">
                  Relative to the project root, or an absolute Windows path. Use . for the root.
                </p>
                <label>
                  Startup command
                  <textarea
                    name="command"
                    required
                    spellCheck={false}
                    maxLength={24000}
                    rows={3}
                    placeholder="npm run dev"
                    defaultValue={editor.service.command}
                  />
                </label>
                <p className="field-help">
                  <GitBranch size={12} /> Executed directly in Git Bash. Pipes, environment
                  variables, and shell scripts are supported.
                </p>
                {runtimes.get(editor.service.id)?.status === 'running' && (
                  <div className="form-notice">Stop this service before saving changes.</div>
                )}
              </>
            )}
            {editor.kind === 'remove-project' && (
              <p className="confirmation">
                Remove <strong>{editor.project.name}</strong> from ProRun? Its services and terminal
                sessions will be stopped. Your project files will stay on disk.
              </p>
            )}
            {editor.kind === 'remove-service' && (
              <p className="confirmation">
                Remove <strong>{editor.service.name}</strong>? The service will be stopped and its
                configuration removed. Your files will stay on disk.
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  setEditor(null);
                  setError('');
                }}
                disabled={busy.has('config')}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={editor.kind.startsWith('remove') ? 'danger' : 'primary'}
                disabled={busy.has('config')}
              >
                {busy.has('config') && <Loader2 size={14} className="spin" />}
                {editor.kind.startsWith('remove')
                  ? 'Remove'
                  : editor.kind === 'service'
                    ? 'Save service'
                    : 'Save changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function ServiceCard({
  service: s,
  runtime: r,
  now,
  index,
  busy,
  bashAvailable,
  onAction,
  onEdit,
  onDelete,
  onLogs,
}: {
  service: Service;
  runtime?: Runtime;
  now: number;
  index: number;
  busy: boolean;
  bashAvailable: boolean;
  onAction: (action: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onLogs: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const status = r?.status || 'stopped';
  const running = status === 'running';
  return (
    <article className={`service-card ${running ? 'is-running' : ''}`}>
      <div className="service-card-top">
        <span className={`service-icon ${index % 2 ? 'violet' : 'blue'}`}>
          {/front|web|client/i.test(s.name) ? <Code2 size={20} /> : <Server size={20} />}
        </span>
        <div>
          <h3>{s.name}</h3>
          <span className={`service-status ${status}`}>
            <i />
            {running ? 'Running' : status === 'failed' ? 'Failed' : 'Stopped'}
          </span>
        </div>
        <div className="service-menu">
          <button
            className="icon-button"
            aria-label={`Options for ${s.name}`}
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <MoreHorizontal size={18} />
          </button>
          {menu && (
            <>
              <div className="menu-dismiss" onClick={() => setMenu(false)} />
              <div className="dropdown">
                <button
                  onClick={() => {
                    setMenu(false);
                    onEdit();
                  }}
                >
                  <Pencil size={14} /> Edit service
                </button>
                <button
                  onClick={() => {
                    setMenu(false);
                    onLogs();
                  }}
                >
                  <Activity size={14} /> View logs
                </button>
                <button
                  className="red-text"
                  onClick={() => {
                    setMenu(false);
                    onDelete();
                  }}
                >
                  <Trash2 size={14} /> Remove service
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="service-command" title={s.command}>
        <span>$</span>
        <code>{s.command}</code>
      </div>
      <div className="service-details">
        <span title={s.directory}>
          <Folder size={12} />
          {s.directory || '.'}
        </span>
        <span>
          <Clock3 size={12} />
          {running
            ? uptime(r?.startedAt || null, now)
            : r?.exitCode != null
              ? `Exit ${r.exitCode}`
              : 'Not running'}
        </span>
      </div>
      {r?.error && (
        <p className="service-error" title={r.error}>
          {r.error}
        </p>
      )}
      <div className="service-card-actions">
        <button
          className={running ? 'stop-service' : 'run-service'}
          disabled={busy || (!running && !bashAvailable)}
          onClick={() => onAction(running ? 'stop' : 'start')}
        >
          {busy ? (
            <Loader2 size={13} className="spin" />
          ) : running ? (
            <Square size={12} />
          ) : (
            <Play size={13} />
          )}{' '}
          {running ? 'Stop service' : 'Run service'}
        </button>
        <button
          className="icon-button"
          disabled={busy || !bashAvailable}
          aria-label={`Restart ${s.name}`}
          onClick={() => onAction('restart')}
        >
          <RotateCw size={15} />
        </button>
        <button className="icon-button" aria-label={`View ${s.name} logs`} onClick={onLogs}>
          <Activity size={15} />
        </button>
      </div>
    </article>
  );
}
