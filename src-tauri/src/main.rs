// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cameo;
mod esp_proxy;
mod grbl;
mod serial;
mod state;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::cameo::{CameoCmd, CameoHandle, CameoInfo, CameoSetup};
use crate::grbl::{RT_CYCLE_START, RT_FEED_HOLD, RT_SOFT_RESET, RT_STATUS_QUERY};
use crate::serial::{filter_likely_engravers, list_ports, spawn_worker, PortInfo};
use crate::state::{events, AppState, LogLine, WorkerCmd, WorkerHandle};

/// Parallel app state for the CAMEO worker (separate from the GRBL `AppState`
/// so the two machine backends never contend for one lock).
#[derive(Default)]
struct CameoStateInner {
    worker: Option<CameoHandle>,
}
type CameoState = Arc<Mutex<CameoStateInner>>;

/// Handles to the mode-specific Tools menu items, kept so the frontend can
/// enable/disable them when the machine mode changes (test pattern is GRBL-only,
/// tepra is CAMEO-only). Stored in managed state at setup time.
struct ToolMenuItems {
    testpattern: MenuItem<tauri::Wry>,
    tepra: MenuItem<tauri::Wry>,
}

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

/// One installed font file, for the tepra font dropdown.
#[derive(serde::Serialize)]
struct FontEntry {
    /// Absolute path passed back to `readFile` when the user picks this font.
    path: String,
    /// Display label (file stem) shown in the dropdown.
    label: String,
}

/// Enumerate installed font files (.ttf/.otf/.ttc) from the OS font folders so
/// the tepra panel can offer a dropdown instead of a file dialog. Returns
/// entries sorted by label, de-duplicated by path. Missing folders are skipped
/// (no error) — a machine without, say, a user fonts dir still lists the rest.
#[tauri::command]
async fn cmd_list_fonts() -> Result<Vec<FontEntry>, String> {
    use std::collections::BTreeMap;

    // Per-OS standard font directories. The home dir comes from HOME (unix) or
    // USERPROFILE (windows) so we avoid pulling in a dirs crate.
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        dirs.push("/System/Library/Fonts".into());
        dirs.push("/System/Library/Fonts/Supplemental".into());
        dirs.push("/Library/Fonts".into());
        if let Some(h) = &home {
            dirs.push(std::path::Path::new(h).join("Library/Fonts"));
        }
    } else if cfg!(target_os = "windows") {
        let win = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        dirs.push(std::path::Path::new(&win).join("Fonts"));
        if let Some(h) = &home {
            // Per-user installed fonts (Windows 10+).
            dirs.push(
                std::path::Path::new(h)
                    .join("AppData/Local/Microsoft/Windows/Fonts"),
            );
        }
    } else {
        // Linux / other unix.
        dirs.push("/usr/share/fonts".into());
        dirs.push("/usr/local/share/fonts".into());
        if let Some(h) = &home {
            dirs.push(std::path::Path::new(h).join(".local/share/fonts"));
            dirs.push(std::path::Path::new(h).join(".fonts"));
        }
    }
    // Also scan ~/Downloads on every OS: users drop hard-to-find fallback fonts
    // (BabelStone Han, Code2000) there, and the tepra "Auto" stack appends those
    // as deep CJK-extension / generalist fallbacks when present.
    if let Some(h) = &home {
        dirs.push(std::path::Path::new(h).join("Downloads"));
    }

    // De-dupe by absolute path; BTreeMap keeps things ordered by label for free
    // (key = lowercased label + path so same-named files in different dirs both
    // show, sorted case-insensitively).
    let mut found: BTreeMap<(String, String), FontEntry> = BTreeMap::new();
    let is_font = |ext: &str| {
        let e = ext.to_ascii_lowercase();
        e == "ttf" || e == "otf" || e == "ttc"
    };

    for dir in dirs {
        // Recurse one level: macOS Supplemental is flat, but Linux often nests
        // (e.g. /usr/share/fonts/truetype/<family>/*.ttf). walk with a small
        // manual stack bounded in depth to avoid pathological trees.
        let mut stack = vec![(dir, 0u8)];
        while let Some((d, depth)) = stack.pop() {
            let rd = match std::fs::read_dir(&d) {
                Ok(rd) => rd,
                Err(_) => continue, // missing/inaccessible dir → skip
            };
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if depth < 3 {
                        stack.push((p, depth + 1));
                    }
                    continue;
                }
                match p.extension().and_then(|e| e.to_str()) {
                    Some(e) if is_font(e) => {}
                    _ => continue,
                }
                let label = p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("font")
                    .to_string();
                let path = p.to_string_lossy().to_string();
                let key = (label.to_lowercase(), path.clone());
                found.entry(key).or_insert(FontEntry { path, label });
            }
        }
    }

    Ok(found.into_values().collect())
}

