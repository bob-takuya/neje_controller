// Tepra-style label generator: render a string as a single row (horizontal) or
// column (vertical) of text sized for a long, narrow roll of media, and build a
// DxfDocument the CAMEO plotter pipeline (cameoGpgl.ts) can draw.
//
// Each glyph's outline is stroked `outlinePasses` times (each pass offset inward
// by `lineGap`), optionally filled with a diagonal zigzag at `lineGap` pitch.
// The result is snapped to the design-space origin like every other doc, so
// placement/preview/GPGL all behave the same as a loaded DXF.

import {
  Bounds,
  DxfDocument,
  DxfLayer,
  PolyShape,
  translateDoc,
} from "./dxf";
import { Font } from "opentype.js";
import { layoutGlyphs, type Polyline } from "./textVector";
import { offsetRingInward, type Ring } from "./polygonFill";
import { fillRegion, type FillMode } from "./concentricFill";

export type TepraOptions = {
  text: string;
  /**
   * A single font, or an ordered STACK for multilingual "Auto" mode (each
   * character is drawn by the first font in the stack that has its glyph).
   */
  font: Font | Font[];
  /** Em height in mm. */
  sizeMm: number;
  /** Extra gap between characters in mm (added to the per-glyph step). */
  charSpacingMm: number;
  /** "horizontal" = left→right row; "vertical" = top→bottom column (縦書き). */
  orientation: "horizontal" | "vertical";
  /**
   * Spacing mode:
   *   - "monospace" (等幅): every glyph occupies a square cell of side sizeMm,
   *     centred, so the step is constant (sizeMm + charSpacing) regardless of
   *     glyph width — "i" and "W" advance equally.
   *   - "optical" (プロポーショナル): step follows each glyph's natural advance
   *     width (+ charSpacing), so narrow glyphs sit closer.
   * Vertical orientation is always cell-based (CJK 縦書き); this only changes
   * the horizontal step.
   */
  spacingMode: "monospace" | "optical";
  /** Hatch/offset pitch in mm: zigzag line spacing AND the inward offset step. */
  lineGapMm: number;
  /** How many inward outline passes to trace (1 = just the glyph outline). */
  outlinePasses: number;
  /** Fill the interior. */
  fill: boolean;
  /** Interior fill pattern: "zigzag" diagonal hatch or "concentric" loops. */
  fillMode: FillMode;
};

/**
 * Glyph contours at an absolute design-space position, plus `feedPos` — the
 * coordinate along the tape FEED direction (X for horizontal, Y for vertical).
 * Glyphs are emitted in ascending feedPos so the plotter finishes the nearest
 * character first and the tape advances one character at a time, never going
 * back over a finished part — the tepra workflow.
 */
type PlacedGlyph = { rings: Ring[]; feedPos: number };

/**
 * Lay glyphs out into absolute design-space contours.
 * Every glyph is treated as sitting in its own SQUARE cell of side `sizeMm`,
 * and the cells are laid end-to-end with `charSpacing` between them — so the
 * pitch is constant (`sizeMm + charSpacing`) regardless of each glyph's natural
 * width. This makes "i" and "W" advance by the same step (equal spacing), with
 * each glyph centred within its cell.
 *
 *   - horizontal: cells run left→right, then the WHOLE line is rotated 90°
 *     clockwise so it runs down the tape's feed axis (+Y). The tape is narrow
 *     and feeds in Y, so a horizontal label must lie along Y. After the
 *     rotation the first character (A) sits at the smallest Y (nearest / fed
 *     first); when the finished tape is turned back upright the text reads
 *     left→right as authored.
 *   - vertical: cells stack down +Y (CJK 縦書き). Same square-cell pitch.
 */
