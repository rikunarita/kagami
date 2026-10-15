/** Minimal stroke icon set (no emoji anywhere in the product). */
const s = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS: Record<string, string> = {
  mark: s(
    `<path d="M12 3v18"/><path d="M7 6.5 4 12l3 5.5"/><path d="M17 6.5 20 12l-3 5.5"/><rect x="8.5" y="6.5" width="7" height="11" rx="1"/>`,
  ),
  upload: s(`<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/>`),
  file: s(`<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>`),
  width: s(`<path d="M3 12h18"/><path d="m6 9-3 3 3 3"/><path d="m18 9 3 3-3 3"/>`),
  image: s(`<rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 3 3 4-4 4 4"/>`),
  gauge: s(`<path d="M4 14a8 8 0 0 1 16 0"/><path d="M12 14 15.5 10"/><path d="M2 18h20"/>`),
  sliders: s(
    `<path d="M5 4v6"/><path d="M5 14v6"/><path d="M12 4v10"/><path d="M12 18v2"/><path d="M19 4v2"/><path d="M19 10v10"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="16" r="2"/><circle cx="19" cy="8" r="2"/>`,
  ),
  zap: s(`<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>`),
  download: s(`<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>`),
  check: s(`<path d="m4 12.5 5 5L20 6.5"/>`),
  x: s(`<path d="m5 5 14 14"/><path d="m19 5-14 14"/>`),
  info: s(`<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>`),
  cpu: s(
    `<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>`,
  ),
  fit: s(`<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>`),
  one: s(`<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M10 9h1.5v7"/><path d="M9 10.5 11.5 9"/>`),
  layers: s(`<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>`),
  lock: s(`<rect x="5" y="11" width="14" height="9" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`),
  wave: s(`<path d="M3 12c2-6 4 6 6 0s4 6 6 0 4 6 6 0"/>`),
};

export function icon(name: string, cls = ""): string {
  return `<span class="ic${cls ? " " + cls : ""}">${ICONS[name] ?? ""}</span>`;
}
