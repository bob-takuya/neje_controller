// DXF parsing wrapper. Uses `dxf-parser` (pure JS, no native deps).
//
// We preserve curve primitives (ARC, CIRCLE) as first-class `Shape`s rather
// than flattening everything to polylines up-front. This lets the G-code
// emitter use native G2/G3 circular interpolation — one GRBL block per curve
// instead of 60+ tiny linear segments that stall the planner.
//
// LWPOLYLINE / POLYLINE are kept as polylines; bulges are still flattened
// inline (treating each bulged segment as an arc-to-poly expansion), which
// matches the Python reference. A future pass can decompose bulged polylines
// into mixed line+arc shapes for the same optimization.

// dxf-parser ships CJS; import the default.
// @ts-ignore — the package doesn't ship types.
import DxfParserCtor from "dxf-parser";

export type Polyline = [number, number][];

export type ArcShape = {
  type: "arc";
  cx: number;
  cy: number;
  r: number;
  /** In degrees, standard math convention (CCW from east). */
  startDeg: number;
  endDeg: number;
  /**
   * Sweep direction in the shape's current coord frame. True = CCW (positive
   * angle direction). `flipY` flips this; placement→MCS also flips (because
   * it inverts Y), so the two typically cancel and a DXF CCW arc emits G3.
   */
  ccw: boolean;
};

export type CircleShape = {
  type: "circle";
  cx: number;
  cy: number;
  r: number;
  /** See ArcShape.ccw — kept for transform symmetry, G-code uses it to pick G2/G3. */
  ccw: boolean;
};

export type PolyShape = {
  type: "poly";
  points: Polyline;
};

export type Shape = PolyShape | ArcShape | CircleShape;

export type DxfLayer = {
  name: string;
  color: string; // CSS color derived from ACI if possible, else #888
  shapes: Shape[];
};

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type DxfDocument = {
  layers: DxfLayer[];
  bounds: Bounds;
};

// AutoCAD Color Index (ACI) → CSS hex. The standard AutoCAD palette is 256
// entries; 1–9 are the "standard" colors, 10–249 walk a hue/saturation/value
// grid, 250–255 are greys. This is the full palette used by AutoCAD/LibreCAD/
// QCAD so DXF imports preview in the colors the artist saw.
//
// ACI 7 in DXF spec is "displayed as black-on-light/white-on-dark". On our
// dark canvas we render it as a light grey so it's actually visible.
const ACI_TO_HEX: Record<number, string> = {
  0: "#000000", 1: "#ff0000", 2: "#ffff00", 3: "#00ff00", 4: "#00ffff",
  5: "#0000ff", 6: "#ff00ff", 7: "#cccccc", 8: "#414141", 9: "#808080",
  10: "#ff0000", 11: "#ffaaaa", 12: "#bd0000", 13: "#bd7e7e", 14: "#810000",
  15: "#815656", 16: "#680000", 17: "#684545", 18: "#4f0000", 19: "#4f3535",
  20: "#ff3f00", 21: "#ffbfaa", 22: "#bd2e00", 23: "#bd8d7e", 24: "#811f00",
  25: "#816056", 26: "#681900", 27: "#684e45", 28: "#4f1300", 29: "#4f3b35",
  30: "#ff7f00", 31: "#ffd4aa", 32: "#bd5e00", 33: "#bd9d7e", 34: "#814000",
  35: "#816b56", 36: "#683400", 37: "#685645", 38: "#4f2700", 39: "#4f4235",
  40: "#ffbf00", 41: "#ffeaaa", 42: "#bd8d00", 43: "#bdad7e", 44: "#816000",
  45: "#817656", 46: "#684e00", 47: "#685f45", 48: "#4f3b00", 49: "#4f4935",
  50: "#ffff00", 51: "#ffffaa", 52: "#bdbd00", 53: "#bdbd7e", 54: "#818100",
  55: "#818156", 56: "#686800", 57: "#686845", 58: "#4f4f00", 59: "#4f4f35",
  60: "#bfff00", 61: "#eaffaa", 62: "#8dbd00", 63: "#adbd7e", 64: "#608100",
  65: "#768156", 66: "#4e6800", 67: "#5f6845", 68: "#3b4f00", 69: "#494f35",
  70: "#7fff00", 71: "#d4ffaa", 72: "#5ebd00", 73: "#9dbd7e", 74: "#408100",
  75: "#6b8156", 76: "#346800", 77: "#566845", 78: "#274f00", 79: "#424f35",
  80: "#3fff00", 81: "#bfffaa", 82: "#2ebd00", 83: "#8dbd7e", 84: "#1f8100",
  85: "#608156", 86: "#196800", 87: "#4e6845", 88: "#134f00", 89: "#3b4f35",
  90: "#00ff00", 91: "#aaffaa", 92: "#00bd00", 93: "#7ebd7e", 94: "#008100",
  95: "#568156", 96: "#006800", 97: "#456845", 98: "#004f00", 99: "#354f35",
  100: "#00ff3f", 101: "#aaffbf", 102: "#00bd2e", 103: "#7ebd8d", 104: "#00811f",
  105: "#568160", 106: "#006819", 107: "#45684e", 108: "#004f13", 109: "#354f3b",
  110: "#00ff7f", 111: "#aaffd4", 112: "#00bd5e", 113: "#7ebd9d", 114: "#008140",
  115: "#56816b", 116: "#006834", 117: "#456856", 118: "#004f27", 119: "#354f42",
  120: "#00ffbf", 121: "#aaffea", 122: "#00bd8d", 123: "#7ebdad", 124: "#008160",
  125: "#568176", 126: "#00684e", 127: "#45685f", 128: "#004f3b", 129: "#354f49",
  130: "#00ffff", 131: "#aaffff", 132: "#00bdbd", 133: "#7ebdbd", 134: "#008181",
  135: "#568181", 136: "#006868", 137: "#456868", 138: "#004f4f", 139: "#354f4f",
  140: "#00bfff", 141: "#aaeaff", 142: "#008dbd", 143: "#7eadbd", 144: "#006081",
  145: "#567681", 146: "#004e68", 147: "#455f68", 148: "#003b4f", 149: "#35494f",
  150: "#007fff", 151: "#aad4ff", 152: "#005ebd", 153: "#7e9dbd", 154: "#004081",
  155: "#566b81", 156: "#003468", 157: "#455668", 158: "#00274f", 159: "#35424f",
  160: "#003fff", 161: "#aabfff", 162: "#002ebd", 163: "#7e8dbd", 164: "#001f81",
  165: "#566081", 166: "#001968", 167: "#454e68", 168: "#00134f", 169: "#353b4f",
  170: "#0000ff", 171: "#aaaaff", 172: "#0000bd", 173: "#7e7ebd", 174: "#000081",
  175: "#565681", 176: "#000068", 177: "#454568", 178: "#00004f", 179: "#35354f",
  180: "#3f00ff", 181: "#bfaaff", 182: "#2e00bd", 183: "#8d7ebd", 184: "#1f0081",
  185: "#605681", 186: "#190068", 187: "#4e4568", 188: "#13004f", 189: "#3b354f",
  190: "#7f00ff", 191: "#d4aaff", 192: "#5e00bd", 193: "#9d7ebd", 194: "#400081",
  195: "#6b5681", 196: "#340068", 197: "#564568", 198: "#27004f", 199: "#42354f",
  200: "#bf00ff", 201: "#eaaaff", 202: "#8d00bd", 203: "#ad7ebd", 204: "#600081",
  205: "#765681", 206: "#4e0068", 207: "#5f4568", 208: "#3b004f", 209: "#49354f",
  210: "#ff00ff", 211: "#ffaaff", 212: "#bd00bd", 213: "#bd7ebd", 214: "#810081",
  215: "#815681", 216: "#680068", 217: "#684568", 218: "#4f004f", 219: "#4f354f",
  220: "#ff00bf", 221: "#ffaaea", 222: "#bd008d", 223: "#bd7ead", 224: "#810060",
  225: "#815676", 226: "#68004e", 227: "#68455f", 228: "#4f003b", 229: "#4f3549",
  230: "#ff007f", 231: "#ffaad4", 232: "#bd005e", 233: "#bd7e9d", 234: "#810040",
  235: "#81566b", 236: "#680034", 237: "#684556", 238: "#4f0027", 239: "#4f3542",
  240: "#ff003f", 241: "#ffaabf", 242: "#bd002e", 243: "#bd7e8d", 244: "#81001f",
  245: "#815660", 246: "#680019", 247: "#68454e", 248: "#4f0013", 249: "#4f353b",
  250: "#333333", 251: "#505050", 252: "#696969", 253: "#828282", 254: "#bebebe",
  255: "#ffffff",
};

