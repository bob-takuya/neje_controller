import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "./lib/api";
import { DxfDocument } from "./lib/dxf";
import { LayerParams, Placement } from "./lib/gcode";
import { ConnectionBar } from "./components/ConnectionBar";
import { JogPanel } from "./components/JogPanel";
import { DxfPanel } from "./components/DxfPanel";
import { DxfPreview } from "./components/DxfPreview";
import { JobPanel } from "./components/JobPanel";
import { LogView } from "./components/LogView";
import { PositionReadout } from "./components/PositionReadout";
import { TestPatternPanel } from "./components/TestPatternPanel";

type LogEntry = api.LogLine & { ts: number };

const MAX_LOG = 2000;

export default function App() {
  const [conn, setConn] = useState<api.ConnState>({ connected: false, port: null, baud: null });
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
    unsubs.push(api.onConnection((c) => setConn(c)));
    unsubs.push(
      api.onProgress((p) => {
        setProgress(p);
        if (p.total > 0 && p.sent < p.total) setRunning(true);
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

    // Poll status once a second while connected.
    const interval = setInterval(() => {
      if (conn.connected) api.pollStatus().catch(() => {});
    }, 1000);

    return () => {
      clearInterval(interval);
      Promise.all(unsubs).then((fns) => fns.forEach((fn) => fn()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kick a poll when we connect.
  useEffect(() => {
    if (conn.connected) {
      setTimeout(() => api.pollStatus().catch(() => {}), 400);
    } else {
      setStatus(null);
    }
  }, [conn.connected]);

  const mpos = useMemo(() => status?.mpos ?? null, [status]);
  const wpos = useMemo(() => status?.wpos ?? null, [status]);

  return (
    <div className="app">
      <header>
        <h1>NEJE MAX4 Controller</h1>
        <ConnectionBar connected={conn.connected} connectedPort={conn.port} />
      </header>

      <main>
        <div className="col col-left">
          <PositionReadout status={status} connected={conn.connected} />
          <JogPanel connected={conn.connected} />
          <JobPanel
            connected={conn.connected}
            doc={doc}
            layers={layers}
            progress={progress}
            running={running}
            placement={placement}
            onPlacementChange={setPlacement}
          />
        </div>

        <div className="col col-center">
          <DxfPreview
            doc={doc}
            layers={layers}
            workArea={workArea}
            mpos={mpos}
            wpos={wpos}
            placement={placement}
            onPlacementChange={setPlacement}
            onJogTo={(x, y) => {
              if (!conn.connected) return;
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
              // Reset placement to back-left with a small margin, so the first
              // rapid is short AND no cut point sits on the hardware limit.
              setPlacement({ x: 0, y: workArea.height - BACK_MARGIN });
            }}
            layers={layers}
            onLayersChange={setLayers}
            fileName={fileName}
            workArea={workArea}
            onWorkAreaChange={setWorkArea}
          />
          <TestPatternPanel
            loaded={doc !== null}
            onGenerated={(d, l, n) => {
              // Same flow as a freshly-loaded DXF: replace doc + layers,
              // snap placement to back-left so it can be dragged from there.
              setDoc(d);
              setFileName(n);
              setLayers(l);
              setPlacement({ x: 0, y: workArea.height - BACK_MARGIN });
            }}
          />
        </div>
      </main>
    </div>
  );
}
