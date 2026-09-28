// GIF-driven tepra label generator: read an animated GIF one frame at a time,
// extract the BLACK region of each frame, and lay the frames out as a single
// row (one frame per square cell) on the long, narrow tape — the bitmap
// equivalent of the text generator in tepra.ts.
//
// The pipeline deliberately mirrors tepra.ts so the output is indistinguishable
// from text mode downstream: each frame's black region is traced into closed
// rings (even-odd, so interior holes stay empty), scaled into a `sizeMm` square
// cell, placed nearest-first along the feed axis, then handed to the SAME
// zigzag fill + inward outline passes. The result is one CAMEO/GRBL doc that
// draws frame N completely before N+1, so the tape advances one frame at a time
// just like one character at a time.
//
// Frame decoding runs in Rust (the `cmd_decode_gif` Tauri command) because the
// webview's WebCodecs ImageDecoder isn't enabled in the Tauri WKWebView/WebView2
// runtimes. Rust composites frame disposal and hands back packed 1-bit masks,
// which we unpack here into the byte-per-pixel FrameMask the tracer expects.

import * as api from "./api";
import {
  Bounds,
  DxfDocument,
  DxfLayer,
  PolyShape,
  translateDoc,
} from "./dxf";
import { offsetRingInward, type Polyline, type Ring } from "./polygonFill";
import { fillRegion, type FillMode } from "./concentricFill";

export type TepraGifOptions = {
  /** Decoded frames as binary masks (true = black/ON pixel). All same size. */
  frames: FrameMask[];
  /** Cell side in mm — each frame is fit into a square of this side (em height). */
  sizeMm: number;
  /** Extra gap between frames in mm (added to the per-cell step). */
  charSpacingMm: number;
  /** "horizontal" = row fed along the tape; "vertical" = stacked column (縦). */
  orientation: "horizontal" | "vertical";
  /** Hatch/offset pitch in mm: zigzag spacing AND the inward offset step. */
  lineGapMm: number;
  /** How many inward outline passes to trace (1 = just the region outline). */
  outlinePasses: number;
  /** Fill the black region's interior. */
  fill: boolean;
  /** Interior fill pattern: "zigzag" diagonal hatch or "concentric" loops. */
  fillMode: FillMode;
};

/** One decoded frame as a binary mask. `bits[y*width + x]` is 1 for black. */
export type FrameMask = {
  width: number;
  height: number;
  bits: Uint8Array;
};

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode every frame of the GIF at `path` into a binary mask via the Rust
 * `cmd_decode_gif` command. A pixel is "black" (ON) when its luminance is below
 * `threshold` (0–255) AND it is not fully transparent — so a black-on-
 * transparent or black-on-white GIF both work. Frames are downscaled in Rust so
 * the longest side is at most `maxSide` pixels (256 keeps shapes crisp while
 * keeping tracing fast and the IPC payload small).
 */
export async function decodeGifFrames(
  path: string,
  opts: { threshold?: number; maxSide?: number; onProgress?: (i: number, total: number) => void } = {},
): Promise<FrameMask[]> {
  const threshold = opts.threshold ?? 128;
  const maxSide = opts.maxSide ?? 256;

  const packed = await api.decodeGif(path, threshold, maxSide);

  // Unpack each frame's base64 1-bit mask into the byte-per-pixel form the
  // tracer expects (bits LSB-first within each byte, matching the Rust packer).
  const masks: FrameMask[] = packed.map((f, i) => {
    const raw = base64ToBytes(f.bits_b64);
    const n = f.width * f.height;
    const bits = new Uint8Array(n);
    for (let q = 0; q < n; q++) {
      bits[q] = (raw[q >> 3] >> (q & 7)) & 1;
    }
    opts.onProgress?.(i + 1, packed.length);
    return { width: f.width, height: f.height, bits };
  });

  if (masks.length === 0) throw new Error("GIF にフレームが見つかりませんでした。");
  return masks;
}

/** Decode a standard base64 string to bytes (atob is available in the webview). */
const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// ---------------------------------------------------------------------------
// Contour tracing (marching squares)
// ---------------------------------------------------------------------------

/**
 * Trace the boundary of the ON region of a binary mask into closed rings, in
 * PIXEL coordinates (x right, y down). Outer boundaries and hole boundaries are
 * both returned as separate rings; even-odd fill downstream then leaves holes
 * empty automatically, so winding direction does not matter here.
 *
 * Algorithm: classic marching squares on the dual grid. We sample 2×2 cells of
 * the mask; each of the 16 corner configurations contributes 0, 1, or 2 edge
 * segments between mid-points of the cell sides. We collect all segments and
 * stitch them into closed loops by endpoint adjacency. This is robust for
 * arbitrary bitmap shapes (unlike a single boundary walk, which breaks on
 * disconnected regions and holes).
 */
