// Benchmark: count G-code-equivalent moves at three optimization levels.
//   raw           — current behavior (every polyline vertex becomes a G1)
//   +collinear    — merge consecutive G1s with angle delta < 0.5°
//   +biarc        — fit polylines to arcs/lines within 0.05mm tolerance
//
// We do not actually emit G-code — we count moves (one G1 per polyline
// segment, one G2/G3 per arc, one G2/G3 per circle). The current emitter
// produces ~1 GRBL block per move.

import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const DxfParser = require("dxf-parser");

const path = process.argv[2];
const text = fs.readFileSync(path, "utf8");
const doc = new DxfParser().parseSync(text);

// --- Replicate the app's parse output (simplified to what matters) -----------

function evalSplinePoly(cps, knots, degree, samples) {
  const n = cps.length - 1;
  if (cps.length < degree + 1 || knots.length < n + degree + 2) return cps;
  const tMin = knots[degree], tMax = knots[n + 1];
  if (!(tMax > tMin)) return cps;
  const findSpan = (t) => {
    if (t >= knots[n + 1]) return n;
    let k = degree;
    while (k < n && t >= knots[k + 1]) k++;
    return k;
  };
  const evalAt = (t) => {
    const k = findSpan(t);
    const d = [];
    for (let j = 0; j <= degree; j++) {
      const cp = cps[k - degree + j];
      d.push([cp[0], cp[1]]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const denom = knots[i + degree - r + 1] - knots[i];
        const alpha = denom === 0 ? 0 : (t - knots[i]) / denom;
        d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0],
                (1 - alpha) * d[j - 1][1] + alpha * d[j][1]];
      }
    }
    return d[degree];
  };
  const poly = [];
  for (let s = 0; s <= samples; s++) {
    const t = tMin + (tMax - tMin) * (s / samples);
    poly.push(evalAt(t));
  }
  return poly;
}

// shapes: { type: 'poly'|'arc'|'circle', ... } same shape as dxf.ts
const shapes = [];

for (const e of doc.entities ?? []) {
  switch (e.type) {
    case "LINE":
      shapes.push({ type: "poly", points: [[e.vertices[0].x, e.vertices[0].y], [e.vertices[1].x, e.vertices[1].y]] });
      break;
    case "LWPOLYLINE":
    case "POLYLINE": {
      const verts = e.vertices ?? [];
      if (verts.length < 2) break;
      // (Ignoring bulge → arc split for benchmark — text DXF rarely has bulges)
      shapes.push({ type: "poly", points: verts.map(v => [v.x, v.y]) });
      break;
    }
    case "CIRCLE":
      shapes.push({ type: "circle", cx: e.center.x, cy: e.center.y, r: e.radius });
      break;
    case "ARC":
      shapes.push({ type: "arc", cx: e.center.x, cy: e.center.y, r: e.radius,
        startDeg: e.startAngle * 180 / Math.PI, endDeg: e.endAngle * 180 / Math.PI });
      break;
    case "SPLINE": {
      const cps = (e.controlPoints ?? []).map(p => [p.x, p.y]);
      const fit = (e.fitPoints ?? []).map(p => [p.x, p.y]);
      const knots = e.knotValues ?? e.knots ?? [];
      const degree = e.degreeOfSplineCurve ?? 3;
      let poly;
      if (fit.length >= 2) poly = fit;
      else if (cps.length >= degree + 1 && knots.length >= cps.length + degree + 1) {
        const segs = cps.length - degree;
        poly = evalSplinePoly(cps, knots, degree, Math.max(32, segs * 16));
      } else if (cps.length >= 2) poly = cps;
      else break;
      if (poly.length >= 2) shapes.push({ type: "poly", points: poly });
      break;
    }
  }
}

// --- Count moves at three levels --------------------------------------------

function countRaw(shapes) {
  let g1 = 0, arcs = 0;
  for (const s of shapes) {
    if (s.type === "poly") g1 += s.points.length - 1;
    else if (s.type === "circle") arcs += 1;
    else if (s.type === "arc") arcs += 1;
  }
  return { g1, arcs, total: g1 + arcs };
}

// Merge consecutive segments whose direction differs by < `tolDeg`.
function collinearMerge(points, tolDeg = 0.5) {
  if (points.length < 3) return points;
  const out = [points[0]];
  let prevDir = null;
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const dir = Math.atan2(dy, dx);
    if (prevDir !== null) {
      let diff = Math.abs(dir - prevDir);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < (tolDeg * Math.PI / 180)) {
        // Same direction — extend last point instead of adding
        out[out.length - 1] = b;
        continue;
      }
    }
    out.push(b);
    prevDir = dir;
  }
  return out;
}

function countCollinear(shapes, tolDeg = 0.5) {
  let g1 = 0, arcs = 0;
  for (const s of shapes) {
    if (s.type === "poly") {
      const merged = collinearMerge(s.points, tolDeg);
      g1 += merged.length - 1;
    } else arcs += 1;
  }
  return { g1, arcs, total: g1 + arcs };
}

// --- Biarc fitting -----------------------------------------------------------
// Strategy: given a polyline P, greedily fit each prefix to a single circle (or
// line). Find the longest prefix where every point lies within `tol` of a
// circle passing through P[0], P[k]. Emit a single arc and continue from P[k].
//
// "Single circle through P[0] and P[k] approximating P[0..k]" — we fit by:
//   1. Use endpoints P[0], P[k] and tangent at P[0] (estimated from P[0]→P[1]).
//   2. Solve for center on the perpendicular bisector of the chord such that
//      the tangent constraint is satisfied. Closed form.
//   3. Verify max deviation of P[1..k-1] from this circle is < tol.
// Falls back to a straight segment if the radius is huge (≈ collinear).
//
// This is a simplification of true biarc (which uses two arcs per span). For
// our purposes the simpler "fit one arc per prefix" gives most of the savings.

