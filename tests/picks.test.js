import assert from "node:assert/strict";
import { decodeHash, decodePicks, encodeHash, encodePicks } from "../js/engine/picks.js";

// Five fake games in file order; g3 is already played.
const GAMES = [
  { id: "g1", status: "scheduled" },
  { id: "g2", status: "scheduled" },
  { id: "g3", status: "played" },
  { id: "g4", status: "scheduled" },
  { id: "g5", status: "other" },
];
const TEAM_IDS = ["SEA", "POR", "GFC"];

// Realistic ESPN-style ids, to exercise the id-shift scenario below.
const REAL = [
  { id: "401854084", status: "scheduled" },
  { id: "401854085", status: "scheduled" },
  { id: "401854086", status: "scheduled" },
];

export const tests = [
  {
    name: "picks encode/decode round trip",
    fn() {
      const picks = { g2: "H", g5: "A" };
      assert.equal(encodePicks(GAMES, picks), "g2H.g5A");
      assert.deepEqual(decodePicks(GAMES, "g2H.g5A"), picks);

      const real = { 401854084: "H", 401854086: "D" };
      assert.equal(encodePicks(REAL, real), "401854084H.401854086D");
      assert.deepEqual(decodePicks(REAL, "401854084H.401854086D"), real);
    },
  },
  {
    name: "picks encode in file order; an empty set encodes to ''",
    fn() {
      assert.equal(encodePicks(GAMES, {}), "");
      assert.equal(encodePicks(GAMES, { g1: "D" }), "g1D");
      // Output order follows the games array, not the picks object.
      assert.equal(encodePicks(GAMES, { g4: "A", g1: "D" }), "g1D.g4A");
      // Postponed ("other") games are still pickable.
      assert.equal(encodePicks(GAMES, { g5: "D" }), "g5D");
    },
  },
  {
    name: "picks on played games are never encoded or decoded",
    fn() {
      assert.equal(encodePicks(GAMES, { g3: "H" }), "");
      assert.deepEqual(decodePicks(GAMES, "g3H"), {});
      assert.deepEqual(decodePicks(GAMES, "g1H.g3D.g5A"), { g1: "H", g5: "A" });
    },
  },
  {
    name: "picks decode drops a pick whose game has since been played",
    fn() {
      // The same link, decoded before and after g2 finishes.
      const before = GAMES;
      const after = GAMES.map((g) => (g.id === "g2" ? { ...g, status: "played" } : g));
      const hash = "g1H.g2D.g4A";
      assert.deepEqual(decodePicks(before, hash), { g1: "H", g2: "D", g4: "A" });
      assert.deepEqual(decodePicks(after, hash), { g1: "H", g4: "A" });
    },
  },
  {
    name: "picks decode ignores unknown game ids",
    fn() {
      assert.deepEqual(decodePicks(GAMES, "g1H.zzzD.g4A"), { g1: "H", g4: "A" });
      assert.deepEqual(decodePicks(GAMES, "999999H"), {});
      assert.deepEqual(decodePicks(REAL, "401854084H.401854999D"), { 401854084: "H" });
    },
  },
  {
    name: "picks survive a game-set change instead of shifting onto the wrong game",
    fn() {
      // ESPN re-issues a postponed fixture under a new, larger event id: the
      // game count is unchanged, but the sorted array shifts.  A positional
      // encoding would silently re-point every later pick; naming the id means
      // the vanished game's pick is dropped and the rest stay put.
      const before = [
        { id: "401854084", status: "scheduled" },
        { id: "401854085", status: "scheduled" },
        { id: "401854086", status: "scheduled" },
      ];
      const after = [
        { id: "401854084", status: "scheduled" },
        { id: "401854086", status: "scheduled" },
        { id: "401859999", status: "scheduled" }, // 401854085, rescheduled
      ];
      const picks = { 401854084: "H", 401854085: "D", 401854086: "A" };
      const hash = encodePicks(before, picks);
      assert.deepEqual(decodePicks(after, hash), { 401854084: "H", 401854086: "A" });
    },
  },
  {
    name: "picks decode ignores junk tokens and bad pick letters",
    fn() {
      assert.deepEqual(decodePicks(GAMES, "g2H.g4D"), { g2: "H", g4: "D" });
      assert.deepEqual(decodePicks(GAMES, "g1X.g2H"), { g2: "H" }); // X is not a result
      assert.deepEqual(decodePicks(GAMES, "g1h"), {}); // lower case is not a pick
      assert.deepEqual(decodePicks(GAMES, "..g1H.."), { g1: "H" }); // empty tokens
      assert.deepEqual(decodePicks(GAMES, "H"), {}); // no id
      assert.deepEqual(decodePicks(GAMES, ""), {});
      assert.deepEqual(decodePicks(GAMES, undefined), {});
      assert.deepEqual(decodePicks(GAMES, null), {});
    },
  },
  {
    name: "picks with an unsafe game id are skipped, never mangled",
    fn() {
      // No real ESPN id looks like this, but if one ever did, encoding it raw
      // would corrupt every pick after it in the string.
      const odd = [
        { id: "ok1", status: "scheduled" },
        { id: "has.dot", status: "scheduled" },
        { id: "has space", status: "scheduled" },
        { id: "ok2", status: "scheduled" },
      ];
      const picks = { ok1: "H", "has.dot": "D", "has space": "A", ok2: "D" };
      const encoded = encodePicks(odd, picks);
      assert.equal(encoded, "ok1H.ok2D");
      // The surviving picks still decode to exactly themselves.
      assert.deepEqual(decodePicks(odd, encoded), { ok1: "H", ok2: "D" });
      // And a hand-written hash containing such an id is ignored, not matched.
      assert.deepEqual(decodePicks(odd, "ok1H.has space" + "A"), { ok1: "H" });
    },
  },
  {
    name: "hash encode/decode with picks and focus",
    fn() {
      const state = { picks: { g2: "H", g5: "A" }, focus: "SEA" };
      const hash = encodeHash(state, GAMES);
      assert.equal(hash, "p=g2H.g5A&t=SEA");
      assert.deepEqual(decodeHash("#" + hash, GAMES, TEAM_IDS), state);
      assert.deepEqual(decodeHash(hash, GAMES, TEAM_IDS), state);

      // URLSearchParams must leave the "." separator and the ids alone.
      const real = encodeHash({ picks: { 401854084: "H", 401854086: "D" }, focus: null }, REAL);
      assert.equal(real, "p=401854084H.401854086D");
      assert.deepEqual(decodeHash(real, REAL, TEAM_IDS).picks, { 401854084: "H", 401854086: "D" });
    },
  },
  {
    name: "hash with focus only, picks only, and nothing at all",
    fn() {
      assert.equal(encodeHash({ picks: {}, focus: "POR" }, GAMES), "t=POR");
      assert.deepEqual(decodeHash("t=POR", GAMES, TEAM_IDS), { picks: {}, focus: "POR" });

      assert.equal(encodeHash({ picks: { g1: "D" }, focus: null }, GAMES), "p=g1D");
      assert.deepEqual(decodeHash("p=g1D", GAMES, TEAM_IDS), { picks: { g1: "D" }, focus: null });

      assert.equal(encodeHash({ picks: {}, focus: null }, GAMES), "");
      assert.deepEqual(decodeHash("", GAMES, TEAM_IDS), { picks: {}, focus: null });
      assert.deepEqual(decodeHash("#", GAMES, TEAM_IDS), { picks: {}, focus: null });
    },
  },
  {
    name: "hash ignores an unknown focus team",
    fn() {
      assert.deepEqual(decodeHash("p=g1D&t=ZZZ", GAMES, TEAM_IDS), { picks: { g1: "D" }, focus: null });
    },
  },
  {
    name: "hash round-trips a full slate of real season games",
    fn() {
      const games = [];
      for (let i = 0; i < 50; i++) games.push({ id: String(401854000 + i), status: "scheduled" });
      const picks = {};
      for (const [i, g] of games.entries()) picks[g.id] = ["H", "D", "A"][i % 3];
      const hash = encodeHash({ picks, focus: "GFC" }, games);
      const round = decodeHash("#" + hash, games, ["GFC"]);
      assert.deepEqual(round.picks, picks);
      assert.equal(round.focus, "GFC");
      // Still a perfectly reasonable URL length.
      assert.ok(hash.length < 700, `hash length ${hash.length}`);
    },
  },
];
