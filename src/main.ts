import "./styles.css";
import { ICONS } from "./ui/icons";
import { RenderEngine, type RenderPair } from "./engine/render";
import { CodecPool } from "./codec/pool";
import { candidatesFor, FORMAT_META, type Effort, type Mode, type OutputFormat } from "./codec/strategies";
import { optimizeSvg } from "./codec/svg";
import { clamp, debounce, formatBytes, formatMs } from "./lib/utils";

/* ---------- dom ---------- */
const $ = (id: string): any => document.getElementById(id) as any;
const $$ = (root: any, sel: string) => Array.from(root.querySelectorAll(sel)) as HTMLElement[];
for (const el of Array.from(document.querySelectorAll("[data-ic]"))) {
  el.classList.add("ic");
  el.innerHTML = ICONS[el.getAttribute("data-ic") ?? ""] ?? "";
}

interface State {
  html: string;
  fileName: string;
  width: number;
  format: OutputFormat;
  mode: Mode;
  quality: number;
  effort: Effort;
  bgToggle: boolean;
  bgColor: string;
  textPaths: boolean;
  external: boolean;
}
const state: State = {
  html: "",
  fileName: "",
  width: 1280,
  format: "png",
  mode: "lossless",
  quality: 85,
  effort: "high",
  bgToggle: false,
  bgColor: "#ffffff",
  textPaths: true,
  external: true,
};
try {
  const saved = JSON.parse(localStorage.getItem("kagami-ui") ?? "{}");
  Object.assign(state, saved, { html: "", fileName: "" });
} catch {
  /* ignore */
}
const persist = () => {
  const { html, fileName, ...ui } = state;
  void html;
  void fileName;
  localStorage.setItem("kagami-ui", JSON.stringify(ui));
};

const PARAMS = new URLSearchParams(location.search);
const URL_WORKERS = clamp(Number(PARAMS.get("workers")) || 0, 0, 8);
const engine =
  URL_WORKERS || PARAMS.has("seq") || PARAMS.has("nores")
    ? new RenderEngine(URL_WORKERS || undefined, { seq: PARAMS.has("seq"), noResolver: PARAMS.has("nores") })
    : new RenderEngine();
let pool: CodecPool | undefined;
const codecPool = () => (pool ??= new CodecPool(URL_WORKERS || clamp(navigator.hardwareConcurrency || 4, 2, 4)));

let pair: RenderPair | undefined;
let previewUrl: string | undefined;
let lastResult: { bytes: Uint8Array; mime: string; ext: string } | undefined;
let renderSeq = 0;

/* ---------- ui helpers ---------- */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, err = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("err", err);
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), err ? 6000 : 2600);
}

function chip(id: string, tx: string, on?: boolean, busy?: boolean) {
  $(id).classList.toggle("on", !!on);
  $(id).classList.toggle("busy", !!busy);
  $(`${id}Tx`).textContent = tx;
}

function setSeg(segId: string, attr: string, value: string) {
  for (const b of $$($(segId), "button")) b.classList.toggle("on", b.dataset[attr] === value);
}

function syncControls() {
  $("width").value = String(state.width);
  for (const b of $$($("widthPresets"), "button")) b.classList.toggle("on", Number(b.dataset.w) === state.width);
  setSeg("formatSeg", "f", state.format);
  setSeg("modeSeg", "m", state.mode);
  setSeg("effortSeg", "e", state.effort);
  const meta = FORMAT_META[state.format];
  const losslessBtn = $("modeSeg").querySelector('[data-m="lossless"]') as HTMLButtonElement;
  const note = $("modeNote");
  if (!meta.losslessCapable) {
    losslessBtn.disabled = true;
    note.hidden = false;
    note.innerHTML = `${ICONS.info} JPEG は DCT ベースのため数学的な可逆圧縮に対応していません。非可逆 (品質スライダー) のみ利用できます。`;
    if (state.mode === "lossless") {
      state.mode = "lossy";
      setSeg("modeSeg", "m", state.mode);
    }
  } else {
    losslessBtn.disabled = false;
    note.hidden = true;
  }
  $("qualityRow").hidden = state.mode !== "lossy";
  $("quality").value = String(state.quality);
  $("qualityVal").textContent = `${state.quality}%`;
  $("effortSeg").style.display = state.format === "svg" ? "none" : "";
  $("effortHint").textContent =
    state.effort === "extreme"
      ? "極限: 全エンコーダ候補を並列評価し、最小バイトを採用します (時間は最大)"
      : state.effort === "high"
        ? "高: 複数候補を並列評価し最小バイトを採用"
        : "標準: 単一候補・高速エンコード";
  $("bgToggle").checked = state.bgToggle;
  $("bgColor").value = state.bgColor;
  $("bgColor").disabled = !state.bgToggle;
  $("textPaths").checked = state.textPaths;
  $("external").checked = state.external;
}

