// unim → tepra label generator: build a CAMEO/GRBL doc directly from unim's
// VECTOR glyph data instead of tracing a rasterized GIF, so glyph edges are
// mathematically exact (no jaggies).
//
// unim (https://baku89.github.io/unim) stores each character as an SVG path-data
// string of Bézier/line segments in a ~1000-unit em (Paper.js under the hood).
// A companion Tampermonkey script copies these paths from the page's
// localStorage["com.baku89.unim.project"]; the user pastes the result here.
//
// We parse the path data into closed contours, then lay the glyphs out as one
// tape row using the SAME common-frame layout + zigzag fill / inward outline
// pipeline as the GIF and text generators, so the output is identical
// downstream — only the geometry source differs (exact vector vs. traced bitmap).

import {
  Bounds,
  DxfDocument,
  DxfLayer,
  PolyShape,
  translateDoc,
} from "./dxf";
import { offsetRingInward, type Polyline, type Ring } from "./polygonFill";
import { fillRegion, type FillMode } from "./concentricFill";

export type TepraUnimOptions = {
  /** Each glyph as one SVG path-data string (may contain multiple subpaths). */
  glyphs: string[];
  /** Cell side in mm — each glyph is fit into a square of this side. */
  sizeMm: number;
  /** Extra gap between glyphs in mm (added to the per-cell step). */
  charSpacingMm: number;
  /** "horizontal" = row fed along the tape; "vertical" = stacked column. */
  orientation: "horizontal" | "vertical";
  /** Hatch/offset pitch in mm: zigzag spacing AND the inward offset step. */
  lineGapMm: number;
  /** How many inward outline passes to trace (1 = just the glyph outline). */
  outlinePasses: number;
  /** Fill the glyph interior. */
  fill: boolean;
  /** Interior fill pattern: "zigzag" diagonal hatch or "concentric" loops. */
  fillMode: FillMode;
};

// ---------------------------------------------------------------------------
// SVG path-data parsing
// ---------------------------------------------------------------------------

type Pt = [number, number];

// Chord subdivision per curve segment. unim glyphs are smooth at label scale
// with 12 steps; the collinear-simplify pass drops redundant points after.
const CURVE_STEPS = 12;

const flattenQuad = (p0: Pt, c: Pt, p1: Pt, out: Polyline) => {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const mt = 1 - t;
    out.push([
      mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0],
      mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1],
    ]);
  }
};

