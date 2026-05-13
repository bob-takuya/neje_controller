//! GRBL 1.1 protocol helpers.
//!
//! Reference: https://github.com/gnea/grbl/wiki/Grbl-v1.1-Interface
//!
//! Covers the bits we care about for NEJE MAX4:
//!   - Normalizing outgoing lines (strip comments / whitespace / blanks).
//!   - Parsing "<...>"-style status reports.
//!   - Recognizing "ok" / "error:NN" / "ALARM:NN" replies.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::state::Status;

/// Realtime bytes.
pub const RT_STATUS_QUERY: u8 = b'?';
pub const RT_FEED_HOLD: u8 = b'!';
pub const RT_CYCLE_START: u8 = b'~';
pub const RT_SOFT_RESET: u8 = 0x18; // Ctrl-X

/// Strip inline comments `(...)` and line comments `;...`.
/// Tabs and CR/LF are removed; internal whitespace is collapsed where safe.
pub fn normalize_line(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut in_paren = 0i32;
    for ch in raw.chars() {
        match ch {
            '(' => in_paren += 1,
            ')' => {
                if in_paren > 0 {
                    in_paren -= 1;
                }
            }
            ';' => break,
            '\r' | '\n' => break,
            _ if in_paren > 0 => {}
            c => out.push(c),
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Does this reply line indicate the controller accepted the previous command?
pub fn is_ack(line: &str) -> bool {
    line.trim().eq_ignore_ascii_case("ok")
}

/// Does this reply line indicate an error for the previous command?
/// Returns (is_error, full_text).
pub fn is_error(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("error:") || t.starts_with("ERROR:")
}

pub fn is_alarm(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("ALARM:") || t.starts_with("alarm:")
}

/// Welcome banner pattern: "Grbl 1.1h ['$' for help]" etc.
pub fn is_welcome(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.starts_with("grbl ")
}

// ---------- Status report parsing ----------

static STATUS_WRAP: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^<(?P<body>[^>]*)>\s*$").unwrap());
// Match 3 or more comma-separated floats (NEJE MAX4 reports 4 axes).
// We capture the first 3 (X, Y, Z) and ignore any trailing axes.
static FLOAT3: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(-?\d+\.?\d*),(-?\d+\.?\d*),(-?\d+\.?\d*)(?:,.*)?$").unwrap());

/// Parse a status report of the form `<Idle|MPos:0.000,0.000,0.000|FS:0,0|Bf:15,127>`.
pub fn parse_status(line: &str) -> Option<Status> {
    let caps = STATUS_WRAP.captures(line.trim())?;
    let body = &caps["body"];
    let mut parts = body.split('|');
    let state = parts.next()?.trim().to_string();

    let mut status = Status {
        state,
        raw: line.trim().to_string(),
        ..Default::default()
    };

    for field in parts {
        let (key, value) = match field.split_once(':') {
            Some(kv) => kv,
            None => continue,
        };
        match key {
            "MPos" => {
                if let Some(xyz) = parse_xyz(value) {
                    status.mpos = Some(xyz);
                }
            }
            "WPos" => {
                if let Some(xyz) = parse_xyz(value) {
                    status.wpos = Some(xyz);
                }
            }
            "FS" | "F" => {
                // F only: feed. FS: feed,spindle.
                let bits: Vec<&str> = value.split(',').collect();
                if let Some(f) = bits.first().and_then(|s| s.trim().parse::<f32>().ok()) {
                    status.feed = Some(f);
                }
                if bits.len() > 1 {
                    if let Ok(s) = bits[1].trim().parse::<f32>() {
                        status.spindle = Some(s);
                    }
                }
            }
            "Bf" => {
                let bits: Vec<&str> = value.split(',').collect();
                if bits.len() == 2 {
                    if let (Ok(a), Ok(b)) =
                        (bits[0].trim().parse::<u32>(), bits[1].trim().parse::<u32>())
                    {
                        status.buffer = Some([a, b]);
                    }
                }
            }
            _ => {}
        }
    }

    Some(status)
}

fn parse_xyz(value: &str) -> Option<[f32; 3]> {
    let caps = FLOAT3.captures(value)?;
    Some([
        caps.get(1)?.as_str().parse().ok()?,
        caps.get(2)?.as_str().parse().ok()?,
        caps.get(3)?.as_str().parse().ok()?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_comments_and_whitespace() {
        assert_eq!(normalize_line("G0 X0 (rapid) Y0"), Some("G0 X0 Y0".into()));
        assert_eq!(normalize_line("; a comment"), None);
        assert_eq!(normalize_line("   "), None);
        assert_eq!(normalize_line("M3 S100\r\n"), Some("M3 S100".into()));
    }

    #[test]
    fn ack_detection() {
        assert!(is_ack("ok"));
        assert!(is_ack("OK\n"));
        assert!(!is_ack("error:1"));
        assert!(is_error("error:1"));
        assert!(is_alarm("ALARM:3"));
        assert!(is_welcome("Grbl 1.1h ['$' for help]"));
    }

    #[test]
    fn status_parses_mpos_and_fs() {
        let s = parse_status("<Idle|MPos:1.000,2.000,3.000|FS:500,100|Bf:15,127>").unwrap();
        assert_eq!(s.state, "Idle");
        assert_eq!(s.mpos, Some([1.0, 2.0, 3.0]));
        assert_eq!(s.feed, Some(500.0));
        assert_eq!(s.spindle, Some(100.0));
        assert_eq!(s.buffer, Some([15, 127]));
    }
}
