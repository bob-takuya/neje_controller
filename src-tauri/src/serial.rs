//! Serial worker: owns the port and talks to GRBL.
//!
//! The worker runs as a dedicated tokio task. It uses `spawn_blocking` for the
//! actual blocking serial reads/writes (the `serialport` crate is synchronous),
//! and communicates with the UI thread via an `UnboundedSender<WorkerCmd>`.
//!
//! Streaming model
//! ---------------
//! GRBL 1.1 supports two streaming models:
//!   (a) Simple "ok" pong: send a line, wait for "ok", repeat.
//!   (b) Character-counting: track the controller's RX buffer usage.
//!
//! For a single user streaming a DXF over USB, (a) is plenty and a lot easier
//! to reason about. That's what we implement here.

use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serialport::{SerialPort, SerialPortType};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

use crate::grbl::{self, RT_SOFT_RESET, RT_STATUS_QUERY};
use crate::state::{events, ConnState, Finished, LogLine, Progress, WorkerCmd};

/// Info about a detected serial port, returned to the UI.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PortInfo {
    pub name: String,
    pub kind: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
}

/// Enumerate available serial ports and classify them.
pub fn list_ports() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| match p.port_type {
            SerialPortType::UsbPort(usb) => PortInfo {
                name: p.port_name,
                kind: "usb".into(),
                manufacturer: usb.manufacturer,
                product: usb.product,
                serial_number: usb.serial_number,
            },
            SerialPortType::BluetoothPort => PortInfo {
                name: p.port_name,
                kind: "bluetooth".into(),
                manufacturer: None,
                product: None,
                serial_number: None,
            },
            SerialPortType::PciPort => PortInfo {
                name: p.port_name,
                kind: "pci".into(),
                manufacturer: None,
                product: None,
                serial_number: None,
            },
            SerialPortType::Unknown => PortInfo {
                name: p.port_name,
                kind: "unknown".into(),
                manufacturer: None,
                product: None,
                serial_number: None,
            },
        })
        .collect())
}

/// Filter to "likely engraver" USB CDC ports.
///
/// Platform notes:
///   - macOS / Linux: ports are named like `/dev/cu.usbserial-*`,
///     `/dev/cu.wchusbserial*`, `/dev/ttyUSB0`, `/dev/ttyACM0`. We match on
///     these name fragments.
///   - Windows: every serial port is named `COMn` regardless of bus, so the
///     name alone tells us nothing. We instead trust the `kind == "usb"`
///     classification from `serialport` (only set for USB CDC ports), plus
///     manufacturer/product hints.
///
/// In every case, manufacturer/product strings like "wch", "ch340", "ch341",
/// or "nejet" are accepted as a strong signal regardless of OS.
pub fn filter_likely_engravers(ports: &[PortInfo]) -> Vec<&PortInfo> {
    let hint = |s: &Option<String>| -> bool {
        s.as_deref()
            .map(|m| {
                let lm = m.to_lowercase();
                lm.contains("wch")
                    || lm.contains("ch340")
                    || lm.contains("ch341")
                    || lm.contains("neje")
                    || lm.contains("usb-serial")
                    || lm.contains("usb serial")
            })
            .unwrap_or(false)
    };

    ports
        .iter()
        .filter(|p| {
            let lower = p.name.to_lowercase();
            let unix_name_match = lower.contains("usbserial")
                || lower.contains("usbmodem")
                || lower.contains("wchusb")
                || lower.contains("ttyusb")
                || lower.contains("ttyacm");
            // On Windows, COM names tell us nothing — fall back to the bus
            // kind reported by serialport. Any USB CDC port is a candidate.
            let win_usb = cfg!(target_os = "windows")
                && p.kind == "usb"
                && lower.starts_with("com");
            unix_name_match || win_usb || hint(&p.manufacturer) || hint(&p.product)
        })
        .collect()
}

