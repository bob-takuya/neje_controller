// Convert DXF shapes into GRBL-flavoured G-code.
//
// Coordinate model:
//   - DXF is loaded with flipY + snapToOrigin applied. Every design point is
//     in "design space" where (0, 0) is visual top-left and Y grows DOWNWARD.
//   - Placement (px, py) is the MCS location of the design's (0, 0) corner.
//   - MCS transform: mcs_x = px + dx,  mcs_y = py - dy.
//     Positive design.y → smaller MCS.y (toward the front of the machine).
//
// Arc/circle emission:
//   - We preserve ARC / CIRCLE primitives from the DXF so we can emit one
//     G2/G3 per curve instead of dozens of tiny G1 segments. GRBL interpolates
//     the arc in firmware; the planner gets a single block that accelerates
//     smoothly, so the head doesn't grind to 0.5mm/s the way it does with
//     flattened curves.
//   - The placement transform inverts Y, which flips the arc's rotational
//     sense. So a DXF CCW arc (the default) that was flipped to CW in design
//     space flips back to CCW in MCS → emits G3.

import {
  ArcShape,
  CircleShape,
  DxfDocument,
  Shape,
} from "./dxf";

export type LayerParams = {
  name: string;
  enabled: boolean;
  /** Laser power 0..1000 (S-value). 0 disables. */
  power: number;
  /** Feed rate mm/min for cutting moves. */
  feed: number;
  /** Number of cut passes. 1 is a single pass. */
  passes: number;
  /** Display color override. When unset, the DXF layer's own color is used. */
  color?: string;
};

/** MCS (machine-coord) location of the design's (0, 0) corner, in mm. */
export type Placement = { x: number; y: number };

export type JobParams = {
  layers: LayerParams[];
  /** Travel feed rate (G0 is rapid; many GRBL firmwares ignore F here). */
  travelFeed: number;
  /** Use M4 (dynamic laser power, coupled to motion) instead of M3 (constant). */
  dynamicPower: boolean;
  /** Return to placement at the end. */
  returnHome: boolean;
  placement: Placement;
};

const fmt = (n: number, digits = 3) => {
  // digits === 0 → integer: return as-is (must NOT strip trailing zeros;
  // the old regex turned 1500 → "15" and 300 → "3", destroying F/S values).
  if (digits === 0) return n.toFixed(0);
  // Fractional: strip unnecessary trailing zeros after the decimal point.
  const v = n.toFixed(digits);
  return v.replace(/\.?0+$/, "") || "0";
};

// Threshold for "these two MCS points are the same shape boundary".
//
// Used to decide whether a shape chains onto the previous one — when they
// chain, we skip the M5/G0/M4 cycle and keep the laser burning across the
// boundary. The bar must be looser than the biarc fitter's tolerance
// (0.05 mm, see dxf.ts), otherwise every adjacent line+arc emits a
// laser-off/on cycle and the controller stalls on each M5 (each one drains
// the planner). At 0.1 mm any visible gap is well below kerf width and the
// stitch pass in dxf.ts already coalesces points within 0.01 mm.
const CHAIN_TOL_MM = 0.1;
const almostSame = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) < CHAIN_TOL_MM && Math.abs(a[1] - b[1]) < CHAIN_TOL_MM;

/** Below this we skip the G1 — 2× motor-step resolution on NEJE MAX4. */
const MIN_SEG_MM = 0.025;

const distSq = (a: [number, number], b: [number, number]) => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
};

/** Map a design-space point to its MCS position. */
export const toMcs = (p: Placement, dx: number, dy: number): [number, number] => [
  p.x + dx,
  p.y - dy,
];

// --- Arc / circle helpers ---

const arcStartDesignPoint = (a: ArcShape): [number, number] => {
  const r0 = (a.startDeg * Math.PI) / 180;
  return [a.cx + a.r * Math.cos(r0), a.cy + a.r * Math.sin(r0)];
};
const arcEndDesignPoint = (a: ArcShape): [number, number] => {
  const r1 = (a.endDeg * Math.PI) / 180;
  return [a.cx + a.r * Math.cos(r1), a.cy + a.r * Math.sin(r1)];
};