const aciToCss = (aci: number | undefined, fallback = "#cccccc") =>
  aci != null && ACI_TO_HEX[aci] ? ACI_TO_HEX[aci] : fallback;

// --- Geometric helpers (used for preview & bounds) ---

/**
 * Segments needed to flatten an arc/circle to a chord-tolerance `t` (mm).
 * The preview default (0.2mm, ≤96 steps) is invisible on a ~1500px canvas;
 * the laser path uses native G2/G3 and doesn't flatten. A machine WITHOUT
 * native arcs (the CAMEO cutter) needs a tighter tolerance + higher cap, hence
 * the parameters — pass e.g. `flatSteps(r, sweep, 0.05, 512)` for cut quality.
 */
const flatSteps = (r: number, sweepRad: number, tolerance = 0.2, maxSteps = 96) => {
  const dTheta = Math.sqrt((8 * tolerance) / Math.max(r, 0.1));
  const steps = Math.ceil(Math.abs(sweepRad) / dTheta);
  return Math.max(8, Math.min(maxSteps, steps));
};

/**
 * Flatten an arc. Respects the `ccw` direction flag: when false, we sweep from
 * start to end via DECREASING angle (CW). `tolerance`/`maxSteps` default to
 * preview grade; pass tighter values for an actual cut (no native arc).
 */
export const flattenArc = (a: ArcShape, tolerance = 0.2, maxSteps = 96): Polyline => {
  const a0 = (a.startDeg * Math.PI) / 180;
  const a1 = (a.endDeg * Math.PI) / 180;
  let sweep = a1 - a0;
  if (a.ccw) {
    // Want sweep > 0 (CCW advances angle forward). If end < start, wrap around.
    if (sweep <= 0) sweep += Math.PI * 2;
  } else {
    // Want sweep < 0 (CW decreases angle). If end > start, wrap backward.
    if (sweep >= 0) sweep -= Math.PI * 2;
  }
  const steps = flatSteps(a.r, sweep, tolerance, maxSteps);
  const pts: Polyline = [];
  for (let i = 0; i <= steps; i++) {
    const ang = a0 + (sweep * i) / steps;
    pts.push([a.cx + a.r * Math.cos(ang), a.cy + a.r * Math.sin(ang)]);
  }
  return pts;
};

export const flattenCircle = (c: CircleShape, tolerance = 0.2, maxSteps = 96): Polyline => {
  const steps = flatSteps(c.r, Math.PI * 2, tolerance, maxSteps);
  const pts: Polyline = [];
  for (let i = 0; i <= steps; i++) {
    const a = (Math.PI * 2 * i) / steps * (c.ccw ? 1 : -1);
    pts.push([c.cx + c.r * Math.cos(a), c.cy + c.r * Math.sin(a)]);
  }
  return pts;
};

/**
 * Flatten any shape to a polyline. Default tolerance is preview grade; pass a
 * tighter `tolerance` + higher `maxSteps` for machines without native arcs
 * (the CAMEO cutter) so curves aren't visibly faceted.
 */
export const flattenShape = (s: Shape, tolerance = 0.2, maxSteps = 96): Polyline => {
  switch (s.type) {
    case "poly":
      return s.points;
    case "arc":
      return flattenArc(s, tolerance, maxSteps);
    case "circle":
      return flattenCircle(s, tolerance, maxSteps);
  }
};

// --- Bulge → ArcShape (used by LWPOLYLINE/POLYLINE parse) ---

/**
 * Convert a DXF bulge segment into an ArcShape primitive so the G-code
 * emitter can output a single G2/G3 instead of dozens of G1 micro-segments.
 *
 * Positive bulge = arc bows to the left (CCW); negative = right (CW).
 * Returns null when the chord is degenerate (near-zero length).
 */