/// Spawn the serial worker task. Returns the command sender + the shared
/// cancel flag (so `cmd_cancel_stream` can interrupt an active stream
/// without going through the worker command channel — the worker's outer
/// loop is blocked while streaming).
pub async fn spawn_worker(
    app: AppHandle,
    port_name: String,
    baud: u32,
) -> Result<(mpsc::UnboundedSender<WorkerCmd>, Arc<AtomicBool>), String> {
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<WorkerCmd>();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel_for_worker = cancel_flag.clone();
    let port_for_task = port_name.clone();

    tokio::task::spawn_blocking(move || {
        match open_port(&port_for_task, baud) {
            Ok(port) => {
                let _ = ready_tx.send(Ok(()));
                run_worker(app, port, cmd_rx, cancel_for_worker);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });

    ready_rx
        .await
        .map_err(|_| "worker did not start".to_string())??;

    Ok((cmd_tx, cancel_flag))
}

fn open_port(name: &str, baud: u32) -> Result<Box<dyn SerialPort>, String> {
    serialport::new(name, baud)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("Failed to open {}: {}", name, e))
}

/// Blocking worker loop.
fn run_worker(
    app: AppHandle,
    mut port: Box<dyn SerialPort>,
    mut rx: mpsc::UnboundedReceiver<WorkerCmd>,
    cancel_flag: Arc<AtomicBool>,
) {
    let _ = app.emit(
        events::CONNECTION,
        ConnState {
            connected: true,
            port: Some(port.name().unwrap_or_default()),
            baud: Some(port.baud_rate().unwrap_or(0)),
        },
    );
    let _ = app.emit(events::LOG, LogLine::info("serial port opened"));

    // Soft-reset the controller so we start from a known state.
    let _ = port.write_all(&[RT_SOFT_RESET]);
    std::thread::sleep(Duration::from_millis(1500));
    let _ = port.clear(serialport::ClearBuffer::All);

    // Two halves: an owned read side (BufReader clone via try_clone) and the write side.
    let reader_port = match port.try_clone() {
        Ok(p) => p,
        Err(e) => {
            let _ = app.emit(
                events::LOG,
                LogLine::error(format!("try_clone failed: {}", e)),
            );
            return;
        }
    };

    // Shared "streaming job" state. cancel_flag is owned by the UI side
    // (set from cmd_cancel_stream) and polled here.
    let (rx_line_tx, rx_line_rx) = std::sync::mpsc::channel::<String>();

    // Reader thread: forwards every line from the port to rx_line_tx *and* emits it
    // as a log event. We don't parse the ok/error here; the main loop does.
    //
    // Framing note: the port is opened with a 100ms read timeout, and GRBL
    // replies can arrive in small fragments (USB-CDC, some CH340 drivers, OS
    // scheduling — all conspire to occasionally hand us one byte at a time).
    // `BufReader::read_line` may return TimedOut after appending PARTIAL data
    // to `buf`. If we cleared `buf` on the next iteration we'd drop that
    // prefix and deliver a corrupted line (e.g. "k" instead of "ok"), which
    // breaks `send_and_wait_ok`'s ack detection and silently hangs the job
    // right after the first G0 actually moves the head.
    //
    // So: accumulate into `buf` across timeouts, and only emit / clear when
    // we receive a complete newline-terminated line.
    let app_for_reader = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader_port);
        let mut buf = String::new();
        loop {
            match reader.read_line(&mut buf) {
                Ok(0) => {
                    // EOF / nothing available — serial port is still alive,
                    // just idle. Don't touch `buf`: a partial line might still
                    // be accumulating (unlikely with 0 but harmless).
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                Ok(_) => {
                    // Successful line (terminated by '\n'). Anything already
                    // accumulated in `buf` from previous timeout iterations is
                    // the complete line.
                    let line = buf.trim_end_matches(['\r', '\n']).to_string();
                    buf.clear();
                    if line.is_empty() {
                        continue;
                    }
                    // Push to job loop.
                    let _ = rx_line_tx.send(line.clone());
                    // Emit to UI. Status reports go to BOTH the STATUS stream
                    // (for the live readout widgets) and the RX log (so the
                    // operator sees the full reply when they manually type `?`
                    // or `$$` — previously status lines were silently dropped
                    // from the log, making the reply look like just "ok").
                    if let Some(status) = grbl::parse_status(&line) {
                        let _ = app_for_reader.emit(events::STATUS, status);
                        let _ = app_for_reader
                            .emit(events::LOG, LogLine::rx(line.clone()));
                    } else if grbl::is_welcome(&line) {
                        let _ = app_for_reader
                            .emit(events::LOG, LogLine::info(format!("[grbl] {}", line)));
                    } else {
                        let _ = app_for_reader.emit(events::LOG, LogLine::rx(line));
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // Preserve `buf`: it may already hold the prefix of the
                    // next line, which will be completed on a subsequent read.
                    continue;
                }
                Err(e) => {
                    let _ = app_for_reader
                        .emit(events::LOG, LogLine::error(format!("serial read: {}", e)));
                    break;
                }
            }
        }
    });

    // Main command loop.
    loop {
        let msg = match rx.blocking_recv() {
            Some(m) => m,
            None => break, // channel closed => shutdown
        };

        match msg {
            WorkerCmd::SendLine(raw) => {
                if let Some(line) = grbl::normalize_line(&raw) {
                    let _ = app.emit(events::LOG, LogLine::tx(line.clone()));
                    if let Err(e) = send_and_wait_ok(&mut port, &line, &rx_line_rx, &cancel_flag) {
                        let _ = app.emit(events::LOG, LogLine::error(e));
                    }
                }
            }

            WorkerCmd::Jog(cmd) => {
                // Jog commands are non-blocking per GRBL spec: we still wait for the
                // "ok" that acknowledges queueing, but nothing beyond that.
                let _ = app.emit(events::LOG, LogLine::tx(cmd.clone()));
                if let Err(e) = send_and_wait_ok(&mut port, &cmd, &rx_line_rx, &cancel_flag) {
                    let _ = app.emit(events::LOG, LogLine::error(e));
                }
            }

            WorkerCmd::Realtime(byte) => {
                // Status-query '?' is pinged once per second by the UI —
                // don't flood the log with it. Other realtime bytes (!, ~,
                // Ctrl-X, 0x85 jog-cancel) are rare and worth logging.
                if byte != RT_STATUS_QUERY {
                    let _ = app.emit(
                        events::LOG,
                        LogLine::tx(format!("<realtime 0x{:02X}>", byte)),
                    );
                }
                if let Err(e) = port.write_all(&[byte]) {
                    let _ = app.emit(
                        events::LOG,
                        LogLine::error(format!("realtime write: {}", e)),
                    );
                }
            }

            WorkerCmd::StreamLines(lines) => {
                cancel_flag.store(false, Ordering::SeqCst);
                // Drain stale rx lines before starting.
                while rx_line_rx.try_recv().is_ok() {}

                let filtered: Vec<String> = lines
                    .iter()
                    .filter_map(|l| grbl::normalize_line(l))
                    .collect();
                let total = filtered.len();
                let mut sent = 0usize;
                let mut error: Option<String> = None;
                let mut was_cancelled = false;

                for line in filtered.iter() {
                    if cancel_flag.load(Ordering::SeqCst) {
                        was_cancelled = true;
                        break;
                    }
                    let _ = app.emit(events::LOG, LogLine::tx(line.clone()));
                    match send_and_wait_ok(&mut port, line, &rx_line_rx, &cancel_flag) {
                        Ok(()) => {}
                        Err(e) => {
                            error = Some(e);
                            break;
                        }
                    }
                    // send_and_wait_ok returns early on cancel — recheck so
                    // we don't count the unfinished line as "sent".
                    if cancel_flag.load(Ordering::SeqCst) {
                        was_cancelled = true;
                        break;
                    }
                    sent += 1;
                    // Emit progress at most every few lines to avoid flooding.
                    if sent % 10 == 0 || sent == total {
                        let _ = app.emit(
                            events::PROGRESS,
                            Progress {
                                sent,
                                total,
                                line: line.clone(),
                            },
                        );
                    }
                }

                // If cancelled mid-stream, decisively stop the controller.
                // Doing this inline (rather than relying on a queued
                // WorkerCmd::Cancel) is what makes the cancel button
                // responsive — the outer command loop is still blocked here.
                if was_cancelled {
                    let _ = port.write_all(&[grbl::RT_FEED_HOLD]);
                    std::thread::sleep(Duration::from_millis(100));
                    let _ = port.write_all(&[RT_SOFT_RESET]);
                    let _ = app.emit(
                        events::LOG,
                        LogLine::warn("cancel: feed-hold + soft-reset"),
                    );
                }

                // Make sure the final progress frame is emitted.
                let _ = app.emit(
                    events::PROGRESS,
                    Progress {
                        sent,
                        total,
                        line: filtered.last().cloned().unwrap_or_default(),
                    },
                );

                let _ = app.emit(
                    events::FINISHED,
                    Finished {
                        cancelled: was_cancelled,
                        error,
                    },
                );
            }

            WorkerCmd::Cancel => {
                cancel_flag.store(true, Ordering::SeqCst);
                // Feed-hold first, then soft-reset for an immediate stop.
                let _ = port.write_all(&[grbl::RT_FEED_HOLD]);
                std::thread::sleep(Duration::from_millis(100));
                let _ = port.write_all(&[RT_SOFT_RESET]);
                let _ = app.emit(events::LOG, LogLine::warn("cancel: feed-hold + soft-reset"));
            }

            WorkerCmd::Shutdown => break,
        }
    }

    let _ = app.emit(
        events::CONNECTION,
        ConnState { connected: false, port: None, baud: None },
    );
    let _ = app.emit(events::LOG, LogLine::info("serial port closed"));
}

