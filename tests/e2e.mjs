/**
 * End-to-end verification with real Chromium (playwright-core + system chromium).
 * Phase A: multi-threaded render pool + layout reuse (?workers=2).
 * Phase B: full format/mode matrix, downloads, magic bytes, console cleanliness.
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");
mkdirSync(outDir, { recursive: true });

const PORT = 5199;
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore" });
const waitServer = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("preview server did not start");
};

const MAGIC = {
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
  webp: (b) => String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP",
  avif: (b) => String.fromCharCode(...b.slice(4, 8)) === "ftyp",
  svg: (b) => b.slice(0, 200).toString().includes("<svg"),
};

const results = [];
const consoleErrors = [];

await waitServer();
const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].filter(Boolean);
const executablePath = CHROMIUM_CANDIDATES.find((c) => existsSync(c));
const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });

const attach = (page) => {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
};

try {
  /* ---------- phase A: parallel pool + layout reuse ---------- */
  const pa = await context.newPage();
  attach(pa);
  await pa.goto(`http://localhost:${PORT}/?workers=2`, { waitUntil: "domcontentloaded" });
  await pa.waitForFunction(() => document.getElementById("chipEngineTx")?.textContent === "ENGINE READY", null, { timeout: 90_000 });
  await pa.setInputFiles("#fileInput", path.join(root, "assets", "sample.html"));
  await pa.waitForFunction(() => !document.getElementById("encodeBtn")?.disabled, null, { timeout: 90_000 });
  const statsA = await pa.evaluate(() => window.__kagami.engine.poolStats());
  console.log("[e2eA] pool stats after preview:", JSON.stringify(statsA));
  results.push({ step: "pool-parallel", ...statsA, ok: statsA.workerCount === 2 && statsA.completedJobs >= 2 });
  await new Promise((r) => setTimeout(r, 3500));
  await pa.fill("#width", "800");
  await pa.waitForFunction(() => document.getElementById("dims")?.textContent?.startsWith("800 ×"), null, { timeout: 60_000 });
  const via = (await pa.textContent("#viaBadge"))?.trim();
  console.log("[e2eA] relayout via:", via);
  results.push({ step: "layout-reuse", via, ok: via === "LAYOUT REUSE" });
  await pa.close();

  /* ---------- phase B: matrix ---------- */
  const page = await context.newPage();
  attach(page);
  await page.goto(`http://localhost:${PORT}/?workers=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("chipEngineTx")?.textContent === "ENGINE READY", null, { timeout: 90_000 });
  await page.setInputFiles("#fileInput", path.join(root, "assets", "sample.html"));
  await page.waitForFunction(() => !document.getElementById("encodeBtn")?.disabled, null, { timeout: 90_000 });
  console.log("[e2eB] preview:", (await page.textContent("#dims"))?.trim());
  await page.screenshot({ path: path.join(outDir, "e2e-1-preview.png") });

  const scenarios = [
    ["png", "lossless", "png", "high"],
    ["webp", "lossless", "webp", "high"],
    ["avif", "lossless", "avif", "balanced"],
    ["jpeg", "lossy", "jpg", "high"],
    ["webp", "lossy", "webp", "high"],
    ["avif", "lossy", "avif", "balanced"],
    ["svg", "lossless", "svg", "high"],
  ];
  for (const [format, mode, ext, effort] of scenarios) {
    await page.click(`#formatSeg [data-f="${format}"]`);
    const modeBtn = page.locator(`#modeSeg [data-m="${mode}"]`);
    if (await modeBtn.isEnabled()) await modeBtn.click();
    if (format !== "svg") await page.click(`#effortSeg [data-e="${effort}"]`);
    const t0 = Date.now();
    await page.click("#encodeBtn");
    await page.waitForFunction(() => !document.getElementById("downloadBtn")?.disabled, null, { timeout: 300_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#downloadBtn")]);
    const file = path.join(outDir, `e2e-${format}-${mode}.${ext}`);
    await download.saveAs(file);
    const meta = (await page.textContent("#resultMeta"))?.replace(/\s+/g, " ").trim();
    const bytes = readFileSync(file);
    const okMagic = MAGIC[format](bytes);
    console.log(`[e2eB] ${format}/${mode}/${effort}: ${bytes.length}B in ${Date.now() - t0}ms magic:${okMagic} :: ${meta}`);
    results.push({ step: `${format}/${mode}`, bytes: bytes.length, ms: Date.now() - t0, magic: okMagic, meta });
    if (!okMagic) process.exitCode = 1;
  }
  await page.screenshot({ path: path.join(outDir, "e2e-2-encoded.png") });
  await page.click("#telemetryBtn");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "e2e-3-telemetry.png") });
  await page.close();
} catch (e) {
  console.error("[e2e] FAILED:", e);
  process.exitCode = 1;
} finally {
  const relevant = consoleErrors.filter((t) => !t.includes("favicon") && !t.includes("Autofill"));
  console.log("[e2e] console errors:", relevant.length ? relevant : "none");
  if (relevant.length) process.exitCode = 1;
  writeFileSync(path.join(root, "tests", "results-e2e.json"), JSON.stringify({ results, consoleErrors: relevant }, null, 2));
  await browser.close();
  server.kill();
}
console.log("[e2e] done, exit", process.exitCode ?? 0);
