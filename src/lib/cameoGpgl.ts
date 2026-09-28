// GPGL path generator for the Silhouette CAMEO 5 — the cutting-plotter analog
// of gcode.ts. It consumes the SAME parsed DXF vector model that the laser path
// uses (dxf.ts `Shape[]`), so a design loaded once can be sent to either
// machine. There is no G-code in between: shapes are linearized and emitted as
// GPGL `M` (pen-up move) / `D` (pen-down cut) commands.
//
// Coordinate model (verified against inkscape-silhouette Graphtec.py):
//   - 1 mm == 20 Silhouette Units (SU). su = round(mm * 20).
//   - Commands are **y-first**: "M<y_su>,<x_su>" and "D<y_su>,<x_su>,...".
//   - The CAMEO's own origin sits at the top-left of the media. We map design
//     space (Y-down, as dxf.ts produces) into CAMEO space via the placement +
//     the machine's left margin.
//
// Commands are returned as an array of bare GPGL strings (no ETX); the Rust
// worker appends the 0x03 terminator and bulk-writes them.

import {
  DxfDocument,
  Shape,
  flattenShape,
} from "./dxf";
import { Placement } from "./gcode";

/** mm → Silhouette Units (integer). */
export const SU_PER_MM = 20;
export const mmToSu = (mm: number): number => Math.round(mm * SU_PER_MM);

/** Fixed cutting area for the plain CAMEO 5 (driver values). */
export const CAMEO5_AREA = {
  /** Usable width in mm (≈13", per inkscape-silhouette device table). */
  width: 330.2,
  /** Left margin offset in mm (negative: tooling travels past nominal edge). */
  marginLeft: -6.0,
  /** Max media length in mm (full roll — the cut boundary `Z` may use this). */
  length: 3000,
  /**
   * Default DISPLAY work area: the standard 12"×24" cutting mat. The full 3 m
   * length is a thin sliver on screen (9:1), so the preview uses this mat size
   * for a sane aspect ratio. Cuts longer than the mat are still allowed.
   */
  matWidth: 305,
  matHeight: 610,
};

export type CameoLayerParams = {
  name: string;
  enabled: boolean;
  /** Tool holder: 1 (left, AutoBlade 300gf) or 2 (right, 5kgf rotary). */
  tool: 1 | 2;
  /** Speed 1..10 (10 = fastest). */
  speed: number;
  /** Downforce 1..33. */
  force: number;
  /** AutoBlade depth 0..10 (tool 1 only). */
  depth: number;
  /** Number of cut passes. */
  passes: number;
  /** Whether the tool is an AutoBlade (enables the TF depth command). */
  autoBlade: boolean;
  /** Display color override; falls back to the DXF layer color. */
  color?: string;
};

/** Machine setup sent once before the job (matches Rust `CameoSetup`). */
export type CameoSetup = {
  tool: number;
  speed: number;
  force: number;
  depth: number;
  auto_blade: boolean;
  blade_offset_mm: number;
  accel: number;
  mat: number;
  track_enhancing: boolean;
  /** Cutting-area width in mm (X) — for the lower-right `Z` boundary. */
  area_w_mm: number;
  /** Cutting-area height in mm (Y) — for the boundary. */
  area_h_mm: number;
};

export type CameoJobParams = {
  layers: CameoLayerParams[];
  /** MCS/device location of the design's (0,0) corner, in mm. */
  placement: Placement;
  /** Global blade offset in mm (0 for pen, ~0.9 for blade). */
  bladeOffsetMm: number;
  /** Acceleration 1..3. */
  accel: number;
  /** Cutting-mat preset (TG): 0=none,1=12x12,2=12x24,9=24x24. */
  mat: number;
  /** Track-enhancing media pre-roll. */
  trackEnhancing: boolean;
  /** Return head to origin at the end. */
  returnHome: boolean;
};

/** Below this, adjacent points collapse (2× CAMEO step ≈ 0.1 mm). */
const MIN_SEG_MM = 0.05;

/**
 * Chord tolerance + step cap used to flatten arcs/circles for an ACTUAL CUT.
 * The shared preview flattener defaults to 0.2 mm / 96 steps (fine on a screen),
 * which leaves visibly faceted ("gatagata") curves on the cutter — the CAMEO
 * has no native arc the way GRBL uses G2/G3. 0.05 mm with a high cap gives
 * smooth curves at the blade's own resolution.
 */
const CUT_TOL_MM = 0.05;
const CUT_MAX_STEPS = 512;

/**
 * Two endpoints within this are treated as the same point, so a shape that
 * starts where the previous one ended does NOT lift the pen — we skip the `M`
 * and keep cutting (GPGL only lifts on `M`). Mirrors gcode.ts CHAIN_TOL_MM.
 */