const flattenCubic = (p0: Pt, c1: Pt, c2: Pt, p1: Pt, out: Polyline) => {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const mt = 1 - t;
    out.push([
      mt * mt * mt * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * p1[0],
      mt * mt * mt * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
};

// Flatten an SVG elliptical arc (A/a) into line segments. Implements the
// endpoint→center parameterization from the SVG spec; used rarely (unim glyphs
// are Béziers) but supported so pasted icon paths don't break.
const flattenArc = (
  p0: Pt,
  rx: number,
  ry: number,
  xAxisDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Pt,
  out: Polyline,
) => {
  if (rx === 0 || ry === 0) {
    out.push(p1);
    return;
  }
  const phi = (xAxisDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  let rxa = Math.abs(rx), rya = Math.abs(ry);
  // Correct out-of-range radii.
  const lambda = (x1p * x1p) / (rxa * rxa) + (y1p * y1p) / (rya * rya);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rxa *= s;
    rya *= s;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const num = rxa * rxa * rya * rya - rxa * rxa * y1p * y1p - rya * rya * x1p * x1p;
  const den = rxa * rxa * y1p * y1p + rya * rya * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * (rxa * y1p)) / rya;
  const cyp = (co * -(rya * x1p)) / rxa;
  const cx = cosP * cxp - sinP * cyp + (p0[0] + p1[0]) / 2;
  const cy = sinP * cxp + cosP * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta0 = ang(1, 0, (x1p - cxp) / rxa, (y1p - cyp) / rya);
  let dTheta = ang((x1p - cxp) / rxa, (y1p - cyp) / rya, (-x1p - cxp) / rxa, (-y1p - cyp) / rya);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil((Math.abs(dTheta) / Math.PI) * CURVE_STEPS));
  for (let i = 1; i <= steps; i++) {
    const th = theta0 + (dTheta * i) / steps;
    const ex = Math.cos(th) * rxa, ey = Math.sin(th) * rya;
    out.push([cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy]);
  }
};

/** Tokenize numbers/flags out of an SVG command's argument run. */
const readNums = (s: string): number[] => {
  const out: number[] = [];
  // Numbers: optional sign, digits, decimal, exponent. Also splits "11-2" and
  // ".5.5" runs the way SVG allows (a new number starts at a '-' or a 2nd '.').
  const re = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(parseFloat(m[0]));
  return out;
};

/**
 * Parse an SVG path-data string into closed contours (one Polyline per
 * subpath). Supports all path commands in both absolute and relative forms.
 * Coordinates are returned in the path's own units, Y-DOWN (SVG convention —
 * which already matches our design space, so no flip is needed).
 */
export const parseSvgPath = (d: string): Polyline[] => {
  const contours: Polyline[] = [];
  let cur: Polyline = [];
  let pen: Pt = [0, 0];
  let start: Pt = [0, 0];
  // Reflection control points for S/T smooth commands.
  let lastCubicC2: Pt | null = null;
  let lastQuadC: Pt | null = null;

  // Split into command chunks: a letter followed by its argument text.
  const cmds = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) ?? [];

  const closeCur = () => {
    if (cur.length >= 2) contours.push(cur);
    cur = [];
  };

  for (const chunk of cmds) {
    const code = chunk[0];
    const nums = readNums(chunk.slice(1));
    const rel = code === code.toLowerCase();
    let i = 0;
    const cx = () => (rel ? pen[0] : 0);
    const cy = () => (rel ? pen[1] : 0);

    switch (code.toUpperCase()) {
      case "M": {
        // First pair = moveto (starts a subpath); extra pairs = implicit linetos.
        closeCur();
        const x = nums[i++] + cx();
        const y = nums[i++] + cy();
        pen = [x, y];
        start = [x, y];
        cur = [[x, y]];
        while (i + 1 < nums.length) {
          const lx = nums[i++] + (rel ? pen[0] : 0);
          const ly = nums[i++] + (rel ? pen[1] : 0);
          pen = [lx, ly];
          cur.push([lx, ly]);
        }
        lastCubicC2 = lastQuadC = null;
        break;
      }
      case "L":
        while (i + 1 < nums.length) {
          const x = nums[i++] + (rel ? pen[0] : 0);
          const y = nums[i++] + (rel ? pen[1] : 0);
          pen = [x, y];
          cur.push([x, y]);
        }
        lastCubicC2 = lastQuadC = null;
        break;
      case "H":
        while (i < nums.length) {
          const x = nums[i++] + (rel ? pen[0] : 0);
          pen = [x, pen[1]];
          cur.push([pen[0], pen[1]]);
        }
        lastCubicC2 = lastQuadC = null;
        break;
      case "V":
        while (i < nums.length) {
          const y = nums[i++] + (rel ? pen[1] : 0);
          pen = [pen[0], y];
          cur.push([pen[0], pen[1]]);
        }
        lastCubicC2 = lastQuadC = null;
        break;
      case "C":
        while (i + 5 < nums.length) {
          const c1: Pt = [nums[i++] + cx(), nums[i++] + cy()];
          const c2: Pt = [nums[i++] + cx(), nums[i++] + cy()];
          const p: Pt = [nums[i++] + cx(), nums[i++] + cy()];
          flattenCubic(pen, c1, c2, p, cur);
          pen = p;
          lastCubicC2 = c2;
        }
        lastQuadC = null;
        break;
      case "S":
        while (i + 3 < nums.length) {
          const c1: Pt = lastCubicC2
            ? [2 * pen[0] - lastCubicC2[0], 2 * pen[1] - lastCubicC2[1]]
            : [pen[0], pen[1]];
          const c2: Pt = [nums[i++] + cx(), nums[i++] + cy()];
          const p: Pt = [nums[i++] + cx(), nums[i++] + cy()];
          flattenCubic(pen, c1, c2, p, cur);
          pen = p;
          lastCubicC2 = c2;
        }
        lastQuadC = null;
        break;
      case "Q":
        while (i + 3 < nums.length) {
          const c: Pt = [nums[i++] + cx(), nums[i++] + cy()];
          const p: Pt = [nums[i++] + cx(), nums[i++] + cy()];
          flattenQuad(pen, c, p, cur);
          pen = p;
          lastQuadC = c;
        }
        lastCubicC2 = null;
        break;
      case "T":
        while (i + 1 < nums.length) {
          const c: Pt = lastQuadC
            ? [2 * pen[0] - lastQuadC[0], 2 * pen[1] - lastQuadC[1]]
            : [pen[0], pen[1]];
          const p: Pt = [nums[i++] + cx(), nums[i++] + cy()];
          flattenQuad(pen, c, p, cur);
          pen = p;
          lastQuadC = c;
        }
        lastCubicC2 = null;
        break;
      case "A":
        while (i + 6 < nums.length) {
          const rx = nums[i++], ry = nums[i++], rot = nums[i++];
          const large = nums[i++] !== 0, sweep = nums[i++] !== 0;
          const p: Pt = [nums[i++] + cx(), nums[i++] + cy()];
          flattenArc(pen, rx, ry, rot, large, sweep, p, cur);
          pen = p;
        }
        lastCubicC2 = lastQuadC = null;
        break;
      case "Z":
        // Close back to subpath start.
        if (cur.length) cur.push([start[0], start[1]]);
        pen = [start[0], start[1]];
        closeCur();
        lastCubicC2 = lastQuadC = null;
        break;
    }
  }
  closeCur();
  return contours;
};

/**
 * Pull glyph path strings out of whatever the user pasted. Accepts, in order:
 *   1. The unim Tampermonkey envelope: `{"unim":..., "glyphs":["M…","M…"]}`.
 *   2. Any SVG markup containing `<path d="…">` elements (one glyph per path).
 *   3. Raw path-data strings separated by newlines or `;`.
 * Returns [] if nothing path-like is found.
 */