/** CCW flag in MCS space = design-space ccw flipped by the placement Y-inversion. */
const mcsCcw = (designCcw: boolean) => !designCcw;

type Emitted = {
  /** MCS start point of the curve/segment (where G0 should rapid to). */
  start: [number, number];
  /** MCS end point (lastMcs after the segment). */
  end: [number, number];
  /** G1/G2/G3 body lines (laser-on moves). */
  body: string[];
};

const emitPolyline = (
  points: [number, number][],
  p: Placement,
  feed: number,
): Emitted => {
  const start = toMcs(p, points[0][0], points[0][1]);
  const body: string[] = [];
  let prev = start;
  let firstG1 = true;
  const minSq = MIN_SEG_MM * MIN_SEG_MM;
  for (let i = 1; i < points.length; i++) {
    const next = toMcs(p, points[i][0], points[i][1]);
    const isLast = i === points.length - 1;
    // Coalesce sub-resolution points except at the endpoint.
    if (!isLast && distSq(prev, next) < minSq) continue;
    if (firstG1) {
      body.push(`G1 X${fmt(next[0])} Y${fmt(next[1])} F${fmt(feed, 0)}`);
      firstG1 = false;
    } else {
      body.push(`G1 X${fmt(next[0])} Y${fmt(next[1])}`);
    }
    prev = next;
  }
  return { start, end: prev, body };
};

const emitArc = (a: ArcShape, p: Placement, feed: number): Emitted => {
  const designStart = arcStartDesignPoint(a);
  const designEnd = arcEndDesignPoint(a);
  const start = toMcs(p, designStart[0], designStart[1]);
  const end = toMcs(p, designEnd[0], designEnd[1]);
  const center = toMcs(p, a.cx, a.cy);
  // I, J are offsets FROM start TO center, in MCS.
  const I = center[0] - start[0];
  const J = center[1] - start[1];
  const word = mcsCcw(a.ccw) ? "G3" : "G2";
  const body = [
    `${word} X${fmt(end[0])} Y${fmt(end[1])} I${fmt(I)} J${fmt(J)} F${fmt(feed, 0)}`,
  ];
  return { start, end, body };
};

const emitCircle = (c: CircleShape, p: Placement, feed: number): Emitted => {
  // Start the circle at angle 0 in design space for simplicity: design point (cx + r, cy).
  const designStart: [number, number] = [c.cx + c.r, c.cy];
  const start = toMcs(p, designStart[0], designStart[1]);
  const center = toMcs(p, c.cx, c.cy);
  const I = center[0] - start[0]; // = -r
  const J = center[1] - start[1]; // = 0
  // For a full circle, end = start; GRBL treats a G2/G3 with start==end and
  // non-zero I/J as a full 360° sweep.
  const word = mcsCcw(c.ccw) ? "G3" : "G2";
  const body = [
    `${word} X${fmt(start[0])} Y${fmt(start[1])} I${fmt(I)} J${fmt(J)} F${fmt(feed, 0)}`,
  ];
  return { start, end: start, body };
};

const emitShape = (s: Shape, p: Placement, feed: number): Emitted | null => {
  switch (s.type) {
    case "poly":
      if (s.points.length < 2) return null;
      return emitPolyline(s.points, p, feed);
    case "arc":
      return emitArc(s, p, feed);
    case "circle":
      return emitCircle(s, p, feed);
  }
};

// --- Main ---