const bulgeToArc = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bulge: number,
): ArcShape | null => {
  const chord = Math.hypot(x1 - x0, y1 - y0);
  if (chord < 1e-9) return null; // degenerate — skip
  const theta = 4 * Math.atan(Math.abs(bulge));
  const r = chord / (2 * Math.sin(theta / 2));
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const perpLen = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const dx = (x1 - x0) / chord;
  const dy = (y1 - y0) / chord;
  const sign = bulge >= 0 ? 1 : -1;
  const cx = mx - sign * perpLen * dy;
  const cy = my + sign * perpLen * dx;
  const startDeg = Math.atan2(y0 - cy, x0 - cx) * (180 / Math.PI);
  const endDeg = Math.atan2(y1 - cy, x1 - cx) * (180 / Math.PI);
  const ccw = bulge > 0;
  return { type: "arc", cx, cy, r, startDeg, endDeg, ccw };
};

// --- B-spline (NURBS, non-rational) evaluation via de Boor ---
//
// DXF SPLINEs typically expose CONTROL points and a KNOT vector — the curve
// passes through the first/last control points only (with clamped knots) and
// merely *near* the interior ones. Treating control points as a polyline is
// what produced the "scattered dots" symptom on imports with many splines:
// the control polygon is a zigzag, not the smooth shape the artist drew.
//
// `evalSplinePoly` samples N points on the actual curve via de Boor, so the
// downstream emitter sees a real flattened curve.

const evalSplinePoly = (
  cps: [number, number][],
  knots: number[],
  degree: number,
  samples: number,
): Polyline => {
  const n = cps.length - 1;
  // Knot vector for a clamped non-periodic B-spline must have m+1 = n+p+2.
  if (cps.length < degree + 1 || knots.length < n + degree + 2) return cps;

  const tMin = knots[degree];
  const tMax = knots[n + 1];
  if (!(tMax > tMin)) return cps;

  // Largest k in [degree, n] such that knots[k] <= t < knots[k+1] (skips
  // empty intervals introduced by knot multiplicity).
  const findSpan = (t: number): number => {
    if (t >= knots[n + 1]) return n;
    let k = degree;
    while (k < n && t >= knots[k + 1]) k++;
    return k;
  };

  const evalAt = (t: number): [number, number] => {
    const k = findSpan(t);
    const d: [number, number][] = [];
    for (let j = 0; j <= degree; j++) {
      const cp = cps[k - degree + j];
      d.push([cp[0], cp[1]]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const denom = knots[i + degree - r + 1] - knots[i];
        const alpha = denom === 0 ? 0 : (t - knots[i]) / denom;
        d[j] = [
          (1 - alpha) * d[j - 1][0] + alpha * d[j][0],
          (1 - alpha) * d[j - 1][1] + alpha * d[j][1],
        ];
      }
    }
    return d[degree];
  };

  const poly: Polyline = [];
  for (let s = 0; s <= samples; s++) {
    const t = tMin + (tMax - tMin) * (s / samples);
    poly.push(evalAt(t));
  }
  return poly;
};

// --- Shape endpoint helpers (used by the stitch pass) ---

const arcPointAtDeg = (a: ArcShape, deg: number): [number, number] => {
  const r = (deg * Math.PI) / 180;
  return [a.cx + a.r * Math.cos(r), a.cy + a.r * Math.sin(r)];
};

/** First point of a shape, or null if the shape is closed (e.g. circle). */
const shapeStart = (s: Shape): [number, number] | null => {
  if (s.type === "poly") return s.points[0];
  if (s.type === "arc") return arcPointAtDeg(s, s.startDeg);
  return null;
};

/** Last point of a shape, or null if the shape is closed. */
const shapeEnd = (s: Shape): [number, number] | null => {
  if (s.type === "poly") return s.points[s.points.length - 1];
  if (s.type === "arc") return arcPointAtDeg(s, s.endDeg);
  return null;
};

/** Return a shape that traces the same path in reverse direction. */
const reverseShape = (s: Shape): Shape => {
  if (s.type === "poly") {
    return { type: "poly", points: s.points.slice().reverse() };
  }
  if (s.type === "arc") {
    return { ...s, startDeg: s.endDeg, endDeg: s.startDeg, ccw: !s.ccw };
  }
  return s; // circle: reversal has no meaningful effect
};

// --- Polyline → arc/line fitting (single-arc biarc-style approximation) ---
//
// Why this exists: Illustrator and Rhino emit curves as SPLINEs that we
// previously flattened into hundreds of micro-segments per curve. GRBL's
// planner only looks ~16 blocks ahead, so when each block is a 0.05 mm G1
// the planner runs out of distance to plan deceleration and the head crawls
// at fractions of mm/s. Empirically a 3300-SPLINE Rhino DXF emits ~300 000
// G-code blocks; with this pass it drops to ~6 600 — a 45× reduction.
//
// Algorithm:
//   For each polyline, greedily extend the longest prefix that can be fit
//   either by a straight line or by a single arc whose tangent matches the
//   incoming direction at P[start] and whose chord touches P[end], within a
//   given tolerance (max perpendicular deviation). When the prefix can no
//   longer be extended, emit that line/arc and restart from the endpoint.
//
//   We accept a fit as a "line" only when the chord deviation is below tol;
//   otherwise we try an arc. This is simpler than full biarc (one arc per
//   span) but captures the bulk of the savings because each prefix may span
//   many sample points.

const COLLINEAR_TOL_DEG = 0.5;

/**
 * Collapse consecutive segments whose direction differs by less than
 * `tolDeg`. Cheap preprocessing that removes the "many points on a straight
 * line" noise before we try arc fitting.
 */
const collinearMerge = (points: Polyline, tolDeg = COLLINEAR_TOL_DEG): Polyline => {
  if (points.length < 3) return points;
  const out: Polyline = [points[0]];
  let prevDir: number | null = null;
  const tolRad = (tolDeg * Math.PI) / 180;
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const dir = Math.atan2(dy, dx);
    if (prevDir !== null) {
      let diff = Math.abs(dir - prevDir);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < tolRad) {
        out[out.length - 1] = b;
        continue;
      }
    }
    out.push(b);
    prevDir = dir;
  }
  return out;
};