const CHAIN_TOL_MM = 0.1;
const almostSame = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) < CHAIN_TOL_MM && Math.abs(a[1] - b[1]) < CHAIN_TOL_MM;

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/**
 * Map a design-space point to CAMEO device coordinates, returning the GPGL
 * pair string "<y_su>,<x_su>" — Y-FIRST, matching Graphtec.py's
 * `move_mm_cmd(self, mmy, mmx)`. HARDWARE-VERIFIED on a CAMEO 5 (an L-shape cut
 * upright + correctly positioned with exactly this mapping).
 *
 * Coordinate frames:
 *   - Design space (from dxf.ts): X right, Y DOWN, origin top-left.
 *   - CAMEO device: X = carriage (across media), Y = media feed.
 *
 * Mapping (verified on hardware):
 *   device_x = placement.x + dx                ← X is NOT mirrored. (An earlier
 *                                                build mirrored X about designW
 *                                                to "fix a left-right flip", but
 *                                                combined with the Y flip below
 *                                                that produced a 180° rotation —
 *                                                output point-symmetric to the
 *                                                viewer. The flip seen back then
 *                                                was really that rotation; the
 *                                                correct fix is to drop the X
 *                                                mirror and keep only the Y flip.)
 *   device_y = placement.y + dy                ← Y is NOT flipped. Design Y grows
 *                                                down and the CAMEO feed axis also
 *                                                grows in the same direction on
 *                                                this hardware, so we add. (An
 *                                                earlier build subtracted, which
 *                                                printed upside-down vs the
 *                                                viewer.) placement.y is the
 *                                                device Y of the design's TOP edge
 *                                                (its smallest design-Y row).
 * Then emit "<device_y_su>,<device_x_su>" (y first). Both must stay ≥ 0 or the
 * boundary clips the segment (drops it) — `placement` is snapped on load so the
 * whole design lands at positive device coords. The machine's −6mm left-margin
 * allowance is NOT applied to the path (that conflates machine extent with
 * design placement and pushed X negative); placement.x is the positioning knob.
 *
 * `designW` is no longer used in the mapping; kept in the signature so callers
 * (and a future re-mirror, if a real left-right flip ever shows up) need no
 * plumbing changes.
 */
const devPair = (p: Placement, dx: number, dy: number, _designW: number): string => {
  const xSu = mmToSu(p.x + dx);
  const ySu = mmToSu(p.y + dy);
  return `${ySu},${xSu}`;
};

const distSq = (a: [number, number], b: [number, number]) => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
};

/**
 * Max perpendicular deviation (mm) for collinear-point removal. A flattened
 * curve / dense polyline emits a point per segment; wherever three consecutive
 * points are within this of a straight line, the middle one is dropped. 0.05 mm
 * = the device's own step, so the cut path is visually identical but far smaller.
 */
const COLLINEAR_TOL_MM = 0.05;

/** Perpendicular distance from point p to the segment a→b (mm). */
const perpDist = (
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  // |cross product| / |a→b|
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
};

/**
 * Reduce a polyline by removing points that lie (within tol) on the straight
 * line between their neighbors — a one-pass Douglas-Peucker-lite. Keeps the
 * first + last point and any genuine corner/curve vertex. This is the single
 * biggest GPGL size win: flattened arcs and CAD polylines carry many collinear
 * points that each cost a full `D<y>,<x>` command.
 */