export function buildGCode(doc: DxfDocument, params: JobParams): string[] {
  const out: string[] = [];
  const { placement } = params;

  out.push("; nejemax4-tauri generated G-code");
  out.push(`; placement: (${fmt(placement.x)}, ${fmt(placement.y)}) mm in MCS`);
  out.push("G21"); // mm
  out.push("G90"); // absolute positioning
  // Force GRBL into laser mode. In laser mode, S is treated as a power level
  // (not spindle RPM), and crucially G0 *automatically forces S to 0* so we
  // can rapid between shapes without explicitly toggling M5/M4. This is what
  // makes shape-to-shape transitions instant instead of stalling ~1s on each
  // M5 (which would otherwise drain the planner before responding ok).
  // NEJE MAX4 ships with $32=1, but force it for safety in case someone has
  // a stale machine.
  out.push("$32=1");
  out.push("M5"); // known-off start state

  // In dynamic mode (M4) we issue ONE M4 at the start of the job and rely on
  // the GRBL laser-mode behavior above to gate the beam during G0 rapids.
  // No more M5/G0/M4 cycle per shape — that was ~5000 sync stalls on the
  // Rhino test file.
  //
  // In constant mode (M3) the laser stays at full power during G0 rapids, so
  // we MUST keep emitting M5/G0/M3 around each shape boundary. M3 users
  // typically know this and accept the cost.
  const dynamic = params.dynamicPower;
  const laserOn = dynamic ? "M4" : "M3";

  const byName: Record<string, Shape[]> = {};
  for (const l of doc.layers) byName[l.name] = l.shapes;

  let lastMcs: [number, number] | null = null;
  let lastPower: number | null = null; // Last S value we sent. Lets us re-emit
                                       // only on power change in dynamic mode.

  for (const layer of params.layers) {
    if (!layer.enabled) continue;
    const shapes = byName[layer.name];
    if (!shapes || shapes.length === 0) continue;

    out.push(
      `; --- layer: ${layer.name} (power=${layer.power}, feed=${layer.feed}, passes=${layer.passes}) ---`,
    );

    if (dynamic && lastPower !== layer.power) {
      // Set/refresh power for this layer; M4 stays on for the whole job.
      out.push(`${laserOn} S${fmt(layer.power, 0)}`);
      lastPower = layer.power;
    }

    for (let pass = 0; pass < Math.max(1, layer.passes); pass++) {
      if (layer.passes > 1) {
        out.push(`; pass ${pass + 1}/${layer.passes}`);
      }
      let laserActive = dynamic; // In dynamic mode the beam is "armed" the
                                 // whole job (G0 auto-disables it). In
                                 // constant mode we toggle per shape.
      for (const shape of shapes) {
        const em = emitShape(shape, placement, layer.feed);
        if (!em || em.body.length === 0) continue;

        const chained = laserActive && lastMcs && almostSame(lastMcs, em.start);

        if (chained) {
          // Shapes chain continuously (e.g. poly→arc from a split
          // LWPOLYLINE). Keep the laser on — no gap move needed.
        } else if (dynamic) {
          // M4 mode: just rapid to the new start. The laser auto-off during
          // G0 (laser-mode $32=1) means we don't need M5/M3 dance, and the
          // planner doesn't stall waiting on a spindle sync.
          if (!lastMcs || !almostSame(lastMcs, em.start)) {
            out.push(`G0 X${fmt(em.start[0])} Y${fmt(em.start[1])}`);
          }
          laserActive = true;
        } else {
          // M3 (constant) mode: full M5/G0/M3 cycle to avoid burning during
          // rapids.
          if (laserActive) out.push("M5");
          if (!lastMcs || !almostSame(lastMcs, em.start)) {
            out.push(`G0 X${fmt(em.start[0])} Y${fmt(em.start[1])}`);
          }
          out.push(`${laserOn} S${fmt(layer.power, 0)}`);
          laserActive = true;
        }

        for (const line of em.body) out.push(line);
        lastMcs = em.end;
      }
    }

    // In M3 mode we drop the beam between layers as a safety pause. In M4
    // mode the rapid to the next layer will auto-disable the beam — no need
    // for an explicit sync stall here.
    if (!dynamic) out.push("M5");
  }

  if (params.returnHome) {
    out.push(
      `G0 X${fmt(placement.x)} Y${fmt(placement.y)} F${fmt(params.travelFeed, 0)}`,
    );
  }
  out.push("M5");

  return out;
}

