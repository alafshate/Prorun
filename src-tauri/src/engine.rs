use crate::terminal_handshake::{StartupHandshake, INITIAL_CURSOR};
use crate::{model::*, windows};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

pub const LOG_LIMIT: usize = 512 * 1024;
pub const TERMINAL_LIMIT: usize = 256 * 1024;
type Shared<T> = Arc<Mutex<T>>;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub status: String,
    pub started_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct Log {
    pub seq: u64,
    pub timestamp: u64,
    pub stream: String,
    pub text: String,
}
pub struct Run {
    pub status: Status,
    pub process: Option<Arc<windows::Process>>,
    pub stopping: bool,
    logs: VecDeque<Log>,
    bytes: usize,
    sequence: u64,
    generation: u64,
}
impl Run {
    fn new(id: String) -> Self {
        Self {
            status: Status {
                id,
                status: "stopped".into(),
                started_at: None,
                exit_code: None,
                error: None,
            },
            process: None,
            stopping: false,
            logs: VecDeque::new(),
            bytes: 0,
            sequence: 0,
            generation: 0,
        }
    }
    fn log(&mut self, stream: &str, text: String) {
        self.sequence += 1;
        self.bytes += text.len();
        self.logs.push_back(Log {
            seq: self.sequence,
            timestamp: now(),
            stream: stream.into(),
            text,
        });
        while self.bytes > LOG_LIMIT || self.logs.len() > 4000 {
            if let Some(l) = self.logs.pop_front() {
                self.bytes -= l.text.len();
            } else {
                break;
            }
        }
    }
}
pub struct TerminalBuffer {
    pub alive: bool,
    pub bytes: VecDeque<u8>,
    pub offset: u64,
}
// Input can block in the OS. Keep it separate from output and ownership so a
// blocked paste cannot prevent reads, resize, session close, or app shutdown.
pub struct Terminal {
    pub project_id: String,
    pub master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub job: Arc<windows::Job>,
    pub output: Mutex<TerminalBuffer>,
}
pub struct Inner {
    pub config: Config,
    pub runs: HashMap<String, Shared<Run>>,
    pub terminals: HashMap<String, Arc<Terminal>>,
}
#[derive(Clone)]
pub struct Engine {
    pub inner: Shared<Inner>,
    pub config_path: PathBuf,
}

