import assert from "node:assert/strict";
import {
  decodeHash,
  decodeLegacyPicks,
  decodePicks,
  encodeHash,
  encodePicks,
} from "../js/engine/picks.js";

// A tiny four-team double round robin: every ordered (home, away) pair once.
const TEAM_IDS = ["AAA", "BBB", "CCC", "DDD"];
const SCOPE = { year: 2026, teamIds: TEAM_IDS };
const GAMES = [
  { id: "g1", home: "AAA", away: "BBB", status: "scheduled" },
  { id: "g2", home: "BBB", away: "AAA", status: "scheduled" },
  { id: "g3", home: "CCC", away: "DDD", status: "played" },
  { id: "g4", home: "DDD", away: "CCC", status: "scheduled" },
  { id: "g5", home: "AAA", away: "CCC", status: "other" },
];

const ids = (o) => Object.keys(o).sort();

export const tests = [
  {
    name: "picks round trip through the compact encoding",
    fn() {
      const picks = { g1: "H", g4: "D", g5: "A" };
      const s = encodePicks(SCOPE, GAMES, picks);
      assert.ok(s.length > 0);
      assert.deepEqual(decodePicks(SCOPE, GAMES, s).picks, picks);

      // Every result value survives, on both home and away sides.
      for (const v of ["H", "D", "A"]) {
        const one = { g2: v };
        assert.deepEqual(decodePicks(SCOPE, GAMES, encodePicks(SCOPE, GAMES, one)).picks, one);
      }
    },
  },
  {
    name: "empty picks encode to '' and decode back to nothing",
    fn() {
      assert.equal(encodePicks(SCOPE, GAMES, {}), "");
      assert.equal(encodePicks(SCOPE, GAMES, null), "");
      for (const junk of ["", "!!!!", "~~~", "        "]) {
        assert.deepEqual(decodePicks(SCOPE, GAMES, junk).picks, {});
      }
    },
  },
  {
    name: "picks on played games are never encoded, and decode as overtaken",
    fn() {
      // g3 is already played, so the author's link never carries it.
      assert.equal(encodePicks(SCOPE, GAMES, { g3: "H" }), "");

      // But a link made BEFORE it was played does, and must say so.
      const earlier = GAMES.map((g) => (g.id === "g3" ? { ...g, status: "scheduled" } : g));
      const s = encodePicks(SCOPE, earlier, { g1: "H", g3: "A" });
      const now = decodePicks(SCOPE, GAMES, s);
      assert.deepEqual(now.picks, { g1: "H" }, "the played game's pick is dropped");
      assert.equal(now.overtaken, 1, "and is reported, not silently lost");
      assert.equal(now.unknown, 0);
    },
  },
  {
    name: "a fixture re-issued under a new id keeps its pick",
    fn() {
      // The failure this encoding exists to prevent: ESPN drops event g4 and
      // re-issues the same DDD v CCC fixture as a brand-new, larger id.
      const s = encodePicks(SCOPE, GAMES, { g1: "H", g4: "D" });
      const reissued = GAMES.map((g) =>
        g.id === "g4" ? { ...g, id: "999999" } : g
      );
      const out = decodePicks(SCOPE, reissued, s);
      assert.deepEqual(out.picks, { g1: "H", 999999: "D" }, "pick follows the fixture, not the id");
      assert.equal(out.overtaken, 0);
      assert.equal(out.unknown, 0);
    },
  },
  {
    name: "a pair that is not in the schedule is reported as unknown",
    fn() {
      const s = encodePicks(SCOPE, GAMES, { g1: "H", g4: "D" });
      // A season where DDD v CCC simply does not exist.
      const fewer = GAMES.filter((g) => g.id !== "g4");
      const out = decodePicks(SCOPE, fewer, s);
      assert.deepEqual(out.picks, { g1: "H" });
      assert.equal(out.unknown, 1);
      assert.equal(out.overtaken, 0);
    },
  },
  {
    name: "the canonical team order does not depend on the caller's order",
    fn() {
      const picks = { g1: "H", g4: "A" };
      const s = encodePicks(SCOPE, GAMES, picks);
      const shuffled = ["DDD", "AAA", "CCC", "BBB"];
      assert.equal(encodePicks({ year: 2026, teamIds: shuffled }, GAMES, picks), s, "encode is order-independent");
      assert.deepEqual(decodePicks({ year: 2026, teamIds: shuffled }, GAMES, s).picks, picks, "so is decode");
    },
  },
  {
    name: "encoding is deterministic and follows file order, not object order",
    fn() {
      const a = encodePicks(SCOPE, GAMES, { g4: "A", g1: "D" });
      const b = encodePicks(SCOPE, GAMES, { g1: "D", g4: "A" });
      assert.equal(a, b);
    },
  },
  {
    name: "encoded picks are base64url and safe in a URL fragment",
    fn() {
      const picks = {};
      for (const g of GAMES) if (g.status !== "played") picks[g.id] = "H";
      const s = encodePicks(SCOPE, GAMES, picks);
      assert.match(s, /^[A-Za-z0-9_-]+$/, "no padding, no reserved characters");
      // URLSearchParams must hand it back untouched.
      const params = new URLSearchParams("s=" + s);
      assert.equal(params.get("s"), s);
      assert.equal(encodeURIComponent(s), s);
    },
  },
  {
    name: "a truncated or corrupted payload degrades instead of throwing",
    fn() {
      const full = {};
      for (const g of GAMES) if (g.status !== "played") full[g.id] = "D";
      const s = encodePicks(SCOPE, GAMES, full);
      for (let cut = 0; cut < s.length; cut++) {
        const out = decodePicks(SCOPE, GAMES, s.slice(0, cut));
        assert.equal(typeof out.picks, "object");
        for (const v of Object.values(out.picks)) assert.ok(["H", "D", "A"].includes(v));
      }
    },
  },
  {
    name: "hash encode/decode with picks and focus",
    fn() {
      const state = { picks: { g1: "H", g4: "D" }, focus: "BBB" };
      const hash = encodeHash(state, GAMES, SCOPE);
      assert.match(hash, /^s=[A-Za-z0-9_-]+&t=BBB$/);
      const out = decodeHash("#" + hash, GAMES, SCOPE);
      assert.deepEqual(out.picks, state.picks);
      assert.equal(out.focus, "BBB");
    },
  },
  {
    name: "hash with focus only, picks only, and nothing at all",
    fn() {
      assert.equal(encodeHash({ picks: {}, focus: "AAA" }, GAMES, SCOPE), "t=AAA");
      assert.equal(encodeHash({ picks: {}, focus: null }, GAMES, SCOPE), "");
      assert.match(encodeHash({ picks: { g1: "A" }, focus: null }, GAMES, SCOPE), /^s=/);

      const empty = decodeHash("", GAMES, SCOPE);
      assert.deepEqual(empty.picks, {});
      assert.equal(empty.focus, null);
    },
  },
  {
    name: "hash ignores an unknown focus team",
    fn() {
      assert.equal(decodeHash("#t=ZZZ", GAMES, SCOPE).focus, null);
      assert.equal(decodeHash("#t=BBB", GAMES, SCOPE).focus, "BBB");
    },
  },
  {
    name: "links in the old p= format still decode",
    fn() {
      // Written by the pre-2026-09 build; no s= present.
      const out = decodeHash("#p=g1H.g4D&t=CCC", GAMES, SCOPE);
      assert.deepEqual(out.picks, { g1: "H", g4: "D" });
      assert.equal(out.focus, "CCC");

      // Old links report overtaken picks too.
      const legacy = decodeLegacyPicks(GAMES, "g1H.g3A.zzzD");
      assert.deepEqual(legacy.picks, { g1: "H" });
      assert.equal(legacy.overtaken, 1, "g3 has been played");
      assert.equal(legacy.unknown, 1, "zzz is not a game");
    },
  },
  {
    name: "s= wins over a stale p= in the same link",
    fn() {
      const s = encodePicks(SCOPE, GAMES, { g1: "A" });
      const out = decodeHash(`#s=${s}&p=g4D`, GAMES, SCOPE);
      assert.deepEqual(out.picks, { g1: "A" });
    },
  },
  {
    name: "a link from another season is refused, not misapplied",
    fn() {
      // The same clubs play the same ordered pairs every year, so without a
      // scope fingerprint a 2026 link would apply cleanly -- and wrongly -- to
      // the 2027 schedule.
      const s = encodePicks(SCOPE, GAMES, { g1: "H", g4: "D" });
      const nextYear = { year: 2027, teamIds: TEAM_IDS };
      const out = decodePicks(nextYear, GAMES, s);
      assert.equal(out.mismatch, true);
      assert.deepEqual(out.picks, {}, "nothing is applied");
      assert.equal(out.overtaken, 0);
      assert.equal(out.unknown, 0);

      // And the same season still works.
      assert.equal(decodePicks(SCOPE, GAMES, s).mismatch, false);
    },
  },
  {
    name: "a changed team list is refused, not silently re-pointed",
    fn() {
      const s = encodePicks(SCOPE, GAMES, { g1: "H", g2: "A", g4: "D" });
      // A club renamed: every pair index after it would shift onto a different
      // fixture, which is worse than losing the picks.
      const renamed = { year: 2026, teamIds: ["AAA", "ZZZ", "CCC", "DDD"] };
      assert.equal(decodePicks(renamed, GAMES, s).mismatch, true);
      // A club added: the index width itself changes.
      const expanded = { year: 2026, teamIds: TEAM_IDS.concat("EEE") };
      assert.equal(decodePicks(expanded, GAMES, s).mismatch, true);
    },
  },
  {
    name: "the check value catches a payload mangled in transit",
    fn() {
      const s = encodePicks(SCOPE, GAMES, { g1: "H", g2: "D", g4: "A" });
      let caught = 0;
      let applied = 0;
      // Flip one character at a time to a different base64url value.
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      for (let i = 0; i < s.length; i++) {
        for (const ch of alphabet) {
          if (ch === s[i]) continue;
          const bad = s.slice(0, i) + ch + s.slice(i + 1);
          const out = decodePicks(SCOPE, GAMES, bad);
          if (out.mismatch) caught++;
          else if (Object.keys(out.picks).length) applied++;
        }
      }
      // The check covers the payload as well as the scope, so essentially all
      // single-character damage is rejected rather than decoding into
      // plausible-but-wrong picks.
      const rate = caught / (caught + applied);
      assert.ok(rate > 0.99, `caught ${caught}, silently applied ${applied} (${(100 * rate).toFixed(1)}%)`);
    },
  },
  {
    name: "old p= links are not subject to the check value",
    fn() {
      // Event ids are already season-specific, so a legacy link simply matches
      // nothing in another season rather than reporting a mismatch.
      const out = decodeHash("#p=g1H.g4D", GAMES, { year: 2027, teamIds: TEAM_IDS });
      assert.equal(out.mismatch, false);
      assert.deepEqual(out.picks, { g1: "H", g4: "D" });
    },
  },
  {
    name: "a full real-season slate encodes to a short link",
    fn() {
      // 16 teams, 50 open games: the case that used to cost 557 characters.
      const teams = [];
      for (let i = 0; i < 16; i++) teams.push("T" + String(i).padStart(2, "0"));
      const games = [];
      let id = 0;
      for (const h of teams) {
        for (const a of teams) {
          if (h !== a) games.push({ id: "g" + id++, home: h, away: a, status: "played" });
        }
      }
      assert.equal(games.length, 240);
      const picks = {};
      for (let i = 0; i < 50; i++) {
        games[i].status = "scheduled";
        picks[games[i].id] = "HDA"[i % 3];
      }
      const s = encodePicks({ year: 2026, teamIds: teams }, games, picks);
      assert.ok(s.length <= 95, `50 picks encode to ${s.length} chars`);
      assert.deepEqual(decodePicks({ year: 2026, teamIds: teams }, games, s).picks, picks);
      assert.equal(ids(decodePicks({ year: 2026, teamIds: teams }, games, s).picks).length, 50);
    },
  },
];