/* ---------- preview ---------- */
async function renderPreview(reason: string) {
  if (!state.html) return;
  const seq = ++renderSeq;
  chip("chipEngine", "RENDERING", true, true);
  try {
    const p = await engine.render(state.html, state.width, {
      textToPaths: state.textPaths,
      backgroundColor: state.bgToggle ? state.bgColor : undefined,
    });
    if (seq !== renderSeq) return;
    pair = p;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([p.png as BlobPart], { type: "image/png" }));
    const img = $("preview");
    img.src = previewUrl;
    img.onload = () => applyZoom();
    $("emptyStage").hidden = true;
    $("scroll").hidden = false;
    $("dims").textContent = `${p.width} × ${p.height}px`;
    const via = $("viaBadge");
    via.hidden = false;
    via.textContent = p.via === "layout-reuse" ? "LAYOUT REUSE" : "WORKER POOL";
    $("encodeBtn").disabled = false;
    chip("chipEngine", "ENGINE READY", true);
    const st = engine.poolStats();
    if (st) chip("chipWorkers", `WORKERS ${st.workerCount} / DONE ${st.completedJobs}`, true, st.activeJobs > 0);
    void reason;
  } catch (e) {
    chip("chipEngine", "ENGINE ERROR", false);
    toast(`レンダリング失敗: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
const renderDebounced = debounce(() => void renderPreview("input"), 220);

/* ---------- zoom ---------- */
function applyZoom() {
  const img = $("preview");
  const wrap = $("canvasWrap");
  if (!pair) return;
  if ($("zoomFit").classList.contains("on")) {
    const avail = wrap.clientWidth - 48;
    img.style.width = `${Math.min(avail, pair.width)}px`;
  } else {
    img.style.width = `${pair.width}px`;
  }
}

/* ---------- encode ---------- */
interface CandRow {
  id: string;
  bytes: number;
  ms: number;
  win?: boolean;
}
let lastTelemetry: { stages: [string, string][]; rows: CandRow[] } = { stages: [], rows: [] };
function drawTelemetry(stages: [string, string][], rows: CandRow[], poolLines: [string, string][]) {
  lastTelemetry = { stages, rows };
  $("stageList").innerHTML = stages.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join("");
  $("candTable").querySelector("tbody")!.innerHTML =
    rows
      .map((r) => `<tr class="${r.win ? "win" : ""}"><td>${r.id}</td><td>${formatBytes(r.bytes)}</td><td>${formatMs(r.ms)}</td></tr>`)
      .join("") || "<tr><td colspan=3>—</td></tr>";
  $("poolList").innerHTML = poolLines.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join("");
}

async function encode() {
  if (!pair) return;
  const btn = $("encodeBtn");
  btn.disabled = true;
  btn.classList.add("run");
  btn.querySelector("span")!.textContent = "エンコード中";
  $("downloadBtn").disabled = true;
  const meta = FORMAT_META[state.format];
  const stages: [string, string][] = [];
  const t0 = performance.now();
  try {
    if (state.format === "svg") {
      const out = optimizeSvg(pair.svg, state.mode, state.quality);
      const bytes = new TextEncoder().encode(out);
      stages.push(["render (satoru)", formatMs(pair.timings.total)], ["svg optimize", formatMs(performance.now() - t0)]);
      drawTelemetry(
        stages,
        [
          {
            id: state.mode === "lossless" ? "svg safe-minify" : "svg precision-round",
            bytes: bytes.byteLength,
            ms: performance.now() - t0,
            win: true,
          },
        ],
        poolLines(),
      );
      finish(
        bytes,
        meta.mime,
        meta.ext,
        `<b>${formatBytes(bytes.byteLength)}</b> / ${state.mode === "lossless" ? "可逆 (構造保存)" : "非可逆 (座標精度削減)"}`,
      );
      return;
    }
    const strat = candidatesFor(state.format, state.mode, state.quality, state.effort);
    if (strat.unsupported) {
      toast(strat.unsupported, true);
      return;
    }
    const p = codecPool();
    await p.warm;
    const srcKey = `${pair.width}x${pair.height}|${pair.png.byteLength}`;
    const src = { k: "png" as const, bytes: pair.png };
    stages.push(["render (satoru)", formatMs(pair.timings.total)]);
    const tEnc = performance.now();
    const results = await Promise.all(
      strat.candidates.map((c) =>
        p.run<{ id: number; bytes: Uint8Array; ms: number }>({ t: "encode", srcKey, src, format: state.format, candidate: c }),
      ),
    );
    stages.push(["encode (parallel ×" + results.length + ")", formatMs(performance.now() - tEnc)]);
    let winIdx = 0;
    results.forEach((r, i) => {
      if (r.bytes.byteLength < results[winIdx].bytes.byteLength) winIdx = i;
    });
    const winner = results[winIdx];
    const tAn = performance.now();
    const analysis = await p.run<{ exact: boolean; maxDiff: number; psnr: number; ms: number }>({
      t: "analyze",
      srcKey,
      format: state.format,
      bytes: winner.bytes.slice(),
      expectExact: state.mode === "lossless",
    });
    stages.push(["decode verify", formatMs(performance.now() - tAn)]);
    const rows: CandRow[] = results.map((r, i) => ({ id: strat.candidates[i].id, bytes: r.bytes.byteLength, ms: r.ms, win: i === winIdx }));
    drawTelemetry(stages, rows, poolLines());
    const verify =
      state.mode === "lossless"
        ? analysis.exact
          ? `<span class="ok">LOSSLESS VERIFIED (pixel-exact)</span>`
          : `<span class="warn">NOT LOSSLESS (max diff ${analysis.maxDiff})</span>`
        : `PSNR <b>${analysis.psnr === Infinity ? "∞" : analysis.psnr.toFixed(2)} dB</b>`;
    finish(
      winner.bytes,
      meta.mime,
      meta.ext,
      `<b>${formatBytes(winner.bytes.byteLength)}</b> / 原 PNG ${formatBytes(pair.png.byteLength)} / ${verify} / 合計 ${formatMs(performance.now() - t0)}`,
    );
  } catch (e) {
    toast(`エンコード失敗: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove("run");
    btn.querySelector("span")!.textContent = "エンコード";
  }
}

