// Run the actual TypeScript parseDxf (via tsx) on an input DXF, then emit a
// DXF reconstructed from the post-biarc Shape list. The output uses only
// LINE and ARC entities so you can open it in any CAD viewer and visually
// confirm that the simplified geometry matches the original.
//
// Usage: node bench-export.mjs <input.dxf> <output.dxf>

// Run with: npx tsx bench-export.mjs <input.dxf> <output.dxf>
// (tsx hooks itself in via its own CLI; no register() needed here.)
import fs from "node:fs";

const { parseDxf } = await import("./src/lib/dxf.ts");

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node bench-export.mjs <input.dxf> <output.dxf>");
  process.exit(1);
}

const text = fs.readFileSync(inPath, "utf8");
const doc = parseDxf(text);

// --- Stats ---
let polyVerts = 0, polyShapes = 0, arcs = 0, circles = 0;
for (const layer of doc.layers) {
  for (const s of layer.shapes) {
    if (s.type === "poly") {
      polyShapes++;
      polyVerts += s.points.length;
    } else if (s.type === "arc") arcs++;
    else if (s.type === "circle") circles++;
  }
}
const totalMoves = (polyVerts - polyShapes) + arcs + circles; // segments + arcs
console.log(`After biarc fit:`);
console.log(`  polyShapes:  ${polyShapes} (${polyVerts} vertices, ${polyVerts - polyShapes} G1 segments)`);
console.log(`  arcs:        ${arcs}`);
console.log(`  circles:     ${circles}`);
console.log(`  total moves: ${totalMoves}`);

// --- DXF writer (minimal R12-ish ASCII) ---
//
// We emit only LINE, ARC, CIRCLE — no headers/tables/blocks beyond what the
// big-name viewers need. dxf-parser is forgiving, so this should round-trip.

const out = [];
const emit = (code, val) => {
  out.push(String(code).padStart(3, " "));
  out.push(String(val));
};

emit(0, "SECTION");
emit(2, "HEADER");
emit(9, "$ACADVER");
emit(1, "AC1009");
emit(0, "ENDSEC");
emit(0, "SECTION");
emit(2, "ENTITIES");

for (const layer of doc.layers) {
  for (const s of layer.shapes) {
    if (s.type === "poly") {
      for (let i = 0; i < s.points.length - 1; i++) {
        const [x0, y0] = s.points[i];
        const [x1, y1] = s.points[i + 1];
        emit(0, "LINE");
        emit(8, layer.name);
        emit(10, x0.toFixed(6));
        emit(20, y0.toFixed(6));
        emit(30, "0.0");
        emit(11, x1.toFixed(6));
        emit(21, y1.toFixed(6));
        emit(31, "0.0");
      }
    } else if (s.type === "arc") {
      // DXF ARC is always CCW from startAngle to endAngle. Our arc may be
      // CW (ccw=false); in that case swap start/end so the resulting
      // ARC has the same geometry (it sweeps the other way visually but
      // covers the same points — viewers don't care).
      emit(0, "ARC");
      emit(8, layer.name);
      emit(10, s.cx.toFixed(6));
      emit(20, s.cy.toFixed(6));
      emit(30, "0.0");
      emit(40, s.r.toFixed(6));
      const a0 = s.ccw ? s.startDeg : s.endDeg;
      const a1 = s.ccw ? s.endDeg : s.startDeg;
      emit(50, a0.toFixed(6));
      emit(51, a1.toFixed(6));
    } else if (s.type === "circle") {
      emit(0, "CIRCLE");
      emit(8, layer.name);
      emit(10, s.cx.toFixed(6));
      emit(20, s.cy.toFixed(6));
      emit(30, "0.0");
      emit(40, s.r.toFixed(6));
    }
  }
}

emit(0, "ENDSEC");
emit(0, "EOF");

fs.writeFileSync(outPath, out.join("\n"));
console.log(`\nWrote ${outPath}`);
