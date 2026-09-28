// Multilingual font stack for the tepra generator's "Auto" mode.
//
// Inspired by baku89's Unim, which covers (nearly) all of Unicode by assigning
// each codepoint to whichever Noto / BabelStone / Code2000 font actually has a
// glyph for it. We do the runtime equivalent: load an ORDERED list of Noto
// fonts and, per character, use the first font in the list that has that glyph
// (opentype.js `font.hasChar`). The result is a synthesized multi-script font.
//
// Fonts are fetched as raw TTF/OTF from the jsDelivr CDN (NOT Google Fonts,
// whose css2 API returns Brotli-compressed woff2 that opentype.js can't parse,
// and dynamically subsets CJK). jsDelivr serves the uncompressed upstream Noto
// files, which opentype.js parses directly and which contain the full glyph set
// so any character can be looked up.
//
// Caching: an in-memory Map for the session, backed by a disk cache under the
// app cache dir (via the fs plugin) so the ~16 MB CJK font isn't re-downloaded
// every launch and so a previously-fetched stack still works OFFLINE. When the
// network is unavailable and nothing is cached, loadFontStack throws and the
// caller (TepraPanel) falls back to a locally-installed font.

import { parse as parseOpentype, Font } from "opentype.js";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";

export type FontSource = { label: string; url: string };

const CDN = "https://cdn.jsdelivr.net/gh";
// Canonical Noto distribution (full, uncompressed unhinted TTFs). jsDelivr
// serves raw repo files; opentype.js parses these directly (unlike Google
// Fonts' woff2). Path shape:
//   <NOTO_REPO>/fonts/<Family>/unhinted/ttf/<Family>-Regular.ttf
const NOTO_REPO = `${CDN}/notofonts/notofonts.github.io@main`;
const notoUrl = (fam: string) =>
  `${NOTO_REPO}/fonts/${fam}/unhinted/ttf/${fam}-Regular.ttf`;

// URL for the big CJK font — handled ON DEMAND (see EXTENDED_STACK head), NOT
// eagerly, because it's ~16 MB / ~30 s to download and would block the whole
// stack from becoming usable. Once fetched it's disk-cached, so the cost is
// one-time. Kept as a constant for clarity.
const CJK_JP_URL = `${CDN}/notofonts/noto-cjk/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf`;

/**
 * CORE = common modern scripts, loaded EAGERLY. These are all SMALL (≤~0.6 MB
 * each, ~2 MB total) so the stack becomes usable in a second or two. The big
 * CJK font is deliberately NOT here — it's the first EXTENDED entry, fetched on
 * demand only when the text actually contains CJK (then disk-cached). Noto Sans
 * leads: it carries Latin / Latin-Extended / phonetic / subscript blocks.
 * EARLIER entries win when several fonts have the same glyph.
 */
export const DEFAULT_STACK: FontSource[] = [
  { label: "Noto Sans", url: notoUrl("NotoSans") },
  { label: "Noto Sans Arabic", url: notoUrl("NotoSansArabic") },
  { label: "Noto Sans Hebrew", url: notoUrl("NotoSansHebrew") },
  { label: "Noto Sans Thai", url: notoUrl("NotoSansThai") },
  { label: "Noto Sans Devanagari", url: notoUrl("NotoSansDevanagari") },
  { label: "Noto Sans Bengali", url: notoUrl("NotoSansBengali") },
  { label: "Noto Sans Tamil", url: notoUrl("NotoSansTamil") },
  { label: "Noto Sans Georgian", url: notoUrl("NotoSansGeorgian") },
  { label: "Noto Sans Armenian", url: notoUrl("NotoSansArmenian") },
  { label: "Noto Sans Khmer", url: notoUrl("NotoSansKhmer") },
  { label: "Noto Sans Myanmar", url: notoUrl("NotoSansMyanmar") },
  { label: "Noto Sans Sinhala", url: notoUrl("NotoSansSinhala") },
  { label: "Noto Sans Ethiopic", url: notoUrl("NotoSansEthiopic") },
  { label: "Noto Sans Symbols", url: notoUrl("NotoSansSymbols") },
  { label: "Noto Sans Symbols2", url: notoUrl("NotoSansSymbols2") },
];

