// Copies vendored binary assets (Satoru worker bundle, fonts) into public/.
import { cp, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nm = path.join(root, "node_modules");
const pub = path.join(root, "public");

async function main() {
  // Satoru's browser worker bundle is emitted by Vite automatically
  // (satoru-render/workers references it via new URL(..., import.meta.url)).

  // 2. Geist variable fonts (UI)
  await mkdir(path.join(pub, "fonts", "geist"), { recursive: true });
  for (const [src, dst] of [
    ["geist/dist/fonts/geist-sans/Geist-Variable.woff2", "geist/Geist-Variable.woff2"],
    ["geist/dist/fonts/geist-mono/GeistMono-Variable.woff2", "geist/GeistMono-Variable.woff2"],
  ]) {
    await copyFile(path.join(nm, src), path.join(pub, "fonts", dst));
  }

  // 3. Noto Sans JP variable subsets (rendering engine fallback fonts, on-demand)
  const notoSrc = path.join(nm, "@fontsource-variable", "noto-sans-jp");
  const notoDst = path.join(pub, "fonts", "noto-sans-jp");
  await mkdir(notoDst, { recursive: true });
  if (!existsSync(path.join(notoDst, "unicode.json"))) {
    await cp(path.join(notoSrc, "files"), notoDst, { recursive: true });
    await copyFile(path.join(notoSrc, "unicode.json"), path.join(notoDst, "unicode.json"));
  }

  // 4. Generate a compact subset index (subset id -> ranges) for FontKit
  const unicode = JSON.parse(await readFile(path.join(notoDst, "unicode.json"), "utf8"));
  const ranges = [];
  for (const [key, value] of Object.entries(unicode)) {
    const id = key.replace(/[[\]]/g, "");
    const pairs = [];
    for (const part of String(value).split(",")) {
      const t = part.trim().toUpperCase().replace("U+", "");
      if (!t) continue;
      if (t.includes("-")) {
        const [a, b] = t.split("-");
        pairs.push([parseInt(a, 16), parseInt(b, 16)]);
      } else {
        const v = parseInt(t, 16);
        pairs.push([v, v]);
      }
    }
    ranges.push({ id, pairs });
  }
  await writeFile(path.join(notoDst, "ranges.json"), JSON.stringify(ranges));
  console.log("[setup] assets ready:", { subsets: ranges.length });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
