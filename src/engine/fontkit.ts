/**
 * FontKit — on-demand Japanese font subsetting for the Satoru engine.
 *
 * Satoru (Skia) has no system fonts. Instead of shipping a 5 MB font or hitting
 * the network for every render, FontKit scans the document's codepoints, picks
 * only the unicode-range subsets of "Noto Sans JP Variable" that cover them
 * (typically 2-5 files, ~40-90 KB each), and caches them in memory + IndexedDB.
 */
import { fnv1a } from "../lib/utils";

export interface FontFace {
  name: string;
  data: Uint8Array;
}

type RangePair = [number, number];
interface Subset {
  id: string;
  pairs: RangePair[];
}

const BASE = import.meta.env.BASE_URL;
const LATIN = "latin";

let subsetsPromise: Promise<Subset[]> | undefined;
const memory = new Map<string, Uint8Array>();
let idb: Promise<IDBDatabase | undefined> | undefined;

function openIdb(): Promise<IDBDatabase | undefined> {
  if (idb) return idb;
  idb = new Promise((resolve) => {
    try {
      const req = indexedDB.open("kagami-fonts", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("subsets");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  return idb;
}

async function idbGet(key: string): Promise<Uint8Array | undefined> {
  const db = await openIdb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction("subsets").objectStore("subsets").get(key);
      req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result as ArrayBuffer) : undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function idbSet(key: string, data: Uint8Array): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("subsets", "readwrite");
      tx.objectStore("subsets").put(data.buffer, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function loadSubsets(): Promise<Subset[]> {
  if (!subsetsPromise) {
    subsetsPromise = fetch(`${BASE}fonts/noto-sans-jp/ranges.json`).then((r) => r.json());
  }
  return subsetsPromise;
}

/** Extracts codepoints of renderable text from an HTML source. */
export function collectCodepoints(html: string): Set<number> {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "");
  const decoded = stripped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, d) => String.fromCodePoint(parseInt(d, 16)))
    .replace(/&amp;/g, "&");
  const out = new Set<number>();
  for (const ch of decoded) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x20) out.add(cp);
  }
  return out;
}

export async function selectSubsetIds(html: string): Promise<string[]> {
  const subsets = await loadSubsets();
  const cps = collectCodepoints(html);
  const ids = new Set<string>([LATIN]);
  for (const cp of cps) {
    if (cp < 0x80) continue;
    for (const s of subsets) {
      if (ids.has(s.id)) continue;
      for (const [lo, hi] of s.pairs) {
        if (cp >= lo && cp <= hi) {
          ids.add(s.id);
          break;
        }
      }
    }
  }
  return [...ids];
}

async function fetchSubset(id: string): Promise<Uint8Array> {
  const cached = memory.get(id);
  if (cached) return cached;
  const fromIdb = await idbGet(id);
  if (fromIdb) {
    memory.set(id, fromIdb);
    return fromIdb;
  }
  const res = await fetch(`${BASE}fonts/noto-sans-jp/noto-sans-jp-${id}-wght-normal.woff2`);
  if (!res.ok) throw new Error(`font subset ${id}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  memory.set(id, buf);
  void idbSet(id, buf);
  return buf;
}

const fontCache = new Map<string, FontFace[]>();

/** Resolves (and caches) the minimal font faces covering the document text. */
export async function resolveDocumentFonts(html: string): Promise<FontFace[]> {
  const key = fnv1a(html);
  const hit = fontCache.get(key);
  if (hit) return hit;
  const ids = await selectSubsetIds(html);
  const faces = await Promise.all(ids.map((id) => fetchSubset(id).then((data) => ({ name: "Noto Sans JP", data }))));
  fontCache.set(key, faces);
  return faces;
}

/**
 * Generic families resolve to an internal scheme; the engine resolver answers
 * those requests with the document-specific bundled subsets (zero network).
 */
export const LOCAL_FONT_MAP: Record<string, string> = {
  "sans-serif": "kagami:docfont",
  serif: "kagami:docfont",
  monospace: "kagami:docfont",
  cursive: "kagami:docfont",
  fantasy: "kagami:docfont",
  emoji: "kagami:docfont",
  "Noto Color Emoji": "kagami:docfont",
  "Noto Emoji": "kagami:docfont",
  notocoloremoji: "kagami:docfont",
  notoemoji: "kagami:docfont",
};

export interface ResolvedFontResult {
  css: Uint8Array;
  fonts: { url: string; data: Uint8Array }[];
}

/** Builds a ResolvedFontResult for family `name` from the document subsets. */
export async function localFontResult(html: string, name: string): Promise<ResolvedFontResult | null> {
  const faces = await resolveDocumentFonts(html);
  if (!faces.length) return null;
  const css = faces
    .map(
      (_f, i) =>
        `@font-face{font-family:'${name}';font-style:normal;font-weight:100 900;font-display:block;src:url(kagami:face-${i}) format('woff2');}`,
    )
    .join("\n");
  return { css: new TextEncoder().encode(css), fonts: faces.map((f, i) => ({ url: `kagami:face-${i}`, data: f.data.slice() })) };
}
