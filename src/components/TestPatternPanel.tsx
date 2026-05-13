import { useMemo, useState } from "react";
import { DxfDocument } from "../lib/dxf";
import { LayerParams } from "../lib/gcode";
import {
  generateTestPattern,
  parseNumberList,
} from "../lib/testPattern";

type Props = {
  /** Whether a doc is currently loaded — when true the form starts collapsed
   *  so the (potentially long) layer table dominates the right column. */
  loaded: boolean;
  onGenerated: (
    doc: DxfDocument,
    layers: LayerParams[],
    fileName: string,
  ) => void;
};

export function TestPatternPanel({ loaded, onGenerated }: Props) {
  const [powersText, setPowersText] = useState("200, 400, 600, 800, 1000");
  const [feedsText, setFeedsText] = useState("500, 1000, 2000, 3000");
  const [size, setSize] = useState(5);
  const [gap, setGap] = useState(5);
  const [passes, setPasses] = useState(1);
  const [labelPower, setLabelPower] = useState(500);
  const [labelFeed, setLabelFeed] = useState(1500);
  const [err, setErr] = useState<string | null>(null);
  // Manual override: lets the user re-open the form to regenerate even
  // after a doc is loaded.
  const [expanded, setExpanded] = useState(false);

  const { powers, feeds } = useMemo(
    () => ({
      powers: parseNumberList(powersText),
      feeds: parseNumberList(feedsText),
    }),
    [powersText, feedsText],
  );

  const onGenerate = () => {
    setErr(null);
    if (powers.length === 0 || feeds.length === 0) {
      setErr("powers と feeds に1つ以上の正の数を入れてください");
      return;
    }
    const result = generateTestPattern({
      powers,
      feeds,
      squareSize: size,
      gap,
      passes,
      labelPower,
      labelFeed,
    });
    onGenerated(result.doc, result.layers, result.fileName);
    // Auto-collapse after a successful generate so the layer table is visible.
    setExpanded(false);
  };

  // Collapsed = doc already loaded AND user hasn't explicitly opened the form.
  const isCollapsed = loaded && !expanded;
  if (isCollapsed) {
    return (
      <div className="panel">
        <div className="row">
          <h3 style={{ flex: 1 }}>Test pattern</h3>
          <button onClick={() => setExpanded(true)}>New / Regenerate…</button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="row">
        <h3 style={{ flex: 1 }}>Test pattern</h3>
        {loaded && (
          <button onClick={() => setExpanded(false)}>Collapse</button>
        )}
      </div>
      <div className="row">
        <label>Powers (S):</label>
        <input
          type="text"
          value={powersText}
          onChange={(e) => setPowersText(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
          title="行ごとに使うレーザー出力（カンマ/空白区切り）"
        />
      </div>
      <div className="row">
        <label>Feeds (mm/min):</label>
        <input
          type="text"
          value={feedsText}
          onChange={(e) => setFeedsText(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
          title="列ごとに使う送り速度（カンマ/空白区切り）"
        />
      </div>
      <div className="row">
        <label>Size:</label>
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          value={size}
          onChange={(e) => setSize(Math.max(1, Number(e.target.value) || 5))}
        />
        <span className="muted">mm</span>
        <label>Gap:</label>
        <input
          type="number"
          min={0}
          max={50}
          step={1}
          value={gap}
          onChange={(e) => setGap(Math.max(0, Number(e.target.value) || 0))}
        />
        <span className="muted">mm</span>
        <label>Passes:</label>
        <input
          type="number"
          min={1}
          max={20}
          value={passes}
          onChange={(e) =>
            setPasses(Math.max(1, Number(e.target.value) || 1))
          }
        />
      </div>
      <div className="row">
        <label>Label S:</label>
        <input
          type="number"
          min={0}
          max={1000}
          value={labelPower}
          onChange={(e) => setLabelPower(Number(e.target.value) || 0)}
        />
        <label>Label feed:</label>
        <input
          type="number"
          min={100}
          max={10000}
          step={100}
          value={labelFeed}
          onChange={(e) => setLabelFeed(Number(e.target.value) || 100)}
        />
      </div>
      <div className="row">
        <button className="primary" onClick={onGenerate}>
          Generate
        </button>
        <span className="muted">
          {powers.length} × {feeds.length} cells
          {powers.length > 0 && feeds.length > 0 && (
            <>
              {" "}
              (
              {(
                size * powers.length +
                gap * (powers.length - 1)
              ).toFixed(0)}
              ×
              {(
                size * feeds.length +
                gap * (feeds.length - 1)
              ).toFixed(0)}
              mm + labels)
            </>
          )}
        </span>
      </div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}
