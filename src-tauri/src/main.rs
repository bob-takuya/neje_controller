// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod grbl;
mod serial;
mod state;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::grbl::{RT_CYCLE_START, RT_FEED_HOLD, RT_SOFT_RESET, RT_STATUS_QUERY};
use crate::serial::{filter_likely_engravers, list_ports, spawn_worker, PortInfo};
use crate::state::{events, AppState, LogLine, WorkerCmd, WorkerHandle};

// ---------- Tauri commands ----------

#[tauri::command]
async fn cmd_list_ports(only_likely: bool) -> Result<Vec<PortInfo>, String> {
    let ports = list_ports()?;
    if only_likely {
        Ok(filter_likely_engravers(&ports)
            .into_iter()
            .cloned()
            .collect())
    } else {
        Ok(ports)
    }
}

#[derive(Deserialize)]
struct ConnectArgs {
    port: String,
    baud: Option<u32>,
}

#[tauri::command]
async fn cmd_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ConnectArgs,
) -> Result<(), String> {
    // Default to 115200 (NEJE MAX4 firmware speaks 115200 out of the box).
    let baud = args.baud.unwrap_or(115_200);
    {
        let guard = state.lock().await;
        if guard.worker.is_some() {
            return Err("already connected".into());
        }
    }

    let (tx, cancel_flag) = spawn_worker(app.clone(), args.port.clone(), baud).await?;
    let mut guard = state.lock().await;
    guard.worker = Some(WorkerHandle {
        tx,
        port_name: args.port.clone(),
        baud,
        cancel_flag,
    });

    let _ = app.emit(
        events::LOG,
        LogLine::info(format!("connected to {} @ {}", args.port, baud)),
    );
    Ok(())
}

#[tauri::command]
async fn cmd_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.lock().await;
    if let Some(h) = guard.worker.take() {
        let _ = h.tx.send(WorkerCmd::Shutdown);
    }
    Ok(())
}

#[tauri::command]
async fn cmd_send_line(state: State<'_, AppState>, line: String) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    h.tx
        .send(WorkerCmd::SendLine(line))
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct JogArgs {
    /// Axis deltas in mm (pre-composed, already respecting soft limits).
    dx: f32,
    dy: f32,
    /// Optional Z, NEJE MAX4 usually doesn't use it.
    #[serde(default)]
    dz: f32,
    /// Feed rate in mm/min.
    feed: f32,
}

#[tauri::command]
async fn cmd_jog(state: State<'_, AppState>, args: JogArgs) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    let mut parts = vec!["$J=G91".to_string(), "G21".to_string()];
    if args.dx != 0.0 {
        parts.push(format!("X{:.4}", args.dx));
    }
    if args.dy != 0.0 {
        parts.push(format!("Y{:.4}", args.dy));
    }
    if args.dz != 0.0 {
        parts.push(format!("Z{:.4}", args.dz));
    }
    parts.push(format!("F{:.0}", args.feed.max(1.0)));
    let cmd = parts.join(" ");
    h.tx.send(WorkerCmd::Jog(cmd)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_jog_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    // GRBL jog-cancel is 0x85.
    h.tx
        .send(WorkerCmd::Realtime(0x85))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_home(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    h.tx
        .send(WorkerCmd::SendLine("$H".into()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_unlock(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    h.tx
        .send(WorkerCmd::SendLine("$X".into()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_set_origin(state: State<'_, AppState>) -> Result<(), String> {
    // G92 X0 Y0 Z0 — mark current position as the work origin.
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    h.tx
        .send(WorkerCmd::SendLine("G92 X0 Y0 Z0".into()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_status_poll(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    h.tx
        .send(WorkerCmd::Realtime(RT_STATUS_QUERY))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_feed_hold(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    h.tx
        .send(WorkerCmd::Realtime(RT_FEED_HOLD))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_cycle_start(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    h.tx
        .send(WorkerCmd::Realtime(RT_CYCLE_START))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_soft_reset(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    h.tx
        .send(WorkerCmd::Realtime(RT_SOFT_RESET))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_stream(state: State<'_, AppState>, lines: Vec<String>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    h.tx
        .send(WorkerCmd::StreamLines(lines))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_cancel_stream(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("not connected")?;
    // Set the shared flag — the streaming loop polls it and self-cancels
    // (sends feed-hold + soft-reset inline). We can't rely on
    // WorkerCmd::Cancel through the channel because the worker's outer
    // loop is blocked while streaming.
    h.cancel_flag.store(true, std::sync::atomic::Ordering::SeqCst);
    // Also enqueue a Cancel for the not-streaming case (e.g. interrupting
    // a manual jog). It'll be processed immediately if the worker is idle,
    // or after the stream loop exits otherwise — harmless either way.
    h.tx
        .send(WorkerCmd::Cancel)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_connection_info(state: State<'_, AppState>) -> Result<Option<(String, u32)>, String> {
    let guard = state.lock().await;
    Ok(guard
        .worker
        .as_ref()
        .map(|h| (h.port_name.clone(), h.baud)))
}

// ---------- App entry ----------

fn main() {
    env_logger::try_init().ok();

    let app_state = state::new_state();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .setup(|app| {
            let _ = app.emit(events::LOG, LogLine::info("nejemax4-tauri started"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_list_ports,
            cmd_connect,
            cmd_disconnect,
            cmd_send_line,
            cmd_jog,
            cmd_jog_cancel,
            cmd_home,
            cmd_unlock,
            cmd_set_origin,
            cmd_status_poll,
            cmd_feed_hold,
            cmd_cycle_start,
            cmd_soft_reset,
            cmd_stream,
            cmd_cancel_stream,
            cmd_connection_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