const placeGlyphs = (opts: TepraOptions): PlacedGlyph[] => {
  const glyphs = layoutGlyphs(opts.font, opts.text, opts.sizeMm);
  const placed: PlacedGlyph[] = [];
  // Constant square-cell pitch — the source of the equal spacing.
  const pitch = opts.sizeMm + opts.charSpacingMm;

  if (opts.orientation === "horizontal") {
    // Clockwise 90° in this Y-down design frame: (x, y) → (-y, x). The line's
    // +X advance becomes +Y, so penX (a glyph's position along the line) is its
    // feed coordinate after rotation, and feed order = reading order.
    const rotCW = ([x, y]: [number, number]): [number, number] => [-y, x];
    const mono = opts.spacingMode === "monospace";
    let penX = 0;
    for (const g of glyphs) {
      // monospace: square cell, glyph centred, constant pitch.
      // optical: glyph at the pen, step = its natural advance + spacing.
      const dx = mono ? (opts.sizeMm - g.advanceMm) / 2 : 0;
      const rings = g.contours.map((c) =>
        c.map(([x, y]) => rotCW([x + penX + dx, y])),
      );
      if (rings.length) placed.push({ rings, feedPos: penX });
      penX += mono ? pitch : g.advanceMm + opts.charSpacingMm;
    }
  } else {
    // Vertical: column pitch = square cell; center each glyph in X.
    let penY = 0;
    for (const g of glyphs) {
      // Center the glyph's advance box within the sizeMm-wide column.
      const dx = (opts.sizeMm - g.advanceMm) / 2;
      const rings = g.contours.map(
        (c) => c.map(([x, y]) => [x + dx, y + penY] as [number, number]),
      );
      if (rings.length) placed.push({ rings, feedPos: penY });
      penY += pitch;
    }
  }
  // Emit nearest-first along the feed axis (already ascending here, but sort
  // explicitly so the "one character at a time" guarantee survives any future
  // layout change).
  placed.sort((a, b) => a.feedPos - b.feedPos);
  return placed;
};

/**
 * Build outline-pass polylines for one glyph: pass 0 is the raw contour, each
 * later pass is the previous offset inward by `lineGap`. Stops early for a ring
 * that collapses (offset exceeded its feature size).
 */
const outlineStrokes = (rings: Ring[], lineGap: number, passes: number): Polyline[] => {
  const out: Polyline[] = [];
  for (const ring of rings) {
    out.push(ring);
    let cur: Ring | null = ring;
    for (let p = 1; p < passes; p++) {
      cur = offsetRingInward(cur as Ring, lineGap);
      if (!cur) break;
      out.push(cur);
    }
  }
  return out;
};

export function generateTepra(opts: TepraOptions): {
  doc: DxfDocument;
  fileName: string;
} {
  const placed = placeGlyphs(opts);
  const lineGap = Math.max(0.1, opts.lineGapMm);
  const passes = Math.max(1, Math.round(opts.outlinePasses));

  // ONE layer, shapes in strict draw order. buildGpgl emits layer.shapes in
  // array order, so this array order IS the GPGL order. We append each glyph
  // completely — its fill THEN its outline — before moving to the next glyph
  // (glyphs already sorted nearest-first along the feed axis). The result: the
  // plotter finishes character N before starting N+1, so the tape advances one
  // character at a time, tepra-style, and never travels back over finished
  // work.
  //
  // Fill-before-outline per glyph matches the pen-plotter convention (flood the
  // interior, then lay a crisp edge on top).
  const shapes: PolyShape[] = [];
  for (const g of placed) {
    if (opts.fill) {
      // Interior fill, clipped to the glyph's rings (even-odd → holes empty).
      for (const seg of fillRegion(g.rings, lineGap, opts.fillMode)) {
        shapes.push({ type: "poly", points: seg });
      }
    }
    // Outline (+ inward passes).
    for (const stroke of outlineStrokes(g.rings, lineGap, passes)) {
      shapes.push({ type: "poly", points: stroke });
    }
  }

  const dxfLayers: DxfLayer[] = [];
  if (shapes.length > 0) {
    dxfLayers.push({ name: "tepra", color: "#d94a4a", shapes });
  }

  // Bounds across everything, then snap to origin (same convention as
  // toDesignSpace / generateTestPattern).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of dxfLayers)
    for (const s of l.shapes) {
      if (s.type !== "poly") continue; // tepra only emits polys
      for (const [x, y] of s.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  const rawBounds: Bounds = isFinite(minX)
    ? { minX, minY, maxX, maxY }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  const doc = translateDoc(
    { layers: dxfLayers, bounds: rawBounds },
    -rawBounds.minX,
    -rawBounds.minY,
  );

  const safe = opts.text.replace(/[^A-Za-z]/g, "").slice(0, 16) || "label";
  return { doc, fileName: `tepra${safe}.gen` };
}
