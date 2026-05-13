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
      const parsed = parseDxf(text);
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
                      min={0}
                      max={1000}
                      value={l.power}
                      onChange={(e) => updateLayer(i, { power: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={100}
                      max={10000}
                      step={100}
                      value={l.feed}
                      onChange={(e) => updateLayer(i, { feed: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={l.passes}
                      onChange={(e) => updateLayer(i, { passes: Math.max(1, Number(e.target.value)) })}
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
