// Generate a power × feed test pattern as a synthetic DxfDocument.
//
// Layout (design space, Y grows DOWN to match a parsed DXF after toDesignSpace):
//
//        f0   f1   f2   ...
//   p0  [_]  [_]  [_]
//   p1  [_]  [_]  [_]
//   p2  [_]  [_]  [_]
//
// Each cell is its own DXF layer with a unique (power, feed) so the existing
// per-layer G-code emitter applies the right S/F values. Row labels (powers)
// sit to the left of each row; column labels (feeds) sit above each column,
// both on a single shared "labels" layer with its own engraving parameters.

import {
  Bounds,
  DxfDocument,
  DxfLayer,
  Polyline,
  PolyShape,
  translateDoc,
} from "./dxf";
import { LayerParams } from "./gcode";

export type TestPatternOptions = {
  powers: number[]; // S values, one per row
  feeds: number[]; // mm/min, one per column
  squareSize: number; // mm
  gap: number; // mm between cells / around labels
  passes: number; // passes per cell
  labelPower: number; // S used for the label layer
  labelFeed: number; // feed used for the label layer
};

// 7-segment digit strokes in a normalized 1×2 box (Y up: a=top, d=bottom).
// The renderer flips Y on emit so the output sits in design space.
const SEG: Record<string, [number, number, number, number]> = {
  a: [0, 2, 1, 2],
  b: [1, 2, 1, 1],
  c: [1, 1, 1, 0],
  d: [0, 0, 1, 0],
  e: [0, 1, 0, 0],
  f: [0, 2, 0, 1],
  g: [0, 1, 1, 1],
};

const DIGITS: Record<string, string[]> = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "g", "e", "d"],
  "3": ["a", "b", "g", "c", "d"],
  "4": ["f", "g", "b", "c"],
  "5": ["a", "f", "g", "c", "d"],
  "6": ["a", "f", "g", "e", "c", "d"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
};

const DIGIT_W_RATIO = 0.5; // width:height = 1:2
const DIGIT_SPACING_RATIO = 0.15;

const textWidth = (s: string, h: number): number => {
  const dw = h * DIGIT_W_RATIO;
  const sp = h * DIGIT_SPACING_RATIO;
  return s.length * dw + Math.max(0, s.length - 1) * sp;
};

/** Render a numeric string at design-space (x, y) (top-left), height h mm. */
const renderText = (s: string, x: number, y: number, h: number): Polyline[] => {
  const dw = h * DIGIT_W_RATIO;
  const sp = h * DIGIT_SPACING_RATIO;
  const out: Polyline[] = [];
  let cx = x;
  for (const ch of s) {
    const segs = DIGITS[ch];
    if (!segs) {
      cx += dw + sp;
      continue;
    }
    for (const segName of segs) {
      const [x1, y1, x2, y2] = SEG[segName];
      const px1 = cx + x1 * dw;
      const py1 = y + (2 - y1) * (h / 2); // flip seg-Y (up) to design-Y (down)
      const px2 = cx + x2 * dw;
      const py2 = y + (2 - y2) * (h / 2);
      out.push([
        [px1, py1],
        [px2, py2],
      ]);
    }
    cx += dw + sp;
  }
  return out;
};

export const parseNumberList = (s: string): number[] =>
  s
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

