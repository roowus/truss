/* ---------- icon registry (16px grid, 1.5px stroke) ----------
   Extracted from components/ui.tsx's private record (issue #99) so the
   glyph data lives outside the component and variants ship side by side.
   Each entry is one <path>: `path` is the d attribute; `fill` switches the
   glyph from stroked (default) to filled (fill="currentColor", no stroke). */
export interface IconDef {
  path: string;
  fill?: boolean;
}

export const ICON_PATHS: Record<string, IconDef> = {
  plus: { path: "M8 3v10M3 8h10" },
  x: { path: "M4 4l8 8M12 4l-8 8" },
  chat: { path: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" },
  wave: { path: "M1.5 8h2l1.5-4 2 8 2-6 1.5 3 1-1h3" },
  term: { path: "M2 3h12v10H2zM4.5 6l2 2-2 2M8 10.5h3" },
  gauge: { path: "M2.5 11a5.5 5.5 0 1 1 11 0M8 11l2.5-3.5" },
  tree: { path: "M4 2.5v11M4 6h4M4 11h4M8.4 6a1.6 1.6 0 1 1 3.2 0a1.6 1.6 0 1 1 -3.2 0M8.4 11a1.6 1.6 0 1 1 3.2 0a1.6 1.6 0 1 1 -3.2 0" },
  spark: { path: "M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" },
  stop: { path: "M5 4h6a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z" },
  send: { path: "M2.5 8h9M8 4l4 4-4 4" },
  trash: { path: "M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9" },
  power: { path: "M8 2v6M4.6 4.2a5 5 0 1 0 6.8 0" },
  chev: { path: "M6 4l4 4-4 4" },
  down: { path: "M4 6l4 4 4-4" },
  folder: { path: "M2 4h4l1.5 1.5H14V12H2z" },
  tag: { path: "M2 2h4.5l5.5 5.5a1 1 0 0 1 0 1.4l-3.1 3.1a1 1 0 0 1-1.4 0L2 6.5zM3.9 4.8a0.9 0.9 0 1 1 1.8 0a0.9 0.9 0 1 1 -1.8 0" },
  archive: { path: "M2.8 3h10.4a0.8 0.8 0 0 1 0.8 0.8v1.8a0.8 0.8 0 0 1 -0.8 0.8h-10.4a0.8 0.8 0 0 1 -0.8 -0.8v-1.8a0.8 0.8 0 0 1 0.8 -0.8zM3.3 6.4v5.4a1.2 1.2 0 0 0 1.2 1.2h7a1.2 1.2 0 0 0 1.2-1.2V6.4M6.6 9h2.8" },
  cost: { path: "M2 8a6 6 0 1 1 12 0a6 6 0 1 1 -12 0M8 4.5v7M10.2 5.8c-.5-.7-1.3-1-2.2-1-1.4 0-2.3.8-2.3 1.9 0 2.5 4.7 1.3 4.7 3.4 0 1.2-1.1 1.9-2.4 1.9-1 0-1.9-.4-2.4-1.1" },
  lock: { path: "M4 7h8a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-8a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1zM5 7V5a3 3 0 0 1 6 0v2" },
  clip: { path: "M10.5 4.5 6 9a3.2 3.2 0 0 0 4.5 4.5l5-5a2.15 2.15 0 0 0-3-3l-5 5a1.1 1.1 0 0 0 1.5 1.5l4.3-4.3" },
  check: { path: "M3 8.5l3 3 7-7" },
  alert: { path: "M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.5" },
  retry: { path: "M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" },
  layout: { path: "M2 2.5h12v11h-12zM7 2.5v11M7 8h7" },
  search: { path: "M2.5 7a4.5 4.5 0 1 1 9 0a4.5 4.5 0 1 1 -9 0M10.5 10.5L14 14" },
  bolt: { path: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" },
  clock: { path: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zM8 4.5V8l2.5 1.5" },
  host: { path: "M2.5 3h11a0.5 0.5 0 0 1 0.5 0.5v3a0.5 0.5 0 0 1 -0.5 0.5h-11a0.5 0.5 0 0 1 -0.5 -0.5v-3a0.5 0.5 0 0 1 0.5 -0.5zM2.5 9h11a0.5 0.5 0 0 1 0.5 0.5v3a0.5 0.5 0 0 1 -0.5 0.5h-11a0.5 0.5 0 0 1 -0.5 -0.5v-3a0.5 0.5 0 0 1 0.5 -0.5zM4.5 5h.01M4.5 11h.01" },
  brain: { path: "M6 3a2 2 0 0 0-2 2 2 2 0 0 0-1.5 3A2 2 0 0 0 4 11a2 2 0 0 0 2 2h0V3zM10 3a2 2 0 0 1 2 2 2 2 0 0 1 1.5 3A2 2 0 0 1 12 11a2 2 0 0 1-2 2V3z" },
  restart: { path: "M3 8a5 5 0 0 1 8.5-3.5L13 6M13 2.5V6H9.5M13 8a5 5 0 0 1-8.5 3.5L3 10" },
  dots: { path: "M2 8a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1 -2.4 0M6.8 8a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1 -2.4 0M11.6 8a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1 -2.4 0", fill: true },
  settings: { path: "M5.7 8a2.3 2.3 0 1 1 4.6 0a2.3 2.3 0 1 1 -4.6 0M6.6 1.7h2.8l.4 1.5 1.2.7 1.5-.3 1.4 2.4-1.1 1.1v1.4l1.1 1.1-1.4 2.4-1.5-.3-1.2.7-.4 1.5H6.6l-.4-1.5-1.2-.7-1.5.3-1.4-2.4 1.1-1.1V7.1L2.1 6l1.4-2.4 1.5.3 1.2-.7z" },
  desktop: { path: "M2.5 2h8a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-8a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1zM4 12h10V5.5M6.5 12v2M4 14h6" },
  copy: { path: "M6 5h7a1 1 0 0 1 1 1v7a1 1 0 0 1 -1 1h-7a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1zM11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" },
  edit: { path: "M3 11.5V13h1.5l8-8-1.5-1.5-8 8zM10.5 4l1.5-1.5 1.5 1.5L12 5.5" },
  arrow: { path: "M2.5 8h10M8.5 4l4 4-4 4" },
  mic: { path: "M8 1.5a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1 -2.5 2.5a2.5 2.5 0 0 1 -2.5 -2.5v-3a2.5 2.5 0 0 1 2.5 -2.5zM3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" },
  pin: { path: "M8 11.25V14.5M5.75 2h4.5a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5.75a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM6.35 6L4.55 10.25a.75.75 0 0 0 .7 1h5.5a.75.75 0 0 0 .7-1L9.65 6" },
  pinSolid: { path: "M5.75 1.5h4.5A1.25 1.25 0 0 1 11.5 2.75v2A1.25 1.25 0 0 1 10.25 6H9.65l1.8 4.25a.75.75 0 0 1-.7 1H9v2.75a1 1 0 1 1-2 0V11.25H5.25a.75.75 0 0 1-.7-1L6.35 6H5.75A1.25 1.25 0 0 1 4.5 4.75v-2A1.25 1.25 0 0 1 5.75 1.5z", fill: true },
};
