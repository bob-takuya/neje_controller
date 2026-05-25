// Carefully verify the proposed resume index by:
//  1. Counting how many G0 anchors A and B share up to and including the
//     proposed anchor. They should match — i.e. the N-th G0 in A is the
//     same as the N-th G0 in B for N <= ourAnchorN.
//  2. Dumping the lines AROUND the anchor on both sides so a human can
//     eyeball alignment.
//  3. Checking that all G0 lines BEFORE stopAt in A appear (in the same
//     order, with same N) in B before our resume index.
//
// Usage: npx tsx bench-verify.mjs <dxf> <stopAt>

import fs from "node:fs";

const { parseDxf } = await import("./src/lib/dxf.ts");
const { buildGCode, defaultLayerParams } =
  await import("./src/lib/gcode.ts");

const [, , dxfPath, stopAtStr] = process.argv;
const stopAt = parseInt(stopAtStr, 10);

const normalize = (raw) => {
  let s = ""; let d = 0;
  for (const ch of raw) {
    if (ch === "(") d++;
    else if (ch === ")") { if (d > 0) d--; }
    else if (ch === ";" || ch === "\n" || ch === "\r") break;
    else if (d === 0) s += ch;
  }
  s = s.trim();
  return s.length === 0 ? null : s;
};

const text = fs.readFileSync(dxfPath, "utf8");
const params = {
  travelFeed: 3000, dynamicPower: true, returnHome: true,
  placement: { x: 0, y: 0 },
};

const docA = parseDxf(text, { disableBiarc: false });
const layersA = defaultLayerParams(docA);
const programA = buildGCode(docA, { ...params, layers: layersA });
const filteredA = []; const fA2raw = [];
for (let i = 0; i < programA.length; i++) {
  const n = normalize(programA[i]);
  if (n != null) { filteredA.push(n); fA2raw.push(i); }
}

const docB = parseDxf(text, { disableBiarc: true });
const layersB = defaultLayerParams(docB);
const programB = buildGCode(docB, { ...params, layers: layersB });
const filteredB = []; const fB2raw = [];
for (let i = 0; i < programB.length; i++) {
  const n = normalize(programB[i]);
  if (n != null) { filteredB.push(n); fB2raw.push(i); }
}

console.log(`A filtered=${filteredA.length}  B filtered=${filteredB.length}`);

// Extract every G0 line from A (up to stopAt) and B (full).
const G0_RE = /^G0\s/;
const aG0 = []; // {idx, text}
for (let i = 0; i <= Math.min(stopAt, filteredA.length - 1); i++) {
  if (G0_RE.test(filteredA[i])) aG0.push({ idx: i, text: filteredA[i] });
}
const bG0 = [];
for (let i = 0; i < filteredB.length; i++) {
  if (G0_RE.test(filteredB[i])) bG0.push({ idx: i, text: filteredB[i] });
}

console.log(`A: ${aG0.length} G0 lines before stopAt`);
console.log(`B: ${bG0.length} G0 lines total`);

// Check: do the first `aG0.length` G0 lines in B match A's G0 sequence?
let matches = 0, mismatches = 0;
const mismatchExamples = [];
for (let i = 0; i < aG0.length; i++) {
  if (i >= bG0.length) { mismatches++; continue; }
  if (aG0[i].text === bG0[i].text) matches++;
  else {
    mismatches++;
    if (mismatchExamples.length < 10) {
      mismatchExamples.push({ n: i, a: aG0[i].text, b: bG0[i].text });
    }
  }
}
console.log("");
console.log(`G0-by-G0 alignment check: ${matches} match / ${mismatches} mismatch (of ${aG0.length})`);
if (mismatches > 0) {
  console.log("  first 10 mismatches:");
  for (const m of mismatchExamples) {
    console.log(`    G0 #${m.n}:  A="${m.a}"  B="${m.b}"`);
  }
}

// Show the last few G0 anchors before stopAt and where they land in B.
console.log("");
console.log("=== last 5 G0s in A before stopAt (and their B match) ===");
for (const g of aG0.slice(-5)) {
  // Find the SAME text in B at the same ordinal position.
  // Ordinal = how many times g.text appears in A up to and including g.idx.
  let occ = 0;
  for (let i = 0; i <= g.idx; i++) if (filteredA[i] === g.text) occ++;
  // Find the occ-th occurrence in B.
  let count = 0, bIdx = -1;
  for (let i = 0; i < filteredB.length; i++) {
    if (filteredB[i] === g.text) {
      count++;
      if (count === occ) { bIdx = i; break; }
    }
  }
  console.log(`  A[${g.idx}] "${g.text}"  → B[${bIdx}] (occurrence #${occ})`);
}

// Dump lines around the proposed anchor.
// Use the last G0 (the one bench-resume picked).
const last = aG0[aG0.length - 1];
let occ = 0;
for (let i = 0; i <= last.idx; i++) if (filteredA[i] === last.text) occ++;
let count = 0, anchorBIdx = -1;
for (let i = 0; i < filteredB.length; i++) {
  if (filteredB[i] === last.text) {
    count++;
    if (count === occ) { anchorBIdx = i; break; }
  }
}

console.log("");
console.log(`=== context around anchor A[${last.idx}] ↔ B[${anchorBIdx}] ===`);
for (let k = -8; k <= 8; k++) {
  const aL = filteredA[last.idx + k] ?? "";
  const bL = filteredB[anchorBIdx + k] ?? "";
  const tag = k === 0 ? "  ← ANCHOR" : "";
  console.log(`  k=${k.toString().padStart(3)}: A="${aL.padEnd(40)}" | B="${bL}"${tag}`);
}

// Last sanity: count lines between A[anchor]..A[stopAt] vs A's prior G0 → stopAt.
console.log("");
console.log(`A: ${stopAt - last.idx} lines between anchor and stopAt`);
// In B, the corresponding tail length starts from anchorBIdx and goes to
// where stopAt's mirror would be — but since there's no exact mirror in B
// we just note tail length.
console.log(`B: resume tail length = ${filteredB.length - anchorBIdx} lines`);
