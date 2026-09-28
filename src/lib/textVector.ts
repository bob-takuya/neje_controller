// Text → vector outlines via opentype.js.
//
// Turns a string + a loaded font into flattened glyph outlines in millimetres,
// laid out in DESIGN SPACE (X right, Y DOWN — the same frame dxf.ts produces
// after toDesignSpace, and what the rest of the app draws/cuts). The tepra
// label generator (tepra.ts) consumes these to build a DxfDocument that can be
// sent to the CAMEO plotter.
//
// opentype.js gives each glyph as a Path of move/line/quadratic/cubic commands
// in FONT UNITS with Y pointing UP. We:
//   1. scale font units → mm by (sizeMm / unitsPerEm), so `sizeMm` is the
//      em-square height (a conventional "font size");
//   2. flip Y (font Y-up → design Y-down) by negating and offsetting so the
//      glyph's top sits near y=0;
//   3. flatten béziers to polylines at a chord tolerance fine enough for the
//      blade (curves are re-checked against the CAMEO cut tolerance downstream).
//
// Each contour becomes ONE closed polyline. A glyph with holes (e.g. "o", "あ"
// counters) yields multiple contours; the fill pass in tepra.ts uses even-odd
// containment so holes stay empty.

// opentype.js's ESM build exports named symbols only (no default). `parse`,
// `Font`, `Glyph` are runtime; `PathCommand` is a type from @types/opentype.js.
import { parse as parseOpentype, Font, Glyph, PathCommand } from "opentype.js";

export type Polyline = [number, number][];

/** One laid-out glyph: its contours (closed polylines, design space) + advance. */
export type GlyphOutline = {
  char: string;
  /** Closed contours in mm, design space (Y down), origin at glyph pen start. */
  contours: Polyline[];
  /** Horizontal advance width in mm (for horizontal layout). */
  advanceMm: number;
};

/**
 * Parse a font from raw bytes (read via the Tauri fs plugin). Throws on an
 * unsupported/corrupt file — callers surface the message to the user.
 */
export function parseFont(bytes: ArrayBuffer): Font {
  // parse() wants an ArrayBuffer; it throws synchronously on bad data.
  return parseOpentype(bytes);
}

/**
 * A short human label for a font (family + style), for the UI dropdown.
 *
 * opentype.js exposes names in two shapes depending on version: a flat
 * `{ fontFamily: { en: "..." } }` OR nested by platform
 * `{ windows: { fontFamily: { en: "..." } }, macintosh: {...} }`. We probe both
 * and fall back through fullName → postScriptName → a fixed label.
 */
export function fontLabel(font: Font): string {
  const names = font.names as unknown as Record<string, any>;
  const localized = (v: any): string | undefined =>
    v && typeof v === "object" ? v.en ?? Object.values(v)[0] : undefined;
  // Look up a name field across flat + per-platform layouts.
  const field = (key: string): string | undefined => {
    const direct = localized(names?.[key]);
    if (direct) return direct;
    for (const plat of ["windows", "macintosh"]) {
      const v = localized(names?.[plat]?.[key]);
      if (v) return v;
    }
    return undefined;
  };
  const family = field("fontFamily") ?? field("fullName") ?? field("postScriptName");
  if (!family) return "Font";
  const sub = field("fontSubfamily");
  return sub && sub.toLowerCase() !== "regular" ? `${family} ${sub}` : family;
}

// Flatten a quadratic bézier (p0→ctrl→p1) into `steps` segments, excluding p0.
const flattenQuad = (
  p0: [number, number],
  c: [number, number],
  p1: [number, number],
  steps: number,
  out: Polyline,
) => {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0];
    const y = mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1];
    out.push([x, y]);
  }
};

// Flatten a cubic bézier (p0→c1→c2→p1) into `steps` segments, excluding p0.
const flattenCubic = (
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p1: [number, number],
  steps: number,
  out: Polyline,
) => {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x =
      mt * mt * mt * p0[0] +
      3 * mt * mt * t * c1[0] +
      3 * mt * t * t * c2[0] +
      t * t * t * p1[0];
    const y =
      mt * mt * mt * p0[1] +
      3 * mt * mt * t * c1[1] +
      3 * mt * t * t * c2[1] +
      t * t * t * p1[1];
    out.push([x, y]);
  }
};

// Bézier subdivision count. Glyph curves are small; 8 steps is smooth at label
// sizes and the downstream collinear-simplify pass drops redundant points.
const CURVE_STEPS = 8;

/**
 * Convert one glyph's opentype Path commands into closed contours in mm,
 * design space (Y down). `scale` = sizeMm / unitsPerEm; `ascentMm` offsets so
 * the glyph top sits at small positive Y (text grows downward from y≈0).
 */
