// Run the actual buildGCode pipeline and count M5/M4 sync stalls and total
// blocks.
//
// Usage: npx tsx bench-gcode.mjs <input.dxf>

import fs from "node:fs";

const { parseDxf } = await import("./src/lib/dxf.ts");
const { buildGCode, defaultLayerParams } = await import("./src/lib/gcode.ts");

const [, , inPath] = process.argv;
const text = fs.readFileSync(inPath, "utf8");
const doc = parseDxf(text);
const layers = defaultLayerParams(doc);

const lines = buildGCode(doc, {
  layers,
  travelFeed: 3000,
  dynamicPower: true,
  returnHome: false,
  placement: { x: 0, y: 0 },
});

const counts = { total: lines.length, m5: 0, m4: 0, m3: 0, g0: 0, g1: 0, g2g3: 0 };
for (const l of lines) {
  if (l.startsWith("M5")) counts.m5++;
  else if (l.startsWith("M4")) counts.m4++;
  else if (l.startsWith("M3")) counts.m3++;
  else if (l.startsWith("G0")) counts.g0++;
  else if (l.startsWith("G1")) counts.g1++;
  else if (l.startsWith("G2") || l.startsWith("G3")) counts.g2g3++;
}

console.log(JSON.stringify(counts, null, 2));
