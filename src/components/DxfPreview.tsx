import { useMemo, useRef, useEffect, useState } from "react";
import { DxfDocument, flattenShape, Polyline } from "../lib/dxf";
import { LayerParams, Placement, toMcs } from "../lib/gcode";

type Props = {
  doc: DxfDocument | null;
  layers: LayerParams[];
  /** Work-area size (mm). The rectangle (0,0)→(width,height) is always drawn. */
  workArea: { width: number; height: number };
  /** Current machine position in mm (used if wpos is null). */
  mpos: [number, number, number] | null;
  /** Current work-coord position in mm (preferred for head crosshair). */
  wpos: [number, number, number] | null;
  /** Where the design's (0, 0) sits in MCS. */
  placement: Placement;
  /** Called with a new placement (dragging in the viewer). */
  onPlacementChange?: (p: Placement) => void;
  /** Called with an absolute MCS coordinate when the user clicks empty area. */
  onJogTo?: (x: number, y: number) => void;
};

const PAD = 20;
/** Pixel threshold below which a mouse-down→up counts as a click, not a drag. */
const DRAG_THRESHOLD = 3;

/**
 * Coord spaces at play:
 *   - Design space: DXF with flipY + snapToOrigin applied, so (0,0) is top-left,
 *     Y grows DOWN (matches screen convention natively).
 *   - MCS: machine coord system. On NEJE MAX4 ($23=1), MPos Y=0 is the front,
 *     MPos Y=$131 is the back where the head parks after $H. MCS Y grows UP
 *     physically (toward the back), which is OPPOSITE of design Y.
 *   - Screen: canvas pixels; Y grows DOWN as usual.
 *
 * The viewer displays MCS with a bird's-eye orientation: the back of the
 * machine is at the TOP of the screen. So the MCS→screen transform inverts Y.
 * Design points are transformed to MCS via placement, then to screen.
 */