/// Write `line\n` to the port and block until we see "ok" (success) or
/// "error:*"/"ALARM:*" (failure). Pings for status once a second so the UI
/// stays alive during long moves.
fn send_and_wait_ok(
    port: &mut Box<dyn SerialPort>,
    line: &str,
    rx: &std::sync::mpsc::Receiver<String>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut msg = String::with_capacity(line.len() + 1);
    msg.push_str(line);
    msg.push('\n');
    port.write_all(msg.as_bytes())
        .map_err(|e| format!("serial write: {}", e))?;
    // Force the OS-level serial tx buffer to hand data to the driver now.
    // Without this, some USB-CDC stacks hold the write until another write
    // comes along — which never happens if we're waiting on this same line's
    // "ok" reply, producing a silent hang indistinguishable from the reader
    // thread dropping bytes.
    let _ = port.flush();

    let mut last_ping = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(reply) => {
                if grbl::is_ack(&reply) {
                    return Ok(());
                }
                if grbl::is_error(&reply) {
                    return Err(format!("GRBL reported {} for '{}'", reply.trim(), line));
                }
                if grbl::is_alarm(&reply) {
                    return Err(format!("GRBL ALARM {} (line: {})", reply.trim(), line));
                }
                // Otherwise it's a status report or unsolicited line: ignore.
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if last_ping.elapsed() >= Duration::from_millis(900) {
                    let _ = port.write_all(&[RT_STATUS_QUERY]);
                    let _ = port.flush();
                    last_ping = std::time::Instant::now();
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("reader thread disconnected".into());
            }
        }
    }
}