export const parseUnimClipboard = (raw: string): string[] => {
  const text = raw.trim();
  if (!text) return [];

  // 1. JSON envelope.
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const obj = JSON.parse(text);
      const arr = Array.isArray(obj) ? obj : obj.glyphs;
      if (Array.isArray(arr)) {
        const out = arr
          .map((g) => (typeof g === "string" ? g : g?.path))
          .filter((s): s is string => typeof s === "string" && /[Mm]/.test(s));
        if (out.length) return out;
      }
    } catch {
      // fall through to the other forms
    }
  }

  // 2. SVG <path d="…"> elements.
  if (/<path[\s>]/i.test(text)) {
    const out: string[] = [];
    const re = /<path[^>]*\sd\s*=\s*"([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[1]);
    if (out.length) return out;
  }

  // 3. Raw path-data lines (split on newline or ';', keep ones starting with M).
  const lines = text
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => /^[Mm]/.test(s));
  return lines;
};

// ---------------------------------------------------------------------------
// Layout — common frame across all glyphs (mirrors tepraGif.placeFrames)
// ---------------------------------------------------------------------------

type PlacedGlyph = { rings: Ring[]; feedPos: number };
type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** Union bounding box of all glyphs' contours, in path units. */
const unionBox = (glyphContours: Polyline[][]): Box => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of glyphContours)
    for (const c of g)
      for (const [x, y] of c) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
};

/** Drop points collinear with their neighbours (after curve flattening). */
const simplifyRing = (ring: Ring, eps = 1e-4): Ring => {
  if (ring.length < 3) return ring;
  const out: Ring = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n];
    const c = ring[i];
    const q = ring[(i + 1) % n];
    const cross = (c[0] - p[0]) * (q[1] - p[1]) - (c[1] - p[1]) * (q[0] - p[0]);
    if (Math.abs(cross) > eps) out.push(c);
  }
  return out.length >= 3 ? out : ring;
};

/**
 * Fit each glyph's contours into a `sizeMm` square cell using the SHARED union
 * box (the common frame), so glyphs keep their relative size/position and the
 * empty margin around the content is removed — same approach as the GIF path.
 * Horizontal rotates the row 90° CW into the +Y feed axis.
 */
const placeGlyphs = (opts: TepraUnimOptions): PlacedGlyph[] => {
  const glyphContours = opts.glyphs.map((d) => parseSvgPath(d));
  const box = unionBox(glyphContours);
  const boxW = box.maxX - box.minX;
  const boxH = box.maxY - box.minY;
  const s = opts.sizeMm / Math.max(boxW, boxH || 1);
  const drawW = boxW * s;
  const drawH = boxH * s;
  const offX = (opts.sizeMm - drawW) / 2;
  const offY = (opts.sizeMm - drawH) / 2;

  const pitch = opts.sizeMm + opts.charSpacingMm;
  const rotCW = ([x, y]: Pt): Pt => [-y, x];
  const placed: PlacedGlyph[] = [];

  glyphContours.forEach((contours, i) => {
    if (contours.length === 0) return; // blank glyph still advances the tape
    const toCell = (px: number, py: number): Pt => [
      (px - box.minX) * s + offX,
      (py - box.minY) * s + offY,
    ];
    const base = i * pitch;
    const rings: Ring[] = contours.map((c) => {
      const mapped = c.map(([px, py]) => {
        const [mx, my] = toCell(px, py);
        return opts.orientation === "horizontal"
          ? rotCW([mx + base, my])
          : ([mx, my + base] as Pt);
      });
      return simplifyRing(mapped);
    });
    placed.push({ rings, feedPos: base });
  });

  placed.sort((a, b) => a.feedPos - b.feedPos); // nearest-first along feed axis
  return placed;
};

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

export function generateTepraUnim(opts: TepraUnimOptions): {
  doc: DxfDocument;
  fileName: string;
} {
  const placed = placeGlyphs(opts);
  const lineGap = Math.max(0.1, opts.lineGapMm);
  const passes = Math.max(1, Math.round(opts.outlinePasses));

  // Fill THEN outline per glyph, glyphs nearest-first — identical draw order to
  // the text/GIF generators so the plotter finishes one glyph before advancing.
  const shapes: PolyShape[] = [];
  for (const g of placed) {
    if (opts.fill) {
      for (const seg of fillRegion(g.rings, lineGap, opts.fillMode)) {
        shapes.push({ type: "poly", points: seg });
      }
    }
    for (const stroke of outlineStrokes(g.rings, lineGap, passes)) {
      shapes.push({ type: "poly", points: stroke });
    }
  }

  const dxfLayers: DxfLayer[] = [];
  if (shapes.length > 0) {
    dxfLayers.push({ name: "tepra-unim", color: "#d94a4a", shapes });
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of dxfLayers)
    for (const sh of l.shapes) {
      if (sh.type !== "poly") continue;
      for (const [x, y] of sh.points) {
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

  return { doc, fileName: `tepraunim.gen` };
}
