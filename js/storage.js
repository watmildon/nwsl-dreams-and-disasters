// Persistence: localStorage for "what I was doing", the URL hash for sharing.
// Both are thin wrappers around the pure encoders in engine/picks.js.

import { decodeHash, encodeHash } from "./engine/picks.js";
import { PICK_VALUES } from "./engine/constants.js";

const VERSION = 1;

// The active tab is a UI preference, not season data, so it is not year-scoped.
const VIEW_KEY = "nwsl-calc-view";
const DEFAULT_VIEW = "standings";

/**
 * Storage key, derived from the season year so a new season starts with a clean
 * slate (and so there is one less place to edit come next year).
 */
export function storageKey(year) {
  return `nwsl-calc-${year}`;
}

/** @returns {{picks: Object}} — never throws (private mode, quota, etc.) */
export function loadLocal(year) {
  const KEY = storageKey(year);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { picks: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== VERSION || typeof parsed.picks !== "object") return { picks: {} };
    return { picks: parsed.picks || {} };
  } catch {
    return { picks: {} };
  }
}

export function saveLocal(year, picks) {
  try {
    localStorage.setItem(storageKey(year), JSON.stringify({ v: VERSION, picks }));
  } catch {
    /* storage unavailable or full — the URL hash still carries the state */
  }
}

/** @returns {string|null} the remembered tab id, or null */
export function loadView() {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

export function saveView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* storage unavailable -- the tab just won't be remembered */
  }
}

/**
 * Read picks, focus and the tab out of the current location hash.
 *
 * `v` is read here rather than in engine/picks.js: `decodeHash` uses
 * URLSearchParams, so the extra param is invisible to it and the hash format
 * for picks and focus is unchanged. The caller validates the view id.
 *
 * @returns {{picks: Object, focus: (string|null), view: (string|null),
 *             overtaken: number, unknown: number, mismatch: boolean}}
 */
export function loadHash(games, scope) {
  const state = decodeHash(location.hash, games, scope);
  const params = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
  return { ...state, view: params.get("v") };
}

/**
 * Mirror the state into the URL without adding history entries.  With nothing
 * picked and no focus the hash is removed entirely, so the bare URL stays clean.
 */
export function saveHash(state, games, view, scope) {
  let body = encodeHash(state, games, scope);
  // The default view is implied, so a plain link stays plain.
  if (view && view !== DEFAULT_VIEW) body += (body ? "&" : "") + "v=" + encodeURIComponent(view);
  try {
    if (body) history.replaceState(null, "", "#" + body);
    else history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* replaceState can throw on file:// — harmless, state is still in localStorage */
  }
}

/** Drop picks whose game has since been played or has vanished from the data. */
export function prunePicks(picks, games) {
  const open = new Map(games.filter((g) => g.status !== "played").map((g) => [g.id, true]));
  const out = {};
  for (const [id, v] of Object.entries(picks || {})) {
    if (open.has(id) && PICK_VALUES.includes(v)) out[id] = v;
  }
  return out;
}
