//! Local usage metadata only. This service never touches the project engine,
//! terminal handles, auth files, prompts, or undocumented HTTP endpoints.
use crate::model::{now, Project};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, SystemTime},
};

const MAX_LINE: usize = 2 * 1024 * 1024;
const SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECORDS: usize = 500_000;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub codex_executable: String,
    pub codex_home: String,
    pub claude_home: String,
    pub claude_snapshot: String,
    pub alerts: Vec<u8>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub cached: u64,
    pub cache_write: u64,
    pub cache_write_hour: u64,
    pub output: u64,
    /// Included in output, never added to totals a second time.
    pub reasoning: u64,
}
impl Tokens {
    fn values(&self) -> [u64; 6] {
        [
            self.input,
            self.cached,
            self.cache_write,
            self.cache_write_hour,
            self.output,
            self.reasoning,
        ]
    }
    fn from_values(v: [u64; 6]) -> Self {
        Self {
            input: v[0],
            cached: v[1],
            cache_write: v[2],
            cache_write_hour: v[3],
            output: v[4],
            reasoning: v[5],
        }
    }
    fn max(&self, other: &Self) -> Self {
        Self::from_values(std::array::from_fn(|i| {
            self.values()[i].max(other.values()[i])
        }))
    }
    fn delta(&self, previous: &Self) -> Self {
        Self::from_values(std::array::from_fn(|i| {
            self.values()[i].saturating_sub(previous.values()[i])
        }))
    }
    fn add(&mut self, other: &Self) {
        *self = Self::from_values(std::array::from_fn(|i| {
            self.values()[i].saturating_add(other.values()[i])
        }));
    }
    fn total(&self) -> u64 {
        self.input + self.cached + self.cache_write + self.cache_write_hour + self.output
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub used_percent: f64,
    pub resets_at: Option<u64>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub five_hour: Option<Limit>,
    pub weekly: Option<Limit>,
    pub refreshed_at: u64,
    pub observed_at: Option<u64>,
    pub source: String,
    pub message: String,
}
impl Provider {
    fn empty(id: &str, source: &str) -> Self {
        Self {
            id: id.into(),
            five_hour: None,
            weekly: None,
            refreshed_at: now(),
            observed_at: None,
            source: source.into(),
            message: String::new(),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub timestamp: u64,
    pub provider: String,
    pub project: String,
    pub model: String,
    pub tokens: Tokens,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub refreshed_at: u64,
    pub providers: Vec<Provider>,
    pub buckets: Vec<Bucket>,
    pub sessions: usize,
    pub files: usize,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub enabled: bool,
    pub existing_status_line: bool,
    pub settings_path: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureBackup {
    settings_path: PathBuf,
    original: Value,
    command: String,
}

#[derive(Clone)]
struct Record {
    at: u64,
    provider: String,
    session: String,
    project: String,
    model: String,
    key: String,
    tokens: Tokens,
    last: Option<Tokens>,
}
#[derive(Default)]
struct LogFile {
    offset: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    pending: Vec<u8>,
    oversized: bool,
    session: String,
    project: String,
    model: String,
    parent: String,
    started: u64,
    records: Vec<Record>,
    malformed: usize,
    regressed: bool,
}
impl LogFile {
    fn parse(&mut self, value: Value, provider: &str) {
        let kind = string(&value, "type");
        let at = timestamp(&value["timestamp"]);
        if provider == "codex" {
            let p = &value["payload"];
            if kind == "session_meta" {
                self.session = string(p, "id");
                self.project = string(p, "cwd");
                self.parent = string(p, "forked_from_id");
                self.started = timestamp(&p["timestamp"]);
                self.model = string(p, "model");
            } else if kind == "turn_context" {
                if let Some(model) = p["model"].as_str() {
                    self.model = model.into();
                }
                if let Some(cwd) = p["cwd"].as_str() {
                    self.project = cwd.into();
                }
            } else if kind == "event_msg"
                && p["type"] == "token_count"
                && p["info"]["total_token_usage"].is_object()
            {
                let t = &p["info"]["total_token_usage"];
                // Keep raw cumulative counters until AFTER differencing. Subtracting
                // cache totals before differencing loses fresh-input transitions.
                let tokens = codex_tokens(t);
                let last = p["info"]["last_token_usage"]
                    .is_object()
                    .then(|| codex_tokens(&p["info"]["last_token_usage"]));
                let session = if !self.parent.is_empty() && at < self.started {
                    self.parent.clone()
                } else {
                    self.session.clone()
                };
                if at > 0 && !session.is_empty() {
                    if self.records.last().is_some_and(|r| {
                        r.key == session
                            && tokens
                                .values()
                                .iter()
                                .zip(r.tokens.values())
                                .any(|(n, p)| *n < p)
                    }) {
                        self.regressed = true;
                    }
                    self.records.push(Record {
                        at,
                        provider: provider.into(),
                        session: session.clone(),
                        project: self.project.clone(),
                        model: self.model.clone(),
                        key: session,
                        tokens,
                        last,
                    });
                }
            }
        } else if kind == "assistant" && value["message"]["usage"].is_object() {
            let m = &value["message"];
            let t = &m["usage"];
            let id = string(m, "id");
            // A message may occur in several streaming records, resumed logs, and
            // subagent copies. Identity is independent of file and session ID.
            if at == 0 || id.is_empty() {
                return;
            }
            let hour = number(&t["cache_creation"], "ephemeral_1h_input_tokens");
            let tokens = Tokens {
                input: number(t, "input_tokens"),
                cached: number(t, "cache_read_input_tokens"),
                // Keep total writes raw until streaming duplicates have merged:
                // earlier partial records may not yet include their TTL split.
                cache_write: number(t, "cache_creation_input_tokens"),
                cache_write_hour: hour,
                output: number(t, "output_tokens"),
                reasoning: number(&t["output_tokens_details"], "thinking_tokens"),
            };
            self.records.push(Record {
                at,
                provider: provider.into(),
                session: string(&value, "sessionId"),
                project: string(&value, "cwd"),
                model: string(m, "model"),
                key: id,
                tokens,
                last: None,
            });
        }
    }
    fn read(&mut self, path: &Path, provider: &str, budget: &mut u64) -> Result<bool, String> {
        let meta =
            fs::metadata(path).map_err(|_| "Some session files could not be read.".to_string())?;
        let modified = meta.modified().ok();
        let created = meta.created().ok();
        if meta.len() < self.offset
            || (self.created.is_some() && created != self.created)
            || (meta.len() == self.offset && self.modified.is_some() && self.modified != modified)
        {
            *self = Self::default();
        }
        self.created = created;
        self.modified = modified;
        if meta.len() == self.offset {
            return Ok(false);
        }
        let mut file =
            File::open(path).map_err(|_| "Some session files could not be read.".to_string())?;
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|e| e.to_string())?;
        let take = (meta.len() - self.offset).min(*budget).min(8 * 1024 * 1024);
        let mut data = Vec::new();
        file.take(take)
            .read_to_end(&mut data)
            .map_err(|_| "A session read was interrupted; it will be retried.".to_string())?;
        self.offset += data.len() as u64;
        *budget -= data.len() as u64;
        for byte in data {
            if byte == b'\n' {
                if !self.oversized {
                    match serde_json::from_slice(trim_bom(&self.pending)) {
                        Ok(value) => self.parse(value, provider),
                        Err(_) => self.malformed += 1,
                    }
                }
                self.pending.clear();
                self.oversized = false;
            } else if !self.oversized {
                if self.pending.len() < MAX_LINE {
                    self.pending.push(byte);
                } else {
                    self.pending.clear();
                    self.oversized = true;
                    self.malformed += 1;
                }
            }
        }
        // An incomplete final JSONL record stays pending until a newline arrives.
        Ok(self.offset < meta.len())
    }
}
fn string(v: &Value, k: &str) -> String {
    v[k].as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(1024)
        .collect()
}
fn trim_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes)
}
fn number(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap_or(0).min(1_000_000_000_000)
}
fn codex_tokens(t: &Value) -> Tokens {
    Tokens {
        input: number(t, "input_tokens"),
        cached: number(t, "cached_input_tokens"),
        cache_write: number(t, "cache_write_input_tokens"),
        output: number(t, "output_tokens"),
        reasoning: number(t, "reasoning_output_tokens"),
        ..Tokens::default()
    }
}
fn timestamp(v: &Value) -> u64 {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis().max(0) as u64)
        .unwrap_or(0)
}
fn normalize(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .trim_start_matches("//?/")
        .to_lowercase()
}
fn project_name(cwd: &str, projects: &[Project]) -> String {
    let path = normalize(cwd);
    projects
        .iter()
        .filter(|p| {
            let root = normalize(&p.root);
            path == root || path.starts_with(&(root + "/"))
        })
        .max_by_key(|p| p.root.len())
        .map(|p| p.name.clone())
        .unwrap_or_else(|| {
            if cwd.is_empty() {
                "Unattributed".into()
            } else {
                cwd.into()
            }
        })
}
fn aggregate(files: &HashMap<PathBuf, LogFile>, projects: &[Project]) -> (Vec<Bucket>, usize) {
    let mut records: Vec<_> = files.values().flat_map(|f| f.records.iter()).collect();
    records.sort_by(|a, b| (a.at, &a.key).cmp(&(b.at, &b.key)));
    let mut previous: HashMap<String, Tokens> = HashMap::new();
    let mut claude: HashMap<String, Record> = HashMap::new();
    let mut normalized = Vec::new();
    let mut sessions = HashSet::new();
    for r in records {
        if r.provider == "claude" {
            claude
                .entry(r.key.clone())
                .and_modify(|old| old.tokens = old.tokens.max(&r.tokens))
                .or_insert_with(|| r.clone());
        } else {
            // A partial/resumed file can begin with counters inherited from an
            // earlier file. Attribute only its reported last request, not the
            // entire historical counter, to this first timestamp.
            let mut delta = if let Some(prev) = previous.get(&r.key) {
                r.tokens.delta(prev)
            } else {
                r.last.clone().unwrap_or_else(|| r.tokens.clone())
            };
            let prev = previous.entry(r.key.clone()).or_default();
            *prev = prev.max(&r.tokens);
            // Cached/write counters are subsets of input. A later partial
            // record filling in those fields must not create extra tokens.
            delta.cached = delta.cached.min(delta.input);
            delta.cache_write = delta.cache_write.min(delta.input - delta.cached);
            delta.input = delta
                .input
                .saturating_sub(delta.cached)
                .saturating_sub(delta.cache_write);
            delta.reasoning = delta.reasoning.min(delta.output);
            if delta.total() > 0 {
                let mut value = r.clone();
                value.tokens = delta;
                normalized.push(value);
            }
        }
    }
    normalized.extend(claude.into_values().map(|mut r| {
        r.tokens.cache_write = r
            .tokens
            .cache_write
            .saturating_sub(r.tokens.cache_write_hour);
        r.tokens.reasoning = r.tokens.reasoning.min(r.tokens.output);
        r
    }));
    let mut buckets: BTreeMap<(u64, String, String, String), Tokens> = BTreeMap::new();
    for r in normalized {
        if r.tokens.total() == 0 {
            continue;
        }
        sessions.insert((r.provider.clone(), r.session));
        // Hourly metadata is enough for charts; no messages leave this module.
        buckets
            .entry((
                r.at / 3_600_000 * 3_600_000,
                r.provider,
                project_name(&r.project, projects),
                if r.model.is_empty() {
                    "Unknown model".into()
                } else {
                    r.model
                },
            ))
            .or_default()
            .add(&r.tokens);
    }
    (
        buckets
            .into_iter()
            .map(|((timestamp, provider, project, model), tokens)| Bucket {
                timestamp,
                provider,
                project,
                model,
                tokens,
            })
            .collect(),
        sessions.len(),
    )
}

