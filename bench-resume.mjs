// Build a resume program that switches the *active* job from biarc-enabled
// to biarc-disabled emission, picking up at the line that corresponds to
// `stopAt` in the current (biarc-enabled) program.
//
// Strategy ("anchor-based"):
//
//   1. Build the biarc-enabled program A using the same parameters the
//      running job used.
//   2. Build the biarc-disabled program B by flattening every arc/circle
//      shape into a polyline first, then running the same emitter.
//   3. Filter both A and B to keep only lines that GRBL would actually
//      consume (`normalize_line` equivalent: strip comments/parens/blanks).
//      `stopAt` is in filtered-A coordinates because that's what the UI's
//      progress bar shows.
//   4. Walk filtered-A and filtered-B in parallel. Any time we see the
//      same exact filtered line in both at the SAME relative progression,
//      mark it as an anchor pairing A[i] ↔ B[j]. Lines that differ are
//      either arc/circle expansions (A: one G2/G3 line, B: many G1 lines)
//      or whole-line content differences from biarc fitting.
//   5. Find the latest anchor where A[i] ≤ stopAt. That anchor's B[j] is
//      where we resume B from.
//
//   The matching loop is a textbook LCS-light: it advances both pointers
//   on equal lines, and on a mismatch it skips ahead in B (since B has
//   STRICTLY MORE lines than A wherever an arc/circle was expanded). If
//   we ever fall off the end of B before A reaches stopAt, the program
//   ordering assumption is broken and we bail out.
//
// Safety bias: when in doubt prefer redoing a few millimeters of cuts to
// missing any cuts. The resume index is the line AT the anchor, not
// after — so the anchor itself gets re-sent. For non-motion anchors
// (M5, M4 S..., G21, etc.) re-sending is harmless. For G0 anchors at
// shape boundaries it just re-issues the rapid we already did.
//
// Usage: npx tsx bench-resume.mjs <dxf> <stopAtFilteredIdx> <out.gcode>

import fs from "node:fs";

const { parseDxf, flattenShape } = await import("./src/lib/dxf.ts");
const { buildGCode, defaultLayerParams } =
  await import("./src/lib/gcode.ts");

const [, , dxfPath, stopAtStr, outPath] = process.argv;
if (!dxfPath || !stopAtStr || !outPath) {
  console.error("usage: bench-resume.mjs <dxf> <stopAtFilteredIdx> <out.gcode>");
  process.exit(1);
}
const stopAt = parseInt(stopAtStr, 10);

// Matches GRBL `normalize_line`: strip parenthesized comments, drop after
// `;`, trim, drop if empty. Returns null for filtered-out lines.
const normalize = (raw) => {
  let s = "";
  let depth = 0;
  for (const ch of raw) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth > 0) depth--;
    } else if (ch === ";" || ch === "\n" || ch === "\r") break;
    else if (depth === 0) s += ch;
  }
  s = s.trim();
  return s.length === 0 ? null : s;
};

const text = fs.readFileSync(dxfPath, "utf8");

const doc = parseDxf(text);
const layers = defaultLayerParams(doc);

// User said: Dynamic power ✅, Return-to-origin ✅, Dry-run ✗
const params = {
  layers,
  travelFeed: 3000,
  dynamicPower: true,
  returnHome: true,
  placement: { x: 0, y: 0 },
};

// --- A: biarc-enabled (the running job) ---
const programA = buildGCode(doc, params);
const filteredA = [];
const filteredAToRaw = []; // map filteredA index → programA index
for (let i = 0; i < programA.length; i++) {
  const n = normalize(programA[i]);
  if (n != null) {
    filteredA.push(n);
    filteredAToRaw.push(i);
  }
}
console.log(`A raw=${programA.length} filtered=${filteredA.length}`);

// --- B: biarc-disabled (replace arcs/circles with flattened polylines) ---
const flatDoc = {
  ...doc,
  layers: doc.layers.map((layer) => ({
    ...layer,
    shapes: layer.shapes.map((s) => {
      if (s.type === "poly") return s;
      const points = flattenShape(s);
      return { type: "poly", points };
    }),
  })),
};
const programB = buildGCode(flatDoc, params);
const filteredB = [];
const filteredBToRaw = [];
for (let i = 0; i < programB.length; i++) {
  const n = normalize(programB[i]);
  if (n != null) {
    filteredB.push(n);
    filteredBToRaw.push(i);
  }
}
console.log(`B raw=${programB.length} filtered=${filteredB.length}`);