/// One decoded GIF frame as a packed 1-bit-per-pixel black mask: `bits[i]`'s
/// (y*width+x)-th bit (LSB-first within each byte) is 1 where the pixel is
/// "black" (luma < threshold and not transparent). Packing keeps the IPC
/// payload small (a 256² frame is 8 KiB packed vs. 64 KiB as a byte array).
#[derive(serde::Serialize)]
struct GifFrameMask {
    width: u32,
    height: u32,
    /// Packed bits, base64-encoded for compact JSON transport.
    bits_b64: String,
}

/// Decode every frame of a GIF file into packed black masks, compositing frame
/// disposal so each returned frame is the FULL displayed image at that step
/// (not just the changed sub-rect). Frames are downscaled by nearest sampling
/// so the longest side is at most `max_side`, then thresholded to 1-bit.
///
/// Lives in Rust because the webview's WebCodecs `ImageDecoder` isn't enabled in
/// the Tauri WKWebView/WebView2 runtimes, so a JS-only decode path fails. This
/// uses the pure-Rust `gif` crate (no system deps).
#[tauri::command]
async fn cmd_decode_gif(
    path: String,
    threshold: u8,
    max_side: u32,
) -> Result<Vec<GifFrameMask>, String> {
    use std::fs::File;

    let file = File::open(&path).map_err(|e| format!("GIFを開けません: {e}"))?;
    let mut opts = gif::DecodeOptions::new();
    opts.set_color_output(gif::ColorOutput::RGBA);
    let mut decoder = opts
        .read_info(file)
        .map_err(|e| format!("GIF解析失敗: {e}"))?;

    let canvas_w = decoder.width() as usize;
    let canvas_h = decoder.height() as usize;
    if canvas_w == 0 || canvas_h == 0 {
        return Err("GIFのサイズが不正です".into());
    }

    // Persistent RGBA canvas we composite each frame onto (honouring disposal).
    let mut canvas = vec![0u8; canvas_w * canvas_h * 4];
    let max_side = max_side.max(1);

    let mut out: Vec<GifFrameMask> = Vec::new();
    // Snapshot saved for DisposalMethod::Previous (restore-to-previous).
    let mut prev_snapshot: Option<Vec<u8>> = None;

    loop {
        let frame = match decoder.read_next_frame() {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => return Err(format!("フレーム読込失敗: {e}")),
        };

        // For "restore to previous", remember the canvas before we draw.
        if frame.dispose == gif::DisposalMethod::Previous {
            prev_snapshot = Some(canvas.clone());
        }

        // Blit this frame's sub-rect (RGBA, top-down) over the canvas, honouring
        // per-pixel transparency (alpha 0 leaves the underlying pixel).
        let fx = frame.left as usize;
        let fy = frame.top as usize;
        let fw = frame.width as usize;
        let fh = frame.height as usize;
        for row in 0..fh {
            let cy = fy + row;
            if cy >= canvas_h {
                break;
            }
            for col in 0..fw {
                let cx = fx + col;
                if cx >= canvas_w {
                    break;
                }
                let si = (row * fw + col) * 4;
                let a = frame.buffer[si + 3];
                if a == 0 {
                    continue; // transparent: keep what's underneath
                }
                let di = (cy * canvas_w + cx) * 4;
                canvas[di] = frame.buffer[si];
                canvas[di + 1] = frame.buffer[si + 1];
                canvas[di + 2] = frame.buffer[si + 2];
                canvas[di + 3] = a;
            }
        }

        // Snapshot of the FULLY-composited frame to emit.
        let composited = canvas.clone();

        // Apply disposal for the NEXT frame.
        match frame.dispose {
            gif::DisposalMethod::Background => {
                // Clear this frame's rect to transparent background.
                for row in 0..fh {
                    let cy = fy + row;
                    if cy >= canvas_h {
                        break;
                    }
                    for col in 0..fw {
                        let cx = fx + col;
                        if cx >= canvas_w {
                            break;
                        }
                        let di = (cy * canvas_w + cx) * 4;
                        canvas[di..di + 4].fill(0);
                    }
                }
            }
            gif::DisposalMethod::Previous => {
                if let Some(snap) = prev_snapshot.take() {
                    canvas = snap;
                }
            }
            // Keep (default) / Any: leave the canvas as-is.
            _ => {}
        }

        // Downscale (nearest) so the longest side ≤ max_side, aspect preserved.
        let scale = (max_side as f32 / canvas_w.max(canvas_h) as f32).min(1.0);
        let tw = ((canvas_w as f32 * scale).round() as u32).max(1);
        let th = ((canvas_h as f32 * scale).round() as u32).max(1);

        let mut bits = vec![0u8; ((tw * th) as usize + 7) / 8];
        for ty in 0..th {
            // Map target pixel back to source (nearest).
            let sy = ((ty as f32 + 0.5) / scale) as usize;
            let sy = sy.min(canvas_h - 1);
            for tx in 0..tw {
                let sx = ((tx as f32 + 0.5) / scale) as usize;
                let sx = sx.min(canvas_w - 1);
                let p = (sy * canvas_w + sx) * 4;
                if composited[p + 3] < 8 {
                    continue; // transparent → background, not ON
                }
                // Rec.601 luma; below threshold counts as black/ON.
                let luma = (0.299 * composited[p] as f32
                    + 0.587 * composited[p + 1] as f32
                    + 0.114 * composited[p + 2] as f32) as u32;
                if luma < threshold as u32 {
                    let idx = (ty * tw + tx) as usize;
                    bits[idx / 8] |= 1 << (idx % 8);
                }
            }
        }

        out.push(GifFrameMask {
            width: tw,
            height: th,
            bits_b64: b64_encode(&bits),
        });
    }

    if out.is_empty() {
        return Err("GIFにフレームが見つかりませんでした".into());
    }
    Ok(out)
}