type FitResult =
  | { kind: "line"; end: number }
  | { kind: "arc"; end: number; cx: number; cy: number; r: number; ccw: boolean };

/**
 * Find the longest prefix of `pts[start..]` that fits either a straight line
 * or a single arc within `tol`. Returns the fit + the index of the last
 * point included.
 *
 * Arc fitting: given the tangent at P[start] (estimated from P[start]→
 * P[start+1]) and the chord P[start]→P[k], the circle is uniquely
 * determined: center lies along the perpendicular to the tangent at P[start]
 * at distance r = chord² / (2 · (chord · normal)).
 */
const fitArcOrLine = (
  pts: Polyline,
  start: number,
  tol: number,
): FitResult | null => {
  if (start + 1 >= pts.length) return null;
  const p0 = pts[start];

  const t0x = pts[start + 1][0] - p0[0];
  const t0y = pts[start + 1][1] - p0[1];
  const tlen = Math.hypot(t0x, t0y);
  if (tlen < 1e-9) return null;
  const tx = t0x / tlen;
  const ty = t0y / tlen;
  const nx = -ty;
  const ny = tx;

  let bestEnd = start + 1;
  let best: FitResult = { kind: "line", end: start + 1 };

  for (let k = start + 2; k < pts.length; k++) {
    const pk = pts[k];
    const chordDx = pk[0] - p0[0];
    const chordDy = pk[1] - p0[1];
    const chordLen = Math.hypot(chordDx, chordDy);
    if (chordLen < 1e-9) continue;

    // --- Line fit: max perpendicular deviation of interior points from
    //     the chord p0→pk. ---
    const lineNx = -chordDy / chordLen;
    const lineNy = chordDx / chordLen;
    let lineMaxDev = 0;
    for (let j = start + 1; j < k; j++) {
      const dx = pts[j][0] - p0[0];
      const dy = pts[j][1] - p0[1];
      const d = Math.abs(dx * lineNx + dy * lineNy);
      if (d > lineMaxDev) lineMaxDev = d;
    }
    if (lineMaxDev < tol) {
      bestEnd = k;
      best = { kind: "line", end: k };
      continue;
    }

    // --- Arc fit: circle through p0 tangent to (tx, ty), passing through pk. ---
    const dot = chordDx * nx + chordDy * ny;
    if (Math.abs(dot) < 1e-9) break; // tangent collinear with chord → only the
    // line fit applies, which we just rejected; can't extend.
    const r = (chordLen * chordLen) / (2 * dot);
    const absR = Math.abs(r);
    if (absR > 1e6 || absR < 1e-3) break;
    const cx = p0[0] + r * nx;
    const cy = p0[1] + r * ny;

    let arcMaxDev = 0;
    for (let j = start + 1; j <= k; j++) {
      const d = Math.abs(Math.hypot(pts[j][0] - cx, pts[j][1] - cy) - absR);
      if (d > arcMaxDev) arcMaxDev = d;
    }
    if (arcMaxDev < tol) {
      bestEnd = k;
      // r > 0 means the center is on the left of the tangent → CCW sweep.
      best = { kind: "arc", end: k, cx, cy, r: absR, ccw: r > 0 };
    } else {
      break;
    }
  }

  // Return null if nothing extended past the immediate next point — caller
  // will fall back to emitting one raw segment.
  if (bestEnd === start + 1 && best.kind === "line") {
    return { kind: "line", end: start + 1 };
  }
  return best;
};

/**
 * Fit one polyline into a sequence of line + arc shapes.
 * `tol` is the maximum perpendicular deviation (mm) allowed.
 */
const fitPolyToShapes = (pts: Polyline, tol = 0.05): Shape[] => {
  if (pts.length < 2) return [];
  const merged = collinearMerge(pts);
  if (merged.length < 3) {
    return [{ type: "poly", points: merged }];
  }

  const out: Shape[] = [];
  let lineRun: Polyline = [merged[0]];
  let i = 0;
  while (i < merged.length - 1) {
    const fit = fitArcOrLine(merged, i, tol);
    if (!fit) {
      lineRun.push(merged[i + 1]);
      i++;
      continue;
    }
    if (fit.kind === "line") {
      lineRun.push(merged[fit.end]);
    } else {
      // Flush any accumulated line run.
      if (lineRun.length >= 2) out.push({ type: "poly", points: lineRun });
      // Convert arc to ArcShape. Angles are in degrees, CCW from +X.
      const p0 = merged[i];
      const p1 = merged[fit.end];
      const startDeg = Math.atan2(p0[1] - fit.cy, p0[0] - fit.cx) * (180 / Math.PI);
      const endDeg = Math.atan2(p1[1] - fit.cy, p1[0] - fit.cx) * (180 / Math.PI);
      out.push({
        type: "arc",
        cx: fit.cx,
        cy: fit.cy,
        r: fit.r,
        startDeg,
        endDeg,
        ccw: fit.ccw,
      });
      lineRun = [merged[fit.end]];
    }
    i = fit.end;
  }
  if (lineRun.length >= 2) out.push({ type: "poly", points: lineRun });
  return out;
};

/**
 * Walk every shape in a layer and apply the fit to any `poly` shape with
 * enough points to benefit. LINE/CIRCLE/ARC are passed through untouched —
 * those are already optimal for G2/G3 emission.
 */
const fitLayerShapes = (shapes: Shape[], tol = 0.05): Shape[] => {
  const out: Shape[] = [];
  for (const s of shapes) {
    if (s.type !== "poly" || s.points.length < 8) {
      out.push(s);
      continue;
    }
    const fitted = fitPolyToShapes(s.points, tol);
    if (fitted.length > 0) out.push(...fitted);
    else out.push(s);
  }
  return out;
};

// --- Stitch pass: chain shapes whose endpoints match ---

