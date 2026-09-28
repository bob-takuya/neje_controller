import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { DxfDocument } from "../lib/dxf";
import { Placement } from "../lib/gcode";
import {
  CameoJobParams,
  CameoLayerParams,
  buildGpgl,
  layerSetup,
} from "../lib/cameoGpgl";

type Props = {
  connected: boolean;
  doc: DxfDocument | null;
  fileName: string | null;
  layers: CameoLayerParams[];
  /** Cutting-mat TG preset (0=none,1=12x12,2=12x24,9=24x24); set with the mat
      size selector in the right column so size + TG stay in sync. */
  mat: number;
  progress: api.Progress | null;
  running: boolean;
  placement: Placement;
  onPlacementChange: (p: Placement) => void;
  /** Pause App auto-connect while the ESP upload owns a serial port. */
  autoConnectPausedRef: React.MutableRefObject<boolean>;
};

export function CameoPanel({
  connected,
  doc,
  fileName,
  layers,
  mat,
  progress,
  running,
  placement,
  onPlacementChange,
  autoConnectPausedRef,
}: Props) {
  // Global job settings.
  const [bladeOffsetMm, setBladeOffsetMm] = useState(0.9);
  const [accel, setAccel] = useState(3);
  const [trackEnhancing, setTrackEnhancing] = useState(false);
  const [returnHome, setReturnHome] = useState(true);

  // Placement inputs (free-typing pattern mirrors JobPanel).
  const [xInput, setXInput] = useState(placement.x.toFixed(2));
  const [yInput, setYInput] = useState(placement.y.toFixed(2));
  useEffect(() => setXInput(placement.x.toFixed(2)), [placement.x]);
  useEffect(() => setYInput(placement.y.toFixed(2)), [placement.y]);
  const commit = (axis: "x" | "y", text: string) => {
    const v = parseFloat(text);
    if (!Number.isFinite(v)) {
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

  const job: CameoJobParams = useMemo(
    () => ({
      layers,
      placement,
      bladeOffsetMm,
      accel,
      mat,
      trackEnhancing,
      returnHome,
    }),
    [layers, placement, bladeOffsetMm, accel, mat, trackEnhancing, returnHome],
  );

  const program = useMemo(() => {
    if (!doc) return [] as string[];
    return buildGpgl(doc, job);
  }, [doc, job]);

  const total = program.length;

  // The "setup" sent with the run uses the FIRST enabled layer's tool/force/
  // speed/depth as the initial machine state; the program itself re-applies
  // per-layer setup, so this is just a sensible default for the worker preamble.
  const firstLayer = layers.find((l) => l.enabled) ?? layers[0];

  const cut = async () => {
    if (!connected || total === 0 || running || !firstLayer) return;
    // The backend applies this setup (boundary + initial tool state) before
    // streaming; buildGpgl re-applies per-layer J/FX/!/FC inline.
    const setup: api.CameoSetup = layerSetup(firstLayer, job);
    await api.cameoRun(setup, program);
  };

  const cancel = () => api.cameoCancel().catch(() => {});
  const home = () => api.cameoHome().catch(() => {});

  // --- ESP32-S3 proxy upload (standalone cutting) -------------------------
  //
  // Save the GPGL program to the ESP board's FAT drive as a ".gpgl" job; the
  // board's boot selector routes a .gpgl job to its CAMEO host (raw USB bulk),
  // so the user can unplug the PC and cut from a charger. We list serial ports
  // and pick the ESP CDC port (the board enumerates as an Espressif CDC device).
  const [espPorts, setEspPorts] = useState<api.PortInfo[]>([]);
  const [espPort, setEspPort] = useState<string>("");
  const [espUploading, setEspUploading] = useState(false);
  const [espMsg, setEspMsg] = useState<string | null>(null);
  // Jobs currently in the ESP's memory (FAT drive). Lets the user confirm an
  // upload actually landed. null = not checked yet.
  const [savedJobs, setSavedJobs] = useState<api.EspJob[] | null>(null);
  const [checkingMem, setCheckingMem] = useState(false);

  const refreshSavedJobs = async (port = espPort) => {
    if (!port) return;
    setCheckingMem(true);
    autoConnectPausedRef.current = true;
    try {
      setSavedJobs(await api.espListJobs(port));
    } catch (e) {
      setEspMsg(`memory check failed: ${e}`);
    } finally {
      autoConnectPausedRef.current = false;
      setCheckingMem(false);
    }
  };

  const refreshEspPorts = async () => {
    try {
      const list = await api.listPorts(false);
      const esps = list.filter((p) => api.classifyPort(p) === "esp");
      setEspPorts(esps);
      if (esps.length && !esps.some((p) => p.name === espPort)) {
        setEspPort(esps[0].name);
      }
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    refreshEspPorts();
    const id = setInterval(refreshEspPorts, 2500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const espUpload = async () => {
    if (!espPort || program.length === 0 || espUploading) return;
    setEspUploading(true);
    setEspMsg(null);
    autoConnectPausedRef.current = true;
    try {
      // ".gpgl" suffix tells the ESP device-mode firmware to store it as a
      // CAMEO job (boot selector then dispatches to the CAMEO host).
      const base = (fileName ?? `cut`).replace(/\.[^.]+$/, "");
      const name = `${base}.gpgl`;
      // Always WIPE first so the board holds EXACTLY ONE job — no stale job can
      // ever be picked up. (The firmware also wipes on JOB BEGIN as a backstop.)
      await api.espWipe(espPort).catch(() => {});
      // NEVER auto-run: upload only (ARM = boot to CAMEO host on next power-on).
      // The operator unplugs, connects the CAMEO to USB_HOST, then power-cycles
      // or holds OK — so an old/wrong job can never fire unattended.
      const [bytes] = await api.espUpload(espPort, name, program, false);
      setEspMsg(
        `uploaded ${bytes} B as ${name} — power-cycle the board (or hold OK) to cut`,
      );
      // Confirm the job actually landed in the ESP's memory.
      await refreshSavedJobs(espPort);
    } catch (e) {
      setEspMsg(`ESP upload failed: ${e}`);
    } finally {
      autoConnectPausedRef.current = false;
      setEspUploading(false);
    }
  };

  return (
    <div className="panel cameo-panel">
      <h3>CAMEO Cut</h3>

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
          title="Device X (mm) of the design's (0,0) corner"
        />
        <span className="muted">Y</span>
        <input
          type="number"
          step={1}
          value={yInput}
          onChange={(e) => setYInput(e.target.value)}
          onBlur={(e) => commit("y", e.target.value)}
          onKeyDown={onPlacementKeyDown}
          title="Device Y (mm) of the design's (0,0) corner"
        />
        <span className="muted">mm (device origin)</span>
      </div>

      {/* Cut layers (tool/speed/force/depth/passes) are edited in the
          "Cut Layers" table in the right column — same place as NEJE's layer
          table — so the two machine modes share one layout. */}

      {/* Global machine settings. */}
      <h4>Machine</h4>
      <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
        <label>Blade offset:</label>
        <input
          type="number"
          min={0}
          max={2}
          step={0.05}
          style={{ width: 64 }}
          value={bladeOffsetMm}
          onChange={(e) => setBladeOffsetMm(Number(e.target.value) || 0)}
        />
        <span className="muted">mm</span>
        <label>Accel:</label>
        <input
          type="number"
          min={1}
          max={3}
          step={1}
          style={{ width: 44 }}
          value={accel}
          onChange={(e) => setAccel(Number(e.target.value) || 1)}
        />
        <span className="muted" title="Set with the Mat selector in the right column">
          mat: {mat === 0 ? "none" : mat === 1 ? "12×12" : mat === 9 ? "24×24" : "12×24"}
        </span>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
        <label className="chk">
          <input
            type="checkbox"
            checked={trackEnhancing}
            onChange={(e) => setTrackEnhancing(e.target.checked)}
          />
          Track enhancing
        </label>
        <label className="chk">
          <input
            type="checkbox"
            checked={returnHome}
            onChange={(e) => setReturnHome(e.target.checked)}
          />
          Return to origin at end
        </label>
      </div>

      {/* Actions. */}
      <div className="row">
        <button
          className="primary"
          disabled={!connected || total === 0 || running}
          onClick={cut}
          title={
            !connected
              ? "Connect to the CAMEO to cut"
              : `Cut ${total} GPGL commands`
          }
        >
          Cut ({total})
        </button>
        <button className="stop" disabled={!running} onClick={cancel}>
          Cancel
        </button>
        <button disabled={!connected || running} onClick={home} title="Pen-up move to origin">
          Home
        </button>
      </div>

      {/* Positioning jog (pen-up relative moves). */}
      <div className="row" style={{ gap: 4 }}>
        <span className="muted">Jog:</span>
        {[-10, -1, 1, 10].map((d) => (
          <button
            key={`x${d}`}
            disabled={!connected || running}
            onClick={() => api.cameoJog(d, 0).catch(() => {})}
          >
            X{d > 0 ? `+${d}` : d}
          </button>
        ))}
        {[-10, -1, 1, 10].map((d) => (
          <button
            key={`y${d}`}
            disabled={!connected || running}
            onClick={() => api.cameoJog(0, d).catch(() => {})}
          >
            Y{d > 0 ? `+${d}` : d}
          </button>
        ))}
      </div>

      {progress && (
        <div className="progress">
          <div
            className="bar"
            style={{
              width: `${
                progress.total === 0 ? 0 : (progress.sent / progress.total) * 100
              }%`,
            }}
          />
          <span>
            {progress.sent} / {progress.total}
          </span>
        </div>
      )}

      <div className="row">
        <span className="muted" style={{ fontSize: 11 }}>
          File: {fileName ?? "(none)"}
        </span>
      </div>

      {/* ESP32-S3 proxy: cut standalone from the board (PC can be unplugged). */}
      <div
        className="esp-card"
        style={{
          marginTop: 10,
          padding: 8,
          borderTop: "2px solid #2b6cb0",
          background: espPorts.length ? "rgba(43,108,176,0.08)" : "transparent",
          opacity: espPorts.length ? 1 : 0.55,
        }}
      >
        <div className="row" style={{ marginBottom: 4 }}>
          <strong style={{ color: "#2b6cb0" }}>ESP Proxy</strong>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            {espPorts.length
              ? "Upload .gpgl, then power-cycle / hold OK on the board"
              : "Plug in an ESP proxy to enable"}
          </span>
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
          <select
            value={espPort}
            onChange={(e) => setEspPort(e.target.value)}
            disabled={!espPorts.length || espUploading}
          >
            {espPorts.length === 0 && <option value="">(no ESP)</option>}
            {espPorts.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="primary"
            disabled={!espPort || program.length === 0 || espUploading}
            onClick={espUpload}
            title="Upload as the single saved job — wipes any old job first. Then power-cycle the board (or hold OK) to cut. Never runs automatically."
          >
            {espUploading ? "Uploading…" : "Save to ESP"}
          </button>
          <button
            disabled={!espPort || checkingMem || espUploading}
            onClick={() => refreshSavedJobs()}
            title="Ask the ESP what job is saved in its memory right now"
          >
            {checkingMem ? "Checking…" : "Check memory"}
          </button>
        </div>
        {espMsg && (
          <div className="hint" style={{ marginTop: 4 }}>
            {espMsg}
          </div>
        )}
        {savedJobs !== null && (
          <div className="row" style={{ marginTop: 4, flexDirection: "column", alignItems: "stretch", gap: 2 }}>
            <span className="muted" style={{ fontSize: 11 }}>
              In ESP memory: {savedJobs.length === 0 ? "(empty)" : `${savedJobs.length} job(s)`}
            </span>
            {savedJobs.map((j) => {
              const isCameoJob = j.name.toLowerCase().endsWith(".gpgl");
              return (
                <div
                  key={j.name}
                  style={{
                    fontFamily: "monospace",
                    fontSize: 11,
                    color: isCameoJob ? "var(--ok)" : "var(--muted)",
                  }}
                  title={isCameoJob ? "CAMEO job (.gpgl) — boots to CAMEO host" : "NEJE job"}
                >
                  {isCameoJob ? "✓ " : "• "}
                  {j.name} ({j.bytes} B)
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
