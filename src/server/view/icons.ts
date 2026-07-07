/** Inline SVG icon set — 1.75px stroke, consistent sizing, used sparingly. */
import { raw, VNode } from "./jsx";

function icon(paths: string, size = 16): VNode {
  return raw(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

/**
 * OBV brand mark — layered strata (physical works) with the top layer
 * offset and keyed, reading as "a verified layer". No shields, chains,
 * or hard hats.
 */
export function brandMark(size = 22, fg = "#ffffff"): VNode {
  return raw(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
      `<rect x="4" y="15.5" width="16" height="3.4" rx="0.8" fill="${fg}" opacity="0.45"/>` +
      `<rect x="4" y="10.4" width="16" height="3.4" rx="0.8" fill="${fg}" opacity="0.7"/>` +
      `<rect x="7.5" y="5.2" width="12.5" height="3.4" rx="0.8" fill="${fg}"/>` +
      `<rect x="4" y="5.2" width="2.4" height="3.4" rx="0.8" fill="${fg}" opacity="0.55"/>` +
      `</svg>`
  );
}

export const icons = {
  overview: () =>
    icon('<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>'),
  projects: () =>
    icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
  camera: () =>
    icon('<path d="M14.5 5h-5L8 7H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-1.5-2z"/><circle cx="12" cy="13" r="3.2"/>'),
  approvals: () =>
    icon('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/>'),
  ledger: () =>
    icon('<rect x="4.5" y="3.5" width="15" height="17" rx="1.5"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  reports: () =>
    icon('<path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5z"/><path d="M14 3.5V8h4.5"/>'),
  shield: () =>
    icon('<path d="M12 3.5c2.6 1.4 5 2 7.5 2.2 0 6.6-2.4 11.4-7.5 14.8-5.1-3.4-7.5-8.2-7.5-14.8C7 5.5 9.4 4.9 12 3.5Z"/>'),
  insights: () =>
    icon('<path d="M4 17.5 9.5 12l3.5 3.5 7-7.5"/><path d="M15.5 8H20v4.5"/>'),
  activity: () => icon('<path d="M3.5 12h4l2.5 6.5 4-13 2.5 6.5h4"/>'),
  check: (size = 16) => icon('<path d="M4.5 12.5 10 18 19.5 6.5"/>', size),
  x: (size = 16) => icon('<path d="M6 6l12 12M18 6 6 18"/>', size),
  alert: (size = 16) =>
    icon('<path d="M12 4 2.8 19.5h18.4L12 4z"/><path d="M12 10v4.5M12 17.2v.1"/>', size),
  clock: (size = 16) => icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', size),
  mapPin: (size = 16) =>
    icon('<path d="M19.5 10.2c0 5.5-7.5 11-7.5 11s-7.5-5.5-7.5-11a7.5 7.5 0 0 1 15 0Z"/><circle cx="12" cy="10" r="2.6"/>', size),
  building: (size = 16) =>
    icon('<rect x="5" y="3.5" width="14" height="17" rx="1"/><path d="M9.5 20.5v-3.5h5v3.5"/><path d="M9 7.5h.5M14.5 7.5h.5M9 11.5h.5M14.5 11.5h.5"/>', size),
  refresh: (size = 16) =>
    icon('<path d="M4 12a8 8 0 0 1 13.6-5.7L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.6 5.7L4 15.5"/><path d="M4 20v-4.5h4.5"/>', size),
  arrowRight: (size = 16) => icon('<path d="M4.5 12h15M13 5.5l6.5 6.5L13 18.5"/>', size),
  file: (size = 16) =>
    icon('<path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5z"/><path d="M14 3.5V8h4.5"/>', size),
  more: (size = 16) =>
    icon('<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>', size),
  user: (size = 16) => icon('<circle cx="12" cy="8.2" r="3.8"/><path d="M4.5 20.3c.8-3.7 3.9-5.6 7.5-5.6s6.7 1.9 7.5 5.6"/>', size),
  dollar: (size = 16) =>
    icon('<path d="M12 3.5v17"/><path d="M16.5 6.5h-6.7a2.8 2.8 0 0 0 0 5.6h4.4a2.8 2.8 0 0 1 0 5.6H6.5"/>', size),
};

/** Status glyphs rendered as text (grayscale-safe, no icon dependency). */
export const glyph = {
  ok: "✓",
  bad: "✕",
  warn: "!",
  pending: "○",
  dot: "●",
};