/**
 * Reorder shapes within a layer so consecutive shapes share an endpoint
 * wherever possible, reversing individual shapes when needed. Consecutive
 * polylines that chain are merged into a single PolyShape.
 *
 * Why: the G-code emitter avoids the M5/G0/M3 cycle when the next shape
 * starts at the previous shape's end. A DXF can contain dozens of LINE
 * entities forming one logical path; without stitching, each LINE is
 * emitted with a redundant rapid + laser-toggle in between.
 *
 * Closed shapes (circles, fully-closed polylines/arcs) are kept as-is and
 * appended after the open chains.
 */
const stitchShapes = (shapes: Shape[], tol = 0.01): Shape[] => {
  if (shapes.length < 2) return shapes;

  const same = (a: [number, number], b: [number, number]) =>
    Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;

  const open: Shape[] = [];
  const closed: Shape[] = [];
  for (const s of shapes) {
    if (s.type === "circle") { closed.push(s); continue; }
    const a = shapeStart(s);
    const b = shapeEnd(s);
    if (a && b && same(a, b)) closed.push(s);
    else open.push(s);
  }

  // Greedy chain extension on open shapes.
  //
  // The naive form scans all `open` shapes for every chain step — O(N²), which
  // melts on large DXFs (a 114k-POLYLINE + 58k-LINE file has ~170k open shapes
  // in one layer → ~10^10 comparisons, minutes of frozen UI). Instead we index
  // every endpoint into a spatial hash (point quantized to a `tol` grid → list
  // of open-shape indices) and only probe the 3×3 cells around the current
  // chain end. Average O(1) per lookup → O(N) overall.
  //
  // Output is identical to the naive scan: among candidates we always pick the
  // SMALLEST unused index, and for a given shape a start-point match is
  // preferred over an end-point match — exactly the old loop's `break` order.
  const used = new Array(open.length).fill(false);
  const ordered: Shape[] = [];

  // Quantize to integer grid cells of size `tol`. Two points within `tol` may
  // land in the same OR an adjacent cell, so lookups must scan the 3×3
  // neighbourhood — that's what makes the grid match the `same()` tolerance.
  const cellKey = (cx: number, cy: number) => cx + "," + cy;
  const cellOf = (p: [number, number]): [number, number] => [
    Math.floor(p[0] / tol),
    Math.floor(p[1] / tol),
  ];

  // startIndex / endIndex: grid cell → ascending list of open indices whose
  // start (resp. end) point falls in that cell. Built in index order, so each
  // bucket is already sorted ascending.
  const startIndex = new Map<string, number[]>();
  const endIndex = new Map<string, number[]>();
  const addTo = (map: Map<string, number[]>, p: [number, number] | null, j: number) => {
    if (!p) return;
    const [cx, cy] = cellOf(p);
    const k = cellKey(cx, cy);
    const bucket = map.get(k);
    if (bucket) bucket.push(j);
    else map.set(k, [j]);
  };
  for (let j = 0; j < open.length; j++) {
    addTo(startIndex, shapeStart(open[j]), j);
    addTo(endIndex, shapeEnd(open[j]), j);
  }

  // Smallest unused index in `map` near `pt` whose registered point actually
  // satisfies `same()` (the 3×3 scan over-approximates; verify each hit). The
  // `pick` accessor returns the candidate's relevant endpoint for the exact
  // distance check.
  const findNearest = (
    map: Map<string, number[]>,
    pt: [number, number],
    pick: (j: number) => [number, number] | null,
  ): number => {
    const [bx, by] = cellOf(pt);
    let best = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = map.get(cellKey(bx + dx, by + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (used[j]) continue;
          if (best !== -1 && j >= best) continue; // can't beat current best
          const q = pick(j);
          if (q && same(pt, q)) best = j;
        }
      }
    }
    return best;
  };

  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    ordered.push(open[i]);
    let curEnd = shapeEnd(open[i]);

    while (curEnd) {
      // Start-match is preferred over end-match for the SAME shape, matching
      // the old loop. Across shapes, the smaller index always wins — so a
      // start-hit only beats an end-hit when its index is ≤ the end-hit's.
      const startHit = findNearest(startIndex, curEnd, (j) => shapeStart(open[j]));
      const endHit = findNearest(endIndex, curEnd, (j) => shapeEnd(open[j]));

      let next = -1;
      let reverse = false;
      if (startHit !== -1 && (endHit === -1 || startHit <= endHit)) {
        next = startHit;
        reverse = false;
      } else if (endHit !== -1) {
        next = endHit;
        reverse = true;
      }
      if (next < 0) break;
      used[next] = true;
      const piece = reverse ? reverseShape(open[next]) : open[next];
      ordered.push(piece);
      curEnd = shapeEnd(piece);
    }
  }

  // Coalesce consecutive PolyShapes whose endpoints meet — saves one shape
  // boundary (and the M5/M3 toggle the emitter would otherwise emit even
  // for chained shapes if the chained-detection ever drifts).
  const merged: Shape[] = [];
  for (const s of ordered) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (prev && prev.type === "poly" && s.type === "poly") {
      const tail = prev.points[prev.points.length - 1];
      const head = s.points[0];
      if (same(tail, head)) {
        merged[merged.length - 1] = {
          type: "poly",
          points: [...prev.points, ...s.points.slice(1)],
        };
        continue;
      }
    }
    merged.push(s);
  }

  return [...merged, ...closed];
};

// --- Bounds helpers ---

const angleInSweep = (angleDeg: number, startDeg: number, endDeg: number, ccw: boolean): boolean => {
  // Normalize to [0, 360).
  const norm = (d: number) => ((d % 360) + 360) % 360;
  const a = norm(angleDeg);
  const s = norm(startDeg);
  const e = norm(endDeg);
  if (ccw) {
    // CCW from s to e: a is in-sweep iff (a - s) mod 360 <= (e - s) mod 360.
    const delta = (a - s + 360) % 360;
    const sweep = (e - s + 360) % 360 || 360;
    return delta <= sweep + 1e-9;
  } else {
    // CW from s to e: a is in-sweep iff (s - a) mod 360 <= (s - e) mod 360.
    const delta = (s - a + 360) % 360;
    const sweep = (s - e + 360) % 360 || 360;
    return delta <= sweep + 1e-9;
  }
};