/**
 * EXTENDED = on-demand families `loadCoverage` pulls only when a text needs
 * them. The big CJK font is FIRST (Japanese/kanji are common, so it usually
 * loads on the first real label, then stays disk-cached). The rest is the full
 * remaining Noto family set (rare/historic/specialist scripts + symbols/music)
 * for near-complete Unicode coverage (Unim-style) without bloating common
 * labels. Auto-generated from the canonical notofonts.github.io repo tree
 * (metric-duplicate *UI families excluded). A 404/parse failure on any entry
 * is skipped at load time.
 */
export const EXTENDED_STACK: FontSource[] = [
  { label: "Noto Sans CJK JP", url: CJK_JP_URL },
  { label: "Noto Sans Adlam", url: notoUrl("NotoSansAdlam") },
  { label: "Noto Sans Adlam Unjoined", url: notoUrl("NotoSansAdlamUnjoined") },
  { label: "Noto Sans Anatolian Hieroglyphs", url: notoUrl("NotoSansAnatolianHieroglyphs") },
  { label: "Noto Sans Avestan", url: notoUrl("NotoSansAvestan") },
  { label: "Noto Sans Balinese", url: notoUrl("NotoSansBalinese") },
  { label: "Noto Sans Bamum", url: notoUrl("NotoSansBamum") },
  { label: "Noto Sans Bassa Vah", url: notoUrl("NotoSansBassaVah") },
  { label: "Noto Sans Batak", url: notoUrl("NotoSansBatak") },
  { label: "Noto Sans Bhaiksuki", url: notoUrl("NotoSansBhaiksuki") },
  { label: "Noto Sans Brahmi", url: notoUrl("NotoSansBrahmi") },
  { label: "Noto Sans Buginese", url: notoUrl("NotoSansBuginese") },
  { label: "Noto Sans Buhid", url: notoUrl("NotoSansBuhid") },
  { label: "Noto Sans Canadian Aboriginal", url: notoUrl("NotoSansCanadianAboriginal") },
  { label: "Noto Sans Carian", url: notoUrl("NotoSansCarian") },
  { label: "Noto Sans Caucasian Albanian", url: notoUrl("NotoSansCaucasianAlbanian") },
  { label: "Noto Sans Chakma", url: notoUrl("NotoSansChakma") },
  { label: "Noto Sans Cham", url: notoUrl("NotoSansCham") },
  { label: "Noto Sans Cherokee", url: notoUrl("NotoSansCherokee") },
  { label: "Noto Sans Chorasmian", url: notoUrl("NotoSansChorasmian") },
  { label: "Noto Sans Coptic", url: notoUrl("NotoSansCoptic") },
  { label: "Noto Sans Cuneiform", url: notoUrl("NotoSansCuneiform") },
  { label: "Noto Sans Cypriot", url: notoUrl("NotoSansCypriot") },
  { label: "Noto Sans Cypro Minoan", url: notoUrl("NotoSansCyproMinoan") },
  { label: "Noto Sans Deseret", url: notoUrl("NotoSansDeseret") },
  { label: "Noto Sans Duployan", url: notoUrl("NotoSansDuployan") },
  { label: "Noto Sans Egyptian Hieroglyphs", url: notoUrl("NotoSansEgyptianHieroglyphs") },
  { label: "Noto Sans Elbasan", url: notoUrl("NotoSansElbasan") },
  { label: "Noto Sans Elymaic", url: notoUrl("NotoSansElymaic") },
  { label: "Noto Sans Glagolitic", url: notoUrl("NotoSansGlagolitic") },
  { label: "Noto Sans Gothic", url: notoUrl("NotoSansGothic") },
  { label: "Noto Sans Grantha", url: notoUrl("NotoSansGrantha") },
  { label: "Noto Sans Gujarati", url: notoUrl("NotoSansGujarati") },
  { label: "Noto Sans Gunjala Gondi", url: notoUrl("NotoSansGunjalaGondi") },
  { label: "Noto Sans Gurmukhi", url: notoUrl("NotoSansGurmukhi") },
  { label: "Noto Sans Hanifi Rohingya", url: notoUrl("NotoSansHanifiRohingya") },
  { label: "Noto Sans Hanunoo", url: notoUrl("NotoSansHanunoo") },
  { label: "Noto Sans Hatran", url: notoUrl("NotoSansHatran") },
  { label: "Noto Sans Imperial Aramaic", url: notoUrl("NotoSansImperialAramaic") },
  { label: "Noto Sans Indic Siyaq Numbers", url: notoUrl("NotoSansIndicSiyaqNumbers") },
  { label: "Noto Sans Inscriptional Pahlavi", url: notoUrl("NotoSansInscriptionalPahlavi") },
  { label: "Noto Sans Inscriptional Parthian", url: notoUrl("NotoSansInscriptionalParthian") },
  { label: "Noto Sans Javanese", url: notoUrl("NotoSansJavanese") },
  { label: "Noto Sans Kaithi", url: notoUrl("NotoSansKaithi") },
  { label: "Noto Sans Kannada", url: notoUrl("NotoSansKannada") },
  { label: "Noto Sans Kawi", url: notoUrl("NotoSansKawi") },
  { label: "Noto Sans Kayah Li", url: notoUrl("NotoSansKayahLi") },
  { label: "Noto Sans Kharoshthi", url: notoUrl("NotoSansKharoshthi") },
  { label: "Noto Sans Khojki", url: notoUrl("NotoSansKhojki") },
  { label: "Noto Sans Khudawadi", url: notoUrl("NotoSansKhudawadi") },
  { label: "Noto Sans Lao", url: notoUrl("NotoSansLao") },
  { label: "Noto Sans Lao Looped", url: notoUrl("NotoSansLaoLooped") },
  { label: "Noto Sans Lepcha", url: notoUrl("NotoSansLepcha") },
  { label: "Noto Sans Limbu", url: notoUrl("NotoSansLimbu") },
  { label: "Noto Sans Linear A", url: notoUrl("NotoSansLinearA") },
  { label: "Noto Sans Linear B", url: notoUrl("NotoSansLinearB") },
  { label: "Noto Sans Lisu", url: notoUrl("NotoSansLisu") },
  { label: "Noto Sans Lycian", url: notoUrl("NotoSansLycian") },
  { label: "Noto Sans Lydian", url: notoUrl("NotoSansLydian") },
  { label: "Noto Sans Mahajani", url: notoUrl("NotoSansMahajani") },
  { label: "Noto Sans Malayalam", url: notoUrl("NotoSansMalayalam") },
  { label: "Noto Sans Mandaic", url: notoUrl("NotoSansMandaic") },
  { label: "Noto Sans Manichaean", url: notoUrl("NotoSansManichaean") },
  { label: "Noto Sans Marchen", url: notoUrl("NotoSansMarchen") },
  { label: "Noto Sans Masaram Gondi", url: notoUrl("NotoSansMasaramGondi") },
  { label: "Noto Sans Math", url: notoUrl("NotoSansMath") },
  { label: "Noto Sans Mayan Numerals", url: notoUrl("NotoSansMayanNumerals") },
  { label: "Noto Sans Medefaidrin", url: notoUrl("NotoSansMedefaidrin") },
  { label: "Noto Sans Meetei Mayek", url: notoUrl("NotoSansMeeteiMayek") },
  { label: "Noto Sans Mende Kikakui", url: notoUrl("NotoSansMendeKikakui") },
  { label: "Noto Sans Meroitic", url: notoUrl("NotoSansMeroitic") },
  { label: "Noto Sans Miao", url: notoUrl("NotoSansMiao") },
  { label: "Noto Sans Modi", url: notoUrl("NotoSansModi") },
  { label: "Noto Sans Mongolian", url: notoUrl("NotoSansMongolian") },
  { label: "Noto Sans Mono", url: notoUrl("NotoSansMono") },
  { label: "Noto Sans Mro", url: notoUrl("NotoSansMro") },
  { label: "Noto Sans Multani", url: notoUrl("NotoSansMultani") },
  { label: "Noto Sans NKo", url: notoUrl("NotoSansNKo") },
  { label: "Noto Sans NKo Unjoined", url: notoUrl("NotoSansNKoUnjoined") },
  { label: "Noto Sans Nabataean", url: notoUrl("NotoSansNabataean") },
  { label: "Noto Sans Nag Mundari", url: notoUrl("NotoSansNagMundari") },
  { label: "Noto Sans Nandinagari", url: notoUrl("NotoSansNandinagari") },
  { label: "Noto Sans New Tai Lue", url: notoUrl("NotoSansNewTaiLue") },
  { label: "Noto Sans Newa", url: notoUrl("NotoSansNewa") },
  { label: "Noto Sans Nushu", url: notoUrl("NotoSansNushu") },
  { label: "Noto Sans Ogham", url: notoUrl("NotoSansOgham") },
  { label: "Noto Sans Ol Chiki", url: notoUrl("NotoSansOlChiki") },
  { label: "Noto Sans Old Hungarian", url: notoUrl("NotoSansOldHungarian") },
  { label: "Noto Sans Old Italic", url: notoUrl("NotoSansOldItalic") },
  { label: "Noto Sans Old North Arabian", url: notoUrl("NotoSansOldNorthArabian") },
  { label: "Noto Sans Old Permic", url: notoUrl("NotoSansOldPermic") },
  { label: "Noto Sans Old Persian", url: notoUrl("NotoSansOldPersian") },
  { label: "Noto Sans Old Sogdian", url: notoUrl("NotoSansOldSogdian") },
  { label: "Noto Sans Old South Arabian", url: notoUrl("NotoSansOldSouthArabian") },
  { label: "Noto Sans Old Turkic", url: notoUrl("NotoSansOldTurkic") },
  { label: "Noto Sans Oriya", url: notoUrl("NotoSansOriya") },
  { label: "Noto Sans Osage", url: notoUrl("NotoSansOsage") },
  { label: "Noto Sans Osmanya", url: notoUrl("NotoSansOsmanya") },
  { label: "Noto Sans Pahawh Hmong", url: notoUrl("NotoSansPahawhHmong") },
  { label: "Noto Sans Palmyrene", url: notoUrl("NotoSansPalmyrene") },
  { label: "Noto Sans Pau Cin Hau", url: notoUrl("NotoSansPauCinHau") },
  { label: "Noto Sans Phags Pa", url: notoUrl("NotoSansPhagsPa") },
  { label: "Noto Sans Phoenician", url: notoUrl("NotoSansPhoenician") },
  { label: "Noto Sans Psalter Pahlavi", url: notoUrl("NotoSansPsalterPahlavi") },
  { label: "Noto Sans Rejang", url: notoUrl("NotoSansRejang") },
  { label: "Noto Sans Runic", url: notoUrl("NotoSansRunic") },
  { label: "Noto Sans Samaritan", url: notoUrl("NotoSansSamaritan") },
  { label: "Noto Sans Saurashtra", url: notoUrl("NotoSansSaurashtra") },
  { label: "Noto Sans Sharada", url: notoUrl("NotoSansSharada") },
  { label: "Noto Sans Shavian", url: notoUrl("NotoSansShavian") },
  { label: "Noto Sans Siddham", url: notoUrl("NotoSansSiddham") },
  { label: "Noto Sans Sign Writing", url: notoUrl("NotoSansSignWriting") },
  { label: "Noto Sans Sogdian", url: notoUrl("NotoSansSogdian") },
  { label: "Noto Sans Sora Sompeng", url: notoUrl("NotoSansSoraSompeng") },
  { label: "Noto Sans Soyombo", url: notoUrl("NotoSansSoyombo") },
  { label: "Noto Sans Sundanese", url: notoUrl("NotoSansSundanese") },
  { label: "Noto Sans Sunuwar", url: notoUrl("NotoSansSunuwar") },
  { label: "Noto Sans Syloti Nagri", url: notoUrl("NotoSansSylotiNagri") },
  { label: "Noto Sans Syriac", url: notoUrl("NotoSansSyriac") },
  { label: "Noto Sans Syriac Eastern", url: notoUrl("NotoSansSyriacEastern") },
  { label: "Noto Sans Syriac Western", url: notoUrl("NotoSansSyriacWestern") },
  { label: "Noto Sans Tagalog", url: notoUrl("NotoSansTagalog") },
  { label: "Noto Sans Tagbanwa", url: notoUrl("NotoSansTagbanwa") },
  { label: "Noto Sans Tai Le", url: notoUrl("NotoSansTaiLe") },
  { label: "Noto Sans Tai Tham", url: notoUrl("NotoSansTaiTham") },
  { label: "Noto Sans Tai Viet", url: notoUrl("NotoSansTaiViet") },
  { label: "Noto Sans Takri", url: notoUrl("NotoSansTakri") },
  { label: "Noto Sans Tamil Supplement", url: notoUrl("NotoSansTamilSupplement") },
  { label: "Noto Sans Tangsa", url: notoUrl("NotoSansTangsa") },
  { label: "Noto Sans Telugu", url: notoUrl("NotoSansTelugu") },
  { label: "Noto Sans Test", url: notoUrl("NotoSansTest") },
  { label: "Noto Sans Thaana", url: notoUrl("NotoSansThaana") },
  { label: "Noto Sans Thai Looped", url: notoUrl("NotoSansThaiLooped") },
  { label: "Noto Sans Tifinagh", url: notoUrl("NotoSansTifinagh") },
  { label: "Noto Sans Tirhuta", url: notoUrl("NotoSansTirhuta") },
  { label: "Noto Sans Ugaritic", url: notoUrl("NotoSansUgaritic") },
  { label: "Noto Sans Vai", url: notoUrl("NotoSansVai") },
  { label: "Noto Sans Vithkuqi", url: notoUrl("NotoSansVithkuqi") },
  { label: "Noto Sans Wancho", url: notoUrl("NotoSansWancho") },
  { label: "Noto Sans Warang Citi", url: notoUrl("NotoSansWarangCiti") },
  { label: "Noto Sans Yi", url: notoUrl("NotoSansYi") },
  { label: "Noto Sans Zanabazar Square", url: notoUrl("NotoSansZanabazarSquare") },
  { label: "Noto Serif", url: notoUrl("NotoSerif") },
  { label: "Noto Serif Ahom", url: notoUrl("NotoSerifAhom") },
  { label: "Noto Serif Armenian", url: notoUrl("NotoSerifArmenian") },
  { label: "Noto Serif Balinese", url: notoUrl("NotoSerifBalinese") },
  { label: "Noto Serif Bengali", url: notoUrl("NotoSerifBengali") },
  { label: "Noto Serif Devanagari", url: notoUrl("NotoSerifDevanagari") },
  { label: "Noto Serif Display", url: notoUrl("NotoSerifDisplay") },
  { label: "Noto Serif Dives Akuru", url: notoUrl("NotoSerifDivesAkuru") },
  { label: "Noto Serif Dogra", url: notoUrl("NotoSerifDogra") },
  { label: "Noto Serif Ethiopic", url: notoUrl("NotoSerifEthiopic") },
  { label: "Noto Serif Georgian", url: notoUrl("NotoSerifGeorgian") },
  { label: "Noto Serif Grantha", url: notoUrl("NotoSerifGrantha") },
  { label: "Noto Serif Gujarati", url: notoUrl("NotoSerifGujarati") },
  { label: "Noto Serif Gurmukhi", url: notoUrl("NotoSerifGurmukhi") },
  { label: "Noto Serif Hebrew", url: notoUrl("NotoSerifHebrew") },
  { label: "Noto Serif Hentaigana", url: notoUrl("NotoSerifHentaigana") },
  { label: "Noto Serif Kannada", url: notoUrl("NotoSerifKannada") },
  { label: "Noto Serif Khitan Small Script", url: notoUrl("NotoSerifKhitanSmallScript") },
  { label: "Noto Serif Khmer", url: notoUrl("NotoSerifKhmer") },
  { label: "Noto Serif Khojki", url: notoUrl("NotoSerifKhojki") },
  { label: "Noto Serif Lao", url: notoUrl("NotoSerifLao") },
  { label: "Noto Serif Makasar", url: notoUrl("NotoSerifMakasar") },
  { label: "Noto Serif Malayalam", url: notoUrl("NotoSerifMalayalam") },
  { label: "Noto Serif Myanmar", url: notoUrl("NotoSerifMyanmar") },
  { label: "Noto Serif NPHmong", url: notoUrl("NotoSerifNPHmong") },
  { label: "Noto Serif Old Uyghur", url: notoUrl("NotoSerifOldUyghur") },
  { label: "Noto Serif Oriya", url: notoUrl("NotoSerifOriya") },
  { label: "Noto Serif Ottoman Siyaq", url: notoUrl("NotoSerifOttomanSiyaq") },
  { label: "Noto Serif Sinhala", url: notoUrl("NotoSerifSinhala") },
  { label: "Noto Serif Tamil", url: notoUrl("NotoSerifTamil") },
  { label: "Noto Serif Tangut", url: notoUrl("NotoSerifTangut") },
  { label: "Noto Serif Telugu", url: notoUrl("NotoSerifTelugu") },
  { label: "Noto Serif Test", url: notoUrl("NotoSerifTest") },
  { label: "Noto Serif Thai", url: notoUrl("NotoSerifThai") },
  { label: "Noto Serif Tibetan", url: notoUrl("NotoSerifTibetan") },
  { label: "Noto Serif Todhri", url: notoUrl("NotoSerifTodhri") },
  { label: "Noto Serif Toto", url: notoUrl("NotoSerifToto") },
  { label: "Noto Serif Vithkuqi", url: notoUrl("NotoSerifVithkuqi") },
  { label: "Noto Serif Yezidi", url: notoUrl("NotoSerifYezidi") },
  { label: "Noto Fangsong KSSRotated", url: notoUrl("NotoFangsongKSSRotated") },
  { label: "Noto Fangsong KSSVertical", url: notoUrl("NotoFangsongKSSVertical") },
  { label: "Noto Kufi Arabic", url: notoUrl("NotoKufiArabic") },
  { label: "Noto Music", url: notoUrl("NotoMusic") },
  { label: "Noto Naskh Arabic", url: notoUrl("NotoNaskhArabic") },
  { label: "Noto Nastaliq Urdu", url: notoUrl("NotoNastaliqUrdu") },
  { label: "Noto Rashi Hebrew", url: notoUrl("NotoRashiHebrew") },
  { label: "Noto Traditional Nushu", url: notoUrl("NotoTraditionalNushu") },
  { label: "Noto Znamenny Musical Notation", url: notoUrl("NotoZnamennyMusicalNotation") },
];

