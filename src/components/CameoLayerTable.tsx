import { DxfDocument } from "../lib/dxf";
import { CameoLayerParams } from "../lib/cameoGpgl";

type Props = {
  doc: DxfDocument | null;
  layers: CameoLayerParams[];
  onLayersChange: (layers: CameoLayerParams[]) => void;
};

/**
 * CAMEO cut-layer table for the right column. Deliberately mirrors the NEJE
 * layer table in DxfPanel (same `.dxf-panel` table styling, same reorder ↑↓,
 * enable checkbox, color swatch, then per-row machine columns) so switching
 * machine modes keeps layer editing in the SAME place with the SAME layout —
 * only the columns differ (tool/speed/force/depth/passes instead of
 * power/feed/passes).
 */
export function CameoLayerTable({ doc, layers, onLayersChange }: Props) {
  const setLayer = (i: number, patch: Partial<CameoLayerParams>) => {
    onLayersChange(layers.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };

  // Cut order = array order (buildGpgl iterates layers in order). Swapping two
  // adjacent entries reorders the cut sequence — same semantics as NEJE.
  const moveLayer = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= layers.length) return;
    const next = layers.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onLayersChange(next);
  };

  if (layers.length === 0) return null;

  return (
    <div className="panel dxf-panel">
      <h3>Cut Layers</h3>
      <div className="layers">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th></th>
              <th>color</th>
              <th>name</th>
              <th>tool</th>
              <th>spd</th>
              <th>force</th>
              <th>depth</th>
              <th>pass</th>
            </tr>
          </thead>
          <tbody>
            {layers.map((l, i) => {
              const dxfColor =
                doc?.layers.find((d) => d.name === l.name)?.color ?? "#cccccc";
              const shownColor = l.color ?? dxfColor;
              const overridden =
                l.color != null &&
                l.color.toLowerCase() !== dxfColor.toLowerCase();
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
                      onChange={(e) => setLayer(i, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="color"
                      value={shownColor}
                      onChange={(e) => setLayer(i, { color: e.target.value })}
                      title={
                        overridden
                          ? `overriding DXF color ${dxfColor}`
                          : `DXF color ${dxfColor}`
                      }
                    />
                    {overridden && (
                      <button
                        type="button"
                        className="link"
                        onClick={() => setLayer(i, { color: undefined })}
                        title="Revert to the color from the DXF file"
                      >
                        reset
                      </button>
                    )}
                  </td>
                  <td title={l.name}>{l.name}</td>
                  <td>
                    <select
                      value={l.tool}
                      onChange={(e) =>
                        setLayer(i, { tool: Number(e.target.value) === 2 ? 2 : 1 })
                      }
                      title="Tool holder (1 = left/AutoBlade, 2 = right/rotary)"
                    >
                      <option value={1}>T1</option>
                      <option value={2}>T2</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      value={l.speed}
                      onChange={(e) => {
                        const v = e.target.value === "" ? 0 : Number(e.target.value);
                        if (Number.isFinite(v)) setLayer(i, { speed: v });
                      }}
                      onBlur={(e) =>
                        setLayer(i, {
                          speed: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                        })
                      }
                      title="Speed 1–10"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={l.force}
                      onChange={(e) => {
                        const v = e.target.value === "" ? 0 : Number(e.target.value);
                        if (Number.isFinite(v)) setLayer(i, { force: v });
                      }}
                      onBlur={(e) =>
                        setLayer(i, {
                          force: Math.max(1, Math.min(33, Number(e.target.value) || 1)),
                        })
                      }
                      title="Downforce 1–33"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={l.depth}
                      disabled={l.tool !== 1 || !l.autoBlade}
                      onChange={(e) => {
                        const v = e.target.value === "" ? 0 : Number(e.target.value);
                        if (Number.isFinite(v)) setLayer(i, { depth: v });
                      }}
                      onBlur={(e) =>
                        setLayer(i, {
                          depth: Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                        })
                      }
                      title="AutoBlade depth 0–10 (tool 1 + AutoBlade only)"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={l.passes}
                      onChange={(e) => {
                        const v = e.target.value === "" ? 0 : Number(e.target.value);
                        if (Number.isFinite(v)) setLayer(i, { passes: v });
                      }}
                      onBlur={(e) =>
                        setLayer(i, {
                          passes: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                        })
                      }
                      title="Passes"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label className="chk" style={{ marginTop: 4 }} title="Tool 1 is an AutoBlade (enables the depth column)">
        <input
          type="checkbox"
          checked={layers.every((l) => l.autoBlade)}
          onChange={(e) =>
            onLayersChange(layers.map((l) => ({ ...l, autoBlade: e.target.checked })))
          }
        />
        AutoBlade on tool 1 (motorized depth)
      </label>
    </div>
  );
}
