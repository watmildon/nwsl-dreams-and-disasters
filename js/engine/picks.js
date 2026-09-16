// URL-hash encoding of the user's picks.
//
// A pick is identified by the FIXTURE it belongs to -- the ordered (home, away)
// pair -- not by the ESPN event id.  The season is a double round robin, so each
// ordered pair is played exactly once and the pair is a stable name for a game:
// ESPN re-issues a postponed fixture under a brand-new event id, and the update
// script's dedupe step guarantees one game per pair, so the pair survives what
// the id does not.  A pair also packs into 8 bits for 16 teams, where the id
// needs 10 characters.
//
// The compact form (`s=`) writes a 16-bit check value, then for each pick the
// pair index and a 2-bit result, packs the bits tight and base64url-encodes
// them.  Like for like, a full 50-game slate is 87 characters of payload
// against the old format's 549, and a single pick is 6 against 10.
//
// The check value covers BOTH the season scope (year + canonical team ids) and
// the pick bytes themselves, so one test rejects two different ways a link can
// be wrong. The scope half matters because a pair index only means something
// within one season's team list: the same 16 clubs play the same 240 ordered
// pairs every year, so without it a 2026 link would apply cleanly -- and
// wrongly -- to the 2027 schedule, and renaming a club would silently move
// picks onto different fixtures. The payload half means damage in transit is
// caught rather than decoding into plausible but wrong picks. Either way the
// link is refused whole instead of misapplied.
//
// The old explicit `<gameId><result>` form (`p=`) is still decoded so links
// shared before this change keep working.  Nothing writes it any more.

import { PICK_VALUES } from "./constants.js";

const SEP = ".";

// Game ids must survive a round trip through a URL fragment untouched, and must
// not contain the separator. Legacy format only.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const RESULT_CODE = { H: 1, D: 2, A: 3 };
const CODE_RESULT = { 1: "H", 2: "D", 3: "A" };
// 0 is deliberately not a result: it is what the zero padding in the last byte
// decodes to, which makes the stream self-terminating.
const RESULT_BITS = 2;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Canonical team order. Sorted here so encoder and decoder cannot disagree. */
function canonicalTeams(teamIds) {
  return (teamIds || []).map(String).slice().sort();
}

const CHECK_BYTES = 2;

/**
 * 16-bit check over the season scope and the pick bytes together: FNV-1a across
 * `"<year>|<sorted team ids>"` and then every payload byte, folded to 16 bits.
 * Rejects a link from another season, a link written against a different team
 * list, and a payload damaged in transit -- roughly 65535 times in 65536.
 *
 * @param {{year: (number|string), teamIds: Array<string>}} scope
 * @param {Array<number>|Uint8Array} bytes  the pick payload, check value excluded
 */
function checkValue(scope, bytes) {
  const year = scope && scope.year !== undefined && scope.year !== null ? String(scope.year) : "?";
  const text = year + "|" + canonicalTeams(scope && scope.teamIds).join(",");
  let h = 0x811c9dc5; // FNV-1a, 32-bit, folded to 16
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
}

/** Bits needed for one (home, away) slot: 16 teams -> 256 slots -> 8 bits. */
function indexBits(n) {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, n * n))));
}

function writeBits(state, value, bits) {
  for (let i = bits - 1; i >= 0; i--) {
    state.cur = (state.cur << 1) | ((value >> i) & 1);
    if (++state.n === 8) {
      state.bytes.push(state.cur);
      state.cur = 0;
      state.n = 0;
    }
  }
}

function readBits(bytes, pos, bits) {
  let v = 0;
  for (let i = 0; i < bits; i++) {
    const p = pos + i;
    v = (v << 1) | ((bytes[p >> 3] >> (7 - (p & 7))) & 1);
  }
  return v;
}

function toBase64Url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b === undefined ? 0 : b) >> 4)];
    if (b === undefined) break;
    out += B64[((b & 15) << 2) | ((c === undefined ? 0 : c) >> 6)];
    if (c === undefined) break;
    out += B64[c & 63];
  }
  return out;
}

/** @returns {Uint8Array|null} null when the string is not base64url at all. */
function fromBase64Url(str) {
  const vals = [];
  for (const ch of str) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    vals.push(v);
  }
  const bytes = [];
  for (let i = 0; i < vals.length; i += 4) {
    const left = vals.length - i;
    const a = vals[i];
    const b = vals[i + 1];
    const c = vals[i + 2];
    const d = vals[i + 3];
    // A lone trailing character encodes no whole byte; ignore it.
    if (left >= 2) bytes.push(((a << 2) | (b >> 4)) & 255);
    if (left >= 3) bytes.push(((b << 4) | (c >> 2)) & 255);
    if (left >= 4) bytes.push(((c << 6) | d) & 255);
  }
  return Uint8Array.from(bytes);
}

/**
 * @param {{year: (number|string), teamIds: Array<string>}} scope
 * @param {Array} games  season games, in file order
 * @param {Object} picks { [gameId]: "H"|"D"|"A" }
 * @returns {string} base64url, or "" when nothing is picked
 */