// Session in-memory cache: parsed Font per URL (survives panel re-open).
const memCache = new Map<string, Font>();

export type StackProgress = {
  /** 0-based index of the font being loaded. */
  index: number;
  total: number;
  label: string;
  /** "cache" (disk/mem hit) | "network" (downloaded) | "skip" (failed). */
  via: "cache" | "network" | "skip";
};

// A filesystem-safe cache filename for a CDN url (keep the extension so the
// magic bytes still line up with what opentype expects).
const cacheNameFor = (url: string): string => {
  const ext = url.endsWith(".otf") ? "otf" : "ttf";
  const stem = url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .slice(0, 120);
  return `${stem}.${ext}`;
};

// Read a cached font file's bytes, or null if not present / fs unavailable.
const readDiskCache = async (dir: string, name: string): Promise<ArrayBuffer | null> => {
  try {
    const path = await join(dir, name);
    if (!(await exists(path))) return null;
    const bytes = await readFile(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
};

// Persist fetched bytes to the disk cache; failures are non-fatal (the font is
// still usable this session from memory).
const writeDiskCache = async (dir: string, name: string, bytes: ArrayBuffer): Promise<void> => {
  try {
    await mkdir(dir, { recursive: true });
    const path = await join(dir, name);
    await writeFile(path, new Uint8Array(bytes));
  } catch {
    /* ignore — cache is best-effort */
  }
};

// Resolve the on-disk cache dir, or null when fs/path is unavailable (e.g. a
// plain browser, where we fall back to memory + network only).
const resolveCacheDir = async (): Promise<string | null> => {
  try {
    return await join(await appCacheDir(), "tepra-fonts");
  } catch {
    return null;
  }
};

// Load ONE font: in-memory cache → disk cache → network (writing both caches).
// Returns the parsed Font and how it was obtained, or null if all paths failed.
const loadOneFont = async (
  src: FontSource,
  cacheDir: string | null,
): Promise<{ font: Font; via: "cache" | "network" } | null> => {
  const mem = memCache.get(src.url);
  if (mem) return { font: mem, via: "cache" };

  const name = cacheNameFor(src.url);
  if (cacheDir) {
    const cached = await readDiskCache(cacheDir, name);
    if (cached) {
      try {
        const f = parseOpentype(cached);
        memCache.set(src.url, f);
        return { font: f, via: "cache" };
      } catch {
        /* corrupt entry — fall through to network */
      }
    }
  }
  try {
    const res = await fetch(src.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const f = parseOpentype(ab);
    memCache.set(src.url, f);
    if (cacheDir) await writeDiskCache(cacheDir, name, ab);
    return { font: f, via: "network" };
  } catch {
    return null;
  }
};

/**
 * A local font file the user has on disk (from cmd_list_fonts). Used as the
 * DEEPEST tepra "Auto" fallback for glyphs no Noto font covers — typically the
 * big generalist fonts BabelStone Han (CJK Ext-B…G) and Code2000 (broad BMP).
 */
export type LocalFont = { label: string; path: string };

// Load a local font file by path (in-memory cached by `path` key). opentype.js
// parses TTF/OTF directly; failures (missing file / fs unavailable) → null.
const loadLocalFont = async (lf: LocalFont): Promise<Font | null> => {
  const key = `local:${lf.path}`;
  const mem = memCache.get(key);
  if (mem) return mem;
  try {
    const bytes = await readFile(lf.path);
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const f = parseOpentype(ab);
    memCache.set(key, f);
    return f;
  } catch {
    return null;
  }
};

/**
 * From a list of installed fonts (cmd_list_fonts), pick the well-known
 * generalist fallbacks — BabelStone Han and Code2000/Code2001 — by filename.
 * These are the non-Noto fonts Unim leans on for CJK extensions and broad
 * symbol coverage; when present locally they extend the Auto stack to true
 * Unim-equivalent reach. Returned in priority order (BabelStone first: its CJK
 * extension coverage is the main gap in Noto).
 */
export const pickGeneralistFallbacks = (
  installed: { label: string; path: string }[],
): LocalFont[] => {
  const want = (re: RegExp) =>
    installed.find((f) => re.test(f.path.split(/[/\\]/).pop() ?? ""));
  const out: LocalFont[] = [];
  const babel = want(/babelstone.*han/i);
  if (babel) out.push({ label: "BabelStone Han", path: babel.path });
  const code = want(/^code200[01]\.ttf$/i) ?? want(/code200[01]/i);
  if (code) out.push({ label: "Code2000", path: code.path });
  return out;
};

/**
 * Load the given font stack (default: DEFAULT_STACK). Returns the parsed Fonts
 * that loaded successfully, in stack order. Each font is taken from the
 * in-memory cache, then the disk cache, then the network (and written to both
 * caches). A font that fails on ALL of those is skipped — a partial stack still
 * renders most text. Throws only if NONE of the fonts could be obtained (e.g.
 * fully offline with an empty cache), so the caller can fall back to a local
 * font.
 */
export async function loadFontStack(
  sources: FontSource[] = DEFAULT_STACK,
  onProgress?: (p: StackProgress) => void,
): Promise<Font[]> {
  const cacheDir = await resolveCacheDir();
  const fonts: Font[] = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const got = await loadOneFont(src, cacheDir);
    onProgress?.({ index: i, total: sources.length, label: src.label, via: got ? got.via : "skip" });
    if (got) fonts.push(got.font);
  }
  if (fonts.length === 0) {
    throw new Error("フォントを取得できませんでした（オフラインかつキャッシュ無し）");
  }
  return fonts;
}

// Codepoints in `text` not covered by any font in `stack` (de-duplicated).
const uncoveredChars = (stack: Font[], text: string): string[] => {
  const out = new Set<string>();
  for (const ch of text) {
    if (ch.trim() === "") continue;
    if (!fontForChar(stack, ch)) out.add(ch);
  }
  return [...out];
};

/**
 * Ensure every character in `text` is covered: start from `base` (the eagerly
 * loaded core stack) and, for any character it can't render, pull EXTENDED_STACK
 * fonts ON DEMAND (in order) until the gaps close or the extended list is
 * exhausted. Returns the combined stack (base first, then any extended fonts
 * actually loaded). This is what lets rare/historic glyphs — Linear B (𐃆),
 * Tangut (𘡐), cuneiform, etc. — render Unim-style without loading ~20 extra
 * fonts for ordinary labels.
 */
export async function loadCoverage(
  text: string,
  base: Font[],
  onProgress?: (p: StackProgress) => void,
  localFallbacks: LocalFont[] = [],
): Promise<Font[]> {
  let stack = base.slice();
  let missing = uncoveredChars(stack, text);
  if (missing.length === 0) return stack;

  // Keep an extra font only if it closes at least one gap, so the synthesized
  // stack stays minimal.
  const tryAdd = (f: Font | null): boolean => {
    if (!f) return false;
    const before = missing.length;
    const trial = [...stack, f];
    const still = uncoveredChars(trial, missing.join(""));
    if (still.length < before) {
      stack = trial;
      missing = still;
      return true;
    }
    return false;
  };

  // 1. Noto extended families (CDN, on demand).
  const cacheDir = await resolveCacheDir();
  for (let i = 0; i < EXTENDED_STACK.length && missing.length > 0; i++) {
    const src = EXTENDED_STACK[i];
    const got = await loadOneFont(src, cacheDir);
    onProgress?.({ index: i, total: EXTENDED_STACK.length, label: src.label, via: got ? got.via : "skip" });
    if (got) tryAdd(got.font);
  }

  // 2. Local generalist fallbacks (BabelStone Han, Code2000) for anything Noto
  //    still can't render — chiefly CJK extensions B…G. Loaded on demand.
  for (let i = 0; i < localFallbacks.length && missing.length > 0; i++) {
    const lf = localFallbacks[i];
    onProgress?.({ index: i, total: localFallbacks.length, label: lf.label, via: "cache" });
    tryAdd(await loadLocalFont(lf));
  }

  return stack;
}

/**
 * Pick the first font in the stack that has a glyph for `ch`. Returns null if
 * none do (the caller renders nothing / a blank advance for that char).
 */
export const fontForChar = (stack: Font[], ch: string): Font | null => {
  for (const f of stack) {
    try {
      if (f.hasChar(ch)) return f;
    } catch {
      /* some fonts throw on exotic input — treat as "no glyph" */
    }
  }
  return null;
};
