#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(test)]
mod action_tests;
mod engine;
mod model;
mod terminal_handshake;
mod usage;
mod windows;
use engine::Engine;
use model::*;
use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

// Filesystem access, process waits, and PTY input may block. Keep them off the
// asynchronous IPC executor so output and stop/close requests remain responsive.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_config(engine: State<'_, Engine>) -> Result<Config, String> {
    Ok(engine.inner.lock().unwrap().config.clone())
}
#[tauri::command]
async fn save_config(engine: State<'_, Engine>, config: Config) -> Result<(), String> {
    let engine = engine.inner().clone();
    blocking(move || engine.save(config)).await
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatus {
    id: String,
    project_id: String,
    alive: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    services: Vec<engine::Status>,
    actions: Vec<engine::Status>,
    terminals: Vec<TerminalStatus>,
    bash_path: Option<String>,
}
#[tauri::command]
async fn snapshot(engine: State<'_, Engine>) -> Result<Snapshot, String> {
    let inner = engine.inner.lock().unwrap();
    Ok(Snapshot {
        actions: inner
            .actions
            .values()
            .map(|r| r.lock().unwrap().status.clone())
            .collect(),
        services: inner
            .runs
            .values()
            .map(|r| r.lock().unwrap().status.clone())
            .collect(),
        terminals: inner
            .terminals
            .iter()
            .map(|(id, t)| TerminalStatus {
                id: id.clone(),
                project_id: t.project_id.clone(),
                alive: t.output.lock().unwrap().alive,
            })
            .collect(),
        bash_path: find_bash(&inner.config.bash_path).map(|p| p.to_string_lossy().into()),
    })
}
#[tauri::command]
async fn service_action(
    engine: State<'_, Engine>,
    id: String,
    action: String,
) -> Result<(), String> {
    let engine = engine.inner().clone();
    blocking(move || match action.as_str() {
        "start" => engine.start(&id),
        "stop" => engine.stop(&id),
        "restart" => {
            engine.stop(&id)?;
            engine.start(&id)
        }
        _ => Err("Unknown service action".into()),
    })
    .await
}
#[tauri::command]
async fn project_action(
    engine: State<'_, Engine>,
    id: String,
    action: String,
) -> Result<(), String> {
    if !["start", "stop"].contains(&action.as_str()) {
        return Err("Unknown project action".into());
    }
    let engine = engine.inner().clone();
    blocking(move || engine.project_action(&id, &action)).await
}
#[tauri::command]
async fn service_logs(
    engine: State<'_, Engine>,
    id: String,
    after: u64,
) -> Result<Vec<engine::Log>, String> {
    Ok(engine.logs(&id, after))
}
#[tauri::command]
async fn clear_logs(engine: State<'_, Engine>, id: String) -> Result<(), String> {
    engine.clear_logs(&id);
    Ok(())
}
#[tauri::command]
async fn action_execute(
    engine: State<'_, Engine>,
    id: String,
    action: String,
) -> Result<(), String> {
    let engine = engine.inner().clone();
    blocking(move || match action.as_str() {
        "start" => engine.start_action(&id),
        "stop" => engine.stop_action(&id),
        _ => Err("Unknown action operation".into()),
    })
    .await
}
#[tauri::command]
async fn action_logs(
    engine: State<'_, Engine>,
    id: String,
    after: u64,
) -> Result<Vec<engine::Log>, String> {
    Ok(engine.action_logs(&id, after))
}
#[tauri::command]
async fn clear_action_logs(engine: State<'_, Engine>, id: String) -> Result<(), String> {
    engine.clear_action_logs(&id);
    Ok(())
}
#[tauri::command]
async fn terminal_create(
    engine: State<'_, Engine>,
    project_id: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let engine = engine.inner().clone();
    blocking(move || engine.terminal_create(&project_id, cols, rows)).await
}
#[tauri::command]
async fn terminal_write(engine: State<'_, Engine>, id: String, data: String) -> Result<(), String> {
    if data.len() > 65536 {
        return Err("Paste is too large; use chunks of 64 KB".into());
    }
    let t = engine.terminal(&id)?;
    if !t.output.lock().unwrap().alive {
        return Err("Terminal has exited".into());
    }
    blocking(move || {
        let mut writer = t.writer.lock().unwrap();
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    })
    .await
}
#[tauri::command]
async fn terminal_resize(
    engine: State<'_, Engine>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminal = engine.terminal(&id)?;
    let size = engine::size(cols, rows)?;
    let result = if let Some(master) = terminal.master.lock().unwrap().as_ref() {
        master.resize(size).map_err(|e| e.to_string())
    } else {
        Ok(())
    };
    result
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    data: Vec<u8>,
    cursor: u64,
    truncated: bool,
    alive: bool,
}
#[tauri::command]
async fn terminal_read(
    engine: State<'_, Engine>,
    id: String,
    cursor: u64,
) -> Result<Output, String> {
    let term = engine.terminal(&id)?;
    let t = term.output.lock().unwrap();
    let start = cursor.max(t.offset).min(t.offset + t.bytes.len() as u64);
    let data: Vec<u8> = t
        .bytes
        .iter()
        .skip((start - t.offset) as usize)
        .take(32768)
        .copied()
        .collect();
    Ok(Output {
        cursor: start + data.len() as u64,
        data,
        truncated: cursor < t.offset,
        alive: t.alive,
    })
}
#[tauri::command]
async fn terminal_close(engine: State<'_, Engine>, id: String) -> Result<(), String> {
    let engine = engine.inner().clone();
    blocking(move || {
        engine.terminal_close(&id);
        Ok(())
    })
    .await
}
#[tauri::command]
async fn validate_directory(path: String) -> Result<String, String> {
    blocking(move || directory(path).map(|p| p.to_string_lossy().into())).await
}

#[tauri::command]
async fn usage_settings(usage: State<'_, usage::Usage>) -> Result<usage::Settings, String> {
    let usage = usage.inner().clone();
    blocking(move || Ok(usage.settings())).await
}
#[tauri::command]
async fn usage_set_tracking(
    usage: State<'_, usage::Usage>,
    provider: String,
    enabled: bool,
) -> Result<usage::Settings, String> {
    let usage = usage.inner().clone();
    blocking(move || usage.set_tracking(&provider, enabled)).await
}
#[tauri::command]
async fn usage_save_settings(
    usage: State<'_, usage::Usage>,
    settings: usage::Settings,
) -> Result<(), String> {
    let usage = usage.inner().clone();
    blocking(move || usage.save(settings)).await
}
#[tauri::command]
async fn usage_report(usage: State<'_, usage::Usage>) -> Result<usage::Report, String> {
    let usage = usage.inner().clone();
    blocking(move || Ok(usage.report())).await
}
#[tauri::command]
async fn usage_refresh(
    usage: State<'_, usage::Usage>,
    engine: State<'_, Engine>,
) -> Result<usage::Report, String> {
    let projects = engine.inner.lock().unwrap().config.projects.clone();
    let usage = usage.inner().clone();
    blocking(move || Ok(usage.refresh(&projects))).await
}
#[tauri::command]
async fn usage_capture_info(usage: State<'_, usage::Usage>) -> Result<usage::CaptureInfo, String> {
    let usage = usage.inner().clone();
    blocking(move || usage.capture_info()).await
}
#[tauri::command]
async fn usage_capture(
    usage: State<'_, usage::Usage>,
    engine: State<'_, Engine>,
    enable: bool,
) -> Result<(), String> {
    let bash_path = engine.inner.lock().unwrap().config.bash_path.clone();
    let usage = usage.inner().clone();
    blocking(move || usage.capture(enable, &bash_path)).await
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("config.json");
            let engine = Engine::open(path).map_err(|error| {
                app.dialog()
                    .message(&error)
                    .title("ProRun could not load your workspace")
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                    .blocking_show();
                std::io::Error::other(error)
            })?;
            app.manage(engine);
            app.manage(usage::Usage::new(app.path().app_config_dir()?));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            snapshot,
            service_action,
            project_action,
            service_logs,
            clear_logs,
            action_execute,
            action_logs,
            clear_action_logs,
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_read,
            terminal_close,
            validate_directory,
            usage_settings,
            usage_set_tracking,
            usage_save_settings,
            usage_refresh,
            usage_report,
            usage_capture_info,
            usage_capture
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.state::<Engine>().shutdown();
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to start ProRun");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Engine>().shutdown();
        }
    });
}
