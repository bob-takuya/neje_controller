//! Shared types and app state.

use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

/// Event names pushed to the frontend via window.emit.
pub mod events {
    pub const LOG: &str = "log";
    pub const STATUS: &str = "status";
    pub const CONNECTION: &str = "connection";
    pub const PROGRESS: &str = "progress";
    pub const FINISHED: &str = "finished";
}

/// A log line emitted to the UI (console-style).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogLine {
    /// "info" | "warn" | "error" | "tx" | "rx"
    pub level: String,
    pub text: String,
}

impl LogLine {
    pub fn info<S: Into<String>>(text: S) -> Self {
        Self { level: "info".into(), text: text.into() }
    }
    pub fn warn<S: Into<String>>(text: S) -> Self {
        Self { level: "warn".into(), text: text.into() }
    }
    pub fn error<S: Into<String>>(text: S) -> Self {
        Self { level: "error".into(), text: text.into() }
    }
    pub fn tx<S: Into<String>>(text: S) -> Self {
        Self { level: "tx".into(), text: text.into() }
    }
    pub fn rx<S: Into<String>>(text: S) -> Self {
        Self { level: "rx".into(), text: text.into() }
    }
}

/// A parsed GRBL status report.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Status {
    /// "Idle" | "Run" | "Hold" | "Jog" | "Alarm" | "Home" | "Check" | "Door" | "Sleep" | ...
    pub state: String,
    /// Machine position (mm).
    pub mpos: Option<[f32; 3]>,
    /// Work position (mm).
    pub wpos: Option<[f32; 3]>,
    /// Feed rate (mm/min) if reported.
    pub feed: Option<f32>,
    /// Spindle/laser S value if reported.
    pub spindle: Option<f32>,
    /// Buffer state: (planner blocks free, RX buffer free).
    pub buffer: Option<[u32; 2]>,
    /// Raw report text for debugging.
    pub raw: String,
}

/// Connection state broadcast to the UI.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnState {
    pub connected: bool,
    pub port: Option<String>,
    pub baud: Option<u32>,
}

/// Job progress update.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Progress {
    pub sent: usize,
    pub total: usize,
    pub line: String,
}

/// Job finished notification.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Finished {
    pub cancelled: bool,
    pub error: Option<String>,
}

/// Commands sent from the UI thread to the serial worker.
#[derive(Debug)]
pub enum WorkerCmd {
    /// Enqueue a single line (will be streamed with handshake).
    SendLine(String),
    /// Stream a whole program.
    StreamLines(Vec<String>),
    /// Cancel the current job (feed-hold + soft-reset).
    Cancel,
    /// Send a realtime byte (e.g. '?', 0x18, 0x85).
    Realtime(u8),
    /// Jog command (GRBL $J=...).
    Jog(String),
    /// Tell the worker to disconnect and exit.
    Shutdown,
}

/// Worker handle kept in the app state.
pub struct WorkerHandle {
    pub tx: mpsc::UnboundedSender<WorkerCmd>,
    pub port_name: String,
    pub baud: u32,
    /// Shared cancel flag. Set from the UI thread to interrupt an active
    /// stream — the worker's outer command loop is blocked while streaming,
    /// so a `WorkerCmd::Cancel` sent through the channel would not be read
    /// until streaming finished. The streaming loop polls this flag every
    /// few hundred ms and self-cancels (feed-hold + soft-reset) when set.
    pub cancel_flag: Arc<AtomicBool>,
}

/// The global application state.
#[derive(Default)]
pub struct AppStateInner {
    pub worker: Option<WorkerHandle>,
}

pub type AppState = Arc<Mutex<AppStateInner>>;

pub fn new_state() -> AppState {
    Arc::new(Mutex::new(AppStateInner::default()))
}