export function DxfPreview({
  doc,
  layers,
  workArea,
  mpos,
  wpos,
  placement,
  onPlacementChange,
  onJogTo,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Current MCS-space → screen transform (filled inside the draw effect).
  const xformRef = useRef<{
    scale: number;
    offX: number;
    // Screen y for MCS y=0. toScreen(mx, my).y = offY - my * scale.
    offY: number;
  } | null>(null);
  const [hoverInDoc, setHoverInDoc] = useState(false);

  const layerStateByName = useMemo(() => {
    const m: Record<string, LayerParams> = {};
    for (const l of layers) m[l.name] = l;
    return m;
  }, [layers]);

  // Helper: design bounds projected into MCS for drag/hit-test.
  const docMcsBounds = useMemo(() => {
    if (!doc) return null;
    const b = doc.bounds;
    const [x0, y1] = toMcs(placement, b.minX, b.minY); // design minY → MCS y_max
    const [x1, y0] = toMcs(placement, b.maxX, b.maxY); // design maxY → MCS y_min
    return { minX: x0, maxX: x1, minY: y0, maxY: y1 };
  }, [doc, placement]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, cssW, cssH);

    // Frame bounds in MCS = union of work area, design (via placement), head pos.
    let fx0 = 0, fy0 = 0, fx1 = workArea.width, fy1 = workArea.height;
    if (docMcsBounds) {
      fx0 = Math.min(fx0, docMcsBounds.minX);
      fy0 = Math.min(fy0, docMcsBounds.minY);
      fx1 = Math.max(fx1, docMcsBounds.maxX);
      fy1 = Math.max(fy1, docMcsBounds.maxY);
    }
    const head = wpos ?? mpos;
    if (head) {
      fx0 = Math.min(fx0, head[0]);
      fy0 = Math.min(fy0, head[1]);
      fx1 = Math.max(fx1, head[0]);
      fy1 = Math.max(fy1, head[1]);
    }
    const fw = Math.max(1e-3, fx1 - fx0);
    const fh = Math.max(1e-3, fy1 - fy0);
    const scale = Math.min((cssW - PAD * 2) / fw, (cssH - PAD * 2) / fh);
    const offX = (cssW - fw * scale) / 2 - fx0 * scale;
    // MCS Y=fy1 should draw at the top of the frame; MCS Y=fy0 at the bottom.
    // screen_y = offY - mcs_y * scale  →  at mcs_y = fy1, screen_y = offY - fy1*scale = top.
    const topPad = (cssH - fh * scale) / 2;
    const offY = topPad + fy1 * scale;

    xformRef.current = { scale, offX, offY };

    const toScreen = (mx: number, my: number): [number, number] => [
      mx * scale + offX,
      offY - my * scale,
    ];

    // --- Grid inside the work area ---
    ctx.strokeStyle = "#252525";
    ctx.lineWidth = 1;
    const step = 10;
    for (let x = 0; x <= workArea.width + 1e-3; x += step) {
      const [sx] = toScreen(x, 0);
      const [, sy0] = toScreen(x, 0);
      const [, sy1] = toScreen(x, workArea.height);
      ctx.beginPath();
      ctx.moveTo(sx, sy0);
      ctx.lineTo(sx, sy1);
      ctx.stroke();
    }
    for (let y = 0; y <= workArea.height + 1e-3; y += step) {
      const [sx0, sy] = toScreen(0, y);
      const [sx1] = toScreen(workArea.width, y);
      ctx.beginPath();
      ctx.moveTo(sx0, sy);
      ctx.lineTo(sx1, sy);
      ctx.stroke();
    }

    // --- Work-area rectangle ---
    const [wx0, wy0] = toScreen(0, 0);
    const [wx1, wy1] = toScreen(workArea.width, workArea.height);
    const wRectX = Math.min(wx0, wx1);
    const wRectY = Math.min(wy0, wy1);
    const wRectW = Math.abs(wx1 - wx0);
    const wRectH = Math.abs(wy1 - wy0);
    ctx.strokeStyle = "#51cf66";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(wRectX, wRectY, wRectW, wRectH);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(81, 207, 102, 0.7)";
    ctx.font = "11px system-ui";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(
      `work area ${workArea.width}×${workArea.height} mm`,
      wRectX + 4,
      wRectY + 4,
    );
    // Axis hints so the operator knows which edge is which in MCS.
    ctx.fillStyle = "#888";
    ctx.textAlign = "center";
    ctx.fillText("Y+ (back)", (wRectX + wRectX + wRectW) / 2, wRectY - 14);
    ctx.textBaseline = "bottom";
    ctx.fillText("Y=0 (front)", (wRectX + wRectX + wRectW) / 2, wRectY + wRectH + 14);
    ctx.textBaseline = "top";

    // --- DXF ---
    if (doc && docMcsBounds) {
      // If any corner of the design lands outside the work area, every
      // move toward it will trigger ALARM:2. Warn loudly with a red border
      // so the operator fixes placement BEFORE pressing Start.
      const outOfArea =
        docMcsBounds.minX < -1e-3 ||
        docMcsBounds.minY < -1e-3 ||
        docMcsBounds.maxX > workArea.width + 1e-3 ||
        docMcsBounds.maxY > workArea.height + 1e-3;

      const [bx0, by0] = toScreen(docMcsBounds.minX, docMcsBounds.minY);
      const [bx1, by1] = toScreen(docMcsBounds.maxX, docMcsBounds.maxY);
      ctx.strokeStyle = outOfArea ? "#ff6b6b" : hoverInDoc ? "#ffd43b" : "#555";
      ctx.lineWidth = outOfArea ? 2 : hoverInDoc ? 1.5 : 1;
      ctx.strokeRect(
        Math.min(bx0, bx1),
        Math.min(by0, by1),
        Math.abs(bx1 - bx0),
        Math.abs(by1 - by0),
      );
      if (outOfArea) {
        ctx.fillStyle = "#ff6b6b";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(
          "⚠ design outside work area — ALARM:2 risk",
          Math.min(bx0, bx1) + 4,
          Math.min(by0, by1) - 4,
        );
      }

      for (const layer of doc.layers) {
        const lp = layerStateByName[layer.name];
        if (lp && !lp.enabled) continue;
        ctx.strokeStyle = lp?.color ?? layer.color;
        ctx.lineWidth = 1.2;
        for (const shape of layer.shapes) {
          const poly = flattenShape(shape);
          ctx.beginPath();
          for (let i = 0; i < poly.length; i++) {
            const [mx, my] = toMcs(placement, poly[i][0], poly[i][1]);
            const [sx, sy] = toScreen(mx, my);
            if (i === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          }
          ctx.stroke();
        }
      }
    }

    // --- First cut point (yellow) — in MCS ---
    if (doc) {
      const byName: Record<string, Polyline[]> = {};
      for (const l of doc.layers) byName[l.name] = l.shapes.map(flattenShape);
      let firstPt: [number, number] | null = null;
      for (const lp of layers) {
        if (!lp.enabled) continue;
        const polys = byName[lp.name];
        if (!polys) continue;
        for (const p of polys) {
          if (p.length >= 2) {
            firstPt = p[0];
            break;
          }
        }
        if (firstPt) break;
      }
      if (firstPt) {
        const [mx, my] = toMcs(placement, firstPt[0], firstPt[1]);
        const [sx, sy] = toScreen(mx, my);
        ctx.fillStyle = "#ffd43b";
        ctx.strokeStyle = "#1a1a1a";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ffd43b";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(
          `start MCS (${mx.toFixed(1)}, ${my.toFixed(1)})`,
          sx + 8,
          sy + 8,
        );
      }
    }

    // --- Machine origin crosshair (MCS 0,0) ---
    const [ox, oy] = toScreen(0, 0);
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ox - 8, oy);
    ctx.lineTo(ox + 8, oy);
    ctx.moveTo(ox, oy - 8);
    ctx.lineTo(ox, oy + 8);
    ctx.stroke();
    ctx.fillStyle = "#ff6b6b";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("MCS 0,0 (front-left)", ox + 6, oy + 6);

    // --- Head position crosshair ---
    if (head) {
      const [hx, hy] = toScreen(head[0], head[1]);
      ctx.strokeStyle = "#4dabf7";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hx - 12, hy);
      ctx.lineTo(hx + 12, hy);
      ctx.moveTo(hx, hy - 12);
      ctx.lineTo(hx, hy + 12);
      ctx.stroke();
      ctx.fillStyle = "#4dabf7";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(
        `head (${head[0].toFixed(1)}, ${head[1].toFixed(1)})${wpos ? " wcs" : " mcs"}`,
        hx + 10,
        hy + 10,
      );
    }

    // --- Placement marker (MCS location of design's (0,0)) ---
    const [px, py] = toScreen(placement.x, placement.y);
    ctx.strokeStyle = "#ffd43b";
    ctx.fillStyle = "rgba(255, 212, 59, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffd43b";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      `origin (${placement.x.toFixed(1)}, ${placement.y.toFixed(1)})`,
      px - 6,
      py - 4,
    );
  }, [
    doc,
    docMcsBounds,
    layerStateByName,
    layers,
    mpos,
    wpos,
    workArea,
    placement,
    hoverInDoc,
  ]);

  // --- Mouse interaction -----------------------------------------------------
  const dragRef = useRef<
    | null
    | {
        kind: "pending" | "dragging";
        startClientX: number;
        startClientY: number;
        // MCS coord where the press landed.
        startMcs: [number, number];
        // Placement at drag start (so dragging adds mouse delta, not cumulates).
        startPlacement: Placement;
      }
  >(null);

  const mcsFromEvent = (
    e: React.MouseEvent<HTMLCanvasElement>,
  ): [number, number] | null => {
    const xf = xformRef.current;
    const canvas = canvasRef.current;
    if (!xf || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return [(sx - xf.offX) / xf.scale, (xf.offY - sy) / xf.scale];
  };

  const inDocMcs = (x: number, y: number) => {
    if (!docMcsBounds) return false;
    return (
      x >= docMcsBounds.minX &&
      x <= docMcsBounds.maxX &&
      y >= docMcsBounds.minY &&
      y <= docMcsBounds.maxY
    );
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const mcs = mcsFromEvent(e);
    if (!mcs) return;
    dragRef.current = {
      kind: "pending",
      startClientX: e.clientX,
      startClientY: e.clientY,
      startMcs: mcs,
      startPlacement: placement,
    };
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mcs = mcsFromEvent(e);
    if (!mcs) return;

    setHoverInDoc(inDocMcs(mcs[0], mcs[1]));

    const d = dragRef.current;
    if (!d) return;

    if (d.kind === "pending") {
      const px = e.clientX - d.startClientX;
      const py = e.clientY - d.startClientY;
      if (Math.hypot(px, py) < DRAG_THRESHOLD) return;
      if (inDocMcs(d.startMcs[0], d.startMcs[1]) && onPlacementChange) {
        d.kind = "dragging";
      } else {
        return;
      }
    }

    if (d.kind === "dragging" && onPlacementChange) {
      const dx = mcs[0] - d.startMcs[0];
      const dy = mcs[1] - d.startMcs[1];
      onPlacementChange({
        x: d.startPlacement.x + dx,
        y: d.startPlacement.y + dy,
      });
    }
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const px = e.clientX - d.startClientX;
    const py = e.clientY - d.startClientY;
    const moved = Math.hypot(px, py) >= DRAG_THRESHOLD;

    if (d.kind === "dragging") return;
    if (moved) return;

    // Click without drag — jog if it landed outside the design, in the work area.
    const mcs = mcsFromEvent(e);
    if (!mcs || !onJogTo) return;
    const [x, y] = mcs;
    if (inDocMcs(x, y)) return;
    const cx = Math.max(0, Math.min(workArea.width, x));
    const cy = Math.max(0, Math.min(workArea.height, y));
    onJogTo(cx, cy);
  };

  const onMouseLeave = () => {
    dragRef.current = null;
    setHoverInDoc(false);
  };

  return (
    <div className="dxf-preview">
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        style={{ cursor: hoverInDoc ? "grab" : onJogTo ? "crosshair" : "default" }}
      />
    </div>
  );
}