export const traceMask = (mask: FrameMask): Ring[] => {
  const { width: w, height: h, bits } = mask;
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && bits[y * w + x] === 1 ? 1 : 0;

  // Each segment is [ax, ay, bx, by] on the grid that runs from (-0.5,-0.5) to
  // (w-0.5, h-0.5); cell (cx, cy) has corners at pixels (cx-1..cx, cy-1..cy).
  // Mid-points are at integer + 0.5 offsets. We key endpoints to stitch loops.
  const segs: [number, number, number, number][] = [];

  // Iterate cells whose 2×2 corner window spans pixel rows/cols [cy-1, cy].
  for (let cy = 0; cy <= h; cy++) {
    for (let cx = 0; cx <= w; cx++) {
      const tl = on(cx - 1, cy - 1);
      const tr = on(cx, cy - 1);
      const br = on(cx, cy);
      const bl = on(cx - 1, cy);
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      // Mid-points of the four cell edges, in grid coords centred on the cell
      // (cx, cy) at corner pixel boundaries. The cell's centre is (cx-0.5, cy-0.5).
      const top: [number, number] = [cx - 0.5, cy - 1]; // between TL & TR
      const right: [number, number] = [cx, cy - 0.5]; // between TR & BR
      const bottom: [number, number] = [cx - 0.5, cy]; // between BR & BL
      const left: [number, number] = [cx - 1, cy - 0.5]; // between BL & TL

      const push = (a: [number, number], b: [number, number]) =>
        segs.push([a[0], a[1], b[0], b[1]]);

      // Marching-squares line cases. For the two saddle cases (5, 10) we split
      // into two non-crossing segments (consistent choice keeps loops closed).
      switch (code) {
        case 1: push(left, bottom); break;        // BL
        case 2: push(bottom, right); break;       // BR
        case 3: push(left, right); break;         // BL+BR
        case 4: push(top, right); break;          // TR
        case 5: push(top, right); push(left, bottom); break; // TR+BL (saddle)
        case 6: push(top, bottom); break;         // TR+BR
        case 7: push(top, left); break;           // TR+BR+BL
        case 8: push(top, left); break;           // TL
        case 9: push(top, bottom); break;         // TL+BL
        case 10: push(top, left); push(bottom, right); break; // TL+BR (saddle)
        case 11: push(top, right); break;         // TL+BL+BR
        case 12: push(left, right); break;        // TL+TR
        case 13: push(bottom, right); break;      // TL+TR+BL
        case 14: push(left, bottom); break;       // TL+TR+BR
      }
    }
  }

  // Stitch segments into closed loops by snapping endpoints to a grid key.
  const key = (x: number, y: number) => `${Math.round(x * 2)},${Math.round(y * 2)}`;
  // adjacency: endpoint key → list of {seg index, which end}
  const adj = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const ka = key(s[0], s[1]);
    const kb = key(s[2], s[3]);
    (adj.get(ka) ?? adj.set(ka, []).get(ka)!).push(i);
    (adj.get(kb) ?? adj.set(kb, []).get(kb)!).push(i);
  });

  const used = new Uint8Array(segs.length);
  const rings: Ring[] = [];

  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    const ring: Ring = [];
    let curIdx = start;
    let curPt: [number, number] = [segs[start][0], segs[start][1]];
    // Walk forward, always leaving the segment by its other endpoint, and at
    // each node hopping to an unused segment that touches it.
    let guard = segs.length + 4;
    while (curIdx >= 0 && guard-- > 0) {
      used[curIdx] = 1;
      const s = segs[curIdx];
      const a: [number, number] = [s[0], s[1]];
      const b: [number, number] = [s[2], s[3]];
      const fromA = key(curPt[0], curPt[1]) === key(a[0], a[1]);
      const next: [number, number] = fromA ? b : a;
      ring.push(next);
      // Find an unused neighbour segment at `next`.
      const cands = adj.get(key(next[0], next[1])) ?? [];
      let nextIdx = -1;
      for (const c of cands) {
        if (!used[c]) {
          nextIdx = c;
          break;
        }
      }
      curIdx = nextIdx;
      curPt = next;
    }
    if (ring.length >= 3) {
      // Simplify collinear runs to keep ring sizes sane before downstream work.
      rings.push(simplifyRing(ring));
    }
  }
  return rings;
};