export const shapeBounds = (s: Shape): Bounds => {
  if (s.type === "poly") {
    let minX = +Infinity, minY = +Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of s.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }
  if (s.type === "circle") {
    return {
      minX: s.cx - s.r,
      minY: s.cy - s.r,
      maxX: s.cx + s.r,
      maxY: s.cy + s.r,
    };
  }
  // arc: endpoints plus axis extrema (0/90/180/270) if they fall in the sweep.
  const s0 = (s.startDeg * Math.PI) / 180;
  const s1 = (s.endDeg * Math.PI) / 180;
  const p0: [number, number] = [s.cx + s.r * Math.cos(s0), s.cy + s.r * Math.sin(s0)];
  const p1: [number, number] = [s.cx + s.r * Math.cos(s1), s.cy + s.r * Math.sin(s1)];
  let minX = Math.min(p0[0], p1[0]);
  let maxX = Math.max(p0[0], p1[0]);
  let minY = Math.min(p0[1], p1[1]);
  let maxY = Math.max(p0[1], p1[1]);
  for (const axisDeg of [0, 90, 180, 270]) {
    if (angleInSweep(axisDeg, s.startDeg, s.endDeg, s.ccw)) {
      const a = (axisDeg * Math.PI) / 180;
      const px = s.cx + s.r * Math.cos(a);
      const py = s.cy + s.r * Math.sin(a);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  return { minX, minY, maxX, maxY };
};

// --- OCS → WCS handling ---
//
// Several DXF entity types (ARC, CIRCLE, ELLIPSE, LWPOLYLINE, POLYLINE,
// TEXT, HATCH, ...) store coordinates in their own Object Coordinate System
// rather than World Coordinate System. The OCS Z-axis is the entity's
// "extrusion direction" (group codes 210/220/230); when that vector is the
// default (0, 0, 1), OCS == WCS and no transform is needed.
//
// AutoCAD frequently emits planar 2D entities with extrusion = (0, 0, -1)
// (e.g. when the source drawing was mirrored or the workplane was flipped).
// Per the Arbitrary Axis Algorithm this maps OCS (x, y) → WCS (-x, y) and
// reverses the apparent rotational sense.
//
// We handle the (0, 0, ±1) cases explicitly — the only ones that show up in
// laser/2D-CAM DXFs in practice. A non-axis-aligned extrusion would need
// the full AAA matrix; we leave a TODO and treat it as identity.
//
// dxf-parser exposes extrusion in TWO incompatible shapes depending on
// which entity handler emitted it:
//   - ARC, LWPOLYLINE, ATTDEF: three scalar fields
//       extrusionDirectionX/Y/Z
//   - LINE, POLYLINE, INSERT, POINT, SOLID: one IPoint object
//       extrusionDirection: { x, y, z }
//   - CIRCLE: not captured at all (a known dxf-parser gap).
const isFlippedExtrusion = (e: any): boolean => {
  let x: number | undefined;
  let y: number | undefined;
  let z: number | undefined;
  if (e.extrusionDirection) {
    x = e.extrusionDirection.x;
    y = e.extrusionDirection.y;
    z = e.extrusionDirection.z;
  } else if (
    e.extrusionDirectionX != null ||
    e.extrusionDirectionY != null ||
    e.extrusionDirectionZ != null
  ) {
    x = e.extrusionDirectionX;
    y = e.extrusionDirectionY;
    z = e.extrusionDirectionZ;
  } else {
    return false;
  }
  if (z == null) return false;
  return z < 0 && Math.abs(x ?? 0) < 1e-6 && Math.abs(y ?? 0) < 1e-6;
};

// --- Main entry ---

export type ParseOptions = {
  /**
   * When true, skip the biarc fit pass that converts dense polylines into
   * line+arc shapes. Useful as an escape hatch when the fitter mis-renders
   * particular geometry: every arc/circle from the source DXF is preserved,
   * but SPLINEs / LWPOLYLINEs that we'd normally compress stay as raw
   * polylines. Combined with the Job-panel "Disable biarc fit" toggle this
   * gives a pure-G1 pipeline with no fitter artefacts in the chain.
   */
  disableBiarc?: boolean;
};

/**
 * Coarse phases of a DXF load, in the order they happen. The UI maps these to
 * a progress label; `ratio` (0..1) is the fraction complete within the phase.
 */
export type ParsePhase =
  | "parsing" // dxf-parser tokenizing the file (one opaque blocking step)
  | "entities" // walking entities → shapes
  | "fitting" // biarc fit pass, per layer
  | "stitching" // endpoint-chaining pass, per layer
  | "bounds"; // final bounds + layer assembly

export type ParseProgress = { phase: ParsePhase; ratio: number };

/**
 * Async-yielding variant of {@link parseDxf}. Reports coarse progress through
 * `onProgress` and `await`s a macrotask between phases (and periodically
 * inside the long entity loop) so the React UI can repaint a progress bar —
 * the synchronous `parseDxf` would otherwise freeze the renderer for the whole
 * parse on large files. The geometry it produces is identical to `parseDxf`.
 */
export async function parseDxfAsync(
  text: string,
  opts: ParseOptions = {},
  onProgress?: (p: ParseProgress) => void,
): Promise<DxfDocument> {
  // Lets the browser paint between phases. `setTimeout(0)` (a macrotask) is
  // used rather than a microtask because microtasks run before paint.
  const yieldToUi = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 0));
  const report = (phase: ParsePhase, ratio: number) =>
    onProgress?.({ phase, ratio });

  report("parsing", 0);
  await yieldToUi();
  const parser = new DxfParserCtor();
  const doc = parser.parseSync(text);
  report("parsing", 1);

  const { byLayer, layerMeta } = collectLayerMeta(doc);
  const entities: any[] = doc.entities ?? [];
  const push = makePush(byLayer);

  // Walk entities in chunks, yielding to the UI between chunks so the bar
  // animates. ENTITY_CHUNK is large enough that the per-chunk yield overhead
  // (one macrotask ≈ a few ms) stays negligible next to the parse itself.
  const ENTITY_CHUNK = 2000;
  report("entities", 0);
  for (let i = 0; i < entities.length; i++) {
    entityToShapes(entities[i], push);
    if ((i + 1) % ENTITY_CHUNK === 0) {
      report("entities", (i + 1) / entities.length);
      await yieldToUi();
    }
  }
  report("entities", 1);

  const layerNames = Object.keys(byLayer);

  if (!opts.disableBiarc) {
    report("fitting", 0);
    for (let i = 0; i < layerNames.length; i++) {
      byLayer[layerNames[i]] = fitLayerShapes(byLayer[layerNames[i]]);
      report("fitting", (i + 1) / layerNames.length);
      await yieldToUi();
    }
  }

  report("stitching", 0);
  for (let i = 0; i < layerNames.length; i++) {
    byLayer[layerNames[i]] = stitchShapes(byLayer[layerNames[i]]);
    report("stitching", (i + 1) / layerNames.length);
    await yieldToUi();
  }

  report("bounds", 0);
  await yieldToUi();
  const result = assembleDocument(byLayer, layerMeta);
  report("bounds", 1);
  return result;
}