function fitArcOrLine(pts, start, tol = 0.05) {
  // Returns { kind:'line'|'arc', end, ... } where end is the index of the
  // last point included.
  const p0 = pts[start];

  // Tangent at p0: direction of p0→p1
  if (start + 1 >= pts.length) return null;
  const t0x = pts[start + 1][0] - p0[0];
  const t0y = pts[start + 1][1] - p0[1];
  const tlen = Math.hypot(t0x, t0y);
  if (tlen < 1e-9) return null;
  const tx = t0x / tlen, ty = t0y / tlen;

  let bestEnd = start + 1;
  let bestKind = "line";
  let bestArc = null;

  // Greedily extend.
  for (let k = start + 2; k < pts.length; k++) {
    const pk = pts[k];
    const chordDx = pk[0] - p0[0];
    const chordDy = pk[1] - p0[1];
    const chordLen = Math.hypot(chordDx, chordDy);
    if (chordLen < 1e-9) continue;

    // Line check: are all P[start..k] within tol of the line p0→pk?
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
      bestKind = "line";
      bestArc = null;
      continue;
    }

    // Arc fit: circle through p0 with tangent (tx, ty) passing through pk.
    // Center is along the normal of the tangent at p0: c = p0 + r*n where
    // n = (-ty, tx) or (ty, -tx).
    // |c - pk|^2 = r^2  →  solve for r.
    // c = p0 + r*n_sgn, distance to pk: (chordDx - r*n_x)^2 + (chordDy - r*n_y)^2 = r^2
    // Expanding: chord^2 - 2r(chordDx*n_x + chordDy*n_y) = 0  →  r = chord^2 / (2*dot)
    const nx = -ty, ny = tx; // unit normal (left of tangent)
    const dot = chordDx * nx + chordDy * ny;
    if (Math.abs(dot) < 1e-9) {
      // Tangent is collinear with chord → it's a line. Fall through; line case
      // already handled above (would only get here if line dev > tol).
      break;
    }
    const r = (chordLen * chordLen) / (2 * dot);
    const absR = Math.abs(r);
    if (absR > 1e6 || absR < 1e-3) break; // degenerate
    const cx = p0[0] + r * nx;
    const cy = p0[1] + r * ny;

    let arcMaxDev = 0;
    for (let j = start + 1; j <= k; j++) {
      const d = Math.abs(Math.hypot(pts[j][0] - cx, pts[j][1] - cy) - absR);
      if (d > arcMaxDev) arcMaxDev = d;
    }
    if (arcMaxDev < tol) {
      bestEnd = k;
      bestKind = "arc";
      bestArc = { cx, cy, r: absR, ccw: r > 0 };
    } else {
      break; // can't extend further
    }
  }

  return { kind: bestKind, end: bestEnd, arc: bestArc };
}

function biarcMerge(points, tol = 0.05) {
  if (points.length < 3) return { lines: points.length - 1, arcs: 0 };
  // First collapse collinear runs.
  const pts = collinearMerge(points, 0.5);
  if (pts.length < 3) return { lines: pts.length - 1, arcs: 0 };

  let lines = 0, arcs = 0;
  let i = 0;
  while (i < pts.length - 1) {
    const fit = fitArcOrLine(pts, i, tol);
    if (!fit) { lines++; i++; continue; }
    if (fit.kind === "line") lines++;
    else arcs++;
    i = fit.end;
  }
  return { lines, arcs };
}

function countBiarc(shapes, tol = 0.05) {
  let g1 = 0, arcs = 0;
  for (const s of shapes) {
    if (s.type === "poly") {
      const r = biarcMerge(s.points, tol);
      g1 += r.lines;
      arcs += r.arcs;
    } else arcs += 1;
  }
  return { g1, arcs, total: g1 + arcs };
}

// --- Output ------------------------------------------------------------------

const raw = countRaw(shapes);
const col = countCollinear(shapes, 0.5);
const bi  = countBiarc(shapes, 0.05);

console.log(`Shapes: ${shapes.length}`);
console.log("");
console.log("level         | G1     | G2/G3 | total  | reduction");
console.log("--------------+--------+-------+--------+----------");
console.log(`raw           | ${String(raw.g1).padStart(6)} | ${String(raw.arcs).padStart(5)} | ${String(raw.total).padStart(6)} | —`);
console.log(`+collinear    | ${String(col.g1).padStart(6)} | ${String(col.arcs).padStart(5)} | ${String(col.total).padStart(6)} | ${(100 * (1 - col.total / raw.total)).toFixed(1)}%`);
console.log(`+biarc(0.05)  | ${String(bi.g1).padStart(6)} | ${String(bi.arcs).padStart(5)} | ${String(bi.total).padStart(6)} | ${(100 * (1 - bi.total / raw.total)).toFixed(1)}%`);

// Also try a looser tolerance.
const bi02 = countBiarc(shapes, 0.2);
console.log(`+biarc(0.2)   | ${String(bi02.g1).padStart(6)} | ${String(bi02.arcs).padStart(5)} | ${String(bi02.total).padStart(6)} | ${(100 * (1 - bi02.total / raw.total)).toFixed(1)}%`);
