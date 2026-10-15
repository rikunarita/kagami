/**
 * RenderEngine — Satoru (Skia/litehtml WASM) orchestration.
 *
 * Performance features:
 *  - Multi-threaded rendering: a Satoru worker pool (`createSatoruWorker`)
 *    executes independent render jobs (SVG vector pass + Skia raster pass)
 *    concurrently on separate cores.
 *  - Layout reuse: a long-lived main-thread document instance is parsed once
 *    (`init_document`); width changes only re-run `layout_document`, and
 *    format / crop / background switches re-run `render_from_state` only.
 *  - Caching: SVG results (LRU), resolved resources (CacheStorage), font
 *    subsets (FontKit: memory + IndexedDB).
 */
import { Satoru } from "satoru-render/index";
import { createSatoruWorker } from "satoru-render/workers";
import type { RenderOptions, WorkerPoolStats } from "satoru-render/workers";

/**
 * Dispatcher over N single-worker Satoru proxies.
 * (worker-lib's internal multi-slot queue showed a concurrency race; N pools of
 *  one worker each give deterministic least-busy dispatch while keeping real
 *  multi-threaded rendering.)
 */
type SatoruProxy = ReturnType<typeof createSatoruWorker>;
class SatoruPool {
  private slots: { p: SatoruProxy; busy: number }[] = [];
  private completed = 0;
  private totalMs = 0;

  constructor(n: number) {
    for (let i = 0; i < n; i++) this.slots.push({ p: createSatoruWorker({ maxParallel: 1 }), busy: 0 });
  }
  async waitReady() {
    await Promise.all(this.slots.map((s) => s.p.waitReady()));
    // Sequentially pre-warm each worker (concurrent cold WASM boots deadlock).
    for (const s of this.slots) {
      await s.p.render({ value: "<p>.</p>", width: 32, format: "svg" } as RenderOptions);
    }
  }
  get workerCount() {
    return this.slots.length;
  }
  stats(): WorkerPoolStats {
    const active = this.slots.filter((s) => s.busy > 0).length;
    return {
      workerCount: this.slots.length,
      activeJobs: active,
      queuedJobs: 0,
      completedJobs: this.completed,
      failedJobs: 0,
      avgJobTimeMs: this.completed ? this.totalMs / this.completed : 0,
    };
  }
  setLimit(n: number) {
    while (this.slots.length > n) {
      const s = this.slots.pop();
      if (s && !s.busy) s.p.close();
      else if (s) this.slots.push(s);
    }
    while (this.slots.length < n) this.slots.push({ p: createSatoruWorker({ maxParallel: 1 }), busy: 0 });
  }
  async render(options: RenderOptions): Promise<string | Uint8Array> {
    let target = this.slots[0];
    for (const s of this.slots) if (s.busy < target.busy) target = s;
    target.busy++;
    const t0 = performance.now();
    try {
      const out = await target.p.render(options);
      this.completed++;
      this.totalMs += performance.now() - t0;
      return out;
    } finally {
      target.busy--;
    }
  }
}
import createSatoruModule from "satoru-render/satoru.js";
import satoruWasmUrl from "satoru-render/satoru.wasm?url";
import { LOCAL_FONT_MAP, localFontResult, resolveDocumentFonts, type FontFace } from "./fontkit";
import { LRU, fnv1a } from "../lib/utils";

export interface RenderPair {
  svg: string;
  png: Uint8Array;
  width: number;
  height: number;
  timings: Record<string, number>;
  fonts: { family: string; status: string }[];
  via: "layout-reuse" | "worker-pool";
}

interface LiveDoc {
  inst: unknown;
  htmlHash: string;
  width: number;
}

export class RenderEngine {
  private satoru!: Satoru;
  private pool!: SatoruPool;
  private live: LiveDoc | undefined;
  private liveProm: Promise<LiveDoc> | undefined;
  private livePromHash = "";
  private pairCache = new LRU<string, RenderPair>(6);
  private resCache?: Cache;
  maxParallel: number;
  external = true;
  activeHtml = "";
  ready: Promise<void>;

