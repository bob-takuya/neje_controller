import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { DxfDocument } from "../lib/dxf";
import {
  JobParams,
  LayerParams,
  Placement,
  buildGCode,
  buildResumeProgram,
} from "../lib/gcode";

type Props = {
  connected: boolean;
  /** "esp": ESP proxy active. "direct": GRBL direct. */
  connKind: api.PortKind;
  doc: DxfDocument | null;
  /** Display name of the loaded design (e.g. the DXF filename). */
  fileName: string | null;
  layers: LayerParams[];
  progress: api.Progress | null;
  running: boolean;
  placement: Placement;
  onPlacementChange: (p: Placement) => void;
  /** Set true to pause App's auto-reconnect while we own the port. */
  autoConnectPausedRef: React.MutableRefObject<boolean>;
};

export function JobPanel({
  connected,
  connKind,
  doc,
  fileName,
  layers,
  progress,
  running,
  placement,
  onPlacementChange,
  autoConnectPausedRef,
}: Props) {
  // "Direct" Start streams over the same serial worker the jog buttons use,
  // which is exactly the GRBL controller. In ESP-proxy mode there is no live
  // GRBL serial — the engraver isn't reachable from here until the ESP
  // reboots into HOST mode — so direct streaming has nowhere to go.
  const directStreamingAvailable = connected && connKind !== "esp";
  // The ESP upload path needs an ESP CDC connection.
  const espActionsAvailable = connected && connKind === "esp";
  const [travelFeed, setTravelFeed] = useState(3000);
  const [dynamicPower, setDynamicPower] = useState(true);
  const [dryRun, setDryRun] = useState(false);

  // Local string state for the placement inputs so the user can type freely
  // (including transient invalid states like "" or "-") without fighting
  // controlled-input clamping. We sync from the prop whenever it changes
  // externally (e.g. canvas drag) and commit back on blur / Enter.
  const [xInput, setXInput] = useState(placement.x.toFixed(2));
  const [yInput, setYInput] = useState(placement.y.toFixed(2));
  useEffect(() => {
    setXInput(placement.x.toFixed(2));
  }, [placement.x]);
  useEffect(() => {
    setYInput(placement.y.toFixed(2));
  }, [placement.y]);

  const commit = (axis: "x" | "y", text: string) => {
    const v = parseFloat(text);
    if (!Number.isFinite(v)) {
      // Revert the displayed text — placement stays where it was.
      setXInput(placement.x.toFixed(2));
      setYInput(placement.y.toFixed(2));
      return;
    }
    onPlacementChange({ ...placement, [axis]: v });
  };
  const onPlacementKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
    if (e.key === "Escape") {
      setXInput(placement.x.toFixed(2));
      setYInput(placement.y.toFixed(2));
      (e.target as HTMLInputElement).blur();
    }
  };

  const program = useMemo(() => {
    if (!doc) return [] as string[];
    const base: JobParams = {
      layers,
      travelFeed,
      dynamicPower,
      // The end-of-job return is now unconditional and X-axis only (handled in
      // buildGCode); this flag no longer gates anything but the type requires it.
      returnHome: true,
      placement,
    };
    const lines = buildGCode(doc, base);
    if (dryRun) {
      // Replace M3/M4 with M5 so nothing actually fires.
      return lines.map((l) => l.replace(/^(M3|M4)\b.*$/, "M5 ; dry-run"));
    }
    return lines;
  }, [doc, layers, travelFeed, dynamicPower, dryRun, placement]);

  const totalLines = program.length;

  const start = async () => {
    if (!connected || program.length === 0 || running) return;
    await api.stream(program);
  };

  const cancel = async () => {
    await api.cancelStream();
  };

  // --- ESP32-S3 proxy upload --------------------------------------------------
  //
  // The user picks (or types) the ESP's CDC port, hits "Save to ESP & Run",
  // and we ship the current `program` over to it. With "auto-run" checked the
  // board reboots into HOST mode and immediately starts streaming to the
  // engraver — the PC can then be unplugged.
  // ESP upload re-uses the same serial port the ConnectionBar already
  // auto-connected to — there's no separate ESP port picker any more
  // because the user has no reason to pick a different one.
  //
  // Off by default: the intended flow is upload → unplug from PC → plug
  // into a charger → hold OK on the board to start. Auto-run is only
  // convenient when the PC stays attached for the whole job.
  const [espAutoRun, setEspAutoRun] = useState(false);
  const [espUploading, setEspUploading] = useState(false);

  const espUpload = async () => {
    if (!espActionsAvailable || program.length === 0 || espUploading) return;
    setEspUploading(true);
    // Hold off auto-connect while we own the port. Without this, App.tsx's
    // 2s reconnect loop wins the race and grabs the port back before
    // upload_job can call serial open.
    autoConnectPausedRef.current = true;
    const name = fileName
      ? fileName.replace(/\.[^.]+$/, "") // strip extension; ESP adds .gcode
      : `job`;
    // Wait until the worker has actually closed the serial port. Just calling
    // `disconnect()` is a fire-and-forget signal — the worker tears down on
    // its own thread, and on macOS the OS won't release the exclusive lock
    // for several hundred ms after that. Hooking the `onConnection` event
    // tells us when the worker thread emitted "serial port closed", and then
    // we add a small grace period for the kernel to drop the lock.
    const waitForClose = (timeoutMs: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsub.then((fn) => fn());
          reject(new Error("close timeout"));
        }, timeoutMs);
        const unsub = api.onConnection((c) => {
          if (!c.connected) {
            clearTimeout(timer);
            unsub.then((fn) => fn());
            resolve();
          }
        });
      });
    try {
      const info = await api.connectionInfo();
      if (!info) {
        throw new Error("not connected");
      }
      const [portName] = info;
      const closed = waitForClose(3000);
      await api.disconnect();
      await closed;
      // macOS releases the exclusive lock a bit after close; give it room.
      await new Promise<void>((r) => setTimeout(r, 700));
      // Clear any previously-saved jobs so the HOST-mode firmware never
      // streams a stale file by accident.
      try {
        await api.espWipe(portName);
      } catch (e) {
        console.warn("ESP wipe (pre-upload) failed; continuing:", e);
      }
      const [bytes, crc] = await api.espUpload(portName, name, program, espAutoRun);
      console.info(
        `ESP upload OK: ${name}.gcode, ${bytes} bytes, CRC ${crc.toString(16).padStart(8, "0")}, ` +
        `${espAutoRun ? "running now" : "armed — RST/charger to run"}`,
      );
    } catch (e) {
      console.error("ESP upload failed:", e);
    } finally {
      autoConnectPausedRef.current = false;
      setEspUploading(false);
    }
  };

  // --- Resume from a specific line --------------------------------------
  //
  // The user can enter any line index and press Resume. We prefill with
  // `progress.sent` whenever a job stops, but it's editable any time the
  // job isn't actively running — so an externally-computed resume index
  // (e.g. from the anchor-based offline tool) can be typed in directly.
  const [resumeAt, setResumeAt] = useState<string>("0");

  // When the active job is a resume, we want the progress widget to show
  // (resumeStart + reportedSent) / originalTotal instead of the raw
  // (sent / resumedLen) the worker reports. Track the offset + the
  // original length here.
  //
  // - `resumeOffset` is the line index in the ORIGINAL program where the
  //   resumed stream starts (= the value the user typed in Resume at).
  // - `resumeTotal` is the length of the ORIGINAL program (so the
  //   denominator stays meaningful).
  // - Header lines added by buildResumeProgram (G21/G90/$32=1/M5/G0/M3-M4)
  //   are NOT part of the original program, so we offset the displayed
  //   sent by `resumeHeaderLines` so progress doesn't briefly count down
  //   while the header is being streamed.
  const [resumeOffset, setResumeOffset] = useState<number | null>(null);
  const [resumeTotal, setResumeTotal] = useState<number | null>(null);
  const [resumeHeaderLines, setResumeHeaderLines] = useState<number>(0);

  const resumeFromIdx = async () => {
    if (!connected || running || program.length === 0) return;
    const idx = parseInt(resumeAt, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= program.length) return;
    const resumed = buildResumeProgram(program, idx);
    // buildResumeProgram prepends header lines then appends program[idx..].
    // Header length = resumed.length - (program.length - idx). When the
    // worker reports `sent`, header lines come first; subsequent lines are
    // index (idx) + (sent - headerLen) in the original program.
    const headerLen = Math.max(0, resumed.length - (program.length - idx));
    setResumeOffset(idx);
    setResumeTotal(program.length);
    setResumeHeaderLines(headerLen);
    await api.stream(resumed);
  };

  // Reset the resume-display offsets when a fresh full job is started (a
  // running job whose reported total matches the current program length is
  // a normal Start, not a resume).
  useEffect(() => {
    if (running && progress && progress.total === program.length) {
      setResumeOffset(null);
      setResumeTotal(null);
      setResumeHeaderLines(0);
    }
  }, [running, progress?.total, program.length]);

  // Compute what the progress widget should display.
  const displayedProgress = useMemo(() => {
    if (!progress) return null;
    if (resumeOffset != null && resumeTotal != null) {
      const sentInTail = Math.max(0, progress.sent - resumeHeaderLines);
      const sent = Math.min(resumeTotal, resumeOffset + sentInTail);
      return { sent, total: resumeTotal };
    }
    return { sent: progress.sent, total: progress.total };
  }, [progress, resumeOffset, resumeTotal, resumeHeaderLines]);

  // Prefill the Resume at input with the last displayed-sent value whenever
  // a job stops. Using displayedProgress (not raw progress) so that after a
  // resume run stops mid-way, the field shows the original-program index
  // matching where the head actually is.
  useEffect(() => {
    if (!running && displayedProgress && displayedProgress.sent > 0) {
      setResumeAt(String(displayedProgress.sent));
    }
  }, [running, displayedProgress?.sent]);

  return (
    <div className="panel job-panel">
      <h3>Job</h3>
      <div className="row">
        <label>Placement:</label>
        <span className="muted">X</span>
        <input
          type="number"
          step={1}
          value={xInput}
          onChange={(e) => setXInput(e.target.value)}
          onBlur={(e) => commit("x", e.target.value)}
          onKeyDown={onPlacementKeyDown}
          title="MCS X (mm) of the design's (0, 0) corner"
        />
        <span className="muted">Y</span>
        <input
          type="number"
          step={1}
          value={yInput}
          onChange={(e) => setYInput(e.target.value)}
          onBlur={(e) => commit("y", e.target.value)}
          onKeyDown={onPlacementKeyDown}
          title="MCS Y (mm) of the design's (0, 0) corner"
        />
        <span className="muted">mm (MCS)</span>
      </div>
      <div className="row">
        <label>Travel feed:</label>
        <input
          type="number"
          min={500}
          max={10000}
          step={100}
          value={travelFeed}
          onChange={(e) => setTravelFeed(Number(e.target.value) || 500)}
        />
        <span className="muted">mm/min</span>
      </div>
      <div className="row">
        <label className="chk">
          <input
            type="checkbox"
            checked={dynamicPower}
            onChange={(e) => setDynamicPower(e.target.checked)}
          />
          Dynamic power (M4)
        </label>
        <label className="chk">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry-run (laser off)
        </label>
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={!directStreamingAvailable || totalLines === 0 || running}
          onClick={start}
          title={
            !connected
              ? "Connect to the engraver to stream"
              : connKind === "esp"
                ? "Direct streaming requires a direct USB connection to NEJE; use 'Save to ESP' below"
                : `Stream ${totalLines} lines straight to the engraver`
          }
        >
          Start ({totalLines} lines)
        </button>
        <button className="danger" disabled={!running} onClick={cancel}>
          Cancel
        </button>
      </div>
      {displayedProgress && (
        <div className="progress">
          <div
            className="bar"
            style={{
              width: `${
                displayedProgress.total === 0
                  ? 0
                  : (displayedProgress.sent / displayedProgress.total) * 100
              }%`,
            }}
          />
          <span>
            {displayedProgress.sent} / {displayedProgress.total}
          </span>
        </div>
      )}
      {/* ESP proxy card — visually separated to make it obvious that this
          is a different control surface from "Start" above (which streams
          directly), and only available when an ESP is connected. */}
      <div
        className="esp-card"
        style={{
          marginTop: 10,
          padding: 8,
          borderTop: "2px solid #2b6cb0",
          background: espActionsAvailable ? "rgba(43,108,176,0.08)" : "transparent",
          opacity: espActionsAvailable ? 1 : 0.55,
        }}
      >
        <div className="row" style={{ marginBottom: 4 }}>
          <strong style={{ color: "#2b6cb0" }}>ESP Proxy</strong>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            {espActionsAvailable
              ? "Upload, then RST or hold OK on the board to run"
              : "Connect an ESP proxy to enable"}
          </span>
        </div>
        <div className="row" style={{ marginBottom: 4 }}>
          <label>File:</label>
          <span style={{ fontFamily: "monospace" }}>
            {fileName ?? <span className="muted">(none loaded)</span>}
          </span>
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
          <label className="chk">
            <input
              type="checkbox"
              checked={espAutoRun}
              onChange={(e) => setEspAutoRun(e.target.checked)}
            />
            Auto-run after upload
          </label>
          <button
            className="primary"
            disabled={!espActionsAvailable || program.length === 0 || espUploading}
            onClick={espUpload}
            title={
              !espActionsAvailable
                ? "Connect to the ESP proxy first (auto-connect picks it up when you plug it in)"
                : espAutoRun
                  ? "Upload the program then immediately reboot the ESP into HOST mode to stream it"
                  : "Upload only — unplug from PC, then either plug into a charger or press RST on the board to run"
            }
          >
            {espUploading
              ? "Uploading…"
              : espAutoRun
                ? "Save to ESP & Run"
                : "Save to ESP"}
          </button>
        </div>
      </div>
      {program.length > 0 && (
        <div className="row resume-row">
          <label>Resume at:</label>
          <input
            type="number"
            min={0}
            max={program.length - 1}
            step={1}
            value={resumeAt}
            onChange={(e) => setResumeAt(e.target.value)}
            disabled={running}
            title="Line index to resume from (re-emits header + rapids head to that point)"
          />
          <span className="muted">/ {program.length}</span>
          <button
            disabled={!connected || running || program.length === 0}
            onClick={resumeFromIdx}
            title="Re-stream from this line onwards"
          >
            Resume from line
          </button>
        </div>
      )}
    </div>
  );
}
