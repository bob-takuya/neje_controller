import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "./lib/api";
import { DxfDocument } from "./lib/dxf";
import { LayerParams, Placement } from "./lib/gcode";
import {
  CameoLayerParams,
  defaultCameoLayers,
  CAMEO5_AREA,
} from "./lib/cameoGpgl";
import { ConnectionBar } from "./components/ConnectionBar";
import { CameoConnectionBar } from "./components/CameoConnectionBar";
import { CameoPanel } from "./components/CameoPanel";
import { CameoLayerTable } from "./components/CameoLayerTable";
import { JogPanel } from "./components/JogPanel";
import { DxfPanel } from "./components/DxfPanel";
import { DxfPreview } from "./components/DxfPreview";
import { JobPanel } from "./components/JobPanel";
import { LogView } from "./components/LogView";
import { PositionReadout } from "./components/PositionReadout";
import { TestPatternPanel } from "./components/TestPatternPanel";
import { TepraPanel } from "./components/TepraPanel";

type LogEntry = api.LogLine & { ts: number };
type MachineMode = "grbl" | "cameo";
// Optional tool panel surfaced from the top-left Tools menu. null = none shown
// (the default: tools are hidden until explicitly picked).
type ActiveTool = null | "testpattern" | "tepra";

const MAX_LOG = 2000;

