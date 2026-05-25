import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import * as api from "../lib/api";
import { DxfDocument, flipY, parseDxf, translateDoc } from "../lib/dxf";
import { LayerParams, defaultLayerParams } from "../lib/gcode";

export type WorkArea = { width: number; height: number };

type Props = {
  doc: DxfDocument | null;
  onDocLoaded: (doc: DxfDocument | null, fileName: string | null) => void;
  layers: LayerParams[];
  onLayersChange: (layers: LayerParams[]) => void;
  fileName: string | null;
  workArea: WorkArea;
  onWorkAreaChange: (w: WorkArea) => void;
};

/**
 * Normalize a freshly-parsed DXF into "design space":
 *   - flipY so the original maxY becomes y=0 (design top is at the top)
 *   - snap so the min corner sits at (0, 0)
 *
 * After this, every point has y ≥ 0 with y growing downward visually, which
 * is the convention the rest of the app (viewer + G-code placement) relies on.
 */
const toDesignSpace = (d: DxfDocument): DxfDocument => {
  const flipped = flipY(d);
  return translateDoc(flipped, -flipped.bounds.minX, -flipped.bounds.minY);
};

export function DxfPanel({
  doc,
  onDocLoaded,
  layers,
  onLayersChange,
  fileName,
  workArea,
  onWorkAreaChange,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // When true, parseDxf skips the biarc fitter entirely. Escape hatch for
  // DXFs where the fitter mis-renders particular geometry (full-circle bug
  // on near-flat arcs). The flag must be set BEFORE opening the file because
  // it changes how the source DXF is parsed; flipping it just rerunning the
  // emitter on an already-fitted doc would inherit the broken ArcShape data.
  const [disableBiarc, setDisableBiarc] = useState(false);

  const openDxf = async () => {
    setErr(null);
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "DXF", extensions: ["dxf", "DXF"] }],
      });
      if (!picked || typeof picked !== "string") return;
      setBusy(true);
      const text = await readTextFile(picked);
      const parsed = parseDxf(text, { disableBiarc });
      const d = toDesignSpace(parsed);
      onDocLoaded(d, picked.split("/").pop() ?? picked);
      onLayersChange(defaultLayerParams(d));
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateLayer = (i: number, patch: Partial<LayerParams>) => {
    const next = layers.slice();
    next[i] = { ...next[i], ...patch };
    onLayersChange(next);
  };

  // Cut order = order in the LayerParams array (buildGCode iterates
  // params.layers in order). Swapping two adjacent entries reorders the
  // cut sequence with no other side effects — shape order within a layer
  // is unchanged.
  const moveLayer = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= layers.length) return;
    const next = layers.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onLayersChange(next);
  };

  const bounds = doc?.bounds;

  return (
    <div className="panel dxf-panel">
      <h3>DXF</h3>
      <div className="row">
        <button className="primary" onClick={openDxf} disabled={busy}>
          Open DXF…
        </button>
        <span className="muted">{fileName ?? "(none)"}</span>
      </div>
      <div className="row">
        <label className="chk">
          <input
            type="checkbox"
            checked={disableBiarc}
            onChange={(e) => setDisableBiarc(e.target.checked)}
            title="Skip the biarc fitter at parse time. Slower output but no fitter artefacts. Apply by re-opening the DXF."
          />
          Disable biarc fit (parse-time)
        </label>
      </div>
      <div className="row">
        <label>Work area:</label>
        <input
          type="number"
          min={10}
          max={2000}
          step={10}
          value={workArea.width}
          onChange={(e) =>
            onWorkAreaChange({ ...workArea, width: Math.max(10, Number(e.target.value) || 10) })
          }
        />
        <span className="muted">×</span>
        <input
          type="number"
          min={10}
          max={2000}
          step={10}
          value={workArea.height}
          onChange={(e) =>
            onWorkAreaChange({ ...workArea, height: Math.max(10, Number(e.target.value) || 10) })
          }
        />
        <span className="muted">mm</span>
        <button
          type="button"
          onClick={() => api.sendLine("$$").catch(() => {})}
          title="Send $$ — pulls $130/$131 (max travel) from GRBL. Result auto-fills above."
        >
          Probe ($$)
        </button>
      </div>
      {bounds && (() => {
        const w = bounds.maxX - bounds.minX;
        const h = bounds.maxY - bounds.minY;
        return (
          <div className="bounds muted">
            design size: {w.toFixed(2)} × {h.toFixed(2)} mm
          </div>
        );
      })()}
      {err && <div className="err">{err}</div>}

      {layers.length > 0 && (
        <div className="layers">
          <h4>Layers</h4>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th></th>
                <th>color</th>
                <th>name</th>
                <th>power</th>
                <th>feed</th>
                <th>passes</th>
              </tr>
            </thead>
            <tbody>
              {layers.map((l, i) => {
                const dxfColor = doc?.layers.find((d) => d.name === l.name)?.color ?? "#cccccc";
                const shownColor = l.color ?? dxfColor;
                const overridden = l.color != null && l.color.toLowerCase() !== dxfColor.toLowerCase();
                return (
                <tr key={l.name}>
                  <td className="order-cell">
                    <span className="muted">{i + 1}</span>
                    <button
                      type="button"
                      className="link"
                      disabled={i === 0}
                      onClick={() => moveLayer(i, -1)}
                      title="Cut this layer earlier"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="link"
                      disabled={i === layers.length - 1}
                      onClick={() => moveLayer(i, 1)}
                      title="Cut this layer later"
                    >
                      ↓
                    </button>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={l.enabled}
                      onChange={(e) => updateLayer(i, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="color"
                      value={shownColor}
                      onChange={(e) => updateLayer(i, { color: e.target.value })}
                      title={overridden ? `overriding DXF color ${dxfColor}` : `DXF color ${dxfColor}`}
                    />
                    {overridden && (
                      <button
                        type="button"
                        className="link"
                        onClick={() => updateLayer(i, { color: undefined })}
                        title="Revert to the color from the DXF file"
                      >
                        reset
                      </button>
                    )}
                  </td>
                  <td>{l.name}</td>
                  <td>
                    <input
                      type="number"
                      // Intentionally no min/max — those make the browser
                      // refuse intermediate values (e.g. "1" before the user
                      // types the trailing "00") and the controlled-state
                      // re-render snaps the field back, so typing feels
                      // broken. Clamp on blur instead.
                      value={l.power}
                      onChange={(e) => {
                        const v = e.target.value === "" ? 0 : Number(e.target.value);
                        if (Number.isFinite(v)) updateLayer(i, { power: v });
                      }}
                      onBlur={(e) => {
                        const v = Math.max(0, Math.min(1000, Number(e.target.value) || 0));
                        updateLayer(i, { power: v });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step={100}
                      value={l.feed}
                      onChange={(e) => {
                        const v = e.target.value === "" ? 0 : Number(e.target.value);
                        if (Number.isFinite(v)) updateLayer(i, { feed: v });
                      }}
                      onBlur={(e) => {
                        const v = Math.max(100, Math.min(10000, Number(e.target.value) || 100));
                        updateLayer(i, { feed: v });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={l.passes}
                      onChange={(e) => {
                        const v = e.target.value === "" ? 0 : Number(e.target.value);
                        if (Number.isFinite(v)) updateLayer(i, { passes: v });
                      }}
                      onBlur={(e) => {
                        const v = Math.max(1, Math.min(20, Number(e.target.value) || 1));
                        updateLayer(i, { passes: v });
                      }}
                    />
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
