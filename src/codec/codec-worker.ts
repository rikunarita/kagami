/**
 * Codec worker — jSquash (Squoosh-derived WASM codecs).
 * Rasterises (Skia PNG decode or SVG vector raster) and encodes one candidate
 * per job, so the pool evaluates the whole candidate matrix in parallel.
 */
/// <reference lib="webworker" />
// Emscripten (Squoosh-era) glue detects workers via importScripts, which module
// workers lack; provide a stub so it takes the worker code path.
if (typeof (self as never as { importScripts?: unknown }).importScripts !== "function") {
  (self as never as { importScripts?: unknown }).importScripts = () => undefined;
}
import mozjpegEncFactory from "@jsquash/jpeg/codec/enc/mozjpeg_enc.js";
import mozjpegDecFactory from "@jsquash/jpeg/codec/dec/mozjpeg_dec.js";
import webpEncFactory from "@jsquash/webp/codec/enc/webp_enc.js";
import webpEncSimdFactory from "@jsquash/webp/codec/enc/webp_enc_simd.js";
import webpDecFactory from "@jsquash/webp/codec/dec/webp_dec.js";
import avifEncFactory from "@jsquash/avif/codec/enc/avif_enc.js";
import avifDecFactory from "@jsquash/avif/codec/dec/avif_dec.js";
import pngInit, { encode as pngEnc, decode as pngDec } from "@jsquash/png/codec/pkg/squoosh_png.js";
import { optimise as oxipngOptimise } from "@jsquash/oxipng";
import { simd } from "wasm-feature-detect";
import { defaultOptions as jpegDefaults } from "@jsquash/jpeg/meta.js";
import { defaultOptions as webpDefaults } from "@jsquash/webp/meta.js";
import { defaultOptions as avifDefaults } from "@jsquash/avif/meta.js";

const ENCODER_DEFAULTS: Record<string, Record<string, unknown>> = {
  jpeg: { ...jpegDefaults },
  webp: { ...webpDefaults },
  avif: { ...avifDefaults },
};
import mozjpegEncWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url";
import mozjpegDecWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?url";
import webpEncWasm from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import webpEncSimdWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";
import webpDecWasm from "@jsquash/webp/codec/dec/webp_dec.wasm?url";
import avifEncWasm from "@jsquash/avif/codec/enc/avif_enc.wasm?url";
import avifDecWasm from "@jsquash/avif/codec/dec/avif_dec.wasm?url";
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm?url";

type Msg =
  | { t: "warm"; id: number }
  | {
      t: "encode";
      id: number;
      srcKey: string;
      src: { k: "png"; bytes: Uint8Array } | { k: "svg"; svg: string; width: number; height: number };
      format: string;
      candidate: { id: string; options: Record<string, unknown>; preprocess?: { quantBits: number; alphaClean: boolean } };
    }
  | { t: "analyze"; id: number; srcKey: string; format: string; bytes: Uint8Array; expectExact: boolean };

const wasmCache = new Map<string, Promise<ArrayBuffer>>();
const loadWasm = (url: string) => {
  let p = wasmCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => r.arrayBuffer());
    wasmCache.set(url, p);
  }
  return p;
};

interface EmscriptenCodec {
  encode(data: Uint8ClampedArray | Uint8Array, w: number, h: number, opts: Record<string, unknown>): Uint8Array | null;
  decode?(buf: ArrayBuffer, ...rest: unknown[]): ImageData | null;
}
const codecs: Record<string, Promise<EmscriptenCodec | typeof import("@jsquash/png/codec/pkg/squoosh_png.js")>> = {} as never;

async function getEncoder(format: string): Promise<EmscriptenCodec> {
  if (!codecs[format]) {
    codecs[format] = (async () => {
      if (format === "jpeg")
        return mozjpegEncFactory({ noInitialRun: true, wasmBinary: await loadWasm(mozjpegEncWasm) }) as Promise<EmscriptenCodec>;
      if (format === "webp") {
        const useSimd = await simd();
        const [fac, bin] = useSimd ? [webpEncSimdFactory, webpEncSimdWasm] : [webpEncFactory, webpEncWasm];
        return fac({ noInitialRun: true, wasmBinary: await loadWasm(bin) }) as Promise<EmscriptenCodec>;
      }
      if (format === "avif")
        return avifEncFactory({ noInitialRun: true, wasmBinary: await loadWasm(avifEncWasm) }) as Promise<EmscriptenCodec>;
      throw new Error(`no encoder ${format}`);
    })();
  }
  return codecs[format] as Promise<EmscriptenCodec>;
}

async function getDecoder(format: string): Promise<EmscriptenCodec> {
  const key = `dec:${format}`;
  if (!codecs[key]) {
    codecs[key] = (async () => {
      if (format === "jpeg")
        return mozjpegDecFactory({ noInitialRun: true, wasmBinary: await loadWasm(mozjpegDecWasm) }) as Promise<EmscriptenCodec>;
      if (format === "webp")
        return webpDecFactory({ noInitialRun: true, wasmBinary: await loadWasm(webpDecWasm) }) as Promise<EmscriptenCodec>;
      if (format === "avif")
        return avifDecFactory({ noInitialRun: true, wasmBinary: await loadWasm(avifDecWasm) }) as Promise<EmscriptenCodec>;
      throw new Error(`no decoder ${format}`);
    })();
  }
  return codecs[key] as Promise<EmscriptenCodec>;
}

async function initPng() {
  await pngInit(await loadWasm(pngWasm));
}

const imageCache = new Map<string, ImageData>();

