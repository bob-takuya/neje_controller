// Find a resume index in the biarc-disabled program that corresponds to
// the stop line in the biarc-enabled program.
//
// Strategy ("G0 anchor"):
//
//   biarc on  → biarc off changes the shape COUNT and ORDER (the fitter
//   splits a single SPLINE into many "line + arc" shapes, which the no-
//   biarc path keeps as one polyline). So line-by-line LCS isn't usable.
//
//   What IS stable across both pipelines:
//     - The set of "shape origins" — every shape in the layer emits a G0
//       to its starting MCS coordinate before the cut moves begin.
//     - The XY coordinate of that G0 is a property of the original DXF
//       entity (the fitter doesn't move endpoints), so the same G0 line
//       appears in both A and B, just at different indices.
//
//   So: walk A up to stopAt and grab the most recent G0 line. Find the
//   same G0 line in B. That's where we resume.
//
//   Failure mode: if the same G0 appears multiple times in B (separate
//   shapes happening to start at the same point — rare), we pick the
//   N-th occurrence where N is the count of identical G0s in A up to
//   stopAt. That keeps the mapping monotonic.
//
// Usage: npx tsx bench-resume.mjs <dxf> <stopAt> <out.gcode>

import fs from "node:fs";

const { parseDxf } = await import("./src/lib/dxf.ts");
const { buildGCode, defaultLayerParams } =
  await import("./src/lib/gcode.ts");

const [, , dxfPath, stopAtStr, outPath] = process.argv;
if (!dxfPath || !stopAtStr || !outPath) {
  console.error("usage: bench-resume.mjs <dxf> <stopAt> <out.gcode>");
  process.exit(1);
}
const stopAt = parseInt(stopAtStr, 10);

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

const params = {
  travelFeed: 3000,
  dynamicPower: true,
  returnHome: true,
  placement: { x: 0, y: 0 },
};

const docA = parseDxf(text, { disableBiarc: false });
const layersA = defaultLayerParams(docA);
const programA = buildGCode(docA, { ...params, layers: layersA });
const filteredA = [];
for (const l of programA) {
  const n = normalize(l);
  if (n != null) filteredA.push(n);
}
console.log(`A raw=${programA.length} filtered=${filteredA.length}`);

const docB = parseDxf(text, { disableBiarc: true });
const layersB = defaultLayerParams(docB);
const programB = buildGCode(docB, { ...params, layers: layersB });
const filteredB = [];
for (const l of programB) {
  const n = normalize(l);
  if (n != null) filteredB.push(n);
}
console.log(`B raw=${programB.length} filtered=${filteredB.length}`);

// In A, find every G0 at-or-before stopAt and record (lineIndex, lineText).
const G0_RE = /^G0\s/;
const aG0sBeforeStop = [];
for (let i = 0; i <= Math.min(stopAt, filteredA.length - 1); i++) {
  if (G0_RE.test(filteredA[i])) aG0sBeforeStop.push({ i, text: filteredA[i] });
}
if (aG0sBeforeStop.length === 0) {
  console.error("no G0 found in A before stopAt — can't anchor");
  process.exit(2);
}
const lastG0A = aG0sBeforeStop[aG0sBeforeStop.length - 1];

// Count how many times the same G0 text appears in A up to (and including)
// the lastG0A position. We'll pick the same-numbered occurrence in B.
let occurrenceCount = 0;
for (let i = 0; i <= lastG0A.i; i++) {
  if (filteredA[i] === lastG0A.text) occurrenceCount++;
}

// Find the same-numbered occurrence in B.
let foundCount = 0;
let bIdx = -1;
for (let i = 0; i < filteredB.length; i++) {
  if (filteredB[i] === lastG0A.text) {
    foundCount++;
    if (foundCount === occurrenceCount) {
      bIdx = i;
      break;
    }
  }
}

if (bIdx < 0) {
  console.error(`G0 anchor "${lastG0A.text}" not found in B (need occurrence ${occurrenceCount})`);
  process.exit(3);
}

console.log(`anchor G0: "${lastG0A.text}"`);
console.log(`  in A at filtered index ${lastG0A.i} (${stopAt - lastG0A.i} lines before stop)`);
console.log(`  in B at filtered index ${bIdx}`);

// Map back to raw B index. (filteredB was built by walking programB; for
// the raw index we walk again.)
let raw = -1;
let fcount = 0;
for (let i = 0; i < programB.length; i++) {
  if (normalize(programB[i]) != null) {
    if (fcount === bIdx) { raw = i; break; }
    fcount++;
  }
}
console.log(`  in B raw program at index ${raw}`);

// Emit resume program: minimal header + programB from raw onward.
const out = [];
out.push(`; --- RESUME (biarc off) from B[${bIdx}] / raw ${raw} ---`);
out.push(`; anchor: ${lastG0A.text}`);
out.push(`; A stopAt=${stopAt}; matched G0 ${stopAt - lastG0A.i} lines before stop`);
out.push("G21");
out.push("G90");
out.push("$32=1");
out.push("M5");
// Re-arm the most recent M3/M4 from B's header.
const HEADER_LASER = /^(M3|M4)\b.*\bS\d/;
for (let i = 0; i < raw; i++) {
  if (HEADER_LASER.test(programB[i])) {
    out.push(programB[i]);
    break;
  }
}
for (let i = raw; i < programB.length; i++) out.push(programB[i]);

fs.writeFileSync(outPath, out.join("\n") + "\n");
console.log(`wrote ${outPath}: ${out.length} lines (resume into B[${bIdx}])`);
console.log(`\nIN THE APP: with "Disable biarc fit (parse-time)" ON and the DXF re-opened,`);
console.log(`Resume at: ${bIdx}`);
