// Verify the anchor pairing by walking both programs from a known-good
// earlier anchor up to the resume index and showing both sides interleaved.
//
// Usage: npx tsx bench-verify.mjs <dxf> <stopAt> <aIdx> <bIdx> <window>

import fs from "node:fs";

const { parseDxf, flattenShape } = await import("./src/lib/dxf.ts");
const { buildGCode, defaultLayerParams } = await import("./src/lib/gcode.ts");

const [, , dxfPath, _stopAt, aIdxStr, bIdxStr, winStr] = process.argv;
const aIdx = parseInt(aIdxStr, 10);
const bIdx = parseInt(bIdxStr, 10);
const win = parseInt(winStr || "100", 10);

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
const params = { layers, travelFeed: 3000, dynamicPower: true, returnHome: true, placement: { x: 0, y: 0 } };

const A = buildGCode(doc, params);
const fA = []; const fA2raw = [];
for (let i = 0; i < A.length; i++) { const n = normalize(A[i]); if (n != null) { fA.push(n); fA2raw.push(i); } }

const flatDoc = { ...doc, layers: doc.layers.map((l) => ({ ...l, shapes: l.shapes.map((s) => s.type === "poly" ? s : ({ type: "poly", points: flattenShape(s) })) })) };
const B = buildGCode(flatDoc, params);
const fB = []; const fB2raw = [];
for (let i = 0; i < B.length; i++) { const n = normalize(B[i]); if (n != null) { fB.push(n); fB2raw.push(i); } }

// Print A around aIdx and B around bIdx, side-by-side.
const aFrom = Math.max(0, aIdx - win);
const bFrom = Math.max(0, bIdx - win);

// Find anchors in this window (lines equal in filtered space).
const anchors = [];
let a = aFrom, b = bFrom;
const aTo = Math.min(fA.length, aIdx + 5);
const bTo = Math.min(fB.length, bIdx + 5);
const aLines = fA.slice(aFrom, aTo);
const bLines = fB.slice(bFrom, bTo);

// Greedy align inside this window for visualization.
const bIdxMap = new Map();
for (let i = 0; i < bLines.length; i++) {
  let arr = bIdxMap.get(bLines[i]);
  if (!arr) { arr = []; bIdxMap.set(bLines[i], arr); }
  arr.push(i);
}
const earliestAfter = (line, from) => {
  const arr = bIdxMap.get(line);
  if (!arr) return -1;
  for (const v of arr) if (v >= from) return v;
  return -1;
};

const pairs = [];
let bp = 0;
for (let ap = 0; ap < aLines.length; ap++) {
  const t = earliestAfter(aLines[ap], bp);
  if (t >= 0) {
    pairs.push({ a: aFrom + ap, b: bFrom + t, line: aLines[ap] });
    bp = t + 1;
  }
}

// Print 10 anchor pairs around the resume point.
const anchorsBeforeStop = pairs.filter(p => p.a < aIdx).slice(-5);
const anchorsAt = pairs.filter(p => p.a === aIdx);
const anchorsAfterStop = pairs.filter(p => p.a > aIdx).slice(0, 3);

console.log("== anchors right before stop ==");
for (const p of anchorsBeforeStop) console.log(`  A[${p.a}]  ↔  B[${p.b}]  :  ${p.line}`);
console.log("== anchor AT stop (this is the resume point) ==");
for (const p of anchorsAt) console.log(`  A[${p.a}]  ↔  B[${p.b}]  :  ${p.line}`);
console.log("== anchors right after stop ==");
for (const p of anchorsAfterStop) console.log(`  A[${p.a}]  ↔  B[${p.b}]  :  ${p.line}`);

console.log("");
console.log(`anchor density in window (${aFrom}..${aIdx + 5}, total ${aIdx + 5 - aFrom} A lines):`);
console.log(`  pairs found: ${pairs.length}`);
console.log(`  A lines without B match in window: ${aTo - aFrom - pairs.length}`);
console.log(`  B lines unmatched (likely arc expansions): ${bTo - bFrom - pairs.length}`);
console.log(`  expansion ratio B/A in window: ${((bTo - bFrom) / (aTo - aFrom)).toFixed(2)}`);

// Show the lines themselves around the anchor pair, side-by-side (10 each).
console.log("");
console.log("== last 10 raw lines of programs before the resume point ==");
const showFromA = fA2raw[aIdx] - 10;
const showFromB = fB2raw[bIdx] - 10;
for (let k = 0; k < 12; k++) {
  const al = A[showFromA + k] ?? "";
  const bl = B[showFromB + k] ?? "";
  console.log(`A[${(showFromA + k).toString().padStart(5)}]: ${al.padEnd(45)} | B[${(showFromB + k).toString().padStart(5)}]: ${bl}`);
}
