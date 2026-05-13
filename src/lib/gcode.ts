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

const almostSame = (a: [number, number], b: [number, number]) =>
  Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4;

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
  out.push("M5"); // laser off to start

  const laserOn = params.dynamicPower ? "M4" : "M3";

  const byName: Record<string, Shape[]> = {};
  for (const l of doc.layers) byName[l.name] = l.shapes;

  let lastMcs: [number, number] | null = null;

  for (const layer of params.layers) {
    if (!layer.enabled) continue;
    const shapes = byName[layer.name];
    if (!shapes || shapes.length === 0) continue;

    out.push(
      `; --- layer: ${layer.name} (power=${layer.power}, feed=${layer.feed}, passes=${layer.passes}) ---`,
    );

    for (let pass = 0; pass < Math.max(1, layer.passes); pass++) {
      if (layer.passes > 1) {
        out.push(`; pass ${pass + 1}/${layer.passes}`);
      }
      let laserActive = false;
      for (const shape of shapes) {
        const em = emitShape(shape, placement, layer.feed);
        if (!em || em.body.length === 0) continue;

        const chained = laserActive && lastMcs && almostSame(lastMcs, em.start);

        if (chained) {
          // Shapes chain continuously (e.g. poly→arc from a split
          // LWPOLYLINE). Keep the laser on — no gap move needed.
        } else {
          // Gap between shapes: turn laser off, rapid to start, turn on.
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

    // Laser off between layers.
    out.push("M5");
  }

  if (params.returnHome) {
    out.push(
      `G0 X${fmt(placement.x)} Y${fmt(placement.y)} F${fmt(params.travelFeed, 0)}`,
    );
  }
  out.push("M5");

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