/// Minimal standard-alphabet base64 encoder (no padding-free; RFC 4648 with
/// padding). Avoids pulling in a base64 crate for this one use.
fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        s.push(T[((n >> 18) & 63) as usize] as char);
        s.push(T[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            s.push(T[((n >> 6) & 63) as usize] as char);
        } else {
            s.push('=');
        }
        if chunk.len() > 2 {
            s.push(T[(n & 63) as usize] as char);
        } else {
            s.push('=');
        }
    }
    s
}

/// Enable/disable the mode-specific Tools menu items for the current machine
/// mode (test pattern = GRBL/laser only, tepra = CAMEO only). Called by the
/// frontend whenever the mode toggles. No-op if the menu wasn't built (e.g. a
/// platform without a menu bar).
#[tauri::command]
fn cmd_set_tool_menu_mode(
    items: State<'_, ToolMenuItems>,
    is_cameo: bool,
) -> Result<(), String> {
    items.testpattern.set_enabled(!is_cameo).map_err(|e| e.to_string())?;
    items.tepra.set_enabled(is_cameo).map_err(|e| e.to_string())?;
    Ok(())
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

#[derive(Deserialize)]
struct EspUploadArgs {
    /// ESP32-S3 CDC port (e.g. "/dev/cu.usbmodem...")
    port: String,
    /// Human-readable job name; gets sanitized + stored as <name>.gcode on the
    /// board's FAT volume.
    name: String,
    /// The full GRBL program, already split into lines.
    lines: Vec<String>,
    /// If true, after a successful upload the board reboots into HOST mode
    /// and immediately starts streaming to the engraver. If false, the user
    /// triggers the run with the on-board OK button later.
    #[serde(default)]
    run_after_upload: bool,
}

#[tauri::command]
async fn cmd_esp_upload(app: AppHandle, args: EspUploadArgs) -> Result<(u64, u32), String> {
    // The ESP CDC port is *not* the same port as the engraver — and the user
    // may be uploading while the engraver-side worker is doing its own thing
    // (e.g. paused mid-cancel). So we open the ESP port on a fresh blocking
    // thread instead of reusing the existing WorkerHandle.
    let log_app = app.clone();
    let progress_app = app.clone();

    let result = tokio::task::spawn_blocking(move || {
        esp_proxy::upload_job(
            &args.port,
            &args.name,
            &args.lines,
            esp_proxy::UploadOptions {
                run_after_upload: args.run_after_upload,
            },
            Box::new(move |sent, total| {
                let _ = progress_app.emit(
                    events::PROGRESS,
                    state::Progress {
                        sent: sent as usize,
                        total: total as usize,
                        line: String::new(),
                    },
                );
            }),
            move |msg| {
                let _ = log_app.emit(events::LOG, LogLine::info(msg));
            },
        )
    })
    .await
    .map_err(|e| format!("join: {}", e))?;

    match result {
        Ok((bytes, crc)) => {
            let _ = app.emit(events::LOG, LogLine::info(format!(
                "ESP upload complete: {} bytes, CRC {:08x}",
                bytes, crc
            )));
            let _ = app.emit(
                events::FINISHED,
                state::Finished {
                    cancelled: false,
                    error: None,
                },
            );
            Ok((bytes, crc as u32))
        }
        Err(e) => {
            let _ = app.emit(events::LOG, LogLine::error(format!(
                "ESP upload failed: {}", e
            )));
            Err(e.to_string())
        }
    }
}

#[derive(Deserialize)]
struct EspCommandArgs {
    port: String,
    cmd: String,
}

/// Send a single CDC command line (WIPE, ARM, DISARM, etc.) and return the
/// first non-INFO reply line. Caller must have released the port first
/// (the Tauri worker can't share a serialport file descriptor).
#[tauri::command]
async fn cmd_esp_command(args: EspCommandArgs) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        esp_proxy::send_command(&args.port, &args.cmd).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

#[derive(Deserialize)]
struct EspPortArg {
    port: String,
}

/// List the jobs currently saved on the ESP's FAT drive (so the UI can confirm
/// a job actually landed in memory after an upload). Opens + closes the port.
#[tauri::command]
async fn cmd_esp_list_jobs(args: EspPortArg) -> Result<Vec<esp_proxy::EspJob>, String> {
    tokio::task::spawn_blocking(move || {
        esp_proxy::list_jobs(&args.port).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

#[tauri::command]
async fn cmd_connection_info(state: State<'_, AppState>) -> Result<Option<(String, u32)>, String> {
    let guard = state.lock().await;
    Ok(guard
        .worker
        .as_ref()
        .map(|h| (h.port_name.clone(), h.baud)))
}

// ---------- CAMEO 5 commands ----------

#[tauri::command]
async fn cmd_cameo_list() -> Result<Vec<CameoInfo>, String> {
    tokio::task::spawn_blocking(cameo::list_cameo)
        .await
        .map_err(|e| format!("join: {}", e))?
}

#[derive(Deserialize)]
struct CameoConnectArgs {
    pid: u16,
    /// Optionally pin a specific unit (0/0 = first match).
    #[serde(default)]
    bus: u8,
    #[serde(default)]
    address: u8,
}

#[tauri::command]
async fn cmd_cameo_connect(
    app: AppHandle,
    state: State<'_, CameoState>,
    args: CameoConnectArgs,
) -> Result<(), String> {
    {
        let guard = state.lock().await;
        if guard.worker.is_some() {
            return Err("CAMEO already connected".into());
        }
    }
    let (tx, model, serial, cancel_flag) =
        cameo::spawn_worker(app.clone(), args.pid, args.bus, args.address).await?;
    let mut guard = state.lock().await;
    guard.worker = Some(CameoHandle {
        tx,
        model,
        serial,
        cancel_flag,
    });
    Ok(())
}

#[tauri::command]
async fn cmd_cameo_disconnect(state: State<'_, CameoState>) -> Result<(), String> {
    let mut guard = state.lock().await;
    if let Some(h) = guard.worker.take() {
        let _ = h.tx.send(CameoCmd::Shutdown);
    }
    Ok(())
}

#[tauri::command]
async fn cmd_cameo_status(state: State<'_, CameoState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("CAMEO not connected")?;
    h.tx.send(CameoCmd::QueryStatus).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_cameo_send(state: State<'_, CameoState>, lines: Vec<String>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("CAMEO not connected")?;
    h.tx.send(CameoCmd::SendRaw(lines)).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct CameoRunArgs {
    setup: CameoSetup,
    lines: Vec<String>,
}

#[tauri::command]
async fn cmd_cameo_run(state: State<'_, CameoState>, args: CameoRunArgs) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("CAMEO not connected")?;
    h.tx
        .send(CameoCmd::Run {
            setup: args.setup,
            lines: args.lines,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_cameo_cancel(state: State<'_, CameoState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("CAMEO not connected")?;
    // Flip the shared flag so a streaming loop self-cancels, and enqueue a
    // Cancel for the idle case (mirrors the GRBL cancel design).
    h.cancel_flag.store(true, Ordering::SeqCst);
    h.tx.send(CameoCmd::Cancel).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct CameoJogArgs {
    dx: f64,
    dy: f64,
}

#[tauri::command]
async fn cmd_cameo_jog(state: State<'_, CameoState>, args: CameoJogArgs) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("CAMEO not connected")?;
    h.tx
        .send(CameoCmd::Jog {
            dx: args.dx,
            dy: args.dy,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_cameo_home(state: State<'_, CameoState>) -> Result<(), String> {
    let guard = state.lock().await;
    let h = guard.worker.as_ref().ok_or("CAMEO not connected")?;
    h.tx.send(CameoCmd::Home).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cmd_cameo_info(state: State<'_, CameoState>) -> Result<Option<(String, Option<String>)>, String> {
    let guard = state.lock().await;
    Ok(guard
        .worker
        .as_ref()
        .map(|h| (h.model.clone(), h.serial.clone())))
}

// ---------- App entry ----------

fn main() {
    env_logger::try_init().ok();

    let app_state = state::new_state();
    let cameo_state: CameoState = Arc::new(Mutex::new(CameoStateInner::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .manage(cameo_state)
        // Add a native "Tools" submenu next to the default File/Edit/View/Window
        // menus. Items emit TOOL_SELECTED to the frontend, which opens the
        // matching tool panel. The two mode-specific items are stashed in
        // managed state so cmd_set_tool_menu_mode can enable/disable them.
        .menu(|app| {
            let menu = Menu::default(app)?;
            let testpattern =
                MenuItem::with_id(app, "tool_testpattern", "テストプリント（出力×速度）", true, None::<&str>)?;
            let tepra =
                MenuItem::with_id(app, "tool_tepra", "テプラ（ロール印刷）", false, None::<&str>)?;
            let close = MenuItem::with_id(app, "tool_close", "ツールを閉じる", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let tools = Submenu::with_items(
                app,
                "Tools",
                true,
                &[&testpattern, &tepra, &sep, &close],
            )?;
            menu.append(&tools)?;
            // Default mode is GRBL → tepra disabled, testpattern enabled (set above).
            app.manage(ToolMenuItems { testpattern, tepra });
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            // Map the clicked item id to a tool key the frontend understands.
            let tool = match event.id().as_ref() {
                "tool_testpattern" => Some("testpattern"),
                "tool_tepra" => Some("tepra"),
                "tool_close" => Some(""), // empty = close any open tool
                _ => None,
            };
            if let Some(t) = tool {
                let _ = app.emit(events::TOOL_SELECTED, t);
            }
        })
        .setup(|app| {
            let _ = app.emit(events::LOG, LogLine::info("nejemax4-tauri started"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_list_ports,
            cmd_list_fonts,
            cmd_decode_gif,
            cmd_set_tool_menu_mode,
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
            cmd_esp_upload,
            cmd_esp_command,
            cmd_esp_list_jobs,
            cmd_cameo_list,
            cmd_cameo_connect,
            cmd_cameo_disconnect,
            cmd_cameo_status,
            cmd_cameo_send,
            cmd_cameo_run,
            cmd_cameo_cancel,
            cmd_cameo_jog,
            cmd_cameo_home,
            cmd_cameo_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