type Src = { k: "png"; bytes: Uint8Array } | { k: "svg"; svg: string; width: number; height: number };
function decodeWith(format: string, dec: EmscriptenCodec, buf: ArrayBuffer): ImageData {
  const res = format === "webp" ? dec.decode!(buf) : format === "jpeg" ? dec.decode!(buf, false) : dec.decode!(buf, 8);
  if (!res) throw new Error("decode failed");
  return res;
}

async function sourcePixels(src: Src, srcKey: string): Promise<ImageData> {
  const hit = imageCache.get(srcKey);
  if (hit) return hit;
  let img: ImageData;
  if (src.k === "png") {
    await initPng();
    img = await pngDec(new Uint8Array(src.bytes));
  } else {
    const blob = new Blob([src.svg], { type: "image/svg+xml" });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(src.width, src.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, src.width, src.height);
    bitmap.close();
    img = ctx.getImageData(0, 0, src.width, src.height);
  }
  if (imageCache.size > 3) imageCache.clear();
  imageCache.set(srcKey, img);
  return img;
}

function preprocess(img: ImageData, q: { quantBits: number; alphaClean: boolean }): ImageData {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const mask = (0xff << q.quantBits) & 0xff;
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i] & mask;
    d[i + 1] = d[i + 1] & mask;
    d[i + 2] = d[i + 2] & mask;
    if (q.alphaClean) d[i + 3] = d[i + 3] < 8 ? 0 : d[i + 3] > 247 ? 255 : d[i + 3];
  }
  return out;
}

function psnrOf(a: ImageData, b: ImageData): { psnr: number; maxDiff: number; exact: boolean } {
  if (a.width !== b.width || a.height !== b.height) return { psnr: -1, maxDiff: -1, exact: false };
  const da = a.data,
    db = b.data;
  let maxDiff = 0,
    sum = 0,
    n = 0;
  for (let i = 0; i < da.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = da[i + c] - db[i + c];
      const ad = diff < 0 ? -diff : diff;
      if (ad > maxDiff) maxDiff = ad;
      sum += diff * diff;
      n++;
    }
    const ad = da[i + 3] - db[i + 3];
    const adiff = ad < 0 ? -ad : ad;
    if (adiff > maxDiff) maxDiff = adiff;
  }
  const mse = sum / n;
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), maxDiff, exact: maxDiff === 0 };
}

self.addEventListener("unhandledrejection", (ev) => console.log("[codec] unhandled", (ev as PromiseRejectionEvent).reason));
self.onerror = (ev) => console.log("[codec] onerror", (ev as ErrorEvent).message);
self.onmessage = async (e: MessageEvent<Msg>) => {
  const msg = e.data;
  try {
    if (msg.t === "warm") {
      const px = new ImageData(new Uint8ClampedArray(4).fill(128), 1, 1);
      await initPng();
      const tinyPng = await pngEnc(new Uint8Array(px.data.buffer), 1, 1, 8);
      await pngDec(new Uint8Array(tinyPng));
      await oxipngOptimise(px, { level: 1 } as never);
      for (const fmt of ["jpeg", "webp", "avif"]) {
        const enc = await getEncoder(fmt);
        const buf = enc.encode(px.data, 1, 1, { ...ENCODER_DEFAULTS[fmt] });
        if (buf) {
          const dec = await getDecoder(fmt);
          decodeWith(fmt, dec, buf.buffer as ArrayBuffer);
        }
      }
      (self as unknown as Worker).postMessage({ t: "warmed", id: msg.id });
      return;
    }
    if (msg.t === "encode") {
      const t0 = performance.now();
      const img = await sourcePixels(msg.src, msg.srcKey);
      void img;
      const pixels = msg.candidate.preprocess ? preprocess(img, msg.candidate.preprocess) : img;
      let bytes: ArrayBuffer;
      if (msg.format === "png" && msg.candidate.options.__oxi) {
        bytes = await oxipngOptimise(pixels, msg.candidate.options as never);
      } else if (msg.format === "png") {
        await initPng();
        const view = new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength);
        const res = await pngEnc(view, pixels.width, pixels.height, 8);
        if (!res) throw new Error("png encode failed");
        bytes = res.buffer as ArrayBuffer;
      } else {
        const enc = await getEncoder(msg.format);
        console.log("[codec] enc start", msg.format, msg.candidate.id);
        const res = enc.encode(pixels.data, pixels.width, pixels.height, { ...ENCODER_DEFAULTS[msg.format], ...msg.candidate.options });
        console.log("[codec] enc done", msg.format, msg.candidate.id, res?.byteLength);
        if (!res) throw new Error("encode failed");
        bytes = res.buffer as ArrayBuffer;
      }
      const out = new Uint8Array(bytes);
      (self as unknown as Worker).postMessage({ t: "encoded", id: msg.id, bytes: out, ms: performance.now() - t0 }, [out.buffer]);
    } else if (msg.t === "analyze") {
      const t0 = performance.now();
      const src = imageCache.get(msg.srcKey);
      let decoded: ImageData;
      if (msg.format === "png") {
        await initPng();
        decoded = await pngDec(new Uint8Array(msg.bytes));
      } else {
        const dec = await getDecoder(msg.format);
        decoded = decodeWith(msg.format, dec, msg.bytes.buffer as ArrayBuffer);
      }
      const stats = src ? psnrOf(src, decoded) : { psnr: -1, maxDiff: -1, exact: false };
      (self as unknown as Worker).postMessage({ t: "analyzed", id: msg.id, ...stats, ms: performance.now() - t0 });
    }
  } catch (err) {
    console.log("[codec] job error", err);
    (self as unknown as Worker).postMessage({ t: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
