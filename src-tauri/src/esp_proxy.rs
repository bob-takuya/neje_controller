//! ESP32-S3 NEJE proxy uploader.
//!
//! Opens the ESP32's CDC-ACM port (the micro-B "DEVICE" face of the
//! USB-OTG board), sends a job using the line/binary protocol implemented in
//! main/neje_proxy_device_main.c, and optionally tells the board to reboot
//! into HOST mode and start streaming to the engraver.
//!
//! Protocol (see neje_proxy_device_main.c for the device side):
//!   PC  -> ESP : "JOB BEGIN <name> <bytes>\n"
//!   ESP -> PC  : "OK JOB BEGIN\r\n"
//!   PC  -> ESP : <bytes> bytes of raw G-code (LF-terminated lines)
//!   PC  -> ESP : "JOB END <crc32_hex>\n"
//!   ESP -> PC  : "OK JOB END <name> <bytes> <crc>\r\n"
//!   PC  -> ESP : "RUN\n"                      (optional)
//!   ESP -> PC  : "INFO rebooting to host mode\r\n"  then the link drops
//!
//! All replies are newline-terminated ASCII. Anything starting with "ERR "
//! is a hard failure for the operation in progress.

use std::io::{BufRead, BufReader, Write};
use std::time::{Duration, Instant};

use serialport::SerialPort;

const ESP_BAUD: u32 = 115_200; // TinyUSB CDC-ACM ignores it but serialport needs a value
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum EspError {
    #[error("open {port}: {source}")]
    Open {
        port: String,
        #[source]
        source: serialport::Error,
    },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("ESP reported: {0}")]
    Reported(String),
    #[error("timed out waiting for {0}")]
    Timeout(String),
    #[error("link closed before {0}")]
    Eof(String),
}

fn open(port_name: &str) -> Result<Box<dyn SerialPort>, EspError> {
    // macOS doesn't release the exclusive lock instantly when the previous
    // owner closes — and on Linux a stale lock from the kernel side can take
    // a moment too. Retry a few times with backoff so we don't fail just
    // because the streaming worker hasn't fully torn down yet.
    let mut last_err = None;
    for delay_ms in [0u64, 250, 500, 1000, 1500] {
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        match serialport::new(port_name, ESP_BAUD)
            .timeout(Duration::from_millis(250))
            .open()
        {
            Ok(p) => return Ok(p),
            Err(e) => last_err = Some(e),
        }
    }
    Err(EspError::Open {
        port: port_name.into(),
        source: last_err.unwrap(),
    })
}

/// Read newline-terminated replies until `pred` returns Some(value), or until
/// `REPLY_TIMEOUT` elapses. Reply lines that don't match the predicate are
/// surfaced via the `on_other` callback so the UI can show them.
fn wait_for<F, T>(
    reader: &mut BufReader<Box<dyn SerialPort>>,
    mut pred: F,
    label: &str,
    mut on_other: impl FnMut(&str),
) -> Result<T, EspError>
where
    F: FnMut(&str) -> Option<T>,
{
    let deadline = Instant::now() + REPLY_TIMEOUT;
    let mut acc = String::new();
    loop {
        if Instant::now() >= deadline {
            return Err(EspError::Timeout(label.into()));
        }
        acc.clear();
        match reader.read_line(&mut acc) {
            Ok(0) => return Err(EspError::Eof(label.into())),
            Ok(_) => {
                let line = acc.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    continue;
                }
                if let Some(rest) = line.strip_prefix("ERR ") {
                    return Err(EspError::Reported(rest.to_string()));
                }
                if let Some(v) = pred(line) {
                    return Ok(v);
                }
                on_other(line);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => return Err(e.into()),
        }
    }
}

/// Progress callback fired during the body write. `sent` and `total` are byte
/// counts (so the UI can show a progress bar even with one logical "line"
/// transfer).
pub type ProgressCb = Box<dyn FnMut(u64, u64) + Send>;

pub struct UploadOptions {
    pub run_after_upload: bool,
}

