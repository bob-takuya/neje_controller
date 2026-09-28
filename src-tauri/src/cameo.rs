//! Silhouette CAMEO cutter worker: owns a libusb (rusb) bulk handle and speaks
//! GPGL to the machine.
//!
//! Why this is a separate module from `serial.rs`
//! ----------------------------------------------
//! The CAMEO 5 is a USB *printer-class* device (VID 0x0b4d / PID 0x1140). It
//! does not present a CDC-ACM serial node — there is no `/dev/cu.*` to open, so
//! the `serialport` crate is useless here. We talk raw libusb bulk transfers to
//! interface 0 (bulk OUT 0x01, bulk IN 0x82), exactly like robocut and
//! inkscape-silhouette do. The command language is GPGL (ASCII, each command
//! terminated with 0x03 / ETX), NOT G-code.
//!
//! Structurally this mirrors `serial.rs`: a dedicated blocking worker thread
//! owns the device handle, takes `CameoCmd`s over an mpsc channel, and emits the
//! SAME UI events (`events::LOG/STATUS/PROGRESS/FINISHED/CONNECTION`) so the
//! existing React listeners work unchanged.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusb::{Direction, TransferType, UsbContext};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

use crate::state::{events, ConnState, Finished, LogLine, Progress, Status};

// ---------- USB / protocol constants ----------

pub const VENDOR_GRAPHTEC: u16 = 0x0b4d;

/// Interface and endpoints are identical across the whole Graphtec/Silhouette
/// family (CC200 → CAMEO 5), per robocut + inkscape-silhouette.
const IFACE: u8 = 0;
const EP_OUT: u8 = 0x01; // bulk OUT
const EP_IN: u8 = 0x82; // bulk IN

/// GPGL command terminator (ETX).
const ETX: u8 = 0x03;
/// 1 mm == 20 Silhouette Units.
pub const SU_PER_MM: f64 = 20.0;

/// Largest bulk OUT chunk; inkscape-silhouette chunks writes at 4096.
const CHUNK: usize = 4096;

/// Known Graphtec product IDs → human model name. Sourced from
/// inkscape-silhouette `Graphtec.py`. We list the whole family so the picker
/// can name whatever is plugged in, but the app targets the CAMEO 5 (0x1140).
pub fn model_for_pid(pid: u16) -> Option<&'static str> {
    Some(match pid {
        0x110a => "Craft Robo CC200-20",
        0x111a => "Craft Robo CC300-20",
        0x111c => "Silhouette SD 1",
        0x111d => "Silhouette SD 2",
        0x1121 => "Silhouette CAMEO",
        0x112b => "Silhouette CAMEO 2",
        0x112f => "Silhouette CAMEO 3",
        0x1137 => "Silhouette CAMEO 4",
        0x1138 => "Silhouette CAMEO 4 Plus",
        0x1139 => "Silhouette CAMEO 4 Pro",
        0x1140 => "Silhouette CAMEO 5",
        0x1141 => "Silhouette CAMEO 5 Plus",
        0x1123 => "Silhouette Portrait",
        0x1132 => "Silhouette Portrait 2",
        0x113a => "Silhouette Portrait 3",
        0x113f => "Silhouette Portrait 4",
        0x1146 => "Silhouette CAMEO Pro MK II",
        _ => return None,
    })
}

// ---------- IPC types ----------

/// A detected CAMEO/Graphtec USB device, returned to the UI for the picker.
#[derive(Debug, Clone, Serialize)]
pub struct CameoInfo {
    pub vid: u16,
    pub pid: u16,
    pub model: String,
    pub serial: Option<String>,
    pub bus: u8,
    pub address: u8,
}

