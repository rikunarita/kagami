/**
 * Headless pipeline verification (Node, no DOM):
 *  Satoru render (SVG+PNG) -> jSquash decode -> candidate encode -> verify.
 * Usage: node tests/node-engine.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { render } from "satoru-render/single";
import pngDecode, { init as pngDecInit } from "@jsquash/png/decode.js";
import pngEncode, { init as pngEncInit } from "@jsquash/png/encode.js";
import jpegEncode, { init as jpegEncInit } from "@jsquash/jpeg/encode.js";
import jpegDecode, { init as jpegDecInit } from "@jsquash/jpeg/decode.js";
import webpEncode, { init as webpEncInit } from "@jsquash/webp/encode.js";
import webpDecode, { init as webpDecInit } from "@jsquash/webp/decode.js";
import avifEncode, { init as avifEncInit } from "@jsquash/avif/encode.js";
import avifDecode, { init as avifDecInit } from "@jsquash/avif/decode.js";
import oxiOptimise, { init as oxiInit } from "@jsquash/oxipng/optimise.js";

const wasm = (p) => readFileSync(new URL(`../node_modules/@jsquash/${p}`, import.meta.url)).buffer;
await Promise.all([
  pngDecInit(wasm("png/codec/pkg/squoosh_png_bg.wasm")),
  pngEncInit(wasm("png/codec/pkg/squoosh_png_bg.wasm")),
  jpegEncInit({ wasmBinary: wasm("jpeg/codec/enc/mozjpeg_enc.wasm") }),
  jpegDecInit({ wasmBinary: wasm("jpeg/codec/dec/mozjpeg_dec.wasm") }),
  webpEncInit({ wasmBinary: wasm("webp/codec/enc/webp_enc_simd.wasm") }),
  webpDecInit({ wasmBinary: wasm("webp/codec/dec/webp_dec.wasm") }),
  avifEncInit({ wasmBinary: wasm("avif/codec/enc/avif_enc.wasm") }),
  avifDecInit({ wasmBinary: wasm("avif/codec/dec/avif_dec.wasm") }),
  oxiInit(wasm("oxipng/codec/pkg/squoosh_oxipng_bg.wasm")),
]);
const html = readFileSync(new URL("../assets/sample.html", import.meta.url), "utf8");
const WIDTH = 1280;

const encoders = {
  png: (img, o) => pngEncode(img, o),
  jpeg: (img, o) => jpegEncode(img, o),
  webp: (img, o) => webpEncode(img, o),
  avif: (img, o) => avifEncode(img, o),
};
const decoders = {
  png: (b) => pngDecode(b),
  jpeg: (b) => jpegDecode(b),
  webp: (b) => webpDecode(b),
  avif: (b) => avifDecode(b),
};

function stats(a, b) {
  let maxDiff = 0,
    sum = 0,
    n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c] - b.data[i + c];
      sum += d * d;
      n++;
      const ad = Math.abs(d);
      if (ad > maxDiff) maxDiff = ad;
    }
    const ad = Math.abs(a.data[i + 3] - b.data[i + 3]);
    if (ad > maxDiff) maxDiff = ad;
  }
  const mse = sum / n;
  return { exact: maxDiff === 0, maxDiff, psnr: mse === 0 ? Infinity : 10 * Math.log10(65025 / mse) };
}

const CASES = [
  [
    "png",
    "lossless",
    [
      { id: "squoosh png", options: { bitDepth: 8 } },
      { id: "oxipng L6", options: { __oxi: 1, level: 6 } },
    ],
  ],
  [
    "webp",
    "lossless",
    [
      { id: "webp L q100 m6 exact", options: { lossless: 1, quality: 100, method: 6, exact: 1 } },
      { id: "webp L q100 m6", options: { lossless: 1, quality: 100, method: 6, exact: 0 } },
    ],
  ],
  ["avif", "lossless", [{ id: "avif L s0", options: { lossless: true, quality: 100, qualityAlpha: 100, subsample: 3, speed: 0 } }]],
  [
    "jpeg",
    "lossy85",
    [
      {
        id: "mozjpeg qt3 tm",
        options: {
          quality: 85,
          progressive: true,
          optimize_coding: true,
          quant_table: 3,
          trellis_multipass: true,
          trellis_opt_zero: true,
          trellis_loops: 4,
          chroma_subsample: 2,
        },
      },
      {
        id: "mozjpeg qt2 tm",
        options: {
          quality: 85,
          progressive: true,
          optimize_coding: true,
          quant_table: 2,
          trellis_multipass: true,
          trellis_opt_zero: true,
          trellis_loops: 4,
          chroma_subsample: 2,
        },
      },
    ],
  ],
  [
    "webp",
    "lossy85",
    [
      { id: "webp m6 p1", options: { quality: 85, method: 6, pass: 1 } },
      { id: "webp m6 p6 sharp", options: { quality: 85, method: 6, pass: 6, use_sharp_yuv: 1 } },
    ],
  ],
  [
    "avif",
    "lossy85",
    [
      { id: "avif s2", options: { quality: 85, speed: 2, subsample: 1 } },
      { id: "avif s2 cdq", options: { quality: 85, speed: 2, subsample: 1, chromaDeltaQ: true, enableSharpYUV: true } },
    ],
  ],
];

const report = { width: WIDTH, cases: [] };
mkdirSync(new URL("../out", import.meta.url), { recursive: true });

const t0 = Date.now();
const svg = await render({ value: html, width: WIDTH, format: "svg", textToPaths: true });
const tSvg = Date.now() - t0;
const t1 = Date.now();
const png = await render({ value: html, width: WIDTH, format: "png", textToPaths: true });
const tPng = Date.now() - t1;
writeFileSync(new URL("../out/node-render.svg", import.meta.url), svg);
writeFileSync(new URL("../out/node-render.png", import.meta.url), Buffer.from(png));
const source = await pngDecode(png.buffer);
console.log(`render: svg ${tSvg}ms (${svg.length}B) / png ${tPng}ms (${png.length}B) / raster ${source.width}x${source.height}`);
report.render = { svgMs: tSvg, svgBytes: svg.length, pngMs: tPng, pngBytes: png.length, dims: [source.width, source.height] };

for (const [format, mode, candidates] of CASES) {
  const rows = [];
  for (const c of candidates) {
    const te = Date.now();
    const buf = c.options.__oxi ? await oxiOptimise(source, c.options) : await encoders[format](source, c.options);
    const ms = Date.now() - te;
    const dec = await decoders[format](buf);
    const st = stats(source, dec);
    rows.push({ id: c.id, bytes: buf.byteLength, ms, ...st });
    writeFileSync(
      new URL(`../out/node-${format}-${mode}-${c.id.replace(/\W+/g, "_")}.${format === "jpeg" ? "jpg" : format}`, import.meta.url),
      Buffer.from(buf),
    );
  }
  const best = rows.reduce((a, b) => (b.bytes < a.bytes ? b : a));
  const ok = mode === "lossless" ? best.exact : true;
  console.log(
    `${format}/${mode}: ` +
      rows
        .map((r) => `${r.id}=${r.bytes}B/${r.ms}ms/exact:${r.exact}/psnr:${r.psnr === Infinity ? "inf" : r.psnr.toFixed(1)}`)
        .join(" | ") +
      `  => WIN ${best.id}`,
  );
  if (mode === "lossless" && !ok) {
    console.error(`FAIL: ${format} lossless not pixel-exact (maxDiff ${best.maxDiff})`);
    process.exitCode = 1;
  }
  report.cases.push({ format, mode, rows, winner: best.id });
}
writeFileSync(new URL("../results-node.json", import.meta.url), JSON.stringify(report, null, 2));
console.log("node engine verification complete");
