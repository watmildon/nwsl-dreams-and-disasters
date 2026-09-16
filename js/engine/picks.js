// URL-hash encoding of the user's picks.
//
// Each pick is written out as an explicit `<gameId><result>` pair, e.g.
// `401854084H.401854085D`.  An earlier design used one character per game in
// `season.json` order, which was shorter but unsafe: ESPN re-issues a postponed
// fixture under a brand-new (larger) event id, so the game *set* can change
// while the count stays at 240.  The sorted array then shifts and every
// positional pick after the change silently lands on the wrong game.  Naming
// the id costs a few hundred characters and makes that impossible -- a pick
// either matches a real open game or is dropped.
//
// `.` is the separator: unreserved in URLs, so URLSearchParams leaves it alone.

import { PICK_VALUES } from "./constants.js";

const SEP = ".";

// Game ids must survive a round trip through a URL fragment untouched, and must
// not contain the separator. ESPN event ids are plain digits, so this always
// passes in practice -- it is a guard against a future data source sneaking in
// an id that would corrupt the encoding rather than merely be dropped.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * @param {Array} games  season games, in file order
 * @param {Object} picks { [gameId]: "H"|"D"|"A" }
 * @returns {string} e.g. "401854084H.401854085D"; "" when nothing is picked
 */
export function encodePicks(games, picks) {
  const p = picks || {};
  const parts = [];
  for (const g of games) {
    const v = p[g.id];
    // Played games are never encoded: their result is already known.
    if (g.status === "played" || !PICK_VALUES.includes(v)) continue;
    const id = String(g.id);
    // An unencodable id is skipped rather than mangled: losing one pick from a
    // shared link is recoverable, silently moving it onto another game is not.
    if (!SAFE_ID.test(id)) continue;
    parts.push(id + v);
  }
  return parts.join(SEP);
}

/**
 * Inverse of encodePicks.  Malformed tokens, unknown game ids and picks on
 * games that have since been played are all silently dropped.
 */
export function decodePicks(games, str) {
  const picks = {};
  if (typeof str !== "string" || !str) return picks;
  const byId = new Map(games.map((g) => [String(g.id), g]));
  for (const token of str.split(SEP)) {
    if (token.length < 2) continue;
    const value = token[token.length - 1];
    const id = token.slice(0, -1);
    if (!PICK_VALUES.includes(value) || !SAFE_ID.test(id)) continue;
    const g = byId.get(id);
    if (!g || g.status === "played") continue;
    picks[id] = value;
  }
  return picks;
}

/**
 * @param {{picks: Object, focus: (string|null)}} state
 * @returns {string} hash body without the leading "#", e.g. "p=401854084H&t=SEA"
 */
export function encodeHash(state, games) {
  const parts = [];
  const p = encodePicks(games, (state && state.picks) || {});
  if (p) parts.push("p=" + p);
  if (state && state.focus) parts.push("t=" + encodeURIComponent(state.focus));
  return parts.join("&");
}

/**
 * @param {string} hash  with or without a leading "#"
 * @returns {{picks: Object, focus: (string|null)}} focus only when it is a real team id
 */
export function decodeHash(hash, games, teamIds) {
  const body = typeof hash === "string" ? hash.replace(/^#/, "") : "";
  const params = new URLSearchParams(body);
  const picks = decodePicks(games, params.get("p") || "");
  const t = params.get("t");
  const valid = !teamIds || teamIds.includes(t);
  return { picks, focus: t && valid ? t : null };
}