/// Machine setup applied before a cut. All ranges are clamped in `apply` to
/// keep the blade/mat safe.
#[derive(Debug, Clone, Deserialize)]
pub struct CameoSetup {
    /// Tool holder: 1 (left, AutoBlade 300gf) or 2 (right, 5kgf rotary).
    pub tool: u8,
    /// Speed 1..=10 (10 == fastest).
    pub speed: u8,
    /// Downforce 1..=33.
    pub force: u8,
    /// AutoBlade depth 0..=10 (tool 1 only; ignored otherwise).
    pub depth: u8,
    /// Whether tool is an AutoBlade (enables the TF depth command on tool 1).
    pub auto_blade: bool,
    /// Blade offset in mm (typ. 0.0 for pen, ~0.9 for blade). Sent as FC.
    pub blade_offset_mm: f64,
    /// Acceleration 1..=3 (TJ).
    pub accel: u8,
    /// Cutting-mat preset for TG (0 = none, 1 = 12x12, 2 = 12x24, 9 = 24x24).
    pub mat: u8,
    /// Enable track-enhancing media feed pre-roll.
    pub track_enhancing: bool,
    /// Cutting-area width in mm (X). Used for the lower-right `Z` boundary.
    pub area_w_mm: f64,
    /// Cutting-area height in mm (Y). Used for the boundary AND as the Y-flip
    /// reference baked into the path commands.
    pub area_h_mm: f64,
}

impl CameoSetup {
    fn tool(&self) -> u8 {
        if self.tool == 2 {
            2
        } else {
            1
        }
    }

    /// Build the GPGL tool-setup commands (verified CAMEO3_ON order:
    /// J → FX → ! → FC, then optional TF depth). Tool/force/speed/offset.
    /// The init handshake (TB71/FA) and boundary (`\0,0`/`Z`) are issued
    /// separately by `run_job` because they need status round-trips / framing.
    fn commands(&self) -> Vec<String> {
        let t = self.tool();
        let speed = self.speed.clamp(1, 10);
        let force = self.force.clamp(1, 33);
        let accel = self.accel.clamp(1, 3);
        let off_su = (self.blade_offset_mm * SU_PER_MM).round() as i64;

        let mut out = Vec::new();
        out.push(format!("J{}", t)); // tool select
        out.push(format!("TJ{}", accel)); // acceleration (CAMEO3+ replacement for `*`)
        out.push(format!("FX{},{}", force, t)); // downforce
        out.push(format!("!{},{}", speed, t)); // speed
        // Blade offset: FC x_su, y_su, tool (y kept at the canonical 1 SU).
        out.push(format!("FC{},{},{}", off_su, 1, t));
        // Cutting-mat preset (0 = none → skip).
        if self.mat > 0 {
            out.push(format!("TG{}", self.mat));
        }
        // AutoBlade depth — tool 1 only, depth 0..10.
        if self.auto_blade && t == 1 {
            out.push(format!("TF{},{}", self.depth.clamp(0, 10), t));
        }
        // Track-enhancing media pre-roll (FU page length seats the media).
        if self.track_enhancing {
            out.push(format!("FU{}", mm_to_su(self.area_h_mm)));
        }
        out
    }

    /// Lower-right boundary command `Z<SU_y>,<SU_x>` for the cutting area.
    fn boundary_z(&self) -> String {
        format!("Z{},{}", mm_to_su(self.area_h_mm), mm_to_su(self.area_w_mm))
    }
}

/// Commands sent from the UI thread to the CAMEO worker.
#[derive(Debug)]
pub enum CameoCmd {
    /// One-shot status query (`\x1b\x05`); emits a STATUS event.
    QueryStatus,
    /// Send raw GPGL command line(s) (manual console / test).
    SendRaw(Vec<String>),
    /// Apply setup then stream a GPGL program (the "cut" action).
    Run { setup: CameoSetup, lines: Vec<String> },
    /// Stop the current job, raise pen, home.
    Cancel,
    /// Pen-up relative move in mm (positioning jog).
    Jog { dx: f64, dy: f64 },
    /// Move to origin (0,0) pen-up.
    Home,
    /// Disconnect and exit the worker.
    Shutdown,
}

/// Worker handle kept in app state.
pub struct CameoHandle {
    pub tx: mpsc::UnboundedSender<CameoCmd>,
    pub model: String,
    pub serial: Option<String>,
    /// Set from the UI to interrupt an in-progress stream; polled by the
    /// streaming loop (same trick as the serial worker).
    pub cancel_flag: Arc<AtomicBool>,
}

// ---------- Enumeration ----------

