// Concentric infill for the tepra label generator — the "solid/top surface"
// fill style used by FFF slicers (PrusaSlicer/BambuStudio `FillConcentric`),
// reimplemented independently from the published algorithm (no slicer code
// copied). Instead of parallel zigzag lines, the region is filled by repeatedly
// insetting its boundary inward by the line pitch, so the path follows the
// glyph's contours — far more refined on letterforms than a rectilinear hatch,
// with no visible scan lines.
//
// Robust polygon offsetting (with self-intersection cleanup and topology splits
// as a stem erodes to its medial spine) is genuinely hard to do correctly by
// hand, so this uses Clipper (`clipper-lib`, MIT) — the same offsetting
// primitive the reference slicers themselves build on. Everything else (even-
// odd handling, mm↔integer scaling, loop ordering) is ours.

import ClipperLib from "clipper-lib";
import { zigzagFill, type Ring, type Polyline } from "./polygonFill";

/** Interior fill style shared by all tepra generators (text / GIF / unim). */
export type FillMode = "zigzag" | "concentric";

// Clipper works in integers; scale mm by this so sub-10µm features survive
// rounding. 1 mm = 1000 units → 0.001 mm resolution, well below blade/laser
// precision at label scale.
const SCALE = 1000;

type IntPath = ClipperLib.IntPoint[];

const toInt = (rings: Ring[]): IntPath[] =>
  rings.map((r) =>
    r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })),
  );

const toMm = (path: IntPath): Polyline =>
  path.map((p) => [p.X / SCALE, p.Y / SCALE] as [number, number]);

/**
 * Normalize the glyph's rings (even-odd winding, holes as inner rings) into
 * clean, correctly-ORIENTED Clipper polygons so ClipperOffset insets the solid
 * area and grows the holes uniformly.
 *
 * The subtlety that previously broke NESTED holes (四, 囚 — a counter that
 * itself contains a solid stroke): a plain even-odd union emits contours whose
 * winding direction is NOT guaranteed by nesting depth. ClipperOffset decides
 * "solid vs. hole" purely from each path's orientation, so a hole emitted with
 * the wrong (solid) winding gets FILLED IN. The bug was data-dependent because
 * it only surfaced when the union happened to emit a hole CCW.
 *
 * Fix: resolve the region into a PolyTree (which records true nesting via
 * `IsHole()`), then FORCE each contour's orientation by its role — solids CCW
 * (positive area), holes CW (negative area) — independent of whatever winding
 * the union produced. Now offset behaviour is deterministic at every depth.
 */
const normalize = (rings: Ring[]): IntPath[] => {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(toInt(rings), ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd,
  );

  // Walk every node; re-orient by its hole/solid role. Clipper's positive area
  // == CCW; we want solids CCW and holes CW so a single -delta offset insets
  // the whole region (outer shrinks, holes grow) regardless of depth.
  const out: IntPath[] = [];
  let node: ClipperLib.PolyNode | null = tree.GetFirst();
  while (node) {
    const contour = node.Contour();
    if (contour.length >= 3) {
      const wantPositive = !node.IsHole(); // solid → positive(CCW), hole → negative(CW)
      const isPositive = ClipperLib.Clipper.Area(contour) > 0;
      if (isPositive !== wantPositive) contour.reverse();
      out.push(contour);
    }
    node = node.GetNext();
  }
  // Remove the near-coincident vertices left by Bézier flattening + integer
  // rounding. Without this, ClipperOffset can spawn degenerate micro-loops
  // (slivers inside a counter) that read as a "filled" hole.
  return ClipperLib.Clipper.CleanPolygons(out, SCALE * 0.0015);
};

/** One inward offset step of `delta` mm on a polygon-with-holes set. */
const insetBy = (paths: IntPath[], delta: number): IntPath[] => {
  const co = new ClipperLib.ClipperOffset(2.0, 0.25 * SCALE);
  // jtMiter keeps insets predictable; etClosedPolygon offsets the whole filled
  // set at once, so holes (CW rings) are respected — they grow as the outside
  // shrinks, and the two meet cleanly when a wall is exhausted.
  co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const solution: IntPath[] = [];
  co.Execute(solution, -delta * SCALE);
  return solution;
};

/**
 * Concentric fill: closed loops that follow the region boundary, each inset
 * `lineGap` mm further than the last, until the region is exhausted. Returns one
 * closed polyline per loop, ordered outermost → innermost. Each loop is a
 * separate closed contour (the tool lifts between loops, like a slicer's
 * concentric infill).
 *
 * `startGap` is the inset of the FIRST loop from the true outline (default
 * `lineGap/2`, so the first fill loop sits half a pitch inside the perimeter).
 *
 * Loops are produced by PROGRESSIVE insetting — each loop set is offset from the
 * PREVIOUS one, not cumulatively from the original boundary. This is the slicer-
 * standard method and is far more robust on glyphs: the previous result is
 * already a clean polygon-with-holes, so a thin wall simply disappears (its
 * outer and hole rings annihilate) instead of producing a malformed near-
 * collapse polygon that can bridge across a counter and fill the hole.
 */
export const concentricFill = (
  rings: Ring[],
  lineGap: number,
  startGap = lineGap / 2,
): Polyline[] => {
  if (rings.length === 0 || lineGap <= 0) return [];
  const region = normalize(rings);
  if (region.length === 0) return [];

  const out: Polyline[] = [];
  // First loop: inset half a pitch from the true boundary.
  let cur = insetBy(region, startGap);
  // Safety bound on loop count (huge glyph / tiny pitch); real glyphs need ≪.
  const maxLoops = 100000;
  for (let i = 0; i < maxLoops && cur.length > 0; i++) {
    for (const path of cur) {
      if (path.length < 3) continue; // drop degenerate slivers
      const loop = toMm(path);
      loop.push([...loop[0]]); // explicitly close
      out.push(loop);
    }
    // Inset the NEXT ring set from the current one (cleaned along the way).
    cur = ClipperLib.Clipper.CleanPolygons(insetBy(cur, lineGap), SCALE * 0.0015);
  }
  return out;
};

/**
 * Fill the interior of `rings` with the chosen pattern at `lineGap` pitch.
 * Single entry point so every generator (tepra/tepraGif/unimVector) can switch
 * fill style with one option. `zigzag` = the original diagonal hatch; the
 * angle is fixed at 45° to match historic output.
 */
export const fillRegion = (
  rings: Ring[],
  lineGap: number,
  mode: FillMode,
): Polyline[] =>
  mode === "concentric"
    ? concentricFill(rings, lineGap)
    : zigzagFill(rings, lineGap, 45);