function poolLines(): [string, string][] {
  const st = engine.poolStats();
  const cs = pool?.stats();
  return [
    ["satoru workers", st ? String(st.workerCount) : "—"],
    ["satoru completed", st ? String(st.completedJobs) : "—"],
    ["satoru avg job", st ? formatMs(st.avgJobTimeMs) : "—"],
    ["codec workers", cs ? `${cs.busy}/${cs.workers} busy` : "idle"],
  ];
}

function finish(bytes: Uint8Array, mime: string, ext: string, metaHtml: string) {
  lastResult = { bytes, mime, ext };
  $("resultMeta").innerHTML = metaHtml;
  $("downloadBtn").disabled = false;
  $("downloadBtn").querySelector("span")!.textContent = `ダウンロード (.${ext})`;
}

/* ---------- events ---------- */
const drop = $("drop");
const fileInput = $("fileInput") as HTMLInputElement;
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e: KeyboardEvent) => e.key === "Enter" && fileInput.click());
for (const ev of ["dragenter", "dragover"])
  drop.addEventListener(ev, (e: DragEvent) => {
    e.preventDefault();
    drop.classList.add("over");
  });
for (const ev of ["dragleave", "drop"])
  drop.addEventListener(ev, (e: DragEvent) => {
    e.preventDefault();
    drop.classList.remove("over");
  });
drop.addEventListener("drop", (e: DragEvent) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
});
fileInput.addEventListener("change", () => fileInput.files?.[0] && void loadFile(fileInput.files[0]));
$("clearFile").addEventListener("click", () => {
  state.html = "";
  state.fileName = "";
  pair = undefined;
  lastResult = undefined;
  $("fileMeta").hidden = true;
  drop.hidden = false;
  $("scroll").hidden = true;
  $("emptyStage").hidden = false;
  $("encodeBtn").disabled = true;
  $("downloadBtn").disabled = true;
  $("resultMeta").innerHTML = "";
  $("dims").textContent = "—";
  $("viaBadge").hidden = true;
});