fn limit(v: &Value, percent: &str, reset: &str) -> Option<Limit> {
    let used = v[percent].as_f64()?;
    if !used.is_finite() || !(0.0..=100.0).contains(&used) {
        return None;
    }
    Some(Limit {
        used_percent: used,
        resets_at: v[reset].as_u64().and_then(|s| s.checked_mul(1000)),
    })
}
fn codex_limits(v: &Value) -> Provider {
    let mut p = Provider::empty("codex", "Codex app-server");
    // Never label a short or model-specific bucket as the account's 5h quota.
    let bucket = if v["rateLimitsByLimitId"].is_object() {
        &v["rateLimitsByLimitId"]["codex"]
    } else {
        &v["rateLimits"]
    };
    if bucket["limitId"].as_str().is_some_and(|id| id != "codex") {
        p.message = "The server returned a different usage bucket.".into();
        return p;
    }
    for key in ["primary", "secondary"] {
        match bucket[key]["windowDurationMins"].as_u64() {
            Some(300) => p.five_hour = limit(&bucket[key], "usedPercent", "resetsAt"),
            Some(10080) => p.weekly = limit(&bucket[key], "usedPercent", "resetsAt"),
            _ => {}
        }
    }
    p.observed_at = Some(now());
    if p.five_hour.is_none() || p.weekly.is_none() {
        p.message = "This account or CLI did not report both supported quota windows.".into();
    }
    p
}

