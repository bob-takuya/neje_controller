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
  doc: DxfDocument | null;
  layers: LayerParams[];
  progress: api.Progress | null;
  running: boolean;
  placement: Placement;
  onPlacementChange: (p: Placement) => void;
};

export function JobPanel({
  connected,
  doc,
  layers,
  progress,
  running,
  placement,
  onPlacementChange,
}: Props) {
  const [travelFeed, setTravelFeed] = useState(3000);
  const [dynamicPower, setDynamicPower] = useState(true);
  const [returnHome, setReturnHome] = useState(true);
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
      returnHome,
      placement,
    };
    const lines = buildGCode(doc, base);
    if (dryRun) {
      // Replace M3/M4 with M5 so nothing actually fires.
      return lines.map((l) => l.replace(/^(M3|M4)\b.*$/, "M5 ; dry-run"));
    }
    return lines;
  }, [doc, layers, travelFeed, dynamicPower, returnHome, dryRun, placement]);

  const totalLines = program.length;

  const start = async () => {
    if (!connected || program.length === 0 || running) return;
    await api.stream(program);
  };

  const cancel = async () => {
    await api.cancelStream();
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
          <input
            type="checkbox"
            checked={returnHome}
            onChange={(e) => setReturnHome(e.target.checked)}
          />
          Return to origin at end
        </label>
        <label className="chk">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry-run (laser off)
        </label>
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={!connected || totalLines === 0 || running}
          onClick={start}
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