async function loadFile(f: File) {
  const text = await f.text();
  state.html = text;
  state.fileName = f.name;
  $("fileName").textContent = f.name;
  $("fileSize").textContent = formatBytes(f.size);
  $("fileMeta").hidden = false;
  drop.hidden = true;
  lastResult = undefined;
  $("downloadBtn").disabled = true;
  await renderPreview("load");
}

$("width").addEventListener("input", () => {
  const v = clamp(Math.round(Number(($("width") as HTMLInputElement).value) || state.width), 80, 8000);
  state.width = v;
  for (const b of $$($("widthPresets"), "button")) b.classList.toggle("on", Number(b.dataset.w) === v);
  persist();
  renderDebounced();
});
$("widthPresets").addEventListener("click", (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  state.width = Number(b.dataset.w);
  $("width").value = String(state.width);
  syncControls();
  persist();
  void renderPreview("preset");
});
$("formatSeg").addEventListener("click", (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b?.dataset.f) return;
  state.format = b.dataset.f as OutputFormat;
  syncControls();
  persist();
});
$("modeSeg").addEventListener("click", (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b?.dataset.m || b.disabled) return;
  state.mode = b.dataset.m as Mode;
  syncControls();
  persist();
});
$("effortSeg").addEventListener("click", (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b?.dataset.e) return;
  state.effort = b.dataset.e as Effort;
  syncControls();
  persist();
});
$("quality").addEventListener("input", () => {
  state.quality = Number(($("quality") as HTMLInputElement).value);
  $("qualityVal").textContent = `${state.quality}%`;
  persist();
});
$("bgToggle").addEventListener("change", () => {
  state.bgToggle = ($("bgToggle") as HTMLInputElement).checked;
  $("bgColor").disabled = !state.bgToggle;
  persist();
  void renderPreview("bg");
});
$("bgColor").addEventListener(
  "input",
  debounce(() => {
    state.bgColor = ($("bgColor") as HTMLInputElement).value;
    persist();
    void renderPreview("bg");
  }, 200),
);
$("textPaths").addEventListener("change", () => {
  state.textPaths = ($("textPaths") as HTMLInputElement).checked;
  persist();
  void renderPreview("textpaths");
});
$("external").addEventListener("change", () => {
  state.external = ($("external") as HTMLInputElement).checked;
  engine.setExternal(state.external);
  persist();
  void renderPreview("external");
});
$("workers").addEventListener("change", () => {
  const n = clamp(Number(($("workers") as HTMLInputElement).value) || 4, 1, 8);
  engine.setParallel(n);
  persist();
});
$("zoomFit").addEventListener("click", () => {
  $("zoomFit").classList.add("on");
  $("zoom100").classList.remove("on");
  applyZoom();
});
$("zoom100").addEventListener("click", () => {
  $("zoom100").classList.add("on");
  $("zoomFit").classList.remove("on");
  applyZoom();
});
$("encodeBtn").addEventListener("click", () => void encode());
$("downloadBtn").addEventListener("click", () => {
  if (!lastResult) return;
  const url = URL.createObjectURL(new Blob([lastResult.bytes as BlobPart], { type: lastResult.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `kagami-${state.width}px.${lastResult.ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});
$("telemetryBtn").addEventListener("click", () => {
  const t = $("telemetry");
  t.hidden = !t.hidden;
  $("telemetryBtn").classList.toggle("on", !t.hidden);
  if (!t.hidden) drawTelemetry(lastTelemetry.stages, lastTelemetry.rows, poolLines());
});
addEventListener("resize", () => applyZoom());

/* ---------- boot ---------- */
(self as unknown as { __kagami?: unknown }).__kagami = { engine, state: () => state };
syncControls();
engine.setExternal(state.external);
$("coreInfo").textContent = `${navigator.hardwareConcurrency || "?"} cores`;
($("workers") as HTMLInputElement).value = String(engine.maxParallel);
chip("chipEngine", "ENGINE BOOT", false, true);
void engine.ready.then(() => {
  chip("chipEngine", "ENGINE READY", true);
  const st = engine.poolStats();
  chip("chipWorkers", `WORKERS ${st?.workerCount ?? 0}`, true);
  chip("chipFonts", "FONTS ON-DEMAND", true);
});