  setExternal(v: boolean) {
    this.external = v;
  }

  setParallel(n: number) {
    this.maxParallel = n;
    try {
      this.pool?.setLimit(n);
    } catch {
      /* pool not ready yet */
    }
  }

  seqJobs = false;
  noResolver = false;

  constructor(maxParallel?: number, opts: { seq?: boolean; noResolver?: boolean } = {}) {
    this.maxParallel = maxParallel ?? Math.max(2, Math.min(4, navigator.hardwareConcurrency || 4));
    this.seqJobs = !!opts.seq;
    this.noResolver = !!opts.noResolver;
    this.ready = this.init();
  }

  private async init() {
    const wasmBin = fetch(satoruWasmUrl).then((r) => r.arrayBuffer());
    const [, , cacheHandle] = await Promise.all([
      (async () => {
        this.satoru = await Satoru.create(async (initial: Record<string, unknown>) =>
          createSatoruModule({ ...initial, wasmBinary: await wasmBin }),
        );
      })(),
      (async () => {
        this.pool = new SatoruPool(this.maxParallel);
        await this.pool.waitReady();
      })(),
      globalThis.caches?.open("kagami-resources").catch(() => undefined),
    ]);
    this.resCache = cacheHandle;
  }

  poolStats(): WorkerPoolStats | undefined {
    try {
      return this.pool?.stats();
    } catch {
      return undefined;
    }
  }

  /** Resource resolver with CacheStorage backing (shared with workers via proxy). */
  resolver = async (
    resource: { type: string; url: string; name?: string },
    defaultResolver: (r: { type: string; url: string }) => Promise<Uint8Array | null>,
  ) => {
    const url = resource.url;
    if (url.startsWith("data:")) return null;
    if (url.startsWith("kagami:docfont")) {
      return localFontResult(this.activeHtml, resource.name || "sans-serif");
    }
    if (url.startsWith("kagami:")) return null;
    if (url.startsWith("provider:")) {
      const fam = resource.name && !resource.name.startsWith("kagami:") ? resource.name : "sans-serif";
      if (fam in LOCAL_FONT_MAP || resource.name?.startsWith("kagami:")) {
        return localFontResult(this.activeHtml, fam);
      }
      if (!this.external) return null;
      return defaultResolver(resource);
    }
    if (!this.external) return null;
    if (this.resCache) {
      const hit = await this.resCache.match(url).catch(() => undefined);
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    }
    const data = await defaultResolver(resource);
    if (data && data.byteLength < 4_000_000 && this.resCache) {
      await this.resCache
        .put(url, new Response(data.slice().buffer, { headers: { "Content-Type": "application/octet-stream" } }))
        .catch(() => undefined);
    }
    return data;
  };

  private baseOptions(html: string, fonts: FontFace[]): Partial<RenderOptions> {
    void html;
    return {
      // clone per job: worker-lib transfers ArrayBuffers (would detach the cache)
      fonts: fonts.map((f) => ({ name: f.name, data: f.data.slice() })),
      fontMap: { ...LOCAL_FONT_MAP },
      ...(this.noResolver ? {} : { resolveResource: this.resolver as unknown as RenderOptions["resolveResource"] }),
      mediaType: "screen",
    };
  }

  private async ensureLive(html: string, width: number): Promise<LiveDoc> {
    const htmlHash = fnv1a(html);
    if (this.live && this.live.htmlHash === htmlHash) return this.live;
    if (this.live) await this.satoru.destroyInstance(this.live.inst);
    const fonts = await resolveDocumentFonts(html);
    for (const f of fonts) await this.satoru.loadFont(f.name, f.data);
    const inst = await this.satoru.initDocument({
      html,
      width,
      height: 0,
      fontMap: { ...LOCAL_FONT_MAP },
      resolveResource: this.resolver as unknown as RenderOptions["resolveResource"],
      mediaType: "screen",
    });
    this.live = { inst, htmlHash, width };
    return this.live;
  }