/// Upload `lines` (already-normalized GRBL) as a job named `name` to the ESP32.
///
/// `lines` is sent as one '\n'-terminated G-code stream — the same byte layout
/// the engraver would consume directly, so the on-flash file is human-readable
/// and the host-mode firmware can re-stream it line by line without parsing.
pub fn upload_job(
    port_name: &str,
    name: &str,
    lines: &[String],
    options: UploadOptions,
    mut progress: ProgressCb,
    mut on_log: impl FnMut(String),
) -> Result<(u64, u32), EspError> {
    // Build the body once so we know exact byte count + CRC up-front. The
    // device protocol is byte-counted, not delimited, so this matters.
    let mut body: Vec<u8> = Vec::with_capacity(lines.iter().map(|s| s.len() + 1).sum());
    for l in lines {
        body.extend_from_slice(l.as_bytes());
        body.push(b'\n');
    }
    let total_bytes = body.len() as u64;
    let crc = crc32(&body);

    on_log(format!(
        "ESP upload: {} lines, {} bytes, CRC {:08x}",
        lines.len(),
        total_bytes,
        crc
    ));

    let mut port = open(port_name)?;
    // Bring DTR up so TinyUSB sees an active host (some implementations
    // suppress TX until DTR is asserted).
    let _ = port.write_data_terminal_ready(true);

    // The ESP may emit "INFO alive" heartbeats; drain anything pending.
    {
        let mut buf = [0u8; 256];
        let _ = port.read(&mut buf);
    }

    // -- PING handshake -------------------------------------------------------
    port.write_all(b"PING\n")?;
    port.flush()?;
    let mut reader = BufReader::new(port);
    wait_for(
        &mut reader,
        |line| if line == "OK PONG" { Some(()) } else { None },
        "PONG",
        |l| on_log(format!("[esp] {}", l)),
    )?;

    // -- JOB BEGIN ------------------------------------------------------------
    {
        let port = reader.get_mut();
        let line = format!("JOB BEGIN {} {}\n", sanitize_name(name), total_bytes);
        port.write_all(line.as_bytes())?;
        port.flush()?;
    }
    wait_for(
        &mut reader,
        |line| if line == "OK JOB BEGIN" { Some(()) } else { None },
        "OK JOB BEGIN",
        |l| on_log(format!("[esp] {}", l)),
    )?;

    // -- Body -----------------------------------------------------------------
    //
    // Stream in fixed-size chunks so the UI gets progress callbacks even for
    // multi-MB jobs. The chunk size is sized to clear TinyUSB's RX FIFO in
    // one transfer (CDC_RX_BUFSIZE = 512 in our sdkconfig).
    const CHUNK: usize = 512;
    let mut sent: u64 = 0;
    {
        let port = reader.get_mut();
        for chunk in body.chunks(CHUNK) {
            port.write_all(chunk)?;
            port.flush()?;
            sent += chunk.len() as u64;
            progress(sent, total_bytes);
        }
    }

    // -- JOB END --------------------------------------------------------------
    {
        let port = reader.get_mut();
        let line = format!("JOB END {:08x}\n", crc);
        port.write_all(line.as_bytes())?;
        port.flush()?;
    }
    wait_for(
        &mut reader,
        |line| {
            if line.starts_with("OK JOB END") {
                Some(())
            } else {
                None
            }
        },
        "OK JOB END",
        |l| on_log(format!("[esp] {}", l)),
    )?;

    // -- RUN or ARM ------------------------------------------------------------
    //
    // RUN: reboot ESP into HOST mode RIGHT NOW (PC must stay attached for the
    // whole job, since the link drops on reboot).
    //
    // ARM: just set the NVS flag and return. The next power-on (e.g. after
    // unplugging the PC and plugging into a charger) will see the flag and
    // boot into HOST mode automatically. This is the default — it matches the
    // "upload, then walk over to a charger" operator flow.
    if options.run_after_upload {
        let port = reader.get_mut();
        port.write_all(b"RUN\n")?;
        port.flush()?;
        // Best-effort: the ESP reboots, the link will drop. Don't fail if we
        // hit EOF instead of seeing an "INFO" reply.
        let _ = wait_for(
            &mut reader,
            |line| {
                if line.contains("rebooting") {
                    Some(())
                } else {
                    None
                }
            },
            "RUN ack",
            |l| on_log(format!("[esp] {}", l)),
        );
    } else {
        let port = reader.get_mut();
        port.write_all(b"ARM\n")?;
        port.flush()?;
        wait_for(
            &mut reader,
            |line| if line == "OK ARMED" { Some(()) } else { None },
            "OK ARMED",
            |l| on_log(format!("[esp] {}", l)),
        )?;
        on_log("ESP armed — next power-on will boot into HOST mode".into());
    }

    on_log("ESP upload complete".into());
    Ok((total_bytes, crc))
}

/// Send a single CDC command line and return the first non-INFO reply.
/// Used for one-shot operations (WIPE, ARM, DISARM) that don't need the
/// full upload state machine.
pub fn send_command(port_name: &str, cmd: &str) -> Result<String, EspError> {
    let port = open(port_name)?;
    let mut reader = BufReader::new(port);
    {
        let port = reader.get_mut();
        let mut line = String::from(cmd);
        line.push('\n');
        port.write_all(line.as_bytes())?;
        port.flush()?;
    }
    // Wait for the first reply that isn't an INFO heartbeat.
    let result = wait_for(
        &mut reader,
        |line| {
            if line.starts_with("INFO ") {
                None
            } else {
                Some(line.to_string())
            }
        },
        "command reply",
        |_| {},
    )?;
    Ok(result)
}

/// A job stored on the ESP's FAT drive, as reported by `LIST`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EspJob {
    pub name: String,
    pub bytes: u64,
}

/// Query the ESP for the jobs currently saved in its memory (FAT drive). Sends
/// `LIST` and collects the `FILE <size> <name>` lines until `END`. Lets the UI
/// confirm a job actually landed on the board after an upload.
pub fn list_jobs(port_name: &str) -> Result<Vec<EspJob>, EspError> {
    let port = open(port_name)?;
    let mut reader = BufReader::new(port);
    {
        let port = reader.get_mut();
        port.write_all(b"LIST\n")?;
        port.flush()?;
    }
    let mut jobs = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if std::time::Instant::now() > deadline {
            break;
        }
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let line = line.trim_end();
                if line == "END" {
                    break;
                }
                if let Some(rest) = line.strip_prefix("FILE ") {
                    // "FILE <size> <name>"
                    if let Some((sz, name)) = rest.split_once(' ') {
                        if let Ok(bytes) = sz.trim().parse::<u64>() {
                            jobs.push(EspJob {
                                name: name.trim().to_string(),
                                bytes,
                            });
                        }
                    }
                }
                // ignore INFO heartbeats and anything else
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(jobs)
}

/// Sanitize the same way the device firmware does (`sanitize_name` in C):
/// keep [A-Za-z0-9._-], replace everything else with '_'. Done host-side so
/// the final filename is predictable.
fn sanitize_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// ---- CRC-32 (IEEE / zlib polynomial, matches esp_crc32_le on the ESP) ------

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = !0;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB88320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_known_vectors() {
        // CRC-32/ISO-HDLC of "123456789" is 0xCBF43926.
        assert_eq!(crc32(b"123456789"), 0xCBF43926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn sanitize_strips_unsafe_chars() {
        assert_eq!(sanitize_name("My Job/2025.gcode"), "My_Job_2025.gcode");
    }
}