// --- Resume from a stopped job ----------------------------------------------
//
// When a job is cancelled or errors out partway, we want to be able to pick
// it back up without redoing finished cuts. Plain `program.slice(startIdx)`
// is not enough: the controller has been soft-reset (by our cancel logic) so
// modal state — units (G21), distance (G90), feed, laser mode, the active M4
// power — is gone. We also need to physically rapid the head to the right
// position before resuming, otherwise the very first G1 cuts a straight line
// from wherever the head currently sits to wherever we left off.
//
// `buildResumeProgram` rebuilds those pieces:
//   1. Copy every "header" line from the original program (everything before
//      the first motion command).
//   2. Re-emit `$32=1` + `M5` + the most recent `M3/M4 S<power>` that was
//      active at startIdx (walked from the start of the program).
//   3. Rapid (G0) to the last known XY position just before startIdx.
//   4. Append `program[startIdx..]`.
//
// Note: this depends on the program being built by `buildGCode` above. Hand-
// crafted programs that don't follow our laser-mode convention may not
// resume correctly.

const X_RE = /\bX([-\d.]+)/;
const Y_RE = /\bY([-\d.]+)/;
const S_RE = /\bS([\d.]+)/;
const MOTION_RE = /^G[0123](?:\b|\s)/;
const LASER_ON_RE = /^(M3|M4)\b/;

/**
 * Rebuild a resumable program that continues `program` from `startIdx`.
 * `startIdx` is interpreted as an index into the ORIGINAL program (0-based).
 * Out-of-range values are clamped.
 */
export function buildResumeProgram(
  program: string[],
  startIdx: number,
): string[] {
  if (program.length === 0) return [];
  const i = Math.max(0, Math.min(startIdx, program.length));
  if (i === 0) return program.slice();

  // Walk lines [0, i) to recover modal state and last position.
  let lastX: number | null = null;
  let lastY: number | null = null;
  let activeLaser: string | null = null; // e.g. "M4 S600"
  let firstMotion = -1;

  for (let k = 0; k < i; k++) {
    const line = program[k];
    if (firstMotion < 0 && MOTION_RE.test(line)) firstMotion = k;
    const mx = line.match(X_RE);
    const my = line.match(Y_RE);
    if (mx) lastX = parseFloat(mx[1]);
    if (my) lastY = parseFloat(my[1]);
    if (LASER_ON_RE.test(line)) {
      // Snapshot the current laser-on command (including any S value).
      const s = line.match(S_RE);
      const mode = line.startsWith("M3") ? "M3" : "M4";
      activeLaser = s ? `${mode} S${s[1]}` : mode;
    } else if (/^M5\b/.test(line)) {
      activeLaser = null;
    }
  }

  // Header = everything before the first motion. If we never saw a motion,
  // treat the entire prefix as header.
  const headerEnd = firstMotion < 0 ? i : firstMotion;
  const out: string[] = [];
  out.push(`; --- RESUME from line ${i} of ${program.length} ---`);
  for (let k = 0; k < headerEnd; k++) out.push(program[k]);

  // Re-arm modal state explicitly even if it was in the header. Idempotent.
  if (!out.some((l) => l.trim() === "G21")) out.push("G21");
  if (!out.some((l) => l.trim() === "G90")) out.push("G90");
  if (!out.some((l) => l.trim() === "$32=1")) out.push("$32=1");
  // Make sure the laser is off before we rapid into position.
  out.push("M5");

  // Rapid to last known XY.
  if (lastX !== null && lastY !== null) {
    out.push(`G0 X${fmt(lastX)} Y${fmt(lastY)}`);
  }

  // Re-arm laser mode/power if it was active when we stopped.
  if (activeLaser) out.push(activeLaser);

  // Tail: the lines we still need to send.
  for (let k = i; k < program.length; k++) out.push(program[k]);
  return out;
}

/** Helper: turn DxfDocument layers into default LayerParams list. */
export function defaultLayerParams(doc: DxfDocument): LayerParams[] {
  return doc.layers.map((l) => ({
    name: l.name,
    enabled: true,
    power: 300,
    feed: 1500,
    passes: 1,
  }));
}