impl Engine {
    pub fn open(config_path: PathBuf) -> Result<Self, String> {
        let config = if config_path.exists() {
            let data =
                fs::read(&config_path).map_err(|e| format!("Cannot read configuration: {e}"))?;
            let config:Config=serde_json::from_slice(&data).map_err(|e|format!("Configuration is damaged. Restore {} from a backup before starting ProRun: {e}",config_path.display()))?;
            config.validate()?;
            config
        } else {
            Config::default()
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                config,
                runs: HashMap::new(),
                terminals: HashMap::new(),
            })),
            config_path,
        })
    }
    pub fn save(&self, config: Config) -> Result<(), String> {
        config.validate()?;
        let mut inner = self.inner.lock().unwrap();
        if config.bash_path != inner.config.bash_path
            && !config.bash_path.trim().is_empty()
            && find_bash(&config.bash_path).is_none()
        {
            return Err("Select Git for Windows' bin/bash.exe or usr/bin/bash.exe".into());
        }
        for old in &inner.config.projects {
            let next = config.projects.iter().find(|p| p.id == old.id);
            for service in &old.services {
                let changed = next
                    .map(|p| {
                        p.root != old.root
                            || p.services.iter().find(|s| s.id == service.id) != Some(service)
                    })
                    .unwrap_or(true);
                if changed
                    && inner
                        .runs
                        .get(&service.id)
                        .map(|r| r.lock().unwrap().status.status == "running")
                        .unwrap_or(false)
                {
                    return Err(format!(
                        "Stop {} before editing or removing its configuration",
                        service.name
                    ));
                }
            }
            if next.map(|p| p.root != old.root).unwrap_or(true)
                && inner.terminals.values().any(|t| t.project_id == old.id)
            {
                return Err("Close this project's terminal sessions before changing its root or removing it".into());
            }
        }
        fs::create_dir_all(self.config_path.parent().unwrap()).map_err(|e| e.to_string())?;
        let temp = self.config_path.with_extension("json.tmp");
        let data = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
        let mut file = File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        windows::replace(&temp, &self.config_path)?;
        let ids: Vec<_> = config
            .projects
            .iter()
            .flat_map(|p| p.services.iter().map(|s| s.id.clone()))
            .collect();
        inner.runs.retain(|id, _| ids.contains(id));
        inner.config = config;
        Ok(())
    }
    pub fn start(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if inner
            .runs
            .get(id)
            .map(|r| r.lock().unwrap().status.status == "running")
            .unwrap_or(false)
        {
            return Ok(());
        }
        let (project, service) = inner
            .config
            .projects
            .iter()
            .find_map(|p| {
                p.services
                    .iter()
                    .find(|s| s.id == id)
                    .map(|s| (p.clone(), s.clone()))
            })
            .ok_or("Service no longer exists")?;
        let run = inner
            .runs
            .entry(id.into())
            .or_insert_with(|| Arc::new(Mutex::new(Run::new(id.into()))))
            .clone();
        let generation = {
            let mut r = run.lock().unwrap();
            r.generation += 1;
            r.stopping = false;
            r.status.error = None;
            r.status.exit_code = None;
            r.status.started_at = None;
            r.generation
        };
        let result = (|| {
            let bash = find_bash(&inner.config.bash_path).ok_or(
                "Git Bash was not found. Install Git for Windows or set its path in Settings.",
            )?;
            directory(&project.root)?;
            let cwd = service_directory(&project, &service)?;
            let (process, out, err) = windows::spawn(&bash, &cwd, &service.command)?;
            Ok::<_, String>((Arc::new(process), out, err))
        })();
        let (process, out, err) = match result {
            Ok(v) => v,
            Err(e) => {
                let mut r = run.lock().unwrap();
                r.status.status = "failed".into();
                r.status.error = Some(e.clone());
                r.log("system", format!("Startup failed: {e}\n"));
                return Err(e);
            }
        };
        {
            let mut r = run.lock().unwrap();
            r.status.status = "running".into();
            r.status.started_at = Some(now());
            r.process = Some(process.clone());
            r.log("system", format!("$ {}\n", service.command));
        }
        read_logs(out, run.clone(), "stdout");
        read_logs(err, run.clone(), "stderr");
        thread::spawn(move || {
            let code = process.wait();
            // A launcher that exits must not leave its server descendants orphaned.
            process.job.terminate();
            let mut r = run.lock().unwrap();
            if r.generation != generation {
                return;
            }
            r.status.exit_code = Some(code);
            r.status.status = if r.stopping || code == 0 {
                "stopped"
            } else {
                "failed"
            }
            .into();
            r.process = None;
            r.log("system", format!("Process exited with code {code}\n"));
        });
        Ok(())
    }
    pub fn stop(&self, id: &str) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let run = inner.runs.get(id).cloned();
        if let Some(run) = run {
            let process = {
                let mut r = run.lock().unwrap();
                r.stopping = true;
                r.process.clone()
            };
            if let Some(p) = process {
                p.stop();
                let mut r = run.lock().unwrap();
                r.status.status = "stopped".into();
                r.status.exit_code = Some(1);
                r.process = None;
            }
        }
        Ok(())
    }
    pub fn project_action(&self, id: &str, action: &str) -> Result<(), String> {
        let services = self
            .inner
            .lock()
            .unwrap()
            .config
            .projects
            .iter()
            .find(|p| p.id == id)
            .ok_or("Project no longer exists")?
            .services
            .clone();
        let mut errors = vec![];
        for s in services {
            let result = if action == "start" {
                self.start(&s.id)
            } else {
                self.stop(&s.id)
            };
            if let Err(e) = result {
                errors.push(format!("{}: {e}", s.name));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("\n"))
        }
    }
    pub fn terminal_create(
        &self,
        project_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        let mut inner = self.inner.lock().unwrap();
        let project = inner
            .config
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or("Project no longer exists")?;
        let cwd = directory(&project.root)?;
        let bash = find_bash(&inner.config.bash_path)
            .ok_or("Git Bash was not found. Configure it in Settings.")?;
        let pair = native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(|e| format!("Cannot open Windows ConPTY: {e}"))?;
        let mut command = CommandBuilder::new(&bash);
        // No startup files until containment is in place. This also guarantees cwd.
        command.args(["--noprofile", "--norc", "-i"]);
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("CHERE_INVOKING", "1");
        command.env("MSYSTEM", "MINGW64");
        command.env("npm_config_script_shell", &bash);
        command.env(
            "PS1",
            "\\[\\e[38;5;78m\\]\\u@ProRun\\[\\e[0m\\] \\[\\e[38;5;111m\\]\\w\\[\\e[0m\\]\\n$ ",
        );
        let parent = bash.parent().unwrap();
        let git_root = if parent.join("msys-2.0.dll").exists() {
            parent.parent().unwrap().parent().unwrap()
        } else {
            parent.parent().unwrap()
        };
        let existing = std::env::var("PATH").unwrap_or_default();
        command.env(
            "PATH",
            format!(
                "{};{};{};{existing}",
                git_root.join("mingw64/bin").display(),
                git_root.join("usr/bin").display(),
                git_root.join("bin").display()
            ),
        );
        let job = Arc::new(windows::Job::new()?);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("Cannot start Git Bash: {e}"))?;
        let containment = child
            .process_id()
            .ok_or_else(|| "PTY did not return a process ID".to_string())
            .and_then(|pid| job.assign_pid(pid));
        if let Err(e) = containment {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Cannot contain terminal process tree: {e}"));
        }
        drop(pair.slave);
        let mut reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                job.terminate();
                return Err(e.to_string());
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                job.terminate();
                return Err(e.to_string());
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        let terminal = Arc::new(Terminal {
            project_id: project_id.into(),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(writer),
            job: job.clone(),
            output: Mutex::new(TerminalBuffer {
                alive: true,
                bytes: VecDeque::new(),
                offset: 0,
            }),
        });
        inner.terminals.insert(id.clone(), terminal.clone());
        let (startup_sender, startup_receiver) = std::sync::mpsc::sync_channel(1);
        let output = Arc::downgrade(&terminal);
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut handshake = StartupHandshake::default();
            let mut startup_sender = Some(startup_sender);
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Err(error) => {
                        if let Some(sender) = startup_sender.take() {
                            let _ =
                                sender.send(Err(format!("Cannot read terminal startup: {error}")));
                        }
                        break;
                    }
                    Ok(n) => {
                        let Some(output) = output.upgrade() else {
                            break;
                        };
                        let (bytes, answer_cursor) = handshake.feed(&buffer[..n]);
                        if answer_cursor {
                            let result = {
                                let mut writer = output.writer.lock().unwrap();
                                writer
                                    .write_all(INITIAL_CURSOR)
                                    .and_then(|_| writer.flush())
                                    .map_err(|error| {
                                        format!("Cannot initialize terminal cursor: {error}")
                                    })
                            };
                            let failed = result.is_err();
                            if let Some(sender) = startup_sender.take() {
                                let _ = sender.send(result);
                            }
                            if failed {
                                break;
                            }
                        }
                        let mut t = output.output.lock().unwrap();
                        t.bytes.extend(bytes);
                        while t.bytes.len() > TERMINAL_LIMIT {
                            t.bytes.pop_front();
                            t.offset += 1;
                        }
                    }
                }
            }
            if let Some(sender) = startup_sender.take() {
                let _ = sender.send(Err(
                    "Terminal exited before its startup handshake completed".into(),
                ));
            }
            if let Some(output) = output.upgrade() {
                output.output.lock().unwrap().alive = false;
                output.job.terminate();
            }
        });
        thread::spawn(move || {
            let _ = child.wait();
            job.terminate();
            // Closing the pseudoconsole drains its final output and releases
            // the reader. The reader marks the session exited after that drain.
            let master = terminal.master.lock().unwrap().take();
            drop(master);
        });
        let startup = startup_receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| format!("ConPTY cursor initialization did not complete: {error}"))
            .and_then(|result| result);
        drop(inner);
        if let Err(error) = startup {
            // ConPTY must also receive a reply before closing a failed startup;
            // otherwise ClosePseudoConsole can wait indefinitely for the cursor.
            if let Ok(terminal) = self.terminal(&id) {
                let mut writer = terminal.writer.lock().unwrap();
                let _ = writer
                    .write_all(INITIAL_CURSOR)
                    .and_then(|_| writer.flush());
            }
            self.terminal_close(&id);
            return Err(error);
        }
        Ok(id)
    }
    pub fn terminal(&self, id: &str) -> Result<Arc<Terminal>, String> {
        self.inner
            .lock()
            .unwrap()
            .terminals
            .get(id)
            .cloned()
            .ok_or("Terminal session is closed".into())
    }
    pub fn terminal_close(&self, id: &str) {
        let terminal = self.inner.lock().unwrap().terminals.remove(id);
        if let Some(t) = terminal {
            t.output.lock().unwrap().alive = false;
            t.job.terminate();
            // Close ConPTY independently of an outstanding input write.
            let master = t.master.lock().unwrap().take();
            drop(master);
        }
    }
    pub fn shutdown(&self) {
        let (runs, terminals) = {
            let inner = self.inner.lock().unwrap();
            (
                inner.runs.keys().cloned().collect::<Vec<_>>(),
                inner.terminals.keys().cloned().collect::<Vec<_>>(),
            )
        };
        for id in terminals {
            self.terminal_close(&id);
        }
        for id in runs {
            let _ = self.stop(&id);
        }
    }
    pub fn logs(&self, id: &str, after: u64) -> Vec<Log> {
        self.inner
            .lock()
            .unwrap()
            .runs
            .get(id)
            .map(|r| {
                r.lock()
                    .unwrap()
                    .logs
                    .iter()
                    .filter(|l| l.seq > after)
                    .take(256)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn clear_logs(&self, id: &str) {
        if let Some(r) = self.inner.lock().unwrap().runs.get(id) {
            let mut r = r.lock().unwrap();
            r.logs.clear();
            r.bytes = 0;
        }
    }
}
pub fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=1000).contains(&cols) || !(1..=500).contains(&rows) {
        return Err("Invalid terminal dimensions".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn read_logs(mut reader: File, run: Shared<Run>, stream: &'static str) {
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => {
                    if !pending.is_empty() {
                        run.lock()
                            .unwrap()
                            .log(stream, String::from_utf8_lossy(&pending).into_owned());
                    }
                    break;
                }
                Ok(n) => {
                    pending.extend_from_slice(&buffer[..n]);
                    let consumed = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    if consumed > 0 {
                        run.lock().unwrap().log(
                            stream,
                            String::from_utf8_lossy(&pending[..consumed]).into_owned(),
                        );
                        pending.drain(..consumed);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn log_memory_is_bounded() {
        let mut r = Run::new("test".into());
        for _ in 0..1000 {
            r.log("stdout", "x".repeat(4096));
        }
        assert!(r.bytes <= LOG_LIMIT);
        assert_eq!(r.sequence, 1000);
    }
    #[test]
    fn pathological_dimensions_rejected() {
        assert!(size(0, 20).is_err());
        assert!(size(80, 24).is_ok());
    }
    #[test]
    fn service_tree_and_streams() {
        let root = std::env::temp_dir().join(format!("prorun test Ω {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let engine = Engine::open(root.join("config.json")).unwrap();
        let service=Service{id:"s".into(),name:"Test".into(),directory:".".into(),command:r#"printf 'hello stdout'; printf 'hello stderr' >&2; printf '%s\n' 'space " $literal ; && \'; sleep 30 & wait"#.into()};
        let config = Config {
            version: 1,
            bash_path: String::new(),
            projects: vec![Project {
                id: "p".into(),
                name: "Test".into(),
                root: root.to_string_lossy().into(),
                services: vec![service],
            }],
        };
        engine.save(config).unwrap();
        engine.start("s").unwrap();
        engine.start("s").unwrap();
        thread::sleep(std::time::Duration::from_millis(1500));
        let logs = engine.logs("s", 0);
        assert!(logs
            .iter()
            .any(|l| l.stream == "stdout" && l.text.contains("hello stdout")));
        assert!(logs
            .iter()
            .any(|l| l.stream == "stderr" && l.text.contains("hello stderr")));
        assert!(logs
            .iter()
            .any(|l| l.stream == "stdout" && l.text.contains(r#"space " $literal ; && \"#)));
        let process = engine.inner.lock().unwrap().runs["s"]
            .lock()
            .unwrap()
            .process
            .clone()
            .unwrap();
        assert!(
            process.job.active_processes() >= 2,
            "Bash and its sleeping descendant must both be contained"
        );
        engine.stop("s").unwrap();
        assert_eq!(
            engine.inner.lock().unwrap().runs["s"]
                .lock()
                .unwrap()
                .status
                .status,
            "stopped"
        );
        for _ in 0..100 {
            if process.job.active_processes() == 0 {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(
            process.job.active_processes(),
            0,
            "Stop must terminate the entire tree"
        );
        engine.start("s").unwrap();
        engine.stop("s").unwrap();
        assert_eq!(
            Engine::open(root.join("config.json"))
                .unwrap()
                .inner
                .lock()
                .unwrap()
                .config
                .projects
                .len(),
            1
        );
        engine.shutdown();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interactive_git_bash_pty() {
        let root = std::env::temp_dir().join(format!("prorun-pty-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let engine = Engine::open(root.join("config.json")).unwrap();
        engine
            .save(Config {
                version: 1,
                bash_path: String::new(),
                projects: vec![Project {
                    id: "p".into(),
                    name: "PTY".into(),
                    root: root.to_string_lossy().into(),
                    services: vec![],
                }],
            })
            .unwrap();
        let id = engine.terminal_create("p", 80, 24).unwrap();
        let other = engine.terminal_create("p", 80, 24).unwrap();
        assert_ne!(id, other);
        let terminal = engine.terminal(&id).unwrap();
        {
            let state = terminal.output.lock().unwrap();
            let output = String::from_utf8_lossy(&state.bytes.iter().copied().collect::<Vec<_>>())
                .into_owned();
            assert!(
                state.alive,
                "Git Bash exited during startup; captured output: {output:?}"
            );
        }
        {
            terminal
                .master
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .resize(size(120, 30).unwrap())
                .unwrap();
            let mut writer = terminal.writer.lock().unwrap();
            writer.write_all(b"printf '\\033[32mPTY_OK\\033[0m\\n'; pwd; printf '\\344\\275\\240\\345\\245\\275\\n'\r").unwrap();
            writer.flush().unwrap();
        }
        let mut output = String::new();
        for _ in 0..150 {
            thread::sleep(std::time::Duration::from_millis(30));
            output = String::from_utf8_lossy(
                &terminal
                    .output
                    .lock()
                    .unwrap()
                    .bytes
                    .iter()
                    .copied()
                    .collect::<Vec<_>>(),
            )
            .into_owned();
            if output.contains("PTY_OK") && output.contains("你好") {
                break;
            }
        }
        assert!(
            output.contains("PTY_OK"),
            "Git Bash PTY did not execute input; captured output: {output:?}"
        );
        assert!(output.contains("你好"));
        assert!(output.contains(root.file_name().unwrap().to_string_lossy().as_ref()));
        let job = terminal.job.clone();
        engine.terminal_close(&id);
        drop(terminal);
        for _ in 0..100 {
            if job.active_processes() == 0 {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(job.active_processes(), 0);
        assert!(
            engine
                .terminal(&other)
                .unwrap()
                .output
                .lock()
                .unwrap()
                .alive
        );
        engine.shutdown();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn conpty_startup_and_close_without_frontend() {
        let root =
            std::env::temp_dir().join(format!("prorun-startup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let engine = Engine::open(root.join("config.json")).unwrap();
        engine
            .save(Config {
                version: 1,
                bash_path: String::new(),
                projects: vec![Project {
                    id: "p".into(),
                    name: "Startup".into(),
                    root: root.to_string_lossy().into(),
                    services: vec![],
                }],
            })
            .unwrap();
        let id = engine
            .terminal_create("p", 80, 24)
            .expect("ConPTY must initialize without a frontend responding to its cursor query");
        let terminal = engine.terminal(&id).unwrap();
        let output: Vec<_> = terminal
            .output
            .lock()
            .unwrap()
            .bytes
            .iter()
            .copied()
            .collect();
        assert!(
            !output.windows(4).any(|bytes| bytes == b"\x1b[6n"),
            "The emulator must not receive a second copy of the initial query"
        );
        let job = terminal.job.clone();
        engine.terminal_close(&id);
        drop(terminal);
        for _ in 0..100 {
            if job.active_processes() == 0 {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(job.active_processes(), 0);
        engine.shutdown();
        fs::remove_dir_all(root).unwrap();
    }
}