  private async renderFromLive(doc: LiveDoc, width: number, textToPaths: boolean, backgroundColor?: string) {
    if (doc.width !== width) {
      await this.satoru.layoutDocument(doc.inst, width);
      doc.width = width;
    }
    const common = { width, height: 0, textToPaths, backgroundColor, mediaType: "screen" as const };
    const [svg, png] = await Promise.all([
      this.satoru.renderFromState(doc.inst, { ...common, format: "svg" }),
      this.satoru.renderFromState(doc.inst, { ...common, format: "png" }),
    ]);
    return { svg: svg as string, png: png as Uint8Array };
  }

  async render(
    html: string,
    width: number,
    opts: { textToPaths: boolean; backgroundColor?: string; signal?: AbortSignal } = { textToPaths: true },
  ): Promise<RenderPair> {
    await this.ready;
    this.activeHtml = html;
    const key = `${fnv1a(html)}|${width}|${opts.textToPaths ? 1 : 0}|${opts.backgroundColor ?? ""}`;
    const cached = this.pairCache.get(key);
    if (cached) return { ...cached, via: "layout-reuse" };

    const t0 = performance.now();
    const hash = fnv1a(html);
    // Fast path: reuse parsed+collected document (layout reuse).
    if (!this.live && this.liveProm && this.livePromHash === hash) {
      try {
        this.live = await this.liveProm;
      } catch {
        this.live = undefined;
      }
    }
    if (this.live && this.live.htmlHash === hash) {
      const { svg, png } = await this.renderFromLive(this.live, width, opts.textToPaths, opts.backgroundColor);
      const pair = this.finalize(svg, png, width, key, t0, "layout-reuse", []);
      return pair;
    }

    // Cold path: two independent render jobs on the worker pool (parallel).
    const fonts = await resolveDocumentFonts(html);
    const common = {
      value: html,
      width,
      backgroundColor: opts.backgroundColor,
      signal: opts.signal,
      limits: { timeoutMs: 60_000, maxResourceCount: 60, maxTotalResourceBytes: 64_000_000 },
    };
    const job = (format: "svg" | "png") =>
      ({
        ...common,
        ...this.baseOptions(html, fonts),
        format,
        textToPaths: opts.textToPaths,
      }) as RenderOptions;
    const [svg, png] = this.seqJobs
      ? [await this.pool.render(job("svg")), await this.pool.render(job("png"))]
      : await Promise.all([this.pool.render(job("svg")), this.pool.render(job("png"))]);
    const pair = this.finalize(svg as string, png as Uint8Array, width, key, t0, "worker-pool", []);
    // Warm the live instance in background for instant subsequent renders.
    this.livePromHash = hash;
    this.liveProm = this.ensureLive(html, width);
    this.liveProm.catch((e) => {
      console.warn("[kagami] layout-reuse warmup failed:", e, (e as Error)?.stack);
      this.liveProm = undefined;
    });
    return pair;
  }

  private finalize(
    svg: string,
    png: Uint8Array,
    width: number,
    key: string,
    t0: number,
    via: RenderPair["via"],
    fonts: RenderPair["fonts"],
  ): RenderPair {
    const dims = readPngSize(png);
    const pair: RenderPair = { svg, png, width, height: dims.height, timings: { total: performance.now() - t0 }, fonts, via };
    this.pairCache.set(key, pair);
    return pair;
  }

  /** Re-render with a different width using layout reuse (no re-parse). */
  async relayout(html: string, width: number, opts: { textToPaths: boolean; backgroundColor?: string }) {
    await this.ready;
    this.activeHtml = html;
    const doc = await this.ensureLive(html, width);
    const t0 = performance.now();
    const { svg, png } = await this.renderFromLive(doc, width, opts.textToPaths, opts.backgroundColor);
    return this.finalize(svg, png, width, `${doc.htmlHash}|${width}|x`, t0, "layout-reuse", []);
  }
}

export function readPngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