/// List every connected Graphtec/Silhouette device.
pub fn list_cameo() -> Result<Vec<CameoInfo>, String> {
    let ctx = rusb::Context::new().map_err(|e| format!("usb context: {}", e))?;
    let devices = ctx.devices().map_err(|e| format!("usb devices: {}", e))?;
    let mut out = Vec::new();
    for dev in devices.iter() {
        let desc = match dev.device_descriptor() {
            Ok(d) => d,
            Err(_) => continue,
        };
        if desc.vendor_id() != VENDOR_GRAPHTEC {
            continue;
        }
        let pid = desc.product_id();
        let model = model_for_pid(pid)
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Graphtec device 0x{:04x}", pid));
        // Reading the serial string requires opening the device; best-effort.
        let serial = dev.open().ok().and_then(|h| {
            h.read_serial_number_string_ascii(&desc).ok()
        });
        out.push(CameoInfo {
            vid: VENDOR_GRAPHTEC,
            pid,
            model,
            serial,
            bus: dev.bus_number(),
            address: dev.address(),
        });
    }
    Ok(out)
}

// ---------- Worker spawn ----------

/// Spawn the CAMEO worker. Opens the device by VID/PID (optionally pinned to a
/// bus/address so we open the exact unit the user picked) and returns the
/// command sender + shared cancel flag.
pub async fn spawn_worker(
    app: AppHandle,
    pid: u16,
    bus: u8,
    address: u8,
) -> Result<(mpsc::UnboundedSender<CameoCmd>, String, Option<String>, Arc<AtomicBool>), String> {
    let (ready_tx, ready_rx) =
        oneshot::channel::<Result<(String, Option<String>), String>>();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<CameoCmd>();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel_for_worker = cancel_flag.clone();

    tokio::task::spawn_blocking(move || {
        match open_device(pid, bus, address) {
            Ok((handle, model, serial)) => {
                let _ = ready_tx.send(Ok((model.clone(), serial.clone())));
                run_worker(app, handle, model, serial, cmd_rx, cancel_for_worker);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });

    let (model, serial) = ready_rx
        .await
        .map_err(|_| "cameo worker did not start".to_string())??;
    Ok((cmd_tx, model, serial, cancel_flag))
}

/// Open + claim the CAMEO. Mirrors robocut's UsbInit / inkscape-silhouette.
fn open_device(
    pid: u16,
    bus: u8,
    address: u8,
) -> Result<(rusb::DeviceHandle<rusb::Context>, String, Option<String>), String> {
    let ctx = rusb::Context::new().map_err(|e| format!("usb context: {}", e))?;
    let devices = ctx.devices().map_err(|e| format!("usb devices: {}", e))?;

    for dev in devices.iter() {
        let desc = match dev.device_descriptor() {
            Ok(d) => d,
            Err(_) => continue,
        };
        if desc.vendor_id() != VENDOR_GRAPHTEC || desc.product_id() != pid {
            continue;
        }
        // If a specific unit was requested, match bus/address too.
        if (bus != 0 || address != 0)
            && (dev.bus_number() != bus || dev.address() != address)
        {
            continue;
        }

        let handle = dev
            .open()
            .map_err(|e| format!("open CAMEO: {} (is another app/print queue using it?)", e))?;

        // On Linux this detaches a kernel printer driver; on macOS it returns
        // NotSupported and rusb treats it as a no-op — safe either way.
        let _ = handle.set_auto_detach_kernel_driver(true);
        // robocut sets configuration 1; usually already active, ignore errors.
        let _ = handle.set_active_configuration(1);

        handle.claim_interface(IFACE).map_err(|e| match e {
            rusb::Error::Busy => "CAMEO is busy — close Silhouette Studio or any \
                 print queue holding the device, then retry"
                .to_string(),
            other => format!("claim interface 0: {}", other),
        })?;
        let _ = handle.set_alternate_setting(IFACE, 0);

        // Sanity-check that the bulk endpoints we expect actually exist.
        verify_endpoints(&dev, &desc);

        let model = model_for_pid(pid)
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Graphtec device 0x{:04x}", pid));
        let serial = handle.read_serial_number_string_ascii(&desc).ok();
        return Ok((handle, model, serial));
    }

    Err(format!(
        "no Graphtec device with PID 0x{:04x} found on USB",
        pid
    ))
}

/// Best-effort log if the expected bulk endpoints aren't present (newer
/// hardware could differ); doesn't fail the open.
fn verify_endpoints(dev: &rusb::Device<rusb::Context>, desc: &rusb::DeviceDescriptor) {
    let config = match dev.config_descriptor(0) {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = desc;
    let mut have_out = false;
    let mut have_in = false;
    for iface in config.interfaces() {
        for d in iface.descriptors() {
            for ep in d.endpoint_descriptors() {
                if ep.transfer_type() == TransferType::Bulk {
                    match ep.direction() {
                        Direction::Out if ep.address() == EP_OUT => have_out = true,
                        Direction::In if ep.address() == EP_IN => have_in = true,
                        _ => {}
                    }
                }
            }
        }
    }
    if !have_out || !have_in {
        log::warn!(
            "CAMEO: expected bulk EPs 0x01/0x82 not both found (out={}, in={}); \
             proceeding anyway",
            have_out,
            have_in
        );
    }
}

// ---------- Worker loop ----------

fn run_worker(
    app: AppHandle,
    mut handle: rusb::DeviceHandle<rusb::Context>,
    model: String,
    serial: Option<String>,
    mut rx: mpsc::UnboundedReceiver<CameoCmd>,
    cancel_flag: Arc<AtomicBool>,
) {
    let label = format!(
        "{}{}",
        model,
        serial.as_deref().map(|s| format!(" ({})", s)).unwrap_or_default()
    );
    let _ = app.emit(
        events::CONNECTION,
        ConnState {
            connected: true,
            port: Some(label.clone()),
            baud: None,
        },
    );
    let _ = app.emit(events::LOG, LogLine::info(format!("CAMEO connected: {}", label)));

    // Initialize device + report initial status.
    let _ = write_bytes(&mut handle, &[0x04]); // EOT — device init
    std::thread::sleep(Duration::from_millis(200));
    emit_status(&app, &mut handle);

    loop {
        let msg = match rx.blocking_recv() {
            Some(m) => m,
            None => break,
        };
        match msg {
            CameoCmd::QueryStatus => {
                emit_status(&app, &mut handle);
            }
            CameoCmd::SendRaw(lines) => {
                for l in &lines {
                    let _ = app.emit(events::LOG, LogLine::tx(l.clone()));
                }
                if let Err(e) = write_gpgl(&mut handle, &lines) {
                    let _ = app.emit(events::LOG, LogLine::error(e));
                }
            }
            CameoCmd::Jog { dx, dy } => {
                // Relative pen-up move. GPGL O is relative; coords are y,x.
                let cmd = format!(
                    "O{},{}",
                    mm_to_su(dy),
                    mm_to_su(dx)
                );
                let _ = app.emit(events::LOG, LogLine::tx(cmd.clone()));
                if let Err(e) = write_gpgl(&mut handle, std::slice::from_ref(&cmd)) {
                    let _ = app.emit(events::LOG, LogLine::error(e));
                }
            }
            CameoCmd::Home => {
                if let Err(e) = end_job(&mut handle) {
                    let _ = app.emit(events::LOG, LogLine::error(e));
                } else {
                    let _ = app.emit(events::LOG, LogLine::info("CAMEO: home"));
                }
            }
            CameoCmd::Run { setup, lines } => {
                cancel_flag.store(false, Ordering::SeqCst);
                run_job(&app, &mut handle, &setup, &lines, &cancel_flag);
            }
            CameoCmd::Cancel => {
                cancel_flag.store(true, Ordering::SeqCst);
                // Best-effort raise + home.
                let _ = end_job(&mut handle);
                let _ = app.emit(events::LOG, LogLine::warn("CAMEO: cancelled, homing"));
            }
            CameoCmd::Shutdown => break,
        }
    }

    let _ = handle.release_interface(IFACE);
    drop(handle);
    let _ = app.emit(
        events::CONNECTION,
        ConnState { connected: false, port: None, baud: None },
    );
    let _ = app.emit(events::LOG, LogLine::info("CAMEO disconnected"));
}

/// Apply setup, stream the job with progress + cancel, then finish.
///
/// This is the hardware-verified CAMEO3_ON sequence (matches inkscape-silhouette
/// and confirmed by drawing an L-shape on the real CAMEO 5):
///   1. wait for ready (status '0')
///   2. TB71 (read reply), FA (read reply)  — calibration / begin-page
///   3. tool setup: J / FX / ! / FC [/ TF]
///   4. boundary: `\0,0` (upper-left) + `Z<h>,<w>` (lower-right)
///   5. the path commands (already y-first + Y-flipped by cameoGpgl.ts)
///   6. end: L0, `\0,0`, M0,0, J0, FN0, TB50,0
fn run_job(
    app: &AppHandle,
    handle: &mut rusb::DeviceHandle<rusb::Context>,
    setup: &CameoSetup,
    lines: &[String],
    cancel: &Arc<AtomicBool>,
) {
    // 1. Init + wait for ready so the device actually executes motion (a job
    //    sent while 'moving'/'unloaded' is silently ignored).
    let _ = write_bytes(handle, &[0x04]);
    if !wait_ready(handle, 12) {
        let _ = app.emit(
            events::LOG,
            LogLine::warn("CAMEO not ready (load media?) — sending anyway"),
        );
    }

    // 2. Calibration / begin-page queries (each replies "    0,    0").
    let _ = send_and_read(handle, "TB71", 8000);
    let _ = send_and_read(handle, "FA", 8000);

    // 3. Tool setup.
    let setup_cmds = setup.commands();
    for c in &setup_cmds {
        let _ = app.emit(events::LOG, LogLine::tx(c.clone()));
    }
    if let Err(e) = write_gpgl(handle, &setup_cmds) {
        finish(app, false, Some(e));
        return;
    }

    // 4. Boundary (cutting window). Without this the device may not move.
    let boundary = vec!["\\0,0".to_string(), setup.boundary_z()];
    if let Err(e) = write_gpgl(handle, &boundary) {
        finish(app, false, Some(e));
        return;
    }

    let _ = app.emit(events::STATUS, status_state("Run"));

    // 5. Stream the path command-by-command, batching wire writes while still
    //    polling cancel + reporting progress between batches.
    let total = lines.len();
    let mut sent = 0usize;
    let mut last_progress = 0usize;
    let mut last_status = Instant::now();
    const BATCH: usize = 64;

    while sent < total {
        if cancel.load(Ordering::SeqCst) {
            let _ = end_job(handle);
            finish(app, true, None);
            return;
        }
        let end = (sent + BATCH).min(total);
        let batch = &lines[sent..end];
        if let Err(e) = write_gpgl(handle, batch) {
            finish(app, false, Some(e));
            return;
        }
        sent = end;

        if sent - last_progress >= BATCH || sent == total {
            let _ = app.emit(
                events::PROGRESS,
                Progress {
                    sent,
                    total,
                    line: lines.get(sent.saturating_sub(1)).cloned().unwrap_or_default(),
                },
            );
            last_progress = sent;
        }

        if last_status.elapsed() >= Duration::from_millis(1000) {
            emit_status(app, handle);
            last_status = Instant::now();
        }
    }

    // 6. End sequence: raise, return to origin, reset.
    let _ = end_job(handle);
    finish(app, false, None);
}

fn finish(app: &AppHandle, cancelled: bool, error: Option<String>) {
    if let Some(ref e) = error {
        let _ = app.emit(events::LOG, LogLine::error(format!("CAMEO job error: {}", e)));
    }
    let _ = app.emit(events::STATUS, status_state("Idle"));
    let _ = app.emit(events::FINISHED, Finished { cancelled, error });
}

/// Poll status up to `tries` times, returning true once the device reports
/// ready ('0'). ~400ms between polls.
fn wait_ready(handle: &mut rusb::DeviceHandle<rusb::Context>, tries: u32) -> bool {
    for _ in 0..tries {
        if let Ok(state) = read_status(handle) {
            if state == "Idle" {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    false
}

/// Send a single ETX-terminated command and read its reply (used for TB71/FA
/// which the device answers). Errors are non-fatal (best effort).
fn send_and_read(
    handle: &mut rusb::DeviceHandle<rusb::Context>,
    cmd: &str,
    timeout_ms: u64,
) -> Result<String, String> {
    write_gpgl(handle, std::slice::from_ref(&cmd.to_string()))?;
    let mut buf = [0u8; 64];
    match handle.read_bulk(EP_IN, &mut buf, Duration::from_millis(timeout_ms)) {
        Ok(n) => Ok(String::from_utf8_lossy(&buf[..n]).to_string()),
        Err(e) => Err(format!("{} read: {}", cmd, e)),
    }
}

/// End-of-job: raise pen, return to origin, deselect tool, reset orientation
/// (the verified CAMEO3_ON reset-to-start sequence).
fn end_job(handle: &mut rusb::DeviceHandle<rusb::Context>) -> Result<(), String> {
    let cmds = vec![
        "L0".to_string(),
        "\\0,0".to_string(),
        "M0,0".to_string(),
        "J0".to_string(),
        "FN0".to_string(),
        "TB50,0".to_string(),
    ];
    write_gpgl(handle, &cmds)
}

// ---------- Low-level GPGL / bulk IO ----------

/// mm → Silhouette Units (rounded), as an i64 so we can format negatives.
pub fn mm_to_su(mm: f64) -> i64 {
    (mm * SU_PER_MM).round() as i64
}

/// Join GPGL command lines with the ETX terminator and bulk-write them.
fn write_gpgl(handle: &mut rusb::DeviceHandle<rusb::Context>, lines: &[String]) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let mut buf: Vec<u8> = Vec::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
    for l in lines {
        buf.extend_from_slice(l.as_bytes());
        buf.push(ETX);
    }
    write_bytes(handle, &buf)
}

/// Bulk-write raw bytes in CHUNK-sized pieces to EP 0x01.
fn write_bytes(handle: &mut rusb::DeviceHandle<rusb::Context>, data: &[u8]) -> Result<(), String> {
    let timeout = Duration::from_secs(15);
    let mut off = 0;
    while off < data.len() {
        let end = (off + CHUNK).min(data.len());
        match handle.write_bulk(EP_OUT, &data[off..end], timeout) {
            Ok(n) => {
                off += n;
                if n == 0 {
                    return Err("bulk write returned 0 bytes".into());
                }
            }
            Err(e) => return Err(format!("bulk write: {}", e)),
        }
    }
    Ok(())
}

/// Query device status: write `\x1b\x05`, read one of '0'/'1'/'2'.
fn read_status(handle: &mut rusb::DeviceHandle<rusb::Context>) -> Result<String, String> {
    handle
        .write_bulk(EP_OUT, &[0x1b, 0x05], Duration::from_secs(3))
        .map_err(|e| format!("status write: {}", e))?;
    let mut buf = [0u8; 64];
    let n = handle
        .read_bulk(EP_IN, &mut buf, Duration::from_secs(3))
        .map_err(|e| format!("status read: {}", e))?;
    let code = buf[..n].iter().find(|&&b| b == b'0' || b == b'1' || b == b'2');
    Ok(match code {
        Some(b'0') => "Idle",
        Some(b'1') => "Run",
        Some(b'2') => "Unloaded",
        _ => "Unknown",
    }
    .to_string())
}

fn emit_status(app: &AppHandle, handle: &mut rusb::DeviceHandle<rusb::Context>) {
    match read_status(handle) {
        Ok(state) => {
            let _ = app.emit(events::STATUS, status_state(&state));
        }
        Err(e) => {
            // A read timeout while the head is moving is normal; only log other
            // failures, and don't spam the bus.
            log::debug!("cameo status: {}", e);
        }
    }
}

/// Build a `Status` with only the `state` field meaningful (the CAMEO doesn't
/// report position over this query).
fn status_state(state: &str) -> Status {
    Status {
        state: state.to_string(),
        mpos: None,
        wpos: None,
        feed: None,
        spindle: None,
        buffer: None,
        raw: format!("cameo:{}", state),
    }
}