export function parseDxf(text: string, opts: ParseOptions = {}): DxfDocument {
  const parser = new DxfParserCtor();
  const doc = parser.parseSync(text);

  const { byLayer, layerMeta } = collectLayerMeta(doc);
  const push = makePush(byLayer);
  for (const e of doc.entities ?? []) entityToShapes(e, push);

  if (!opts.disableBiarc) {
    for (const name of Object.keys(byLayer)) {
      byLayer[name] = fitLayerShapes(byLayer[name]);
    }
  }
  for (const name of Object.keys(byLayer)) {
    byLayer[name] = stitchShapes(byLayer[name]);
  }
  return assembleDocument(byLayer, layerMeta);
}

const makePush = (byLayer: Record<string, Shape[]>) => (layer: string, shape: Shape) => {
  if (!byLayer[layer]) byLayer[layer] = [];
  byLayer[layer].push(shape);
};

/**
 * Read the layer table (for ACI colors) and emit the diagnostic per-entity
 * counts. Shared by the sync and async parse paths.
 */
function collectLayerMeta(doc: any): {
  byLayer: Record<string, Shape[]>;
  layerMeta: Record<string, { color?: number }>;
} {
  const layerMeta: Record<string, { color?: number }> = {};
  if (doc?.tables?.layer?.layers) {
    for (const [name, info] of Object.entries<any>(doc.tables.layer.layers)) {
      layerMeta[name] = { color: info.color };
    }
  }

  // Diagnostic: per-entity-type counts and OCS flip detection.
  // Helps catch dxf-parser quirks (e.g. extrusionDirection vs
  // extrusionDirectionX/Y/Z) and verifies the OCS-flip path actually
  // fires for entities that need it.
  const debugCounts: Record<string, { total: number; flipped: number }> = {};
  for (const e of doc.entities ?? []) {
    const t = e.type ?? "?";
    if (!debugCounts[t]) debugCounts[t] = { total: 0, flipped: 0 };
    debugCounts[t].total++;
    if (isFlippedExtrusion(e)) debugCounts[t].flipped++;
  }
  // eslint-disable-next-line no-console
  console.log("[parseDxf] entity counts (total / OCS-flipped):", debugCounts);

  return { byLayer: {}, layerMeta };
}

