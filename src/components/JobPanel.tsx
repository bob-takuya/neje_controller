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
  // When a job is cancelled or fails partway, the progress bar shows
  // "sent / total". The user can edit `resumeAt` and press Resume to pick
  // up from that line (with the header + last-known position re-emitted).
  //
  // We default to a few lines earlier than the last ack, because the
  // controller's planner buffer was dropped on soft-reset — any line that
  // had been "ack'd" but not yet executed needs to be redone.
  const RESUME_BACKOFF = 5;
  const [resumeAt, setResumeAt] = useState<string>("");
  useEffect(() => {
    // Whenever progress lands on a stopped state, prefill the input with a
    // safe default. We don't overwrite while the user has it focused —
    // checking document.activeElement isn't great in React but the simple
    // heuristic "don't update if there's a value already and user might be
    // editing" works well enough here.
    if (!running && progress && progress.sent > 0) {
      const safe = Math.max(0, progress.sent - RESUME_BACKOFF);
      setResumeAt(String(safe));
    }
  }, [running, progress?.sent]);

  const resumeFromIdx = async () => {
    if (!connected || running || program.length === 0) return;
    const idx = parseInt(resumeAt, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= program.length) return;
    const resumed = buildResumeProgram(program, idx);
    await api.stream(resumed);
  };

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
      {progress && (
        <div className="progress">
          <div
            className="bar"
            style={{ width: `${progress.total === 0 ? 0 : (progress.sent / progress.total) * 100}%` }}
          />
          <span>
            {progress.sent} / {progress.total}
          </span>
        </div>
      )}
      {progress && progress.sent > 0 && progress.sent < progress.total && (
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
