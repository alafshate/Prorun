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
  GripVertical,
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
import UsageTab from './UsageTab';
import ActionsPane from './ActionsPane';

type Editor =
  | { kind: 'service' | 'action'; projectId: string; service: Service }
  | { kind: 'project'; project: Project }
  | { kind: 'settings' }
  | { kind: 'remove-project'; project: Project }
  | { kind: 'remove-service' | 'remove-action'; projectId: string; service: Service };
const initialSnapshot: Snapshot = { services: [], actions: [], terminals: [], bashPath: null };
const newId = () => crypto.randomUUID();
export default function App() {
  const [view, setView] = useState<'project' | 'usage'>('project');
  const [usageAlerts, setUsageAlerts] = useState(0);
  const [config, setConfig] = useState<Config | null>(null),
    [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot),
    [selected, setSelected] = useState(''),
    [search, setSearch] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null),
    [error, setError] = useState(''),
    [fatal, setFatal] = useState(''),
    [busy, setBusy] = useState<Set<string>>(new Set()),
    [panel, setPanel] = useState<'logs' | 'actions' | 'terminal'>('logs');
  const [logSelections, setLogSelections] = useState<Record<string, string>>({}),
    [actionSelections, setActionSelections] = useState<Record<string, string>>({}),
    [terminalSelections, setTerminalSelections] = useState<Record<string, string>>({}),
    [now, setNow] = useState(Date.now());
  const [draggingProject, setDraggingProject] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<string | null>(null);
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
  const visibleProjects =
    config?.projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())) || [];
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
  const selectedAction =
    project?.actions.find((a) => a.id === actionSelections[selected])?.id ||
    project?.actions[0]?.id || '';
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
        setView('project');
        return;
      }
      const added: Project = {
        id: newId(),
        name: folderName(canonical),
        root: canonical,
        services: [],
        actions: [],
      };
      await save({ ...configRef.current!, projects: [...configRef.current!.projects, added] });
      setSelected(added.id);
      setView('project');
      setPanel('logs');
    });
  const moveProject = (
    id: string,
    targetId: string | undefined,
    focusButton?: HTMLButtonElement,
  ) => {
    if (!targetId || id === targetId) return;
    void perform('config', async () => {
      const current = configRef.current;
      if (!current) return;
      const from = current.projects.findIndex((p) => p.id === id);
      const to = current.projects.findIndex((p) => p.id === targetId);
      if (from < 0 || to < 0) return;
      const projects = [...current.projects];
      const [moved] = projects.splice(from, 1);
      projects.splice(to, 0, moved);
      await save({ ...current, projects });
      if (focusButton) requestAnimationFrame(() => focusButton.focus());
    });
  };
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
  const executeAction = (saved: Service, operation: 'start' | 'stop') =>
    void perform(saved.id, async () => {
      setActionSelections((old) => ({ ...old, [selected]: saved.id }));
      try {
        await invoke('action_execute', { id: saved.id, action: operation });
      } finally {
        await refresh();
      }
    });
  const duplicateAction = (saved: Service) =>
    project &&
    void perform('config', async () => {
      const copy = { ...saved, id: newId(), name: `${saved.name} copy` };
      await save({
        ...configRef.current!,
        projects: configRef.current!.projects.map((p) =>
          p.id === project.id ? { ...p, actions: [...p.actions, copy] } : p),
      });
      setActionSelections((old) => ({ ...old, [project.id]: copy.id }));
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
      if (editor?.kind === 'service' || editor?.kind === 'action') {
        const collection = editor.kind === 'action' ? 'actions' : 'services';
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
                  [collection]: p[collection].some((s) => s.id === updated.id)
                    ? p[collection].map((s) => (s.id === updated.id ? updated : s))
                    : [...p[collection], updated],
                }
              : p,
          ),
        });
        (editor.kind === 'action' ? setActionSelections : setLogSelections)((old) => ({
          ...old, [editor.projectId]: updated.id,
        }));
      }
      if (editor?.kind === 'remove-project') {
        await invoke('project_action', { id: editor.project.id, action: 'stop' });
        for (const a of editor.project.actions)
          await invoke('action_execute', { id: a.id, action: 'stop' });
        const sessions = snapshot.terminals.filter((t) => t.projectId === editor.project.id);
        for (const t of sessions) await invoke('terminal_close', { id: t.id });
        const projects = current.projects.filter((p) => p.id !== editor.project.id);
        await save({ ...current, projects });
        setSelected(projects[0]?.id || '');
        await refresh();
      }
      if (editor?.kind === 'remove-service' || editor?.kind === 'remove-action') {
        const collection = editor.kind === 'remove-action' ? 'actions' : 'services';
        await invoke(editor.kind === 'remove-action' ? 'action_execute' : 'service_action', {
          id: editor.service.id, action: 'stop',
        });
        await save({
          ...current,
          projects: current.projects.map((p) =>
            p.id === editor.projectId
              ? { ...p, [collection]: p[collection].filter((s) => s.id !== editor.service.id) }
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
        <button
          className={`usage-nav ${view === 'usage' ? 'active' : ''}`}
          aria-current={view === 'usage' ? 'page' : undefined}
          onClick={() => setView('usage')}
        >
          <Activity size={17} /> AI Usage
          {usageAlerts > 0 && <b aria-label={`${usageAlerts} usage alerts`}>{usageAlerts}</b>}
        </button>
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
          {visibleProjects.map((p, index) => {
            const count = p.services.filter((s) => runtimes.get(s.id)?.status === 'running').length;
            return (
              <button
                key={p.id}
                className={`project-link ${p.id === selected && view === 'project' ? 'active' : ''} ${p.id === draggingProject ? 'is-dragging' : ''} ${p.id === projectDropTarget && draggingProject && draggingProject !== p.id ? (visibleProjects.findIndex((item) => item.id === draggingProject) < index ? 'drop-after' : 'drop-before') : ''}`}
                draggable={visibleProjects.length > 1 && !busy.has('config')}
                title={
                  visibleProjects.length > 1
                    ? 'Drag to reorder · Alt+Up/Down to move · Alt+Home/End for top/bottom'
                    : undefined
                }
                aria-description="Drag to reorder. Alt+Up/Down moves one place; Alt+Home/End moves to the top or bottom."
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End"
                onDragStart={(event) => {
                  if (busyRef.current.has('config')) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('application/x-prorun-project', p.id);
                  setDraggingProject(p.id);
                }}
                onDragOver={(event) => {
                  if (!draggingProject || draggingProject === p.id || busyRef.current.has('config'))
                    return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setProjectDropTarget(p.id);
                }}
                onDrop={(event) => {
                  if (!draggingProject || busyRef.current.has('config')) return;
                  event.preventDefault();
                  moveProject(draggingProject, p.id);
                  setDraggingProject(null);
                  setProjectDropTarget(null);
                }}
                onDragEnd={() => {
                  setDraggingProject(null);
                  setProjectDropTarget(null);
                }}
                onKeyDown={(event) => {
                  if (!event.altKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
                    return;
                  event.preventDefault();
                  const target =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? visibleProjects.length - 1
                        : index + (event.key === 'ArrowUp' ? -1 : 1);
                  moveProject(p.id, visibleProjects[target]?.id, event.currentTarget);
                }}
                onClick={() => {
                  setSelected(p.id);
                  setView('project');
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
                <span className="project-trailing">
                  {count > 0 ? (
                    <span className="project-running">
                      {count}
                      <i />
                    </span>
                  ) : (
                    <span className="inactive-dot" />
                  )}
                  {config.projects.length > 1 && (
                    <GripVertical size={14} className="project-drag-handle" aria-hidden="true" />
                  )}
                </span>
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
            <strong>{view === 'usage' ? 'AI Usage' : project?.name || 'Overview'}</strong>
          </div>
          <span className="environment-badge">
            <span /> Local environment
          </span>
        </header>
        {view === 'project' && usageAlerts > 0 && (
          <div className="usage-alert usage-global-alert" role="status">
            <Activity size={16} />
            <span>
              {usageAlerts} AI usage alert{usageAlerts === 1 ? '' : 's'} · A provider reached a
              configured capacity threshold.
            </span>
            <button onClick={() => setView('usage')}>View usage</button>
          </div>
        )}
        {error && !editor && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        <UsageTab active={view === 'usage'} onAlertCount={setUsageAlerts} />
        {!project ? (
          <div className="welcome" hidden={view === 'usage'}>
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
          <div className="project-content" hidden={view === 'usage'}>
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
            <section className={`output-panel ${panel === 'actions' ? 'actions-panel' : ''}`}>
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
                    aria-selected={panel === 'actions'}
                    className={panel === 'actions' ? 'active' : ''}
                    onClick={() => setPanel('actions')}
                  >
                    <Play size={15} /> Actions{' '}
                    {project.actions.length > 0 && <span>{project.actions.length}</span>}
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
              {panel === 'actions' && (
                <ActionsPane
                  key={project.id}
                  actions={project.actions}
                  runtimes={snapshot.actions}
                  selected={selectedAction}
                  now={now}
                  busy={busy}
                  configBusy={busy.has('config')}
                  bashAvailable={!!snapshot.bashPath}
                  onSelect={(id) => setActionSelections((old) => ({ ...old, [project.id]: id }))}
                  onRun={(a) => executeAction(a, 'start')}
                  onStop={(a) => executeAction(a, 'stop')}
                  onAdd={() => setEditor({
                    kind: 'action', projectId: project.id,
                    service: { id: newId(), name: '', directory: '.', command: '' },
                  })}
                  onEdit={(a) => setEditor({ kind: 'action', projectId: project.id, service: a })}
                  onDuplicate={duplicateAction}
                  onDelete={(a) => setEditor({ kind: 'remove-action', projectId: project.id, service: a })}
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
                    active={view === 'project' && panel === 'terminal' && activeTerminal === t.id}
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
                : editor.kind === 'service' || editor.kind === 'action'
                  ? project?.[editor.kind === 'action' ? 'actions' : 'services'].some((s) => s.id === editor.service.id)
                    ? `Edit ${editor.kind}`
                    : editor.kind === 'action' ? 'Add an action' : 'Add a service'
                  : editor.kind === 'remove-project'
                    ? 'Remove project?'
                    : editor.kind === 'remove-action' ? 'Delete action?' : 'Remove service?'
          }
          subtitle={
            editor.kind === 'service' || editor.kind === 'action'
              ? editor.kind === 'action' ? 'Save a Git Bash command to run on demand.' : 'Give your process a name and a Git Bash startup command.'
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
                        'Install Git for Windows to run services, actions, and terminals.'}
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
                    output stay in memory and are bounded. Closing ProRun stops its services, actions, and
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
                  Stop the project's services and actions and close its terminals before changing its root.
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
            {(editor.kind === 'service' || editor.kind === 'action') && (
              <>
                <label>
                  {editor.kind === 'action' ? 'Action name' : 'Service name'}
                  <input
                    autoComplete="off"
                    name="name"
                    required
                    maxLength={80}
                    placeholder={editor.kind === 'action' ? 'e.g. Run tests' : 'e.g. Frontend'}
                    defaultValue={editor.service.name}
                  />
                </label>
                {editor.kind === 'service' && <div className="name-presets">
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
                </div>}
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
                      aria-label={`Choose ${editor.kind} directory`}
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
                  {editor.kind === 'action' ? 'Command' : 'Startup command'}
                  <textarea
                    name="command"
                    required
                    spellCheck={false}
                    maxLength={24000}
                    rows={3}
                    placeholder={editor.kind === 'action' ? 'npm test' : 'npm run dev'}
                    defaultValue={editor.service.command}
                  />
                </label>
                <p className="field-help">
                  <GitBranch size={12} /> Executed directly in Git Bash. Pipes, environment
                  variables, and shell scripts are supported.
                </p>
                {(editor.kind === 'action' ? snapshot.actions.find((a) => a.id === editor.service.id) : runtimes.get(editor.service.id))?.status === 'running' && (
                  <div className="form-notice">Stop this {editor.kind} before saving changes.</div>
                )}
              </>
            )}
            {editor.kind === 'remove-project' && (
              <p className="confirmation">
                Remove <strong>{editor.project.name}</strong> from ProRun? Its services, actions, and terminal
                sessions will be stopped. Your project files will stay on disk.
              </p>
            )}
            {editor.kind === 'remove-service' && (
              <p className="confirmation">
                Remove <strong>{editor.service.name}</strong>? The service will be stopped and its
                configuration removed. Your files will stay on disk.
              </p>
            )}
            {editor.kind === 'remove-action' && (
              <p className="confirmation">
                Delete <strong>{editor.service.name}</strong>? Any running execution and its child processes will be stopped, and the saved action and output removed.
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
                  ? editor.kind === 'remove-action' ? 'Delete' : 'Remove'
                  : editor.kind === 'service' || editor.kind === 'action'
                    ? `Save ${editor.kind}`
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