/// Resolve a native executable, including npm's packaged Windows binary. Do not
/// execute .cmd/.ps1 shims through a shell or interpolate configured paths.
fn find_codex(custom: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if !custom.is_empty() {
        candidates.push(PathBuf::from(custom));
    } else {
        if let Some(path) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&path).map(|p| p.join("codex.exe")));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs/Codex/codex.exe"));
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            candidates.push(PathBuf::from(profile).join(".local/bin/codex.exe"));
        }
    }
    let mut npm_roots = Vec::new();
    if custom.is_empty() {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            npm_roots.push(PathBuf::from(appdata).join("npm/node_modules/@openai/codex"));
        }
        if let Some(path) = std::env::var_os("PATH") {
            npm_roots
                .extend(std::env::split_paths(&path).map(|p| p.join("node_modules/@openai/codex")));
        }
    } else if let Some(parent) = Path::new(custom).parent() {
        npm_roots.push(parent.join("node_modules/@openai/codex"));
    }
    for root in npm_roots {
        for arch in ["x64", "arm64"] {
            let triple = if arch == "x64" {
                "x86_64-pc-windows-msvc"
            } else {
                "aarch64-pc-windows-msvc"
            };
            candidates.push(root.join(format!(
                "node_modules/@openai/codex-win32-{arch}/vendor/{triple}/bin/codex.exe"
            )));
            candidates.push(root.join(format!(
                "../codex-win32-{arch}/vendor/{triple}/bin/codex.exe"
            )));
            candidates.push(root.join(format!("vendor/{triple}/codex/codex.exe")));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")))
}

fn read_codex(settings: &Settings) -> Provider {
    let unavailable = |message: &str| {
        let mut p = Provider::empty("codex", "Codex app-server");
        p.message = message.into();
        p
    };
    let Some(exe) = find_codex(&settings.codex_executable) else {
        return unavailable(
            "Codex executable not found. Set its native executable location in usage settings.",
        );
    };
    let mut command = Command::new(exe);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    command.env("CODEX_HOME", &settings.codex_home);
    let Ok(mut child) = command.spawn() else {
        return unavailable(
            "Could not start Codex app-server. Check the installation and permissions.",
        );
    };
    // A private kill-on-close job owns only this monitoring process and its children.
    let job = crate::windows::Job::new().and_then(|j| j.assign_pid(child.id()).map(|_| j));
    let Ok(job) = job else {
        let _ = child.kill();
        let _ = child.wait();
        return unavailable("Could not isolate the Codex monitor process.");
    };
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::sync_channel(32);
    let reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            if reader
                .by_ref()
                .take(MAX_LINE as u64 + 1)
                .read_until(b'\n', &mut line)
                .unwrap_or(0)
                == 0
                || line.len() > MAX_LINE
            {
                break;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let result = (|| -> Result<Value, ()> {
        let input = child.stdin.as_mut().ok_or(())?;
        writeln!(input,"{}",json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"prorun_usage","title":"Prorun AI Usage","version":"1.0.0"}}})).map_err(|_|())?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let receive = |id: u64| -> Result<Value, ()> {
            loop {
                let value = rx
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                    .map_err(|_| ())?;
                if value["id"].as_u64() == Some(id) {
                    return if value["error"].is_object() {
                        Err(())
                    } else {
                        Ok(value["result"].clone())
                    };
                }
            }
        };
        receive(1)?;
        writeln!(input, "{}", json!({"method":"initialized","params":{}})).map_err(|_| ())?;
        writeln!(
            input,
            "{}",
            json!({"id":2,"method":"account/rateLimits/read"})
        )
        .map_err(|_| ())?;
        input.flush().map_err(|_| ())?;
        receive(2)
    })();
    drop(rx);
    drop(child.stdin.take());
    job.terminate();
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    match result { Ok(v)=>codex_limits(&v), Err(_)=>unavailable("Limits unavailable: app-server timed out, is unsupported, or has no eligible signed-in subscription. Sign in through Codex itself.") }
}