export function generateTestPattern(opts: TestPatternOptions): {
  doc: DxfDocument;
  layers: LayerParams[];
  fileName: string;
} {
  const { powers, feeds, squareSize, gap, passes, labelPower, labelFeed } = opts;

  // Pick a label height that keeps the longest label inside one cell width.
  const maxLen = Math.max(
    1,
    ...powers.map((p) => String(p).length),
    ...feeds.map((f) => String(f).length),
  );
  const fitH = squareSize / (maxLen * DIGIT_W_RATIO + Math.max(0, maxLen - 1) * DIGIT_SPACING_RATIO);
  const labelH = Math.max(1, Math.min(squareSize * 0.6, fitH));
  const labelMargin = Math.max(gap * 0.5, 1);

  // Power-label width sets the left margin so the grid clears them.
  const maxPowerLabelW = Math.max(
    ...powers.map((p) => textWidth(String(p), labelH)),
  );
  const cellW = squareSize + gap;
  const cellH = squareSize + gap;
  const gridX0 = maxPowerLabelW + labelMargin;
  const gridY0 = labelH + labelMargin;

  const dxfLayers: DxfLayer[] = [];
  const layerParams: LayerParams[] = [];

  // ---- One layer per cell (unique power × feed) ----
  for (let r = 0; r < powers.length; r++) {
    for (let c = 0; c < feeds.length; c++) {
      const power = powers[r];
      const feed = feeds[c];
      const x0 = gridX0 + c * cellW;
      const y0 = gridY0 + r * cellH;
      const x1 = x0 + squareSize;
      const y1 = y0 + squareSize;
      const sq: Polyline = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ];
      const name = `r${r}c${c}_p${power}_f${feed}`;
      dxfLayers.push({
        name,
        color: "#888",
        shapes: [{ type: "poly", points: sq } as PolyShape],
      });
      layerParams.push({
        name,
        enabled: true,
        power,
        feed,
        passes,
      });
    }
  }

  // ---- Single labels layer ----
  const labelShapes: PolyShape[] = [];

  // Power labels (left of each row, right-aligned to the grid edge).
  for (let r = 0; r < powers.length; r++) {
    const s = String(powers[r]);
    const w = textWidth(s, labelH);
    const lblY = gridY0 + r * cellH + (squareSize - labelH) / 2;
    const lblX = gridX0 - labelMargin - w;
    for (const p of renderText(s, lblX, lblY, labelH)) {
      labelShapes.push({ type: "poly", points: p });
    }
  }
  // Feed labels (above each column, centered to the cell).
  for (let c = 0; c < feeds.length; c++) {
    const s = String(feeds[c]);
    const w = textWidth(s, labelH);
    const lblY = gridY0 - labelMargin - labelH;
    const lblX = gridX0 + c * cellW + (squareSize - w) / 2;
    for (const p of renderText(s, lblX, lblY, labelH)) {
      labelShapes.push({ type: "poly", points: p });
    }
  }

  if (labelShapes.length > 0) {
    dxfLayers.push({
      name: "labels",
      color: "#666",
      shapes: labelShapes,
    });
    layerParams.push({
      name: "labels",
      enabled: true,
      power: labelPower,
      feed: labelFeed,
      passes: 1,
    });
  }

  // ---- Outer frame surrounding everything (cells + labels) ----
  // Compute the extent of what's been emitted so far, then expand by a
  // margin so the frame doesn't graze label/cell strokes.
  let minX = +Infinity,
    minY = +Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const layer of dxfLayers) {
    for (const s of layer.shapes) {
      if (s.type !== "poly") continue;
      for (const [x, y] of s.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (isFinite(minX)) {
    const frameMargin = Math.max(gap, 2);
    const fx0 = minX - frameMargin;
    const fy0 = minY - frameMargin;
    const fx1 = maxX + frameMargin;
    const fy1 = maxY + frameMargin;
    const frame: Polyline = [
      [fx0, fy0],
      [fx1, fy0],
      [fx1, fy1],
      [fx0, fy1],
      [fx0, fy0],
    ];
    dxfLayers.push({
      name: "frame",
      color: "#aaa",
      shapes: [{ type: "poly", points: frame } as PolyShape],
    });
    layerParams.push({
      name: "frame",
      enabled: true,
      power: labelPower,
      feed: labelFeed,
      passes: 1,
    });
    // Frame is now the outermost geometry — update bounds.
    minX = fx0;
    minY = fy0;
    maxX = fx1;
    maxY = fy1;
  }

  const rawBounds: Bounds = isFinite(minX)
    ? { minX, minY, maxX, maxY }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  // Snap to origin (matches the convention `toDesignSpace` enforces for
  // parsed DXFs) so placement & dragging start from a known (0, 0) corner.
  const doc = translateDoc(
    { layers: dxfLayers, bounds: rawBounds },
    -rawBounds.minX,
    -rawBounds.minY,
  );

  return {
    doc,
    layers: layerParams,
    fileName: `test_${powers.length}x${feeds.length}.gen`,
  };
}