export function encodePicks(scope, games, picks) {
  const p = picks || {};
  const ids = canonicalTeams(scope && scope.teamIds);
  const n = ids.length;
  if (!n) {
    // Returning "" here would drop every pick out of the URL without a trace,
    // so make the misuse audible rather than silent.
    if (Object.keys(p).length) {
      console.warn("[nwsl] encodePicks called without a team list; picks left out of the link");
    }
    return "";
  }
  const slot = new Map(ids.map((id, i) => [id, i]));
  const bits = indexBits(n);
  const state = { bytes: [], cur: 0, n: 0 };
  let count = 0;
  for (const g of games) {
    const v = p[g.id];
    // Played games are never encoded: their result is already known.
    if (g.status === "played" || !PICK_VALUES.includes(v)) continue;
    const h = slot.get(String(g.home));
    const a = slot.get(String(g.away));
    if (h === undefined || a === undefined) continue;
    writeBits(state, h * n + a, bits);
    writeBits(state, RESULT_CODE[v], RESULT_BITS);
    count++;
  }
  if (!count) return "";
  if (state.n) state.bytes.push(state.cur << (8 - state.n));
  // The check value covers the finished payload, so it goes on the front last.
  const sum = checkValue({ year: scope.year, teamIds: ids }, state.bytes);
  return toBase64Url(Uint8Array.from([sum >> 8, sum & 0xff].concat(state.bytes)));
}

/**
 * Inverse of encodePicks.
 *
 * @returns {{picks: Object, overtaken: number, unknown: number, mismatch: boolean}}
 *   `overtaken` counts picks whose game has since been played -- the real result
 *   now stands instead. `unknown` counts pairs that are not in this season's
 *   schedule at all. `mismatch` means the link was written for a different
 *   season or team list, in which case nothing is applied.
 */
export function decodePicks(scope, games, str) {
  const out = { picks: {}, overtaken: 0, unknown: 0, mismatch: false };
  if (typeof str !== "string" || !str) return out;
  const bytes = fromBase64Url(str);
  if (!bytes || !bytes.length) return out;

  const ids = canonicalTeams(scope && scope.teamIds);
  const n = ids.length;
  if (!n) return out;
  const bits = indexBits(n);
  const group = bits + RESULT_BITS;

  // Too short to carry a check value at all: junk, not a season mismatch.
  if (bytes.length <= CHECK_BYTES) return out;
  const body = bytes.subarray(CHECK_BYTES);
  if (((bytes[0] << 8) | bytes[1]) !== checkValue({ year: scope.year, teamIds: ids }, body)) {
    out.mismatch = true;
    return out;
  }

  const byPair = new Map();
  for (const g of games) {
    const key = g.home + ">" + g.away;
    // If a pair ever appears twice, the one still to be played wins.
    if (!byPair.has(key) || byPair.get(key).status === "played") byPair.set(key, g);
  }

  const total = body.length * 8;
  for (let pos = 0; pos + group <= total; pos += group) {
    const code = readBits(body, pos + bits, RESULT_BITS);
    if (!code) break; // zero padding in the final byte
    const raw = readBits(body, pos, bits);
    const home = ids[Math.floor(raw / n)];
    const away = ids[raw % n];
    if (!home || !away || home === away) {
      out.unknown++;
      continue;
    }
    const g = byPair.get(home + ">" + away);
    if (!g) {
      out.unknown++;
      continue;
    }
    if (g.status === "played") {
      out.overtaken++;
      continue;
    }
    out.picks[g.id] = CODE_RESULT[code];
  }
  return out;
}

/**
 * The pre-2026-09 format: explicit `<gameId><result>` tokens joined by ".".
 * Decoded so old shared links keep working; never written.
 */
export function decodeLegacyPicks(games, str) {
  // No fingerprint needed: event ids are already season-specific, so a link
  // from another year simply matches nothing.
  const out = { picks: {}, overtaken: 0, unknown: 0, mismatch: false };
  if (typeof str !== "string" || !str) return out;
  const byId = new Map(games.map((g) => [String(g.id), g]));
  for (const token of str.split(SEP)) {
    if (token.length < 2) continue;
    const value = token[token.length - 1];
    const id = token.slice(0, -1);
    if (!PICK_VALUES.includes(value) || !SAFE_ID.test(id)) continue;
    const g = byId.get(id);
    if (!g) {
      out.unknown++;
      continue;
    }
    if (g.status === "played") {
      out.overtaken++;
      continue;
    }
    out.picks[id] = value;
  }
  return out;
}

/**
 * @param {{picks: Object, focus: (string|null)}} state
 * @returns {string} hash body without the leading "#", e.g. "s=Aa4B&t=SEA"
 */
export function encodeHash(state, games, scope) {
  const parts = [];
  const p = encodePicks(scope, games, (state && state.picks) || {});
  if (p) parts.push("s=" + p);
  if (state && state.focus) parts.push("t=" + encodeURIComponent(state.focus));
  return parts.join("&");
}

/**
 * @param {string} hash  with or without a leading "#"
 * @param {{year: (number|string), teamIds: Array<string>}} scope
 * @returns {{picks: Object, focus: (string|null), overtaken: number,
 *            unknown: number, mismatch: boolean}}
 */
export function decodeHash(hash, games, scope) {
  const body = typeof hash === "string" ? hash.replace(/^#/, "") : "";
  const params = new URLSearchParams(body);
  const compact = params.get("s");
  const decoded = compact
    ? decodePicks(scope, games, compact)
    : decodeLegacyPicks(games, params.get("p") || "");
  const teamIds = scope && scope.teamIds;
  const t = params.get("t");
  const valid = !teamIds || teamIds.includes(t);
  return {
    picks: decoded.picks,
    focus: t && valid ? t : null,
    overtaken: decoded.overtaken,
    unknown: decoded.unknown,
    mismatch: decoded.mismatch,
  };
}
