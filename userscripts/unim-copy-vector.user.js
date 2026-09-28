// ==UserScript==
// @name         unim → テプラ ベクターコピー
// @namespace    com.baku89.unim.tepra
// @version      1.1.0
// @description  baku89 unim で「選択中」のシーケンス/グリフを SVG ベクターパスとしてコピーし、NEJE MAX4 Controller の「テプラ → unim」タブに貼り付けられるようにする。ベジェ曲線をそのまま取り出すのでラスタ化のジャギーが出ません。ロゴメニューに「Copy Vectors」を追加します。
// @author       You
// @match        https://baku89.github.io/unim/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.io
// @grant        none
// ==/UserScript==

(function () {
  "use strict";
  const ACTION_ID = "copy_selected_vectors";

  // ---- 内部アクセス用ヘルパ（pleaserename.js と同じ経路）----
  const getApp = () => document.getElementById("app")?.__vue_app__ || null;

  function getPinia(app) {
    if (!app) return null;
    const gp = app.config?.globalProperties?.$pinia;
    if (gp) return gp;
    // provide(piniaSymbol, pinia) からのフォールバック
    const provides = app._context?.provides || {};
    for (const k of Reflect.ownKeys(provides)) {
      const v = provides[k];
      if (v && v._s instanceof Map && v.state) return v;
    }
    return null;
  }

  const getStore = (pinia, id) => pinia?._s?.get(id) || null;

  // 選択中のグリフ群を取得（pleaserename.js の getSelectedText と同じ選択ロジック。
  // 文字列ではなく各グリフの SVG パスを集める点だけが異なる）。
  function getSelectedGlyphs(pinia) {
    const appState = getStore(pinia, "appState");
    const project = getStore(pinia, "project");
    if (!appState || !project) return [];

    const selections =
      appState.selections ?? pinia.state.value?.appState?.selections ?? [];
    const items = project.items ?? pinia.state.value?.project?.items ?? [];

    const glyphs = [];
    for (const sel of selections) {
      const item = items[sel.index];
      if (!item || item.type !== "glyphSequence") continue;
      if (sel.type === "item") {
        glyphs.push(...item.glyphs); // アイテム全体を選択
      } else if (sel.type === "sequenceChar" && !sel.gap) {
        const g = item.glyphs[sel.charIndex]; // 1文字を選択
        if (g) glyphs.push(g);
      }
    }
    return glyphs;
  }

  // ---- 簡易トースト（pleaserename.js と同じ見た目）----
  function toast(msg, isErr) {
    const el = document.createElement("div");
    el.textContent = msg;
    Object.assign(el.style, {
      position: "fixed",
      left: "50%",
      bottom: "32px",
      transform: "translateX(-50%)",
      background: isErr ? "#a33" : "var(--tq-color-accent, #6565f7)",
      color: "#fff",
      font: "500 13px/1.4 var(--tq-font-heading, sans-serif)",
      padding: "8px 14px",
      borderRadius: "8px",
      zIndex: "99999",
      boxShadow: "0 4px 16px rgba(0,0,0,.25)",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity .15s",
      maxWidth: "80vw",
      textAlign: "center",
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = "1"));
    setTimeout(
      () => {
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 200);
      },
      isErr ? 4000 : 1800,
    );
  }

  // ---- コピー本体 ----
  async function performCopy(pinia) {
    const glyphs = getSelectedGlyphs(pinia);
    if (!glyphs.length) {
      toast("選択中のグリフがありません", true);
      return;
    }
    // 各グリフの SVG パス（ベジェ）。パスを持たないグリフ(空白など)は除外。
    const paths = glyphs
      .map((g) => (typeof g?.path === "string" ? g.path : null))
      .filter((p) => p && /[Mm]\s*[-\d.]/.test(p));
    if (!paths.length) {
      toast("選択中にベクターパスがありません", true);
      return;
    }

    const payload = JSON.stringify({ unim: "1", em: 1000, glyphs: paths });
    try {
      await navigator.clipboard.writeText(payload);
      toast(`${paths.length} グリフのベクターをコピーしました`);
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = payload;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (_) {}
      ta.remove();
      toast(
        ok ? `${paths.length} グリフのベクターをコピーしました` : "コピーに失敗しました",
        !ok,
      );
    }
  }

  // ---- アクション登録（＝ロゴメニューに項目を追加）----
  function register() {
    const pinia = getPinia(getApp());
    if (!pinia) return false;
    const actions = getStore(pinia, "actions");
    if (!actions || typeof actions.register !== "function") return false;
    if (actions.allActions && actions.allActions[ACTION_ID]) return true; // 登録済み

    actions.register([
      {
        id: ACTION_ID,
        label: "Copy Vectors", // メニューに出る表示名
        icon: "mdi:vector-curve",
        // bind: 'command+shift+v',  // ← ショートカットが欲しければ有効化
        perform: () => performCopy(pinia),
      },
    ]);

    return !!(actions.allActions && actions.allActions[ACTION_ID]);
  }

  // ストアが用意できるまでポーリング（最大 ~20 秒）
  let tries = 0;
  const timer = setInterval(() => {
    if (register() || ++tries > 100) clearInterval(timer);
  }, 200);
})();
