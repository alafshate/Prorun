use crate::{engine::Engine, model::*};
use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

struct Workspace {
    root: PathBuf,
    engine: Engine,
}
impl Workspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("prorun actions Ω {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested Ω")).unwrap();
        let engine = Engine::open(root.join("config.json")).unwrap();
        engine
            .save(Config {
                version: 1,
                bash_path: String::new(),
                projects: vec![Project {
                    id: "p".into(),
                    name: "Actions".into(),
                    root: root.to_string_lossy().into(),
                    services: vec![],
                    actions: vec![],
                }],
            })
            .unwrap();
        Self { root, engine }
    }
    fn config(&self) -> Config {
        self.engine.inner.lock().unwrap().config.clone()
    }
    fn status(&self, id: &str) -> crate::engine::Status {
        self.engine.inner.lock().unwrap().actions[id]
            .lock()
            .unwrap()
            .status
            .clone()
    }
    fn wait(&self, id: &str) -> crate::engine::Status {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = self.status(id);
            if status.status != "running" {
                return status;
            }
            assert!(Instant::now() < deadline, "Action did not finish: {id}");
            thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        self.engine.shutdown();
        // Windows can retain a process's working directory briefly after exit.
        for _ in 0..100 {
            if fs::remove_dir_all(&self.root).is_ok() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
fn action(id: &str, command: &str) -> Action {
    Action {
        id: id.into(),
        name: id.into(),
        directory: ".".into(),
        command: command.into(),
    }
}

#[test]
fn actions_persist_edits_duplicates_and_deletions_per_project() {
    let w = Workspace::new();
    let mut config = w.config();
    config.projects[0].actions = vec![action("a", "printf original")];
    w.engine.save(config.clone()).unwrap();
    config.projects[0].actions[0].command = "printf edited".into();
    config.projects[0].actions[0].directory = "nested Ω".into();
    let mut copy = config.projects[0].actions[0].clone();
    copy.id = "copy".into();
    copy.name = "a copy".into();
    config.projects[0].actions.push(copy);
    let mut other = config.projects[0].clone();
    other.id = "other-project".into();
    other.actions = vec![action("other", "printf independent")];
    config.projects.push(other);
    w.engine.save(config.clone()).unwrap();
    config.projects[0].actions.remove(0);
    w.engine.save(config.clone()).unwrap();
    let restored = Engine::open(w.root.join("config.json")).unwrap();
    assert!(restored.inner.lock().unwrap().config.projects == config.projects);
    assert!(
        restored.inner.lock().unwrap().actions.is_empty(),
        "Runtime state must not persist"
    );
}

#[test]
fn actions_report_invalid_directories_and_missing_git_bash() {
    let w = Workspace::new();
    let mut config = w.config();
    let mut a = action("a", "printf test");
    a.directory = "missing-directory".into();
    config.projects[0].actions.push(a);
    w.engine.save(config.clone()).unwrap();
    assert!(w
        .engine
        .start_action("a")
        .unwrap_err()
        .contains("Directory does not exist"));
    assert_eq!(w.status("a").status, "failed");
    assert!(w.status("a").exit_code.is_none());
    assert!(w
        .engine
        .action_logs("a", 0)
        .iter()
        .any(|l| l.text.contains("Startup failed")));
    config.projects[0].actions[0].directory = ".".into();
    w.engine.save(config).unwrap();
    // Simulate a previously configured Git installation being removed.
    w.engine.inner.lock().unwrap().config.bash_path =
        w.root.join("missing-bash.exe").to_string_lossy().into();
    assert!(w
        .engine
        .start_action("a")
        .unwrap_err()
        .contains("Git Bash was not found"));
    assert_eq!(w.status("a").status, "failed");
    assert!(w.engine.inner.lock().unwrap().runs.is_empty());
}

#[test]
fn actions_capture_streams_working_directory_exit_codes_and_clear_output() {
    let w = Workspace::new();
    let mut config = w.config();
    let mut a = action("success", "printf 'hello stdout Ω'; printf 'hello stderr' >&2; pwd; printf '%s' \"$BASH_VERSION\"; sleep 0.1");
    a.directory = "nested Ω".into();
    let mut absolute = action("absolute", "pwd");
    absolute.directory = w.root.join("nested Ω").to_string_lossy().into();
    config.projects[0].actions = vec![
        a,
        absolute,
        action("failure", "printf failure >&2; exit 7"),
        action("missing-command", "prorun_nonexistent_command_402598"),
    ];
    w.engine.save(config).unwrap();
    for id in ["success", "absolute", "failure", "missing-command"] {
        w.engine.start_action(id).unwrap();
    }
    let success = w.wait("success");
    assert_eq!(success.status, "success");
    assert_eq!(success.exit_code, Some(0));
    assert!(success.ended_at.unwrap() >= success.started_at.unwrap());
    let logs = w.engine.action_logs("success", 0);
    assert!(logs
        .iter()
        .any(|l| l.stream == "stdout" && l.text.contains("hello stdout Ω")));
    assert!(logs
        .iter()
        .any(|l| l.stream == "stderr" && l.text.contains("hello stderr")));
    assert!(logs
        .iter()
        .any(|l| l.stream == "stdout" && l.text.contains("nested Ω")));
    assert_eq!(w.wait("absolute").status, "success");
    assert!(w
        .engine
        .action_logs("absolute", 0)
        .iter()
        .any(|l| l.stream == "stdout" && l.text.contains("nested Ω")));
    assert_eq!(w.wait("failure").exit_code, Some(7));
    assert_eq!(w.status("failure").status, "failed");
    assert_eq!(w.wait("missing-command").exit_code, Some(127));
    assert!(
        w.engine.logs("success", 0).is_empty(),
        "Service logs must remain separate"
    );
    w.engine.clear_logs("success");
    assert!(!w.engine.action_logs("success", 0).is_empty());
    let cursor = logs.last().unwrap().seq;
    w.engine.clear_action_logs("success");
    assert!(w.engine.action_logs("success", 0).is_empty());
    w.engine.start_action("success").unwrap();
    assert_eq!(w.wait("success").status, "success");
    assert!(w
        .engine
        .action_logs("success", cursor)
        .iter()
        .all(|l| l.seq > cursor));
}

#[test]
fn actions_are_isolated_from_run_all_and_stop_all() {
    let w = Workspace::new();
    let mut config = w.config();
    config.projects[0]
        .actions
        .push(action("a", "sleep 30 & wait"));
    config.projects[0]
        .services
        .push(action("s", "sleep 30 & wait"));
    w.engine.save(config).unwrap();
    w.engine.project_action("p", "start").unwrap();
    assert!(
        w.engine.inner.lock().unwrap().actions.is_empty(),
        "Run all cannot launch actions"
    );
    assert!(w.engine.start("a").is_err());
    assert!(w.engine.start_action("s").is_err());
    w.engine.start_action("a").unwrap();
    w.engine.project_action("p", "stop").unwrap();
    assert_eq!(
        w.status("a").status,
        "running",
        "Stop all only stops services"
    );
    w.engine.project_action("p", "start").unwrap();
    w.engine.stop_action("a").unwrap();
    assert_eq!(
        w.engine.inner.lock().unwrap().runs["s"]
            .lock()
            .unwrap()
            .status
            .status,
        "running"
    );
}

#[test]
fn actions_allow_concurrency_block_duplicate_runs_and_terminate_owned_trees() {
    let w = Workspace::new();
    let mut config = w.config();
    config.projects[0].actions = vec![
        action("a", "printf marker; sleep 30 & wait"),
        action("b", "sleep 30 & wait"),
    ];
    w.engine.save(config.clone()).unwrap();
    let first = w.engine.clone();
    let second = w.engine.clone();
    let start = thread::spawn(move || first.start_action("a"));
    let duplicate = thread::spawn(move || second.start_action("a"));
    start.join().unwrap().unwrap();
    duplicate.join().unwrap().unwrap();
    w.engine.start_action("b").unwrap();
    let process = w.engine.inner.lock().unwrap().actions["a"]
        .lock()
        .unwrap()
        .process
        .clone()
        .unwrap();
    let other = w.engine.inner.lock().unwrap().actions["b"]
        .lock()
        .unwrap()
        .process
        .clone()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while process.job.active_processes() < 2 || other.job.active_processes() < 2 {
        assert!(Instant::now() < deadline, "Actions must own their children");
        thread::sleep(Duration::from_millis(20));
    }
    let marker = w
        .engine
        .action_logs("a", 0)
        .iter()
        .filter(|l| l.stream == "system" && l.text.contains("$ "))
        .count();
    assert_eq!(
        marker, 1,
        "Duplicate requests cannot launch a second execution"
    );
    let mut edited = config.clone();
    edited.projects[0].actions[0].command = "printf changed".into();
    assert!(w.engine.save(edited).is_err());
    let mut moved = config.clone();
    moved.projects[0].root = w.root.join("nested Ω").to_string_lossy().into();
    assert!(w.engine.save(moved).is_err());
    let mut removed = config.clone();
    removed.projects.clear();
    assert!(w.engine.save(removed).is_err());
    w.engine.stop_action("a").unwrap();
    assert_eq!(w.status("a").status, "idle");
    assert!(w.status("a").ended_at.is_some());
    let deadline = Instant::now() + Duration::from_secs(5);
    while process.job.active_processes() != 0 {
        assert!(Instant::now() < deadline, "Stop must kill all descendants");
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(w.status("b").status, "running");
    assert!(other.job.active_processes() > 0);
    // Restart immediately, before the previous monitor necessarily finishes.
    w.engine.start_action("a").unwrap();
    w.engine.stop_action("a").unwrap();
    config.projects[0].actions.remove(0);
    w.engine.save(config).unwrap();
    assert!(!w.engine.inner.lock().unwrap().actions.contains_key("a"));
    w.engine.shutdown();
    assert_eq!(w.status("b").status, "idle");
    let deadline = Instant::now() + Duration::from_secs(5);
    while other.job.active_processes() != 0 {
        assert!(
            Instant::now() < deadline,
            "Shutdown must kill action descendants"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        w.engine.start_action("b").is_err(),
        "Shutdown must reject late launches"
    );
}