/** Drop points that lie on the straight segment between their neighbours. */
const simplifyRing = (ring: Ring, eps = 1e-6): Ring => {
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

// ---------------------------------------------------------------------------
// Layout (mirrors tepra.ts placeGlyphs)
// ---------------------------------------------------------------------------

type PlacedFrame = { rings: Ring[]; feedPos: number };

/** A content crop box in NORMALIZED frame coordinates (0..1 of width/height). */
type NormBox = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * The COMMON FRAME: the union of every frame's black-content bounding box, in
 * normalized 0..1 coords (so frames of differing pixel sizes still combine).
 *
 * Each GIF frame's glyph fills only a fraction of the (square) canvas, at a
 * different spot per frame, so fitting the WHOLE canvas into a cell makes every
 * glyph tiny with huge dead margins (the "spacing looks enormous" bug). Instead
 * we crop every frame to ONE shared box — the tightest box that still contains
 * the content of all frames — then fit that box into the cell. Using the union
 * (not each frame's own box) keeps the glyphs' relative sizes and positions
 * (e.g. a common baseline) intact while removing the empty border.
 *
 * Returns the full [0,1] box if no frame has any content.
 */
export const unionContentBox = (frames: FrameMask[]): NormBox => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of frames) {
    const { width: w, height: h, bits } = f;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!bits[row + x]) continue;
        // Normalize by this frame's own size (pixel→0..1). For same-size frames
        // this is just /w, /h; differing sizes still align in 0..1 space.
        const nx0 = x / w, ny0 = y / h;
        const nx1 = (x + 1) / w, ny1 = (y + 1) / h; // pixel covers a cell
        if (nx0 < minX) minX = nx0;
        if (ny0 < minY) minY = ny0;
        if (nx1 > maxX) maxX = nx1;
        if (ny1 > maxY) maxY = ny1;
      }
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
};

/**
 * Scale one frame's pixel-space rings into a `sizeMm` square cell and translate
 * it to its slot in the row/column — for horizontal, rotate the whole line 90°
 * CW into the +Y feed axis (like tepra.ts), so feed order = frame order and the
 * finished tape reads correctly when turned upright.
 *
 * Crucially, the fit is computed against the SHARED `box` (the common frame),
 * not each frame's full canvas: the box is mapped to fill the cell (aspect
 * preserved, centred), and every frame uses the same mapping. This erases the
 * empty margin so glyphs are large and tightly spaced, while preserving each
 * glyph's relative size/position within the common frame.
 */
const placeFrames = (opts: TepraGifOptions): PlacedFrame[] => {
  const placed: PlacedFrame[] = [];
  const pitch = opts.sizeMm + opts.charSpacingMm;
  const rotCW = ([x, y]: [number, number]): [number, number] => [-y, x];

  const box = unionContentBox(opts.frames);

  opts.frames.forEach((frame, i) => {
    const rings = traceMask(frame);
    if (rings.length === 0) return; // blank frame → no shape, but still advances

    // The common box in THIS frame's pixels.
    const bx0 = box.minX * frame.width;
    const by0 = box.minY * frame.height;
    const boxW = (box.maxX - box.minX) * frame.width;
    const boxH = (box.maxY - box.minY) * frame.height;

    // Scale so the box fits the sizeMm square cell, aspect preserved; centre the
    // (possibly non-square) box within the cell.
    const s = opts.sizeMm / Math.max(boxW, boxH);
    const drawW = boxW * s;
    const drawH = boxH * s;
    const offX = (opts.sizeMm - drawW) / 2;
    const offY = (opts.sizeMm - drawH) / 2;
    // Map a pixel (px, py) → cell-local mm: subtract the box origin first.
    const toCell = (px: number, py: number): [number, number] => [
      (px - bx0) * s + offX,
      (py - by0) * s + offY,
    ];

    const base = i * pitch;
    if (opts.orientation === "horizontal") {
      // Cell laid along +X at penX=base, then rotated CW so it runs down +Y.
      const cellRings = rings.map((r) =>
        r.map(([px, py]) => {
          const [cx, cy] = toCell(px, py);
          return rotCW([cx + base, cy]);
        }),
      );
      placed.push({ rings: cellRings, feedPos: base });
    } else {
      // Vertical: stack cells down +Y, centred in X.
      const cellRings = rings.map((r) =>
        r.map(([px, py]) => {
          const [cx, cy] = toCell(px, py);
          return [cx, cy + base] as [number, number];
        }),
      );
      placed.push({ rings: cellRings, feedPos: base });
    }
  });

  placed.sort((a, b) => a.feedPos - b.feedPos); // nearest-first along feed axis
  return placed;
};

// Build outline-pass polylines for one frame's rings (same as tepra.ts).
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

export function generateTepraGif(opts: TepraGifOptions): {
  doc: DxfDocument;
  fileName: string;
} {
  const placed = placeFrames(opts);
  const lineGap = Math.max(0.1, opts.lineGapMm);
  const passes = Math.max(1, Math.round(opts.outlinePasses));

  // One layer, shapes in strict draw order — fill THEN outline per frame, frames
  // nearest-first — identical to tepra.ts so the plotter finishes one frame
  // before advancing the tape to the next.
  const shapes: PolyShape[] = [];
  for (const f of placed) {
    if (opts.fill) {
      for (const seg of fillRegion(f.rings, lineGap, opts.fillMode)) {
        shapes.push({ type: "poly", points: seg });
      }
    }
    for (const stroke of outlineStrokes(f.rings, lineGap, passes)) {
      shapes.push({ type: "poly", points: stroke });
    }
  }

  const dxfLayers: DxfLayer[] = [];
  if (shapes.length > 0) {
    dxfLayers.push({ name: "tepra-gif", color: "#d94a4a", shapes });
  }

  // Bounds, then snap to origin (same convention as tepra.ts / test pattern).
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

  return { doc, fileName: `tepragif.gen` };
}
