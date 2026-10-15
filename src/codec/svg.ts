/**
 * SVG post-processor.
 *  - lossless: comment stripping + inter-tag whitespace collapsing (byte-identical rendering)
 *  - lossy:    additionally rounds geometry numerics; precision follows the quality slider
 */
export function optimizeSvg(svg: string, mode: "lossless" | "lossy", quality: number): string {
  let out = svg.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/>\s+</g, "><").replace(/\s*\n\s*/g, "");
  if (mode === "lossy") {
    const digits = quality >= 90 ? 3 : quality >= 70 ? 2 : quality >= 45 ? 1 : 0;
    const round = (num: string) => {
      const v = Number(num);
      if (!Number.isFinite(v)) return num;
      const r = v.toFixed(digits);
      return r.replace(/\.?0+$/, "") || "0";
    };
    out = out.replace(
      /(d|points)="([^"]*)"/g,
      (_m, attr: string, body: string) => `${attr}="${body.replace(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi, round)}"`,
    );
  }
  return out;
}