export default function App() {
  // Which machine backend is active. GRBL (NEJE laser, serial) or CAMEO
  // (Silhouette cutter, USB). The two never share a connection.
  const [machineMode, setMachineMode] = useState<MachineMode>("grbl");
  // Which tool panel (if any) is open. Opened from the native "Tools" menu
  // (Rust emits tool-selected; see the listener below).
  const [activeTool, setActiveTool] = useState<ActiveTool>(null);
  // CAMEO-specific connection label (model + serial). The shared ConnState
  // `conn` is reused for the connected flag in both modes (the Rust workers
  // emit the same CONNECTION event), but the CAMEO has no port/baud.
  const [cameoLabel, setCameoLabel] = useState<string | null>(null);
  const [cameoLayers, setCameoLayers] = useState<CameoLayerParams[]>([]);
  // CAMEO cutting mat: drives BOTH the preview work-area size AND the TG
  // command. Default = 12"×24" standard mat. `tg` is the GPGL TG preset.
  const [cameoMat, setCameoMat] = useState<{ width: number; height: number; tg: number }>(
    { width: CAMEO5_AREA.matWidth, height: CAMEO5_AREA.matHeight, tg: 2 },
  );

  const [conn, setConn] = useState<api.ConnState>({ connected: false, port: null, baud: null });
  // Kind of the currently-connected port. We re-derive this when the
  // connection event arrives (the port name alone isn't enough — we have to
  // look up its manufacturer/product). Polled in tandem with auto-connect
  // logic below.
  const [connKind, setConnKind] = useState<api.PortKind>("unknown");
  // Track auto-connect attempts so we don't fire them in a tight loop while a
  // connect is in-flight (the Tauri command isn't reentrant).
  const autoConnectingRef = useRef(false);
  // External code (e.g. JobPanel's ESP upload path) flips this when it needs
  // the serial port to itself. Setting it true pauses auto-connect; flipping
  // back to false lets the next polling tick re-attach.
  const autoConnectPausedRef = useRef(false);
  const [status, setStatus] = useState<api.Status | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<api.Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [doc, setDoc] = useState<DxfDocument | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerParams[]>([]);
  const [workArea, setWorkArea] = useState<{ width: number; height: number }>({
    width: 400,
    height: 400,
  });
  // MCS position of the design's (0, 0) corner. We default to a few mm shy of
  // the back edge rather than exactly `workArea.height`: a design point sitting
  // on `Y = $131` is AT the hardware limit switch (post-pulloff) and some
  // NEJE firmware trips ALARM:1/ALARM:2 on exact-boundary targets. 5mm of
  // headroom costs nothing and saves a re-home cycle.
  const BACK_MARGIN = 5;
  const [placement, setPlacement] = useState<Placement>({ x: 0, y: 400 - BACK_MARGIN });

  // Latest placement, kept in a ref so the (mounted-once) onFinished
  // listener can read the current value without resubscribing every render.
  const placementRef = useRef(placement);
  useEffect(() => {
    placementRef.current = placement;
  }, [placement]);

  // Latest connected flag + machine mode, kept in refs so the mounted-once
  // status-poll interval reads current values without resubscribing.
  const connectedRef = useRef(conn.connected);
  useEffect(() => {
    connectedRef.current = conn.connected;
  }, [conn.connected]);
  const machineModeRef = useRef(machineMode);
  useEffect(() => {
    machineModeRef.current = machineMode;
  }, [machineMode]);

  // Wire up event listeners once.
  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [];

    unsubs.push(
      api.onLog((l) => {
        setLog((prev) => {
          const next = prev.concat({ ...l, ts: Date.now() });
          return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
        });
        // Sniff GRBL `$$` replies for soft-limit max travel and auto-fill the
        // work area. GRBL emits `$130=<x_max_mm>` (X) and `$131=<y_max_mm>` (Y).
        if (l.level === "rx") {
          const m = l.text.match(/^\$(\d+)=([\d.]+)/);
          if (m) {
            const key = Number(m[1]);
            const val = Number(m[2]);
            if (Number.isFinite(val) && val > 10) {
              if (key === 130) setWorkArea((wa) => ({ ...wa, width: Math.round(val) }));
              if (key === 131) {
                const h = Math.round(val);
                setWorkArea((wa) => ({ ...wa, height: h }));
                // Re-snap default placement to (margin-inset) back edge if it
                // still looks like a pristine default.
                setPlacement((p) =>
                  p.y === 400 - BACK_MARGIN || p.y === 0 || p.y === 400
                    ? { x: p.x, y: h - BACK_MARGIN }
                    : p,
                );
              }
            }
          }
        }
      }),
    );
    unsubs.push(api.onStatus((s) => setStatus(s)));
    unsubs.push(api.onConnection((c) => {
      setConn(c);
      // If we just disconnected, drop the kind label too so the UI doesn't
      // leave a stale "ESP Proxy" badge dangling.
      if (!c.connected) {
        setConnKind("unknown");
        setCameoLabel(null);
      } else {
        // In CAMEO mode the Rust worker puts the model+serial in `port`.
        setCameoLabel(c.port);
      }
    }));
    unsubs.push(
      api.onProgress((p) => {
        setProgress(p);
        if (p.total > 0 && p.sent < p.total) setRunning(true);
      }),
    );
    // Native Tools menu → open/close a tool panel. Empty string = close.
    unsubs.push(
      api.onToolSelected((tool) => {
        setActiveTool(tool === "" ? null : (tool as ActiveTool));
      }),
    );
    unsubs.push(
      api.onFinished(async (f) => {
        setRunning(false);
        if (f.error) {
          console.error("job error:", f.error);
        }
        // On cancel, the worker did feed-hold + soft-reset, so the head
        // is stopped wherever the cut was interrupted. Drive it back to
        // the placement origin (the same point the end-of-job return-home
        // line uses) so the next job starts from a known position.
        if (f.cancelled) {
          // Wait for GRBL's post-reset welcome banner / idle state to settle.
          await new Promise<void>((r) => setTimeout(r, 600));
          const p = placementRef.current;
          try {
            // Clear potential alarm before issuing motion.
            await api.sendLine("$X");
            // Re-establish modal state then rapid back to placement.
            await api.sendLine("G21 G90 M5");
            await api.sendLine(`G0 X${p.x.toFixed(3)} Y${p.y.toFixed(3)}`);
          } catch (e) {
            console.error("return-home after cancel failed:", e);
          }
        }
      }),
    );

    // Poll status once a second while connected. Each backend has its own
    // status command; `machineModeRef` keeps this mounted-once interval aware
    // of the current mode without resubscribing.
    const interval = setInterval(() => {
      if (!connectedRef.current) return;
      if (machineModeRef.current === "cameo") api.cameoStatus().catch(() => {});
      else api.pollStatus().catch(() => {});
    }, 1000);

    return () => {
      clearInterval(interval);
      Promise.all(unsubs).then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  // -- Auto-connect ---------------------------------------------------------
  //
  // Every 2 seconds, look at the current port list. If we're disconnected
  // and recognize something we can connect to, connect to it. Preference:
  //   ESP proxy   > direct NEJE > unknown (left for manual selection)
  // Also re-fires when the user plugs the ESP back in (the port list
  // changes), so the "unplug to swap files, plug back in" loop doesn't
  // require any clicks.
  useEffect(() => {
    let stopped = false;
    const tryConnect = async () => {
      if (stopped) return;
      // GRBL auto-connect only runs in GRBL mode; CAMEO has its own connect UI.
      if (machineMode !== "grbl") return;
      if (conn.connected || autoConnectingRef.current) return;
      if (autoConnectPausedRef.current) return;
      let ports: api.PortInfo[];
      try {
        ports = await api.listPorts(true);
      } catch {
        return;
      }
      // Prefer the ESP proxy when both are present (the intended workflow
      // is ESP-mediated; direct is for hands-on debugging).
      const espPort = ports.find((p) => api.classifyPort(p) === "esp");
      const direct = ports.find((p) => api.classifyPort(p) === "direct");
      const target = espPort ?? direct;
      if (!target) return;
      const kind = api.classifyPort(target);
      autoConnectingRef.current = true;
      try {
        await api.connect(target.name, 115200);
        setConnKind(kind);
      } catch (e) {
        console.warn("auto-connect failed:", e);
      } finally {
        autoConnectingRef.current = false;
      }
    };
    tryConnect();
    const id = setInterval(tryConnect, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.connected, machineMode]);

  // Kick a poll when we connect.
  useEffect(() => {
    if (conn.connected) {
      setTimeout(() => {
        if (machineMode === "cameo") api.cameoStatus().catch(() => {});
        else api.pollStatus().catch(() => {});
      }, 400);
    } else {
      setStatus(null);
    }
  }, [conn.connected, machineMode]);

  // Regenerate CAMEO layer params whenever a new design loads. (GRBL layers
  // are managed inside DxfPanel; the CAMEO panel uses its own param shape.)
  useEffect(() => {
    setCameoLayers(doc ? defaultCameoLayers(doc) : []);
  }, [doc]);

  // Keep the native Tools menu's mode-specific items enabled for the current
  // mode (test pattern = GRBL only, tepra = CAMEO only).
  useEffect(() => {
    api.setToolMenuMode(machineMode === "cameo").catch(() => {});
  }, [machineMode]);

  // Switching machine mode: disconnect whatever backend is currently active so
  // we never leave a dangling worker holding the device.
  const switchMode = (mode: MachineMode) => {
    if (mode === machineMode) return;
    if (conn.connected) {
      if (machineMode === "cameo") api.cameoDisconnect().catch(() => {});
      else api.disconnect().catch(() => {});
    }
    // A tool that's mode-specific (test pattern → GRBL, tepra → CAMEO) can't stay
    // open across a mode switch.
    setActiveTool((t) =>
      (t === "testpattern" && mode !== "grbl") || (t === "tepra" && mode !== "cameo")
        ? null
        : t,
    );
    setMachineMode(mode);
  };

  const mpos = useMemo(() => status?.mpos ?? null, [status]);
  const wpos = useMemo(() => status?.wpos ?? null, [status]);
  // CAMEO uses a fixed bed; GRBL pulls work area from $130/$131. For CAMEO we
  // display the standard 12"×24" mat (the full 3 m roll would render as a thin
  // vertical sliver — 9:1 aspect — making the canvas look absurdly tall).
  const effectiveWorkArea = useMemo(
    () =>
      machineMode === "cameo"
        ? { width: cameoMat.width, height: cameoMat.height }
        : workArea,
    [machineMode, workArea, cameoMat],
  );

  const isCameo = machineMode === "cameo";

  // Where a freshly-loaded design should sit. GRBL: back-left of the bed with a
  // small margin (so no point sits on the limit switch). CAMEO: top-left of the
  // media — placement.y must cover the design height so every device Y stays ≥ 0
  // (design Y grows down, device Y = placement.y − designY).
  // `_d` (the loaded doc) is no longer needed for placement now that CAMEO uses
  // a fixed small top margin; kept in the signature so the call sites — which
  // pass the doc — stay unchanged.
  const placementForLoad = (_d: DxfDocument | null): Placement => {
    if (isCameo) {
      // CAMEO devPair maps device_y = placement.y + designY (Y NOT flipped). So
      // placement.y is the device Y of the design's TOP edge; design Y runs
      // [0, h] downward, giving device Y [placement.y, placement.y + h]. A small
      // positive top margin keeps every device-Y ≥ 0 (the boundary clips — and
      // drops — negative coords), and the design feeds top-first into the media.
      return { x: 0, y: 10 };
    }
    return { x: 0, y: workArea.height - BACK_MARGIN };
  };

  return (
    <div className="app">
      <header>
        {/* Tool panels are opened from the native "Tools" menu in the menu bar
            (next to File/Edit), handled in Rust → tool-selected event. */}
        <h1>{isCameo ? "CAMEO 5 / NEJE Controller" : "NEJE MAX4 Controller"}</h1>
        {/* Machine-mode toggle: GRBL (NEJE laser) vs CAMEO (Silhouette cutter). */}
        <div className="mode-switch" role="tablist" aria-label="Machine mode">
          <button
            type="button"
            className={!isCameo ? "active" : ""}
            onClick={() => switchMode("grbl")}
          >
            NEJE (laser)
          </button>
          <button
            type="button"
            className={isCameo ? "active" : ""}
            onClick={() => switchMode("cameo")}
          >
            CAMEO 5 (cutter)
          </button>
        </div>
        {isCameo ? (
          <CameoConnectionBar connected={conn.connected} connectedLabel={cameoLabel} />
        ) : (
          <ConnectionBar
            connected={conn.connected}
            connectedPort={conn.port}
            connKind={connKind}
          />
        )}
      </header>

      <main>
        <div className="col col-left">
          <PositionReadout status={status} connected={conn.connected} />
          {isCameo ? (
            <CameoPanel
              connected={conn.connected}
              doc={doc}
              fileName={fileName}
              layers={cameoLayers}
              mat={cameoMat.tg}
              progress={progress}
              running={running}
              placement={placement}
              onPlacementChange={setPlacement}
              autoConnectPausedRef={autoConnectPausedRef}
            />
          ) : (
            <>
              {/* Jog only makes sense when we're talking directly to the engraver.
                  In ESP-proxy mode the ESP isn't connected to NEJE in real time
                  (it's relaying upload + ARM), so jog/manual GRBL commands have
                  nowhere to go. */}
              <JogPanel connected={conn.connected && connKind !== "esp"} />
              <JobPanel
                connected={conn.connected}
                connKind={connKind}
                doc={doc}
                fileName={fileName}
                layers={layers}
                progress={progress}
                running={running}
                placement={placement}
                onPlacementChange={setPlacement}
                autoConnectPausedRef={autoConnectPausedRef}
              />
            </>
          )}
        </div>

        <div className="col col-center">
          <DxfPreview
            doc={doc}
            layers={isCameo ? cameoLayers : layers}
            workArea={effectiveWorkArea}
            mpos={mpos}
            wpos={wpos}
            placement={placement}
            onPlacementChange={setPlacement}
            invertY={!isCameo}
            onJogTo={(x, y) => {
              if (!conn.connected) return;
              if (isCameo) {
                // CAMEO jog is relative; the preview gives absolute device
                // coords, so this is a no-op for now (placement drag is the
                // primary positioning tool in cutter mode).
                return;
              }
              // Absolute MCS jog. GRBL 1.1+ accepts G90 inside $J=.
              const line = `$J=G90 G21 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`;
              api.sendLine(line).catch(() => {});
            }}
          />
          <LogView entries={log} />
        </div>

        <div className="col col-right">
          <DxfPanel
            doc={doc}
            onDocLoaded={(d, n) => {
              setDoc(d);
              setFileName(n);
              // Snap placement near the machine origin (mode-aware).
              setPlacement(placementForLoad(d));
            }}
            layers={layers}
            onLayersChange={setLayers}
            fileName={fileName}
            workArea={workArea}
            onWorkAreaChange={setWorkArea}
            compact={isCameo}
            matPreset={isCameo ? { width: cameoMat.width, height: cameoMat.height } : undefined}
            onMatChange={
              isCameo
                ? (m) => {
                    // Map the chosen mat size to the GPGL TG preset.
                    const tg =
                      m.width === 305 && m.height === 305
                        ? 1
                        : m.width === 305 && m.height === 610
                          ? 2
                          : 0;
                    setCameoMat({ width: m.width, height: m.height, tg });
                  }
                : undefined
            }
          />
          {/* CAMEO cut-layer table — same right-column slot + table style as the
              NEJE layer table, with reorder ↑↓, so the layout matches. */}
          {isCameo && (
            <CameoLayerTable
              doc={doc}
              layers={cameoLayers}
              onLayersChange={setCameoLayers}
            />
          )}
          {/* Tool panels — surfaced from the top-left Tools menu, hidden by
              default. Test pattern is a laser power×feed grid (GRBL only);
              tepra is the CAMEO roll-label generator. */}
          {!isCameo && activeTool === "testpattern" && (
            <TestPatternPanel
              loaded={doc !== null}
              onGenerated={(d, l, n) => {
                // Same flow as a freshly-loaded DXF: replace doc + layers,
                // snap placement near origin so it can be dragged from there.
                setDoc(d);
                setFileName(n);
                setLayers(l);
                setPlacement(placementForLoad(d));
              }}
            />
          )}
          {isCameo && activeTool === "tepra" && (
            <TepraPanel
              onClose={() => setActiveTool(null)}
              onGenerated={(d, n) => {
                // CAMEO layer params are regenerated by the doc-change effect
                // (setCameoLayers(defaultCameoLayers(doc))), so we only set the
                // doc + filename + placement here.
                setDoc(d);
                setFileName(n);
                setPlacement(placementForLoad(d));
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
