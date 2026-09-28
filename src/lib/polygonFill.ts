// Polygon geometry for the tepra label generator: even-odd point-in-polygon,
// diagonal zigzag fill, and inward contour offset. All operate on closed
// polylines (first point == last, or implicitly closed) in mm, design space.
//
// These are intentionally simple and self-contained (no clipper/martinez dep):
// the inputs are glyph outlines at label scale, where robustness matters more
// than handling pathological CAD polygons.

export type Pt = [number, number];
export type Ring = Pt[]; // closed contour (implicitly closed; last≠first ok)
export type Polyline = Pt[];

/**
 * Even-odd containment: is point (x, y) inside the set of rings? A glyph with
 * counters (holes) is multiple rings; even-odd makes an odd crossing count =
 * inside, so holes are correctly excluded.
 */
export const pointInRings = (x: number, y: number, rings: Ring[]): boolean => {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      // Ray to +X: does edge (j→i) straddle the horizontal line y?
      const straddles = yi > y !== yj > y;
      if (straddles) {
        const xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (x < xCross) inside = !inside;
      }
    }
  }
  return inside;
};

const bbox = (rings: Ring[]): { minX: number; minY: number; maxX: number; maxY: number } => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return { minX, minY, maxX, maxY };
};

// Intersections of a horizontal line Y=y with all ring edges → sorted X list.
// Returned X's pair up into [in,out] spans by the even-odd rule.
const scanlineCrossings = (rings: Ring[], y: number): number[] => {
  const xs: number[] = [];
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ring[i][1], yj = ring[j][1];
      if (yi > y !== yj > y) {
        const xi = ring[i][0], xj = ring[j][0];
        xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
  }
  xs.sort((a, b) => a - b);
  return xs;
};

/** One interior run on a scanline, in the (rotated) hatch frame. */
type Span = { y: number; x0: number; x1: number; used: boolean };

/**
 * Fill the interior of `rings` with a CONTINUOUS zigzag/crank path at
 * `angleDeg`, hatch lines spaced `spacing` mm apart. Holes (even-odd) stay
 * empty.
 *
 * Unlike a naive scanline fill (one disconnected segment per line, i.e. a
 * pen-up/down for every line), this CHAINS consecutive scanline spans: it draws
 * a span, then a short connector down the shared edge to the next line's
 * overlapping span, then back across — a boustrophedon "crank" the pen/blade
 * traces without lifting. The pen only lifts when the fill genuinely splits
 * (e.g. the two stems of "H", or around a hole) and no overlapping span
 * continues the run; then a new path starts. Returns one polyline per
 * continuous run.
 *
 * Implementation: rotate the world by −angle so hatch lines become horizontal,
 * fill in that frame, rotate the result back — keeps the crossing math 1-D
 * while supporting the 45° ("斜め") diagonal.
 */
export const zigzagFill = (
  rings: Ring[],
  spacing: number,
  angleDeg = 45,
): Polyline[] => {
  if (rings.length === 0 || spacing <= 0) return [];
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  // Rotate a point by −angle (into hatch frame) and by +angle (back).
  const fwd = (p: Pt): Pt => [p[0] * cos + p[1] * sin, -p[0] * sin + p[1] * cos];
  const back = (p: Pt): Pt => [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos];

  const rot = rings.map((r) => r.map(fwd));
  const { minY, maxY } = bbox(rot);

  // Collect spans per scanline (rows), top → bottom.
  const rows: Span[][] = [];
  for (let y = minY + spacing * 0.5; y < maxY; y += spacing) {
    const xs = scanlineCrossings(rot, y);
    const row: Span[] = [];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = xs[k], x1 = xs[k + 1];
      if (x1 - x0 < 1e-6) continue; // skip slivers
      row.push({ y, x0, x1, used: false });
    }
    rows.push(row);
  }

  // Two spans on adjacent rows can be joined by a connector that stays inside
  // the shape only if their X intervals OVERLAP. (A gap between them means the
  // straight connector would cross empty space / a hole.)
  const overlaps = (a: Span, b: Span) => a.x0 < b.x1 && b.x0 < a.x1;

  // X-overlap is necessary but NOT sufficient: near a CONCAVE corner (e.g. the
  // inside corner of a counter in 口/四), a wide span can overlap a span on the
  // next row whose connector nonetheless cuts diagonally across the empty
  // counter. Guard every connector — the straight segment from (exitX, yA) to
  // (entryX, yB) — by sampling several points along it and requiring all to be
  // solid; if any lands in a hole/outside, refuse the join (the run ends, pen
  // lifts) so no fill segment bleeds into a counter.
  const SAMPLES = 5;
  const connectorInside = (
    exitX: number,
    entryX: number,
    yA: number,
    yB: number,
  ): boolean => {
    for (let k = 1; k < SAMPLES; k++) {
      const t = k / SAMPLES;
      const x = exitX + (entryX - exitX) * t;
      const y = yA + (yB - yA) * t;
      if (!pointInRings(x, y, rot)) return false;
    }
    return true;
  };

  const out: Polyline[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (const seed of rows[r]) {
      if (seed.used) continue;
      // Start a new continuous run. The first span is drawn left→right; every
      // subsequent span is entered at the end nearest the previous exit (a
      // short connector down the shared edge) and traversed to its far end, so
      // travel alternates direction — a crank that never lifts the pen.
      // Serpentine: traverse each span fully end-to-end, then step down to the
      // next overlapping span entering at the end nearest the current exit, so
      // travel alternates (a crank). The connector + turn live within the X
      // overlap of the two spans, so they stay inside the shape.
      const path: Polyline = [];
      let cur: Span = seed;
      let row = r;
      cur.used = true;
      path.push([cur.x0, cur.y], [cur.x1, cur.y]);
      let exitX = cur.x1;

      while (true) {
        // Among unused, X-overlapping spans on the next row, take the first one
        // whose connector actually stays inside the solid (rejects the diagonal
        // that would cut across a counter corner). Enter at the end nearer the
        // current exit; the connector runs (exitX, curY) → (entry, nextY).
        const candidates = rows[row + 1]?.filter((s) => !s.used && overlaps(cur, s)) ?? [];
        let chosen: { span: Span; entry: number; far: number } | null = null;
        for (const s of candidates) {
          const enterX0 = Math.abs(exitX - s.x0) <= Math.abs(exitX - s.x1);
          const entry = enterX0 ? s.x0 : s.x1;
          const far = enterX0 ? s.x1 : s.x0;
          if (connectorInside(exitX, entry, cur.y, s.y)) {
            chosen = { span: s, entry, far };
            break;
          }
        }
        if (!chosen) break;
        chosen.span.used = true;
        path.push([chosen.entry, chosen.span.y], [chosen.far, chosen.span.y]);
        exitX = chosen.far;
        cur = chosen.span;
        row++;
      }
      if (path.length >= 2) out.push(path.map(back));
    }
  }
  return out;
};