/// Native Claude Code executable only (installer or PATH); never a shell shim.
fn find_claude() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|p| p.join("claude.exe")));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        candidates.push(PathBuf::from(profile).join(".local/bin/claude.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Maps Claude Code's `get_usage` control response. Returns None when the
/// account reports no plan windows, so the status-line snapshot can be used.
fn claude_limits(v: &Value) -> Option<Provider> {
    if v["rate_limits_available"] != true || !v["rate_limits"].is_object() {
        return None;
    }
    let window = |key: &str| {
        let w = &v["rate_limits"][key];
        let used = w["utilization"].as_f64()?;
        if !used.is_finite() || used < 0.0 {
            return None;
        }
        let reset = timestamp(&w["resets_at"]);
        Some(Limit {
            used_percent: used.min(100.0),
            resets_at: (reset > 0).then_some(reset),
        })
    };
    let mut p = Provider::empty("claude", "Claude Code CLI");
    p.five_hour = window("five_hour");
    p.weekly = window("seven_day");
    if p.five_hour.is_none() && p.weekly.is_none() {
        return None;
    }
    p.observed_at = Some(now());
    if p.five_hour.is_none() || p.weekly.is_none() {
        p.message = "This account or CLI did not report both supported quota windows.".into();
    }
    Some(p)
}

/// Asks the installed Claude Code CLI for plan limits through its stream-json
/// `get_usage` control request. No prompt is sent, so no model call is made.
fn read_claude_live(claude_home: &str) -> Option<Provider> {
    let exe = find_claude()?;
    let mut command = Command::new(exe);
    command
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--strict-mcp-config",
        ])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    // Setting CLAUDE_CONFIG_DIR to the default home changes where Claude Code
    // looks for its global config, so only pass a genuinely custom home.
    let default_home = std::env::var_os("USERPROFILE")
        .map(|p| normalize(&PathBuf::from(p).join(".claude").to_string_lossy()));
    if !claude_home.is_empty() && default_home.as_deref() != Some(&normalize(claude_home)) {
        command.env("CLAUDE_CONFIG_DIR", claude_home);
    }
    let mut child = command.spawn().ok()?;
    let job = crate::windows::Job::new().and_then(|j| j.assign_pid(child.id()).map(|_| j));
    let Ok(job) = job else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::sync_channel(32);
    let reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            if reader
                .by_ref()
                .take(MAX_LINE as u64 + 1)
                .read_until(b'\n', &mut line)
                .unwrap_or(0)
                == 0
                || line.len() > MAX_LINE
            {
                break;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let result = (|| -> Option<Value> {
        let input = child.stdin.as_mut()?;
        writeln!(
            input,
            "{}",
            json!({"type":"control_request","request_id":"prorun-usage","request":{"subtype":"get_usage","skip_behaviors":true}})
        )
        .ok()?;
        input.flush().ok()?;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let value = rx
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .ok()?;
            let response = &value["response"];
            if value["type"] == "control_response" && response["request_id"] == "prorun-usage" {
                return (response["subtype"] == "success").then(|| response["response"].clone());
            }
        }
    })();
    drop(rx);
    drop(child.stdin.take());
    job.terminate();
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    claude_limits(&result?)
}

fn read_claude(path: &Path) -> Provider {
    let mut p = Provider::empty("claude", "Claude Code status line");
    let result = fs::metadata(path)
        .ok()
        .filter(|m| m.len() <= 64 * 1024)
        .and_then(|_| fs::read(path).ok())
        .and_then(|b| serde_json::from_slice::<Value>(trim_bom(&b)).ok());
    let Some(value) = result else {
        p.message="No status-line snapshot. Enable capture in usage settings, then use Claude Code, or select an existing snapshot.".into();
        return p;
    };
    p.observed_at = value["capturedAt"].as_u64().or_else(|| {
        fs::metadata(path)
            .ok()?
            .modified()
            .ok()?
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as u64)
    });
    p.five_hour = limit(
        &value["rate_limits"]["five_hour"],
        "used_percentage",
        "resets_at",
    );
    p.weekly = limit(
        &value["rate_limits"]["seven_day"],
        "used_percentage",
        "resets_at",
    );
    if p.five_hour.is_none() || p.weekly.is_none() {
        p.message="Claude Code did not report both subscription limits. Fields may be absent before a response or on unsupported plans/versions.".into();
    }
    p
}