const simplifyCollinear = (
  pts: [number, number][],
  tol: number,
): [number, number][] => {
  if (pts.length <= 2) return pts;
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    // Drop pts[i] if it's within tol of the line from the last KEPT point to
    // the next point. (anchor = last kept, so error doesn't accumulate badly.)
    const anchor = out[out.length - 1];
    if (perpDist(pts[i], anchor, pts[i + 1]) > tol) {
      out.push(pts[i]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
};

type EmittedShape = {
  /** GPGL command lines (a leading `M` unless chained, then `D` per point). */
  cmds: string[];
  /** Design-space start + end points, for chaining the next shape. */
  start: [number, number];
  end: [number, number];
};

/**
 * Emit one shape as GPGL. Flattens curves at CUT tolerance (smooth, not the
 * preview's coarse 0.2 mm). Emits ONE `D` per point (matches Graphtec.py). The
 * pen stays down across the `D`s (GPGL only lifts on `M`). If `chainFrom` is
 * given and equals this shape's start, the leading `M` is SKIPPED so the pen
 * doesn't lift between touching shapes. Returns null for degenerate shapes.
 */
const emitShape = (
  s: Shape,
  p: Placement,
  chainFrom: [number, number] | null,
  designW: number,
): EmittedShape | null => {
  const poly = flattenShape(s, CUT_TOL_MM, CUT_MAX_STEPS);
  if (poly.length < 2) return null;

  // 1. Coalesce points below motor resolution (keep first + last).
  let pts: [number, number][] = [poly[0]];
  const minSq = MIN_SEG_MM * MIN_SEG_MM;
  for (let i = 1; i < poly.length; i++) {
    const isLast = i === poly.length - 1;
    if (!isLast && distSq(pts[pts.length - 1], poly[i]) < minSq) continue;
    pts.push(poly[i]);
  }
  // 2. Drop points that lie on the straight line between their neighbors. This
  //    is the big size win — a flattened arc / CAD polyline keeps only its true
  //    vertices, each saved point is one fewer `D<y>,<x>` command.
  pts = simplifyCollinear(pts, COLLINEAR_TOL_MM);
  if (pts.length < 2) return null;

  const start = pts[0];
  const end = pts[pts.length - 1];
  const out: string[] = [];
  // Lift+move to the start ONLY if we're not already there from the last shape.
  const chained = chainFrom !== null && almostSame(chainFrom, start);
  if (!chained) out.push(`M${devPair(p, start[0], start[1], designW)}`);
  // One `D` per point — the hardware-verified form (a batched multi-point D was
  // not validated on the real CAMEO 5). Collinear removal already cut the count.
  for (let i = 1; i < pts.length; i++) {
    out.push(`D${devPair(p, pts[i][0], pts[i][1], designW)}`);
  }
  return { cmds: out, start, end };
};

/**
 * Build a setup object for a given layer (used per-layer; the worker re-applies
 * tool/force/speed when the active layer's tool changes).
 */
export const layerSetup = (
  l: CameoLayerParams,
  job: CameoJobParams,
): CameoSetup => ({
  tool: l.tool,
  speed: clamp(Math.round(l.speed), 1, 10),
  force: clamp(Math.round(l.force), 1, 33),
  depth: clamp(Math.round(l.depth), 0, 10),
  auto_blade: l.autoBlade,
  blade_offset_mm: job.bladeOffsetMm,
  accel: clamp(Math.round(job.accel), 1, 3),
  mat: job.mat,
  track_enhancing: job.trackEnhancing,
  area_w_mm: CAMEO5_AREA.width,
  area_h_mm: CAMEO5_AREA.length,
});

/**
 * Build the GPGL PATH program for a job: per enabled layer a J/FX/!/FC[/TF]
 * setup block (so tool, force, speed and depth follow the layer), then the
 * shapes' M/D commands, repeated for `passes`. Layers are matched to the doc
 * by name.
 *
 * The init handshake (TB71/FA), the cutting-area boundary (`\0,0`/`Z`) and the
 * end/reset sequence are issued by the Rust backend (`cameo.rs::run_job`), NOT
 * here — those need device status round-trips and the verified framing. This
 * function returns only the per-layer setup + path commands (bare GPGL, no ETX).
 */
export function buildGpgl(doc: DxfDocument, job: CameoJobParams): string[] {
  const out: string[] = [];
  const { placement } = job;

  // Design width, threaded to devPair. Currently unused there (X is not
  // mirrored — see devPair's note on the old 180° bug), but kept so re-enabling
  // a mirror later needs no signature changes.
  const designW = doc.bounds.maxX - doc.bounds.minX;

  const byName = new Map(doc.layers.map((l) => [l.name, l]));

  for (const lp of job.layers) {
    if (!lp.enabled) continue;
    const layer = byName.get(lp.name);
    if (!layer || layer.shapes.length === 0) continue;

    const tool = lp.tool === 2 ? 2 : 1;
    // Per-layer setup: select tool, set force + speed, blade offset, depth.
    out.push(`J${tool}`);
    out.push(`FX${clamp(Math.round(lp.force), 1, 33)},${tool}`);
    out.push(`!${clamp(Math.round(lp.speed), 1, 10)},${tool}`);
    const offSu = mmToSu(job.bladeOffsetMm);
    out.push(`FC${offSu},1,${tool}`);
    if (lp.autoBlade && tool === 1) {
      out.push(`TF${clamp(Math.round(lp.depth), 0, 10)},${tool}`);
    }

    const passes = Math.max(1, Math.round(lp.passes));
    for (let pass = 0; pass < passes; pass++) {
      // Track the previous shape's END point so a shape that starts there does
      // not lift the pen (dxf.ts already stitches shapes into adjacency order).
      let prevEnd: [number, number] | null = null;
      for (const s of layer.shapes) {
        const em = emitShape(s, placement, prevEnd, designW);
        if (!em) continue;
        out.push(...em.cmds);
        prevEnd = em.end;
      }
    }
  }

  return out;
}

/** Default per-layer CAMEO params (mirrors gcode.ts `defaultLayerParams`). */
export function defaultCameoLayers(doc: DxfDocument): CameoLayerParams[] {
  return doc.layers.map((l) => ({
    name: l.name,
    enabled: true,
    tool: 1,
    speed: 5,
    force: 10,
    depth: 1,
    passes: 1,
    autoBlade: true,
  }));
}
