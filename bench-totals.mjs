import fs from "node:fs";
const { parseDxf } = await import("./src/lib/dxf.ts");
const { buildGCode, defaultLayerParams } = await import("./src/lib/gcode.ts");

const input = process.argv[2];
if (!input) {
  console.error("usage: node bench-totals.mjs <file.dxf>");
  process.exit(1);
}
const text = fs.readFileSync(input, "utf8");
const doc = parseDxf(text);
const layers = defaultLayerParams(doc);

const combos = [
  [3000, true, true], [3000, true, false], [3000, false, true], [3000, false, false],
  [1500, true, true], [1500, true, false],
  [6000, true, true], [6000, true, false],
];
for (const [tf, dp, rh] of combos) {
  const p = buildGCode(doc, {
    layers, travelFeed: tf, dynamicPower: dp, returnHome: rh,
    placement: { x: 0, y: 0 },
  });
  console.log(`travelFeed=${tf} dynamic=${dp} returnHome=${rh} → ${p.length}`);
}
