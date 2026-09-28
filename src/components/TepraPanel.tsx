import { useEffect, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-dialog";
import type { Font } from "opentype.js";
import * as api from "../lib/api";
import { DxfDocument } from "../lib/dxf";
import { parseFont } from "../lib/textVector";
import { generateTepra, TepraOptions } from "../lib/tepra";
import {
  decodeGifFrames,
  generateTepraGif,
  type FrameMask,
} from "../lib/tepraGif";
import { generateTepraUnim, parseUnimClipboard } from "../lib/unimVector";
import type { FillMode } from "../lib/concentricFill";
import {
  loadFontStack,
  loadCoverage,
  pickGeneralistFallbacks,
  DEFAULT_STACK,
  type StackProgress,
} from "../lib/fontStack";

type Props = {
  /** Hand the generated label up to App (same flow as a loaded DXF). */
  onGenerated: (doc: DxfDocument, fileName: string) => void;
  onClose: () => void;
};

/** Font source mode: a synthesized multilingual stack vs one local font. */
type FontMode = "auto" | "local";
/** Which input drives the label: typed text, GIF frames, or unim vector paths. */
type SourceTab = "text" | "gif" | "unim";

/**
 * Tepra label generator (CAMEO plotter). Three input sources, switched by a tab:
 *
 *   - テキスト: prints an input string as a single row/column on long roll
 *     media, with adjustable font/orientation (the original generator).
 *   - GIF: reads an animated GIF one frame at a time, extracts the BLACK region
 *     of each frame, and lays the frames out as a single row — the bitmap
 *     equivalent (e.g. a Unim-rendered character animation → a tape of glyphs).
 *   - unim: pastes VECTOR glyph paths copied from baku89.github.io/unim (via a
 *     Tampermonkey script that reads the page's localStorage). Exact outlines,
 *     no rasterization → no jaggies. Preferred over the GIF path.
 *
 * The geometry controls (size, spacing, orientation, hatch pitch, outline
 * passes, fill) are SHARED — every source feeds the same fill+outline pipeline,
 * so the output is identical downstream.
 */
export function TepraPanel({ onGenerated, onClose }: Props) {
  const [tab, setTab] = useState<SourceTab>("text");

  // --- Text source ---
  const [text, setText] = useState("テプラ");
  const [fontMode, setFontMode] = useState<FontMode>("auto");

  // --- Auto (multilingual stack) state ---
  const [stack, setStack] = useState<Font[] | null>(null);
  const [stackStatus, setStackStatus] = useState<string>("");
  const [stackLoading, setStackLoading] = useState(false);

  // --- Local font state ---
  // Installed fonts (OS folders), chosen path, parsed Font for that path.
  const [fonts, setFonts] = useState<api.FontEntry[]>([]);
  const [fontPath, setFontPath] = useState<string>("");
  const [font, setFont] = useState<Font | null>(null);
  const [loadingFonts, setLoadingFonts] = useState(true);

  // --- GIF source ---
  const [gifPath, setGifPath] = useState<string>("");
  const [gifFrames, setGifFrames] = useState<FrameMask[] | null>(null);
  const [gifStatus, setGifStatus] = useState<string>("");
  const [gifThreshold, setGifThreshold] = useState(128);

  // --- unim vector source ---
  const [unimText, setUnimText] = useState<string>("");
  const unimGlyphs = parseUnimClipboard(unimText);

  // --- Shared geometry controls ---
  const [sizeMm, setSizeMm] = useState(15);
  const [charSpacingMm, setCharSpacingMm] = useState(2);
  const [orientation, setOrientation] = useState<TepraOptions["orientation"]>("horizontal");
  const [spacingMode, setSpacingMode] = useState<TepraOptions["spacingMode"]>("monospace");
  const [lineGapMm, setLineGapMm] = useState(1);
  const [outlinePasses, setOutlinePasses] = useState(1);
  const [fill, setFill] = useState(false);
  const [fillMode, setFillMode] = useState<FillMode>("concentric");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch the installed-font list once on mount (used by local mode + fallback).
  useEffect(() => {
    let alive = true;
    api
      .listFonts()
      .then((list) => {
        if (!alive) return;
        setFonts(list);
        setLoadingFonts(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(`フォント一覧の取得に失敗: ${String(e)}`);
        setLoadingFonts(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Load the multilingual stack on mount (and whenever switching back to auto
  // if it isn't loaded yet). Only relevant on the text tab. On total failure,
  // fall back to local mode.
  useEffect(() => {
    if (tab !== "text" || fontMode !== "auto" || stack || stackLoading) return;
    let alive = true;
    setStackLoading(true);
    setErr(null);
    setStackStatus(`フォント取得中… (0/${DEFAULT_STACK.length})`);
    loadFontStack(DEFAULT_STACK, (p: StackProgress) => {
      if (alive) {
        setStackStatus(
          `フォント取得中… (${p.index + 1}/${p.total}) ${p.label}${
            p.via === "network" ? " ↓" : p.via === "cache" ? " ✓" : " —"
          }`,
        );
      }
    })
      .then((loaded) => {
        if (!alive) return;
        setStack(loaded);
        setStackStatus(`多言語フォント ${loaded.length} 種を合成`);
        setStackLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setStackStatus("");
        setStackLoading(false);
        setFontMode("local");
        setErr(
          `多言語フォントを取得できませんでした（${String(
            e,
          )}）。ローカルフォントに切替えました。`,
        );
      });
    return () => {
      alive = false;
    };
  }, [tab, fontMode, stack, stackLoading]);

  // Load + parse the font file at `path`. Stores the parsed Font (or an error).
  const selectFont = async (path: string) => {
    setErr(null);
    setFontPath(path);
    setFont(null);
    if (!path) return;
    try {
      const bytes = await readFile(path);
      // readFile returns a Uint8Array; opentype wants the underlying ArrayBuffer.
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      setFont(parseFont(ab));
    } catch (e: any) {
      setErr(`フォント読込失敗: ${String(e)}`);
    }
  };

  // Pick a GIF and decode all its frames to binary masks at the current
  // threshold. Re-decoding on a threshold change is cheap relative to picking,
  // so we keep the raw path and re-run decode when threshold changes.
  const pickGif = async () => {
    setErr(null);
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "GIF", extensions: ["gif", "GIF"] }],
      });
      if (!picked || typeof picked !== "string") return;
      setGifPath(picked);
      await decodeGif(picked, gifThreshold);
    } catch (e: any) {
      setErr(`GIF読込失敗: ${String(e)}`);
    }
  };

  const decodeGif = async (path: string, threshold: number) => {
    setBusy(true);
    setGifFrames(null);
    setGifStatus("GIF を解析中…");
    try {
      const frames = await decodeGifFrames(path, {
        threshold,
        onProgress: (i, total) =>
          setGifStatus(`フレーム解析中… (${i}/${total || "?"})`),
      });
      setGifFrames(frames);
      const name = path.split("/").pop() ?? path;
      setGifStatus(`${name} — ${frames.length} フレーム`);
    } catch (e: any) {
      setGifStatus("");
      setErr(`GIF解析失敗: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onGenerateText = async () => {
    if (text.length === 0) {
      setErr("印刷する文字列を入力してください");
      return;
    }
    if (fontMode === "local" && !font) {
      setErr("先にフォントを選択してください（.ttf / .otf）");
      return;
    }
    setBusy(true);
    try {
      let fontArg: Font | Font[];
      if (fontMode === "auto") {
        // Ensure the eager base stack exists. loadFontStack is cached and
        // idempotent, so pressing 生成 early just WAITS for it.
        let base = stack;
        if (!base || base.length === 0) {
          setStackStatus("基本フォント取得中…");
          base = await loadFontStack(DEFAULT_STACK, (p) =>
            setStackStatus(`基本フォント取得中… (${p.index + 1}/${p.total})`),
          );
          setStack(base);
        }
        // Pull on-demand fonts for any character the base can't cover.
        setStackStatus("不足グリフのフォントを取得中…");
        const localFb = pickGeneralistFallbacks(fonts);
        const covered = await loadCoverage(
          text,
          base,
          (p) => setStackStatus(`追加フォント取得中… ${p.label}`),
          localFb,
        );
        if (covered.length > base.length) setStack(covered);
        fontArg = covered;
        setStackStatus(`多言語フォント ${covered.length} 種を合成`);
      } else {
        fontArg = font as Font;
      }

      const { doc, fileName } = generateTepra({
        text,
        font: fontArg,
        sizeMm,
        charSpacingMm,
        orientation,
        spacingMode,
        lineGapMm,
        outlinePasses,
        fill,
        fillMode,
      });
      onGenerated(doc, fileName);
    } catch (e: any) {
      setErr(`生成失敗: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onGenerateGif = async () => {
    if (!gifFrames || gifFrames.length === 0) {
      setErr("先に GIF を読み込んでください");
      return;
    }
    setBusy(true);
    try {
      const { doc, fileName } = generateTepraGif({
        frames: gifFrames,
        sizeMm,
        charSpacingMm,
        orientation,
        lineGapMm,
        outlinePasses,
        fill,
        fillMode,
      });
      onGenerated(doc, fileName);
    } catch (e: any) {
      setErr(`生成失敗: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onGenerateUnim = () => {
    if (unimGlyphs.length === 0) {
      setErr("unim のパスを貼り付けてください（Tampermonkey でコピー）");
      return;
    }
    setBusy(true);
    try {
      const { doc, fileName } = generateTepraUnim({
        glyphs: unimGlyphs,
        sizeMm,
        charSpacingMm,
        orientation,
        lineGapMm,
        outlinePasses,
        fill,
        fillMode,
      });
      onGenerated(doc, fileName);
    } catch (e: any) {
      setErr(`生成失敗: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onGenerate = () => {
    setErr(null);
    if (tab === "text") onGenerateText();
    else if (tab === "gif") onGenerateGif();
    else onGenerateUnim();
  };

  return (
    <div className="panel">
      <div className="row">
        <h3 style={{ flex: 1 }}>テプラ (ロール印刷)</h3>
        <button onClick={onClose} title="このツールを閉じる">
          ✕
        </button>
      </div>

      {/* Source tabs: typed text / GIF frames / unim vector paths. */}
      <div className="tabs">
        <button
          className={tab === "text" ? "tab active" : "tab"}
          onClick={() => setTab("text")}
        >
          テキスト
        </button>
        <button
          className={tab === "gif" ? "tab active" : "tab"}
          onClick={() => setTab("gif")}
        >
          GIF
        </button>
        <button
          className={tab === "unim" ? "tab active" : "tab"}
          onClick={() => setTab("unim")}
          title="baku89 unim のベクター（Tampermonkeyでコピー）を貼り付け"
        >
          unim
        </button>
      </div>

      {tab === "text" ? (
        <>
          <div className="row">
            <label>文字列:</label>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
              placeholder="印刷する文字"
            />
          </div>

          <div className="row">
            <label>フォント:</label>
            <select
              value={fontMode}
              onChange={(e) => setFontMode(e.target.value as FontMode)}
              title="Auto = 多言語合成フォント(オンライン) / ローカル = 端末のフォント"
            >
              <option value="auto">Auto（多言語・オンライン）</option>
              <option value="local">ローカルフォント</option>
            </select>
          </div>

          {fontMode === "auto" ? (
            <div className="row">
              <span className="muted" style={{ flex: 1, minWidth: 0 }}>
                {stackLoading ? stackStatus : stack ? stackStatus : "（未取得）"}
              </span>
            </div>
          ) : (
            <div className="row">
              <select
                value={fontPath}
                onChange={(e) => selectFont(e.target.value)}
                disabled={loadingFonts}
                style={{ flex: 1, minWidth: 0 }}
                title="インストール済みフォントから選択"
              >
                <option value="">
                  {loadingFonts
                    ? "読込中…"
                    : fonts.length === 0
                      ? "(フォントが見つかりません)"
                      : "— フォントを選択 —"}
                </option>
                {fonts.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      ) : tab === "gif" ? (
        <>
          <div className="row">
            <button onClick={pickGif} disabled={busy}>
              GIFを開く…
            </button>
            <span className="muted" style={{ flex: 1, minWidth: 0 }}>
              {gifStatus || "（未選択）"}
            </span>
          </div>

          <div className="row">
            <label>黒判定しきい値:</label>
            <input
              type="range"
              min={1}
              max={254}
              step={1}
              value={gifThreshold}
              onChange={(e) => setGifThreshold(Number(e.target.value))}
              // Re-decode the already-picked GIF when the slider settles.
              onMouseUp={() => gifPath && decodeGif(gifPath, gifThreshold)}
              onTouchEnd={() => gifPath && decodeGif(gifPath, gifThreshold)}
              style={{ flex: 1, minWidth: 0 }}
              title="この明るさより暗い画素を「黒（塗る対象）」とみなす"
            />
            <span className="muted">{gifThreshold}</span>
          </div>
          <div className="hint">
            各フレームの黒い部分を1コマずつ読み取り、横一列に並べて塗ります。
            （縁のジャギーが気になる場合は unim タブのベクターを推奨）
          </div>
        </>
      ) : (
        <>
          <div className="row">
            <label style={{ alignSelf: "flex-start" }}>unimパス:</label>
            <textarea
              value={unimText}
              onChange={(e) => setUnimText(e.target.value)}
              rows={4}
              style={{ flex: 1, minWidth: 0, resize: "vertical", fontFamily: "monospace", fontSize: 11 }}
              placeholder='Tampermonkey でコピーした JSON / SVG / パス文字列を貼り付け'
            />
          </div>
          <div className="row">
            <button onClick={() => setUnimText("")} disabled={!unimText}>
              クリア
            </button>
            <span className="muted" style={{ flex: 1, minWidth: 0 }}>
              {unimText.trim()
                ? `${unimGlyphs.length} グリフを認識`
                : "（未入力）"}
            </span>
          </div>
          <div className="hint">
            baku89 unim のベクター（ベジェ曲線）を直接使うのでジャギーが出ません。
          </div>
        </>
      )}

      <div className="row">
        <label>{tab === "gif" ? "コマサイズ:" : "文字サイズ:"}</label>
        <input
          type="number"
          min={1}
          max={500}
          step={1}
          value={sizeMm}
          onChange={(e) => setSizeMm(Math.max(1, Number(e.target.value) || 1))}
        />
        <span className="muted">mm</span>
        <label>{tab === "gif" ? "コマ間隔:" : "文字間隔:"}</label>
        <input
          type="number"
          min={0}
          max={100}
          step={0.5}
          value={charSpacingMm}
          onChange={(e) => setCharSpacingMm(Math.max(0, Number(e.target.value) || 0))}
        />
        <span className="muted">mm</span>
      </div>

      <div className="row">
        <label>書字方向:</label>
        <select
          value={orientation}
          onChange={(e) => setOrientation(e.target.value as TepraOptions["orientation"])}
        >
          <option value="horizontal">横並び</option>
          <option value="vertical">縦並び</option>
        </select>
        {tab === "text" && (
          <>
            <label>字送り:</label>
            <select
              value={spacingMode}
              onChange={(e) => setSpacingMode(e.target.value as TepraOptions["spacingMode"])}
              title="等幅 = 正方形セルで等間隔 / optical = 各文字の自然な字幅"
            >
              <option value="monospace">等幅</option>
              <option value="optical">optical</option>
            </select>
          </>
        )}
      </div>

      <div className="row">
        <label>線の間隔:</label>
        <input
          type="number"
          min={0.1}
          max={20}
          step={0.1}
          value={lineGapMm}
          onChange={(e) => setLineGapMm(Math.max(0.1, Number(e.target.value) || 0.1))}
          title="塗りつぶしジグザグの線間隔、および外周なぞりの内側オフセット量"
        />
        <span className="muted">mm</span>
        <label>外周なぞり:</label>
        <input
          type="number"
          min={1}
          max={20}
          step={1}
          value={outlinePasses}
          onChange={(e) => setOutlinePasses(Math.max(1, Number(e.target.value) || 1))}
          title="輪郭を内側に線の間隔ぶんずらしながら何周なぞるか"
        />
        <span className="muted">周</span>
      </div>

      <div className="row">
        <label className="chk">
          <input
            type="checkbox"
            checked={fill}
            onChange={(e) => setFill(e.target.checked)}
          />
          塗りつぶし
        </label>
        {fill && (
          <select
            value={fillMode}
            onChange={(e) => setFillMode(e.target.value as FillMode)}
            title="concentric = 輪郭に沿う同心ループ（スライサーの solid 塗り相当・推奨）/ ジグザグ = 斜めの直線ハッチ"
          >
            <option value="concentric">concentric（輪郭沿い）</option>
            <option value="zigzag">ジグザグ（斜め直線）</option>
          </select>
        )}
      </div>

      <div className="row">
        <button className="primary" onClick={onGenerate} disabled={busy}>
          生成
        </button>
        <span className="muted">
          {orientation === "horizontal" ? "横一列" : "縦一列"} /{" "}
          {tab === "text"
            ? `${text.length} 文字`
            : tab === "gif"
              ? `${gifFrames?.length ?? 0} コマ`
              : `${unimGlyphs.length} グリフ`}
        </span>
      </div>

      {err && <div className="err">{err}</div>}
    </div>
  );
}