/** Finalize bounds + layer ordering. Shared by the sync and async paths. */
function assembleDocument(
  byLayer: Record<string, Shape[]>,
  layerMeta: Record<string, { color?: number }>,
): DxfDocument {
  let minX = +Infinity, minY = +Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const shapes of Object.values(byLayer)) {
    for (const s of shapes) {
      const b = shapeBounds(s);
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
  }
  if (!isFinite(minX)) {
    minX = 0; minY = 0; maxX = 0; maxY = 0;
  }

  const layers: DxfLayer[] = Object.entries(byLayer)
    .map(([name, shapes]) => ({
      name,
      color: aciToCss(layerMeta[name]?.color),
      shapes,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { layers, bounds: { minX, minY, maxX, maxY } };
}

/**
 * Convert one DXF entity into zero or more Shapes, appending them via `push`.
 * Pure and synchronous — both `parseDxf` (sync) and `parseDxfAsync` (chunked,
 * progress-reporting) drive this so the produced geometry is identical.
 */
function entityToShapes(e: any, push: (layer: string, shape: Shape) => void): void {
  {
    const layer = e.layer ?? "0";
    switch (e.type) {
      case "LINE": {
        push(layer, {
          type: "poly",
          points: [
            [e.vertices[0].x, e.vertices[0].y],
            [e.vertices[1].x, e.vertices[1].y],
          ],
        });
        break;
      }

      case "LWPOLYLINE":
      case "POLYLINE": {
        const rawVerts: any[] = e.vertices ?? [];
        if (rawVerts.length === 0) break;

        // OCS → WCS for polylines with flipped extrusion: negate vertex X
        // and bulge sign (bulge is CCW-positive in OCS, becomes CW under
        // the X mirror).
        const flipped = isFlippedExtrusion(e);
        const verts = flipped
          ? rawVerts.map((v) => ({
              ...v,
              x: -v.x,
              bulge: v.bulge != null ? -v.bulge : v.bulge,
            }))
          : rawVerts;

        // Split into straight poly segments + arc primitives so the G-code
        // emitter can use native G2/G3 for curved (bulge) sections instead of
        // emitting dozens of tiny G1 moves that stall the GRBL planner.
        let polyAcc: Polyline = [[verts[0].x, verts[0].y]];

        const flushPoly = () => {
          if (polyAcc.length >= 2) {
            push(layer, { type: "poly", points: polyAcc });
          }
          polyAcc = [];
        };

        const processSegment = (prev: any, cur: any) => {
          const bulge = prev.bulge ?? 0;
          if (bulge !== 0) {
            const arc = bulgeToArc(prev.x, prev.y, cur.x, cur.y, bulge);
            if (arc) {
              flushPoly();
              push(layer, arc);
              polyAcc = [[cur.x, cur.y]]; // restart poly from arc endpoint
            } else {
              // Degenerate bulge — treat as straight segment
              polyAcc.push([cur.x, cur.y]);
            }
          } else {
            polyAcc.push([cur.x, cur.y]);
          }
        };

        for (let i = 1; i < verts.length; i++) {
          processSegment(verts[i - 1], verts[i]);
        }

        if (e.shape || (e as any).closed) {
          processSegment(verts[verts.length - 1], verts[0]);
        }

        flushPoly();
        break;
      }

      case "CIRCLE": {
        const flipped = isFlippedExtrusion(e);
        push(layer, {
          type: "circle",
          cx: flipped ? -e.center.x : e.center.x,
          cy: e.center.y,
          r: e.radius,
          // OCS-CCW becomes WCS-CW under the X-flip.
          ccw: !flipped,
        });
        break;
      }

      case "ARC": {
        const flipped = isFlippedExtrusion(e);
        // dxf-parser stores ARC startAngle/endAngle in *radians* (it
        // already converts the DXF degree value at parse time). Convert
        // back to degrees for our ArcShape, which uses degrees throughout.
        const startDegOcs = (e.startAngle * 180) / Math.PI;
        const endDegOcs = (e.endAngle * 180) / Math.PI;
        // After flipping X, WCS angle = 180° − OCS angle, and the
        // rotational sense flips too.
        const cx = flipped ? -e.center.x : e.center.x;
        const startDeg = flipped ? 180 - startDegOcs : startDegOcs;
        const endDeg = flipped ? 180 - endDegOcs : endDegOcs;
        const ccw = !flipped;
        push(layer, {
          type: "arc",
          cx,
          cy: e.center.y,
          r: e.radius,
          startDeg,
          endDeg,
          ccw,
        });
        break;
      }

      case "ELLIPSE": {
        // Ellipses don't map to G2/G3 directly (needs G-code ellipse or
        // polyline approx). Flatten to poly; good enough for most engrave jobs.
        const steps = 96;
        const cx = e.center.x;
        const cy = e.center.y;
        const ax = e.majorAxisEndPoint.x;
        const ay = e.majorAxisEndPoint.y;
        const ratio = e.axisRatio ?? 1;
        const a0 = e.startAngle ?? 0;
        const a1 = e.endAngle ?? Math.PI * 2;
        let sweep = a1 - a0;
        if (sweep <= 0) sweep += Math.PI * 2;
        const rot = Math.atan2(ay, ax);
        const rMaj = Math.hypot(ax, ay);
        const rMin = rMaj * ratio;
        const poly: Polyline = [];
        for (let i = 0; i <= steps; i++) {
          const t = a0 + (sweep * i) / steps;
          const x = rMaj * Math.cos(t);
          const y = rMin * Math.sin(t);
          const rx = x * Math.cos(rot) - y * Math.sin(rot) + cx;
          const ry = x * Math.sin(rot) + y * Math.cos(rot) + cy;
          poly.push([rx, ry]);
        }
        push(layer, { type: "poly", points: poly });
        break;
      }

      case "SPLINE": {
        const cps: [number, number][] = (e.controlPoints ?? []).map(
          (p: any) => [p.x, p.y] as [number, number],
        );
        const fitPts: [number, number][] = (e.fitPoints ?? []).map(
          (p: any) => [p.x, p.y] as [number, number],
        );
        const knots: number[] = e.knotValues ?? (e as any).knots ?? [];
        const degree: number = e.degreeOfSplineCurve ?? 3;

        let poly: Polyline;
        if (fitPts.length >= 2) {
          // Fit points lie ON the curve — use directly.
          poly = fitPts;
        } else if (cps.length >= degree + 1 && knots.length >= cps.length + degree + 1) {
          // Sample the actual B-spline through the control points.
          const segs = cps.length - degree;
          poly = evalSplinePoly(cps, knots, degree, Math.max(32, segs * 16));
        } else if (cps.length >= 2) {
          // Last-resort fallback (shouldn't normally hit this).
          poly = cps;
        } else {
          break;
        }

        if (poly.length >= 2) push(layer, { type: "poly", points: poly });
        break;
      }

      default:
        break;
    }
  }
}

// NOTE on the biarc/stitch/bounds passes: they previously lived inline here.
// They now run in `parseDxf` (sync) and `parseDxfAsync` (chunked), each
// reusing `fitLayerShapes` / `stitchShapes` / `assembleDocument` so the two
// paths produce identical documents. See those two functions above.

// --- Transforms ---

const translateShape = (s: Shape, dx: number, dy: number): Shape => {
  switch (s.type) {
    case "poly":
      return {
        type: "poly",
        points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
      };
    case "arc":
      return { ...s, cx: s.cx + dx, cy: s.cy + dy };
    case "circle":
      return { ...s, cx: s.cx + dx, cy: s.cy + dy };
  }
};

const flipShape = (s: Shape): Shape => {
  switch (s.type) {
    case "poly":
      return {
        type: "poly",
        points: s.points.map(([x, y]) => [x, -y] as [number, number]),
      };
    case "arc":
      // y → -y mirrors the arc across the X axis. The sweep direction reverses
      // (CCW becomes CW when viewed in the flipped frame) and each angle is
      // negated. Mathematically: (cx + r·cos(a), -cy - r·sin(a)) equals
      // (cx + r·cos(-a), (-cy) + r·sin(-a)), so center=(cx, -cy), angles
      // negate, and `ccw` inverts.
      return {
        ...s,
        cy: -s.cy,
        startDeg: -s.startDeg,
        endDeg: -s.endDeg,
        ccw: !s.ccw,
      };
    case "circle":
      return { ...s, cy: -s.cy, ccw: !s.ccw };
  }
};

const rebound = (layers: DxfLayer[]): Bounds => {
  let minX = +Infinity, minY = +Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of layers) {
    for (const s of l.shapes) {
      const b = shapeBounds(s);
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
  return { minX, minY, maxX, maxY };
};

/** Translate every shape by (dx, dy). Returns a new doc. */
export function translateDoc(doc: DxfDocument, dx: number, dy: number): DxfDocument {
  const layers = doc.layers.map((l) => ({
    ...l,
    shapes: l.shapes.map((s) => translateShape(s, dx, dy)),
  }));
  return { layers, bounds: rebound(layers) };
}

/** Flip all shapes across the X axis (y → -y). */
export function flipY(doc: DxfDocument): DxfDocument {
  const layers = doc.layers.map((l) => ({
    ...l,
    shapes: l.shapes.map(flipShape),
  }));
  return { layers, bounds: rebound(layers) };
}