// --- Anchor scan ----------------------------------------------------------
// Two pointers a (in filteredA) and b (in filteredB). On equal lines emit
// an anchor and advance both. On mismatch advance b (B is the "expanded"
// program with extra G1 sequences inside what was one G2/G3 in A). If b
// runs to the end we also try advancing a (covers oddities like A having
// shorter "arc" representations that aren't strictly contained in B).
// Build a small index: for each filtered B line, the list of indices where
// it occurs. Lets us, given the next A line we're looking for, find the
// earliest B occurrence at-or-after our current b in O(log n).
//
// Memory: ~93k strings → tens of MB worst case; fine for offline use.
const bIndex = new Map();
for (let i = 0; i < filteredB.length; i++) {
  const v = filteredB[i];
  let arr = bIndex.get(v);
  if (!arr) { arr = []; bIndex.set(v, arr); }
  arr.push(i);
}
const earliestBAfter = (line, fromB) => {
  const arr = bIndex.get(line);
  if (!arr) return -1;
  // Binary search the first occurrence >= fromB.
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < fromB) lo = mid + 1;
    else hi = mid;
  }
  return lo < arr.length ? arr[lo] : -1;
};

// Greedy with "look ahead from a, find earliest B match >= b". This is
// equivalent to walking both pointers and treating B as the "expanded"
// stream — any A line that has a future B match anchors there. Any A line
// that DOESN'T appear in B from b onward is dropped (rare, usually the
// last header line at the very end of the program).
let a = 0, b = 0;
let bestAnchorA = -1, bestAnchorB = -1;

while (a < filteredA.length) {
  const targetB = earliestBAfter(filteredA[a], b);
  if (targetB >= 0) {
    // Anchor: A[a] == B[targetB].
    if (a <= stopAt) {
      bestAnchorA = a;
      bestAnchorB = targetB;
    } else {
      // We've gone past the stop; no point continuing.
      break;
    }
    a++;
    b = targetB + 1;
  } else {
    // No future occurrence of A[a] in B — skip this A line.
    a++;
  }
}

if (bestAnchorA < 0) {
  console.error("no anchor before stopAt — order assumption broken");
  process.exit(2);
}
console.log(
  `last anchor before stopAt=${stopAt}: A[${bestAnchorA}] ↔ B[${bestAnchorB}]`,
);
console.log(`  anchor line content: ${filteredA[bestAnchorA]}`);
console.log(`  anchor distance from stop: ${stopAt - bestAnchorA} filtered lines`);

// --- Emit resume program --------------------------------------------------
// We use programB (raw, with comments) as the source so the resume file is
// human-readable. The anchor's raw index is filteredBToRaw[bestAnchorB].
const tailStart = filteredBToRaw[bestAnchorB];
const headerLines = [];
// Re-emit a small canonical header so modal state is known even if the
// anchor lands mid-shape (it shouldn't, but defensive).
for (let i = 0; i < tailStart; i++) {
  const l = programB[i];
  if (
    /^G21\b/.test(l) ||
    /^G90\b/.test(l) ||
    /^\$32=1\b/.test(l) ||
    /^M[345]\b/.test(l)
  ) {
    headerLines.push(l);
  }
}
// Deduplicate while preserving order.
const seen = new Set();
const dedupedHeader = [];
for (const l of headerLines) {
  if (!seen.has(l)) {
    seen.add(l);
    dedupedHeader.push(l);
  }
}

const out = [];
out.push(`; --- RESUME (biarc off) at filtered B[${bestAnchorB}] / raw ${tailStart} ---`);
out.push(`; matched A[${bestAnchorA}] of ${filteredA.length} (stopAt was ${stopAt})`);
out.push(`; will redo ${stopAt - bestAnchorA} filtered lines, no gaps`);
out.push("G21");
out.push("G90");
out.push("$32=1");
out.push("M5");
for (const l of dedupedHeader) out.push(l);
for (let i = tailStart; i < programB.length; i++) out.push(programB[i]);

fs.writeFileSync(outPath, out.join("\n") + "\n");
console.log(`wrote ${outPath}: ${out.length} lines`);