const glyphToContours = (
  glyph: Glyph,
  scale: number,
  ascentMm: number,
): Polyline[] => {
  // glyph.path.commands are raw font-unit move/line/quad/cubic ops with Y up.
  // We transform them ourselves (rather than getPath(x,y,size)) so the Y-flip
  // and mm scaling stay explicit and consistent with the rest of the pipeline.
  const cmds: PathCommand[] = glyph.path.commands;
  const contours: Polyline[] = [];
  let cur: Polyline = [];

  // Font Y is up; design Y is down. tx/ty map a font-unit point to design mm.
  const tx = (x: number) => x * scale;
  const ty = (y: number) => ascentMm - y * scale;

  let startPt: [number, number] | null = null;
  for (const c of cmds) {
    switch (c.type) {
      case "M": {
        if (cur.length > 1) contours.push(cur);
        cur = [];
        const p: [number, number] = [tx(c.x), ty(c.y)];
        startPt = p;
        cur.push(p);
        break;
      }
      case "L": {
        cur.push([tx(c.x), ty(c.y)]);
        break;
      }
      case "Q": {
        const p0 = cur[cur.length - 1];
        flattenQuad(p0, [tx(c.x1), ty(c.y1)], [tx(c.x), ty(c.y)], CURVE_STEPS, cur);
        break;
      }
      case "C": {
        const p0 = cur[cur.length - 1];
        flattenCubic(
          p0,
          [tx(c.x1), ty(c.y1)],
          [tx(c.x2), ty(c.y2)],
          [tx(c.x), ty(c.y)],
          CURVE_STEPS,
          cur,
        );
        break;
      }
      case "Z": {
        // Close: ensure the contour ends where it began.
        if (startPt && cur.length > 0) {
          const last = cur[cur.length - 1];
          if (last[0] !== startPt[0] || last[1] !== startPt[1]) cur.push([...startPt]);
        }
        if (cur.length > 1) contours.push(cur);
        cur = [];
        break;
      }
    }
  }
  if (cur.length > 1) contours.push(cur);
  return contours;
};

/**
 * Lay out a string as a sequence of glyph outlines (each glyph's contours are
 * in its own local frame with origin at the glyph's pen position — the caller
 * positions glyphs using `advanceMm`). `sizeMm` is the em height.
 *
 * `fonts` may be a single Font or an ordered STACK. With a stack, each
 * character is rendered by the first font that has a glyph for it
 * (multilingual "Auto" mode); a character no font covers contributes a blank
 * advance from the first font so spacing stays regular. Each glyph is scaled
 * by ITS OWN font's unitsPerEm so the requested em height holds across mixed
 * fonts, and aligned by its own ascent so baselines line up.
 *
 * Kerning is NOT applied (kerning + plotter pen width is below the device's
 * resolution and the tepra layout uses explicit letter spacing anyway).
 */
export function layoutGlyphs(
  fonts: Font | Font[],
  text: string,
  sizeMm: number,
): GlyphOutline[] {
  const stack = Array.isArray(fonts) ? fonts : [fonts];
  if (stack.length === 0) return [];

  // Per-font metrics, computed once.
  const metric = (f: Font) => {
    const upm = f.unitsPerEm || 1000;
    const scale = sizeMm / upm;
    return { upm, scale, ascentMm: (f.ascender ?? upm * 0.8) * scale };
  };
  const metrics = new Map<Font, ReturnType<typeof metric>>();
  const metricFor = (f: Font) => {
    let m = metrics.get(f);
    if (!m) {
      m = metric(f);
      metrics.set(f, m);
    }
    return m;
  };

  // First font that has a glyph for `ch`, or null.
  const pick = (ch: string): Font | null => {
    for (const f of stack) {
      try {
        if (f.hasChar(ch)) return f;
      } catch {
        /* exotic input — treat as no glyph */
      }
    }
    return null;
  };

  const out: GlyphOutline[] = [];
  for (const ch of text) {
    const isSpace = ch.trim() === "";
    const owner = isSpace ? stack[0] : pick(ch) ?? stack[0];
    const m = metricFor(owner);
    const glyph = owner.charToGlyph(ch);
    const advanceMm = (glyph.advanceWidth ?? m.upm * 0.5) * m.scale;
    // Whitespace, or a char no font covers, contributes advance but no outline.
    const contours =
      isSpace || !owner.hasChar(ch)
        ? []
        : glyphToContours(glyph, m.scale, m.ascentMm);
    out.push({ char: ch, contours, advanceMm });
  }
  return out;
}