#[derive(Clone)]
pub struct Usage {
    inner: Arc<Mutex<UsageInner>>,
}
struct UsageInner {
    directory: PathBuf,
    settings: Settings,
    files: HashMap<PathBuf, LogFile>,
}
impl Usage {
    pub fn new(directory: PathBuf) -> Self {
        let settings = fs::read(directory.join("usage-settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(trim_bom(&b)).ok())
            .unwrap_or_else(|| Settings {
                alerts: vec![80, 90, 100],
                ..Settings::default()
            });
        Self {
            inner: Arc::new(Mutex::new(UsageInner {
                directory,
                settings,
                files: HashMap::new(),
            })),
        }
    }
    pub fn settings(&self) -> Settings {
        let inner = self.inner.lock().unwrap();
        effective(&inner.settings, &inner.directory)
    }
    pub fn capture_info(&self) -> Result<CaptureInfo, String> {
        let inner = self.inner.lock().unwrap();
        let settings = effective(&inner.settings, &inner.directory);
        let path = PathBuf::from(settings.claude_home).join("settings.json");
        let value = read_settings(&path)?;
        let backup = fs::read(inner.directory.join("claude-capture-backup.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<CaptureBackup>(&b).ok());
        Ok(CaptureInfo {
            enabled: backup.is_some_and(|b| {
                b.settings_path == path && value["statusLine"]["command"] == b.command
            }),
            existing_status_line: !value["statusLine"].is_null(),
            settings_path: path.to_string_lossy().into(),
        })
    }
    /// Explicit opt-in command. The original statusLine object is retained in a
    /// backup, and its command still receives the same JSON on stdin via Bash.
    pub fn capture(&self, enable: bool, bash_override: &str) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let backup_path = inner.directory.join("claude-capture-backup.json");
        if !enable {
            let backup: CaptureBackup = serde_json::from_slice(
                &fs::read(&backup_path).map_err(|_| "No capture backup found")?,
            )
            .map_err(|_| "Capture backup is damaged")?;
            let mut value = read_settings(&backup.settings_path)?;
            if value["statusLine"]["command"] != backup.command {
                return Err("The status line changed after capture was installed. Your changes were preserved; restore it manually from the capture backup.".into());
            }
            if backup.original.is_null() {
                value.as_object_mut().unwrap().remove("statusLine");
            } else {
                value["statusLine"] = backup.original;
            }
            write_json(&backup.settings_path, &value)?;
            fs::remove_file(backup_path).map_err(|e| e.to_string())?;
            return Ok(());
        }
        if backup_path.exists() {
            return Err("A capture backup already exists. Disable the previous capture before enabling it again.".into());
        }
        let settings = effective(&inner.settings, &inner.directory);
        let path = PathBuf::from(settings.claude_home).join("settings.json");
        let mut value = read_settings(&path)?;
        let original_settings = value.clone();
        let snapshot_path = Path::new(&settings.claude_snapshot);
        if snapshot_path.exists() {
            let valid = fs::metadata(snapshot_path)
                .ok()
                .filter(|m| m.len() <= 64 * 1024)
                .and_then(|_| fs::read(snapshot_path).ok())
                .and_then(|bytes| serde_json::from_slice::<Value>(trim_bom(&bytes)).ok())
                .is_some_and(|v| v["rate_limits"].is_object());
            if !valid {
                return Err("The snapshot path contains another file. Choose a dedicated usage snapshot; the existing file was preserved.".into());
            }
        }
        let original = value["statusLine"].clone();
        if !original.is_null()
            && (original["type"] != "command" || !original["command"].is_string())
        {
            return Err("The existing status-line format is unsupported. It was preserved. Use a custom snapshot instead.".into());
        }
        let previous = original["command"].as_str().unwrap_or("");
        let bash = if previous.is_empty() {
            String::new()
        } else {
            crate::model::find_bash(bash_override).ok_or("Git Bash is needed to preserve the existing status-line command. Check its path in workspace settings. Your settings were not changed.")?.to_string_lossy().into_owned()
        };
        let script_path = inner.directory.join("claude-usage-statusline.ps1");
        let escape = |s: &str| s.replace('\'', "''");
        let script = include_str!("claude-statusline.ps1")
            .replace("__SNAPSHOT__", &escape(&settings.claude_snapshot))
            .replace("__PREVIOUS__", &escape(previous))
            .replace("__BASH__", &escape(&bash));
        fs::create_dir_all(&inner.directory).map_err(|e| e.to_string())?;
        // Windows PowerShell 5.1 otherwise reads UTF-8 script literals as ANSI.
        fs::write(&script_path, format!("\u{feff}{script}")).map_err(|e| e.to_string())?;
        let shell_path = script_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        let command=format!("powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '{shell_path}'");
        write_json(
            &backup_path,
            &CaptureBackup {
                settings_path: path.clone(),
                original: original.clone(),
                command: command.clone(),
            },
        )?;
        let mut hook = if original.is_object() {
            original
        } else {
            json!({"type":"command"})
        };
        hook["command"] = Value::String(command);
        value["statusLine"] = hook;
        if read_settings(&path)? != original_settings {
            let _ = fs::remove_file(&backup_path);
            return Err("Claude settings changed while capture was being prepared. Your changes were preserved; try again.".into());
        }
        if let Err(error) = write_json(&path, &value) {
            let _ = fs::remove_file(backup_path);
            return Err(error);
        }
        Ok(())
    }
    pub fn save(&self, settings: Settings) -> Result<(), String> {
        if settings.alerts.iter().any(|n| ![80, 90, 100].contains(n)) {
            return Err("Alert thresholds must be 80, 90, or 100 percent.".into());
        }
        for p in [
            &settings.codex_executable,
            &settings.codex_home,
            &settings.claude_home,
            &settings.claude_snapshot,
        ] {
            if !p.is_empty() && (!Path::new(p).is_absolute() || p.contains('\0')) {
                return Err("Usage paths must be absolute Windows paths.".into());
            }
        }
        let mut inner = self.inner.lock().unwrap();
        let before = effective(&inner.settings, &inner.directory);
        let after = effective(&settings, &inner.directory);
        if inner.directory.join("claude-capture-backup.json").exists()
            && (before.claude_home != after.claude_home
                || before.claude_snapshot != after.claude_snapshot)
        {
            return Err("Disable Claude capture before changing its home or snapshot path, then enable capture again.".into());
        }
        write_json(&inner.directory.join("usage-settings.json"), &settings)?;
        inner.settings = settings;
        inner.files.clear();
        Ok(())
    }
    pub fn refresh(&self, projects: &[Project]) -> Report {
        let mut inner = self.inner.lock().unwrap();
        let settings = effective(&inner.settings, &inner.directory);
        let mut warnings = HashSet::new();
        let mut paths = Vec::new();
        for (provider, root) in [
            (
                "codex",
                PathBuf::from(&settings.codex_home).join("sessions"),
            ),
            (
                "codex",
                PathBuf::from(&settings.codex_home).join("archived_sessions"),
            ),
            (
                "claude",
                PathBuf::from(&settings.claude_home).join("projects"),
            ),
        ] {
            if !root.exists() {
                if !root.ends_with("archived_sessions") {
                    warnings.insert(format!(
                        "{provider}: local session directory not found; check usage settings."
                    ));
                }
                continue;
            }
            discover(&root, provider, 0, &mut paths, &mut warnings);
        }
        // Index recent activity first on large installations. Every file keeps
        // its own cursor, so later refreshes still make progress through backlog.
        paths.sort_by_cached_key(|(path, _)| {
            (
                std::cmp::Reverse(
                    fs::metadata(path)
                        .and_then(|m| m.modified())
                        .unwrap_or(SystemTime::UNIX_EPOCH),
                ),
                path.clone(),
            )
        });
        paths.dedup();
        let accessible: HashSet<_> = paths.iter().map(|(p, _)| p).collect();
        inner.files.retain(|p, _| accessible.contains(p));
        let mut budget = SCAN_BYTES;
        let mut records = inner.files.values().map(|f| f.records.len()).sum::<usize>();
        for (path, provider) in &paths {
            if records >= MAX_RECORDS {
                warnings.insert("History metadata limit reached (500,000 records). Choose a smaller source directory.".into());
                break;
            }
            let f = inner.files.entry(path.clone()).or_default();
            let before = f.records.len();
            match f.read(path, provider, &mut budget) {
                Ok(true) => {
                    warnings.insert(
                        "History is still indexing; refresh again to load the next batch.".into(),
                    );
                }
                Err(e) => {
                    warnings.insert(e);
                }
                _ => {}
            }
            records = records.saturating_sub(before) + f.records.len();
        }
        if inner.files.values().any(|f| f.malformed > 0) {
            warnings.insert("Incomplete, oversized, or malformed log records were skipped. History may be partial.".into());
        }
        if inner.files.values().any(|f| f.regressed) {
            warnings.insert("Some Codex counters moved backwards. Only increases above observed totals are counted; history may be partial.".into());
        }
        if inner.files.values().any(|f| !f.pending.is_empty()) {
            warnings.insert(
                "A trailing record is incomplete and will be retried when its writer finishes."
                    .into(),
            );
        }
        let (buckets, sessions) = aggregate(&inner.files, projects);
        Report {
            refreshed_at: now(),
            providers: vec![
                read_codex(&settings),
                read_claude_live(&settings.claude_home)
                    .unwrap_or_else(|| read_claude(Path::new(&settings.claude_snapshot))),
            ],
            buckets,
            sessions,
            files: paths.len(),
            warnings: warnings.into_iter().collect(),
        }
    }
}
fn read_settings(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let bytes = fs::read(path).map_err(|_| "Cannot read Claude settings; they were preserved.")?;
    let v: Value = serde_json::from_slice(trim_bom(&bytes))
        .map_err(|_| "Claude settings are not valid JSON; they were preserved.")?;
    if !v.is_object() {
        return Err("Claude settings must be a JSON object; they were preserved.".into());
    }
    Ok(v)
}
fn effective(settings: &Settings, directory: &Path) -> Settings {
    let mut s = settings.clone();
    let profile = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default();
    if s.codex_home.is_empty() {
        s.codex_home = std::env::var("CODEX_HOME")
            .unwrap_or_else(|_| profile.join(".codex").to_string_lossy().into());
    }
    if s.claude_home.is_empty() {
        s.claude_home = std::env::var("CLAUDE_CONFIG_DIR")
            .unwrap_or_else(|_| profile.join(".claude").to_string_lossy().into());
    }
    if s.claude_snapshot.is_empty() {
        s.claude_snapshot = directory.join("claude-usage.json").to_string_lossy().into();
    }
    s
}
fn discover(
    root: &Path,
    provider: &'static str,
    depth: usize,
    paths: &mut Vec<(PathBuf, &'static str)>,
    warnings: &mut HashSet<String>,
) {
    if depth > 12 || paths.len() >= 10000 {
        warnings.insert("Session discovery was capped at 10,000 files or 12 nested directories; history is partial.".into());
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        warnings.insert(format!("{provider}: a session directory is inaccessible."));
        return;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink()
            || entry.metadata().is_ok_and(|m| {
                use std::os::windows::fs::MetadataExt;
                m.file_attributes() & 0x400 != 0
            })
        {
            continue;
        }
        if paths.len() >= 10000 {
            warnings.insert("Session discovery capped at 10,000 files; history is partial.".into());
            break;
        }
        if kind.is_dir() {
            discover(&entry.path(), provider, depth + 1, paths, warnings);
        } else if entry.path().extension().is_some_and(|e| e == "jsonl") {
            paths.push((entry.path(), provider));
        }
    }
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid settings path")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    let mut file = File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    crate::windows::replace(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn meta(f: &mut LogFile, id: &str) {
        f.parse(json!({"type":"session_meta","payload":{"id":id,"cwd":"C:\\Work\\Demo","timestamp":"2026-11-20T00:00:00Z"}}),"codex");
    }
    fn cumulative(
        f: &mut LogFile,
        time: &str,
        input: u64,
        cached: u64,
        output: u64,
        reasoning: u64,
    ) {
        f.parse(json!({"type":"event_msg","timestamp":time,"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":input,"cached_input_tokens":cached,"output_tokens":output,"reasoning_output_tokens":reasoning}}}}),"codex");
    }
    fn total(buckets: &[Bucket]) -> Tokens {
        let mut t = Tokens::default();
        for b in buckets {
            t.add(&b.tokens);
        }
        t
    }
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("prorun-usage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    #[test]
    fn cumulative_counters_copies_and_model_switches_are_deduplicated() {
        let mut f = LogFile::default();
        meta(&mut f, "session");
        f.model = "first".into();
        cumulative(&mut f, "2026-11-20T01:00:00Z", 100, 40, 20, 5);
        cumulative(&mut f, "2026-11-20T01:00:01Z", 100, 40, 20, 5);
        cumulative(&mut f, "2026-11-20T01:30:00Z", 90, 30, 10, 3);
        assert!(f.regressed);
        f.model = "second".into();
        cumulative(&mut f, "2026-11-20T02:00:00Z", 180, 100, 30, 8);
        let mut files = HashMap::new();
        files.insert(PathBuf::from("one"), f);
        let mut copy = LogFile::default();
        meta(&mut copy, "session");
        cumulative(&mut copy, "2026-11-20T02:00:00Z", 180, 100, 30, 8);
        files.insert(PathBuf::from("copy"), copy);
        let (buckets, sessions) = aggregate(&files, &[]);
        let t = total(&buckets);
        assert_eq!((t.input, t.cached, t.output, t.reasoning), (80, 100, 30, 8));
        assert_eq!(t.total(), 210);
        assert_eq!(sessions, 1);
        assert!(buckets.iter().any(|b| b.model == "first"));
    }
    #[test]
    fn partial_codex_history_does_not_assign_inherited_totals_to_first_request() {
        let mut f = LogFile::default();
        meta(&mut f, "partial");
        f.parse(json!({"type":"event_msg","timestamp":"2026-11-20T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"output_tokens":100},"last_token_usage":{"input_tokens":50,"output_tokens":10}}}}),"codex");
        cumulative(&mut f, "2026-11-20T02:00:00Z", 1100, 0, 120, 0);
        let (b, _) = aggregate(&HashMap::from([(PathBuf::from("p"), f)]), &[]);
        assert_eq!(total(&b).total(), 180);
    }
    #[test]
    fn fork_inherited_records_use_parent_identity() {
        let mut parent = LogFile::default();
        meta(&mut parent, "parent");
        cumulative(&mut parent, "2026-11-20T01:00:00Z", 100, 0, 20, 0);
        let mut fork = LogFile::default();
        fork.parse(json!({"type":"session_meta","payload":{"id":"fork","forked_from_id":"parent","timestamp":"2026-11-20T02:00:00Z"}}),"codex");
        cumulative(&mut fork, "2026-11-20T01:00:00Z", 100, 0, 20, 0);
        let (b, _) = aggregate(
            &HashMap::from([
                (PathBuf::from("parent"), parent),
                (PathBuf::from("fork"), fork),
            ]),
            &[],
        );
        assert_eq!(total(&b).total(), 120);
    }
    #[test]
    fn claude_streaming_records_and_cross_session_copies_count_once() {
        let mut files = HashMap::new();
        for (i, output) in [4, 10, 6].into_iter().enumerate() {
            let mut f = LogFile::default();
            let hour = if i == 0 { 0 } else { 20 };
            f.parse(json!({"type":"assistant","timestamp":"2026-11-20T01:00:00Z","sessionId":format!("s{i}"),"message":{"id":"msg_one","model":"claude-opus-5-5","usage":{"input_tokens":5,"cache_read_input_tokens":10,"cache_creation_input_tokens":30,"cache_creation":{"ephemeral_1h_input_tokens":hour},"output_tokens":output,"output_tokens_details":{"thinking_tokens":2}},"content":[{"text":"SECRET PROMPT NEVER RETURNED"}]}}),"claude");
            files.insert(PathBuf::from(i.to_string()), f);
        }
        let (b, sessions) = aggregate(&files, &[]);
        let t = total(&b);
        assert_eq!(
            (
                t.input,
                t.cached,
                t.cache_write,
                t.cache_write_hour,
                t.output
            ),
            (5, 10, 10, 20, 10)
        );
        assert_eq!(t.total(), 55);
        assert_eq!(sessions, 1);
        assert!(!serde_json::to_string(&b).unwrap().contains("SECRET"));
    }
    #[test]
    fn quota_windows_are_selected_by_duration_and_bucket_identity() {
        let p = codex_limits(
            &json!({"rateLimits":{"primary":{"windowDurationMins":300,"usedPercent":99}},"rateLimitsByLimitId":{"codex":{"primary":{"windowDurationMins":10080,"usedPercent":42,"resetsAt":2000},"secondary":{"windowDurationMins":300,"usedPercent":0}}}}),
        );
        assert_eq!(p.five_hour.unwrap().used_percent, 0.0);
        assert_eq!(p.weekly.unwrap().resets_at, Some(2_000_000));
        let unsupported = codex_limits(
            &json!({"rateLimits":{"primary":{"windowDurationMins":15,"usedPercent":80},"secondary":{"windowDurationMins":10080,"usedPercent":101}}}),
        );
        assert!(unsupported.five_hour.is_none());
        assert!(unsupported.weekly.is_none());
        let other = codex_limits(
            &json!({"rateLimitsByLimitId":{"other":{"primary":{"windowDurationMins":300,"usedPercent":50}}}}),
        );
        assert!(other.five_hour.is_none());
    }
    #[test]
    fn jsonl_reads_are_incremental_handle_partial_lines_and_truncation() {
        let directory = temp();
        let path = directory.join("session.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"s\"}}\n{\"type\":",
        )
        .unwrap();
        let mut f = LogFile::default();
        f.read(&path, "codex", &mut SCAN_BYTES.clone()).unwrap();
        assert_eq!(f.session, "s");
        assert!(!f.pending.is_empty());
        let offset = f.offset;
        f.read(&path, "codex", &mut SCAN_BYTES.clone()).unwrap();
        assert_eq!(f.offset, offset);
        let mut out = fs::OpenOptions::new().append(true).open(&path).unwrap();
        out.write_all(b"\"turn_context\",\"payload\":{\"model\":\"model\"}}\nnot-json\n")
            .unwrap();
        drop(out);
        f.read(&path, "codex", &mut SCAN_BYTES.clone()).unwrap();
        assert_eq!(f.model, "model");
        assert_eq!(f.malformed, 1);
        fs::write(&path, b"{}\n").unwrap();
        f.read(&path, "codex", &mut SCAN_BYTES.clone()).unwrap();
        assert_eq!(f.offset, 3);
        assert!(f.session.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn snapshot_never_uses_context_window_percent_as_subscription_percent() {
        let directory = temp();
        let path = directory.join("snapshot.json");
        fs::write(&path,format!("\u{feff}{}",json!({"capturedAt":1234,"context_window":{"used_percentage":99},"rate_limits":{"five_hour":{"used_percentage":0,"resets_at":4567}}}))).unwrap();
        let p = read_claude(&path);
        assert_eq!(p.five_hour.unwrap().used_percent, 0.0);
        assert!(p.weekly.is_none());
        assert_eq!(p.observed_at, Some(1234));
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn windows_project_matching_uses_deepest_root_and_path_boundaries() {
        let p = |name: &str, root: &str| Project {
            id: name.into(),
            name: name.into(),
            root: root.into(),
            services: vec![],
            actions: vec![],
        };
        let projects = vec![p("Root", "C:\\Work\\Demo"), p("Nested", "c:/work/demo/sub")];
        assert_eq!(
            project_name("C:\\WORK\\DEMO\\sub\\child", &projects),
            "Nested"
        );
        assert_eq!(
            project_name("C:\\Work\\DemoOther", &projects),
            "C:\\Work\\DemoOther"
        );
    }
    #[test]
    fn capture_requires_opt_in_and_restores_existing_settings() {
        let directory = temp();
        let home = directory.join("claude");
        fs::create_dir_all(&home).unwrap();
        let path = home.join("settings.json");
        let original = json!({"statusLine":{"type":"command","command":"printf 'existing line'","padding":3},"otherSetting":true});
        fs::write(&path, format!("\u{feff}{original}")).unwrap();
        let usage = Usage::new(directory.join("usage"));
        usage
            .save(Settings {
                claude_home: home.to_string_lossy().into(),
                ..Settings::default()
            })
            .unwrap();
        assert_eq!(read_settings(&path).unwrap(), original);
        // A missing Bash produces an actionable error without changing settings.
        match usage.capture(true, "") {
            Ok(()) => {
                assert!(usage.capture_info().unwrap().enabled);
                assert_eq!(read_settings(&path).unwrap()["otherSetting"], true);
                assert_eq!(read_settings(&path).unwrap()["statusLine"]["padding"], 3);
                usage.capture(false, "").unwrap();
                assert_eq!(read_settings(&path).unwrap(), original);
            }
            Err(e) => {
                assert!(e.contains("Git Bash"), "{e}");
                assert_eq!(read_settings(&path).unwrap(), original);
            }
        }
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn capture_restore_preserves_subsequent_user_edits() {
        let directory = temp();
        let usage = Usage::new(directory.clone());
        let home = directory.join("claude");
        usage
            .save(Settings {
                claude_home: home.to_string_lossy().into(),
                ..Settings::default()
            })
            .unwrap();
        usage.capture(true, "").unwrap();
        let path = home.join("settings.json");
        let edited = json!({"statusLine":{"type":"command","command":"new command"}});
        write_json(&path, &edited).unwrap();
        assert!(usage
            .capture(false, "")
            .unwrap_err()
            .contains("changed after"));
        assert_eq!(read_settings(&path).unwrap(), edited);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn collector_writes_only_limits_with_windows_unicode_paths() {
        let directory = temp();
        let usage = Usage::new(directory.join("Usage ' test 测试"));
        usage
            .save(Settings {
                claude_home: directory.join("Claude home").to_string_lossy().into(),
                ..Settings::default()
            })
            .unwrap();
        usage.capture(true, "").unwrap();
        let script = directory.join("Usage ' test 测试/claude-usage-statusline.ps1");
        let mut process = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let input = json!({"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":123456},"seven_day":{"used_percentage":0,"resets_at":234567}},"context_window":{"used_percentage":99},"session_id":"SECRET_SESSION","prompt":"SECRET_PROMPT"});
        process
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        let output = process.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("23.5%"));
        let snapshot = fs::read(&usage.settings().claude_snapshot).unwrap();
        assert!(!String::from_utf8_lossy(&snapshot).contains("SECRET"));
        let value: Value = serde_json::from_slice(&snapshot).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
        assert_eq!(value["rate_limits"]["seven_day"]["used_percentage"], 0);
        assert!(value["capturedAt"].as_u64().unwrap() > 0);
        usage.capture(false, "").unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn claude_live_usage_maps_windows_and_defers_when_unavailable() {
        let p = claude_limits(&json!({"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":3,"resets_at":"2026-11-20T10:40:00.104714+00:00"},"seven_day":{"utilization":104.5,"resets_at":null}}})).unwrap();
        let five = p.five_hour.unwrap();
        assert_eq!(five.used_percent, 3.0);
        assert_eq!(five.resets_at, Some(1_795_171_200_104));
        assert_eq!(p.weekly.unwrap().used_percent, 100.0);
        assert!(p.observed_at.is_some());
        assert!(claude_limits(&json!({"rate_limits_available":false,"rate_limits":null})).is_none());
        assert!(claude_limits(&json!({"rate_limits_available":true,"rate_limits":{"five_hour":null}})).is_none());
    }
    #[test]
    #[ignore = "Explicit live smoke test; queries only the installed Claude Code get_usage control request"]
    fn installed_claude_interface() {
        let usage = Usage::new(temp());
        let p = read_claude_live(&usage.settings().claude_home).expect("no live Claude usage");
        println!(
            "Claude Code answered; 5-hour window: {}, weekly window: {}",
            p.five_hour.is_some(),
            p.weekly.is_some()
        );
    }
    #[test]
    #[ignore = "Explicit live smoke test; queries only the installed Codex account/rateLimits/read interface"]
    fn installed_codex_interface() {
        let usage = Usage::new(temp());
        let p = read_codex(&usage.settings());
        assert!(p.observed_at.is_some(), "{}", p.message);
        println!(
            "Codex app-server answered; 5-hour window: {}, weekly window: {}",
            p.five_hour.is_some(),
            p.weekly.is_some()
        );
    }
}
