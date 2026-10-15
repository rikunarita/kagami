/**
 * Compression strategies — candidate matrices per format / mode / effort.
 * The codec pool evaluates every candidate concurrently (one per worker)
 * and the smallest valid output wins.
 */
export type OutputFormat = "svg" | "png" | "jpeg" | "webp" | "avif";
export type Mode = "lossless" | "lossy";
export type Effort = "balanced" | "high" | "extreme";

export interface Candidate {
  id: string;
  /** jSquash encoder options */
  options: Record<string, unknown>;
  /** pixel pre-processing before lossless PNG encode (uniform quantisation) */
  preprocess?: { quantBits: number; alphaClean: boolean };
}

export interface StrategyResult {
  candidates: Candidate[];
  /** format cannot honour the requested mode */
  unsupported?: string;
}

const jpegLossy = (q: number, effort: Effort): Candidate[] => {
  const loops = effort === "extreme" ? 8 : effort === "high" ? 4 : 1;
  const multipass = effort !== "balanced";
  const base = (id: string, extra: Record<string, unknown>): Candidate => ({
    id,
    options: {
      quality: q,
      baseline: false,
      arithmetic: false,
      progressive: true,
      optimize_coding: true,
      smoothing: 0,
      color_space: 3,
      quant_table: 3,
      trellis_multipass: multipass,
      trellis_opt_zero: multipass,
      trellis_opt_table: effort === "extreme",
      trellis_loops: loops,
      auto_subsample: true,
      chroma_subsample: 2,
      separate_chroma_quality: false,
      chroma_quality: q,
      ...extra,
    },
  });
  const list = [base("mozjpeg qt3", {})];
  if (effort !== "balanced") list.push(base("mozjpeg qt2", { quant_table: 2 }));
  if (effort === "extreme") list.push(base("mozjpeg arith", { arithmetic: true, progressive: false }));
  return list;
};

const webpLossless = (effort: Effort): Candidate[] => {
  const list: Candidate[] = [
    {
      id: "webp L m6 q100",
      options: { lossless: 1, quality: 100, method: 6, exact: 1, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100 },
    },
  ];
  if (effort !== "balanced")
    list.push({
      id: "webp L m6 q100 noexact",
      options: { lossless: 1, quality: 100, method: 6, exact: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100 },
    });
  if (effort === "extreme")
    list.push({
      id: "webp L m6 q75",
      options: { lossless: 1, quality: 75, method: 6, exact: 1, alpha_compression: 1, alpha_filtering: 2, alpha_quality: 100 },
    });
  return list;
};

const webpLossy = (q: number, effort: Effort): Candidate[] => {
  const method = effort === "balanced" ? 4 : 6;
  const pass = effort === "extreme" ? 6 : 1;
  const list: Candidate[] = [
    {
      id: `webp m${method} p${pass}`,
      options: { quality: q, method, pass, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100, autofilter: 0 },
    },
  ];
  if (effort !== "balanced")
    list.push({
      id: "webp sharp-yuv",
      options: { quality: q, method: 6, pass, use_sharp_yuv: 1, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100 },
    });
  if (effort === "extreme")
    list.push({
      id: "webp autofilter",
      options: { quality: q, method: 6, pass: 10, autofilter: 1, alpha_compression: 1, alpha_filtering: 2, alpha_quality: 100 },
    });
  return list;
};

const avifLossless = (effort: Effort): Candidate[] => {
  const speed = effort === "extreme" ? 0 : effort === "high" ? 1 : 4;
  return [
    {
      id: `avif L s${speed}`,
      options: {
        lossless: true,
        quality: 100,
        qualityAlpha: 100,
        subsample: 3,
        speed,
        tileColsLog2: 0,
        tileRowsLog2: 0,
        chromaDeltaQ: false,
        sharpness: 0,
        tune: 0,
        enableSharpYUV: false,
        bitDepth: 8,
      },
    },
  ];
};

const avifLossy = (q: number, effort: Effort): Candidate[] => {
  const speed = effort === "extreme" ? 0 : effort === "high" ? 2 : 4;
  const list: Candidate[] = [
    {
      id: `avif s${speed}`,
      options: {
        quality: q,
        qualityAlpha: q,
        subsample: 1,
        speed,
        tune: 0,
        chromaDeltaQ: false,
        sharpness: 0,
        enableSharpYUV: false,
        bitDepth: 8,
        lossless: false,
      },
    },
  ];
  if (effort !== "balanced")
    list.push({
      id: `avif s${speed} cdq`,
      options: {
        quality: q,
        qualityAlpha: q,
        subsample: 1,
        speed,
        tune: 0,
        chromaDeltaQ: true,
        sharpness: 1,
        enableSharpYUV: true,
        bitDepth: 8,
        lossless: false,
      },
    });
  return list;
};

const pngLossy = (q: number): Candidate[] => {
  // uniform channel quantisation (lossy pre-process) + oxipng lossless container
  const bits = q >= 90 ? 1 : q >= 70 ? 2 : q >= 45 ? 3 : 4;
  return [
    {
      id: `png q${bits}bit + oxipng L6`,
      options: { __oxi: 1, level: 6, interlace: false, optimiseAlpha: false },
      preprocess: { quantBits: bits, alphaClean: true },
    },
  ];
};

export function candidatesFor(format: OutputFormat, mode: Mode, quality: number, effort: Effort): StrategyResult {
  if (format === "svg") return { candidates: [] };
  if (format === "jpeg") {
    if (mode === "lossless")
      return {
        candidates: [],
        unsupported: "JPEG has no mathematically lossless mode (MozJPEG is DCT-based). Use PNG / WebP / AVIF for lossless output.",
      };
    return { candidates: jpegLossy(quality, effort) };
  }
  if (format === "png") {
    if (mode === "lossless")
      return {
        candidates: [
          { id: "oxipng L6", options: { __oxi: 1, level: 6, interlace: false, optimiseAlpha: false } },
          ...(effort === "balanced" ? [] : [{ id: "oxipng L5", options: { __oxi: 1, level: 5, interlace: false, optimiseAlpha: false } }]),
          ...(effort === "extreme"
            ? [{ id: "oxipng L6 interlaced", options: { __oxi: 1, level: 6, interlace: true, optimiseAlpha: false } }]
            : []),
          { id: "squoosh png", options: { bitDepth: 8 } },
        ],
      };
    return { candidates: pngLossy(quality) };
  }
  if (format === "webp") return { candidates: mode === "lossless" ? webpLossless(effort) : webpLossy(quality, effort) };
  if (format === "avif") return { candidates: mode === "lossless" ? avifLossless(effort) : avifLossy(quality, effort) };
  return { candidates: [] };
}

export const FORMAT_META: Record<OutputFormat, { mime: string; ext: string; label: string; losslessCapable: boolean }> = {
  svg: { mime: "image/svg+xml", ext: "svg", label: "SVG", losslessCapable: true },
  png: { mime: "image/png", ext: "png", label: "PNG", losslessCapable: true },
  jpeg: { mime: "image/jpeg", ext: "jpg", label: "JPEG", losslessCapable: false },
  webp: { mime: "image/webp", ext: "webp", label: "WebP", losslessCapable: true },
  avif: { mime: "image/avif", ext: "avif", label: "AVIF", losslessCapable: true },
};