// Signed area (shoelace). >0 == counter-clockwise in a Y-UP frame; in our
// Y-DOWN design space the sign is inverted but only the relative sign matters
// (we use it to pick the inward normal direction consistently per ring).
const signedArea = (ring: Ring): number => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return s / 2;
};

/**
 * Offset a single closed ring inward by `dist` mm using per-vertex angle-
 * bisector displacement (a miter offset). "Inward" is determined from the
 * ring's winding so the outer boundary shrinks and holes grow — i.e. the
 * remaining cut area erodes uniformly.
 *
 * This is a pragmatic offset, not a full polygon-clipping straight skeleton:
 * for label glyphs at small offsets it produces clean inset outlines. Returns
 * null if the ring collapses (offset exceeds local feature size — the caller
 * just stops adding passes for that ring).
 */
export const offsetRingInward = (ring: Ring, dist: number): Ring | null => {
  // Drop a duplicated closing point if present so neighbours wrap cleanly.
  let pts = ring.slice();
  if (
    pts.length > 1 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
  ) {
    pts = pts.slice(0, -1);
  }
  const n = pts.length;
  if (n < 3) return null;

  // Inward sign: shrink the area magnitude. For CCW (area>0) inward is to the
  // LEFT of each directed edge; we encode this with `s`.
  const s = signedArea(pts) > 0 ? 1 : -1;

  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];

    // Unit edge directions in/out of the vertex.
    const d1: Pt = [cur[0] - prev[0], cur[1] - prev[1]];
    const d2: Pt = [next[0] - cur[0], next[1] - cur[1]];
    const l1 = Math.hypot(d1[0], d1[1]) || 1;
    const l2 = Math.hypot(d2[0], d2[1]) || 1;
    const u1: Pt = [d1[0] / l1, d1[1] / l1];
    const u2: Pt = [d2[0] / l2, d2[1] / l2];

    // Inward normals of the two edges (rotate edge dir by +90°·s).
    const nrm1: Pt = [-u1[1] * s, u1[0] * s];
    const nrm2: Pt = [-u2[1] * s, u2[0] * s];

    // Miter direction = normalized sum of the two normals; scale so the offset
    // distance along each edge normal is exactly `dist` (miter length = dist /
    // cos(theta/2)).
    let mx = nrm1[0] + nrm2[0];
    let my = nrm1[1] + nrm2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      // ~180° turn (spike); fall back to a single normal to avoid blowup.
      mx = nrm1[0];
      my = nrm1[1];
    } else {
      mx /= ml;
      my /= ml;
    }
    // cos(theta/2) = dot(miter, nrm1); guard against tiny values (sharp spikes)
    // that would shoot the miter to infinity.
    const cosHalf = Math.max(0.25, mx * nrm1[0] + my * nrm1[1]);
    const off = dist / cosHalf;
    out.push([cur[0] + mx * off, cur[1] + my * off]);
  }

  // Reject if the offset inverted the winding (over-eroded → garbage).
  if (Math.sign(signedArea(out)) !== Math.sign(signedArea(pts))) return null;
  // Re-close.
  out.push([...out[0]]);
  return out;
};
