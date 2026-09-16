import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bestWorstFromPoints, computeScenarios } from "../js/engine/scenarios.js";
import { computeStandings, resolveGames } from "../js/engine/standings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "season-2026-09-13.json");
const snapshot = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const g = (home, away) => ({ home, away });

// The four hand-checked fixtures from the plan (§5.4).
const CASES = [
  {
    name: "S1 no open games",
    ids: ["A", "B", "C", "D"],
    pts: { A: 10, B: 7, C: 7, D: 1 },
    open: [],
    expect: { A: [1, 1], B: [2, 3], C: [2, 3], D: [4, 4] },
  },
  {
    name: "S2 two open games",
    ids: ["A", "B", "C", "D"],
    pts: { A: 10, B: 7, C: 7, D: 1 },
    open: [g("B", "C"), g("D", "A")],
    expect: { A: [1, 2], B: [1, 3], C: [1, 3], D: [4, 4] },
  },
  {
    name: "S3 draw matters",
    ids: ["A", "B", "C", "D"],
    pts: { A: 6, B: 5, C: 5, D: 0 },
    open: [g("B", "C"), g("A", "D")],
    expect: { A: [1, 3], B: [1, 3], C: [1, 3], D: [4, 4] },
  },
  {
    name: "S4 three-way cycle",
    ids: ["A", "B", "C", "D", "E"],
    pts: { A: 9, B: 9, C: 9, D: 8, E: 4 },
    open: [g("A", "B"), g("B", "C"), g("C", "A"), g("D", "E")],
    expect: { A: [1, 4], B: [1, 4], C: [1, 4], D: [1, 4], E: [5, 5] },
  },
];

// --- brute force reference -------------------------------------------------
// Enumerate all 3^k outcomes and read off the extremes directly.
function brute(ids, pts, open, T) {
  const k = open.length;
  let best = Infinity;
  let worst = -Infinity;
  const total = 3 ** k;
  for (let mask = 0; mask < total; mask++) {
    const P = { ...pts };
    let m = mask;
    for (let i = 0; i < k; i++) {
      const o = m % 3;
      m = (m / 3) | 0;
      const gm = open[i];
      if (o === 0) P[gm.home] += 3;
      else if (o === 1) P[gm.away] += 3;
      else {
        P[gm.home] += 1;
        P[gm.away] += 1;
      }
    }
    let above = 0; // strictly more points than T -> above T even in T's best case
    let atLeast = 0; // at least T's points -> above T in T's worst case
    for (const x of ids) {
      if (x === T) continue;
      if (P[x] > P[T]) above++;
      if (P[x] >= P[T]) atLeast++;
    }
    if (1 + above < best) best = 1 + above;
    if (1 + atLeast > worst) worst = 1 + atLeast;
  }
  return [best, worst];
}

/** Replay a witness over a points table: 3 for a win, 1 each for a draw. */
function applyWitness(pts, open, witness) {
  const P = { ...pts };
  for (let k = 0; k < open.length; k++) {
    const o = witness[k];
    if (o === "H") P[open[k].home] += 3;
    else if (o === "A") P[open[k].away] += 3;
    else {
      P[open[k].home] += 1;
      P[open[k].away] += 1;
    }
  }
  return P;
}

/** [#teams strictly above T, #teams at or above T] under a points table. */
function counts(ids, P, T) {
  let above = 0;
  let atLeast = 0;
  for (const x of ids) {
    if (x === T) continue;
    if (P[x] > P[T]) above++;
    if (P[x] >= P[T]) atLeast++;
  }
  return [above, atLeast];
}

/** The C.2 invariant, checked against a full standings table. */
function assertWitnessRealises(teams, games, picks, sc, teamId, kind) {
  const witness = kind === "best" ? sc.bestWitness : sc.worstWitness;
  const applied = { ...picks, ...witness };
  const { rows, byId } = computeStandings(teams, games, applied);
  const row = byId[teamId];
  assert.equal(row.remaining, 0, `${teamId} has no open games left after the ${kind} witness`);
  if (kind === "best") {
    const above = rows.filter((r) => r.id !== teamId && r.pts > row.pts).length;
    assert.equal(above + 1, sc.best, `${teamId} best witness lands on ${sc.best}`);
    assert.equal(row.rank, sc.best, `${teamId} rank matches best`);
  } else {
    const atLeast = rows.filter((r) => r.id !== teamId && r.pts >= row.pts).length;
    assert.equal(atLeast + 1, sc.worst, `${teamId} worst witness lands on ${sc.worst}`);
    assert.equal(row.rank + row.tiedCount - 1, sc.worst, `${teamId} tie-group bottom matches worst`);
  }
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SNAPSHOT_EXPECT = [
  ["GFC", 48, 1, 11],
  ["WAS", 43, 1, 13],
  ["SD", 42, 1, 14],
  ["UTA", 42, 1, 14],
  ["NC", 39, 1, 15],
  ["POR", 39, 1, 15],
  ["KC", 38, 1, 15],
  ["SEA", 37, 1, 15],
  ["LA", 33, 1, 16],
  ["DEN", 31, 1, 16],
  ["ORL", 30, 1, 16],
  ["BOS", 26, 2, 16],
  ["HOU", 26, 2, 16],
  ["LOU", 23, 5, 16],
  ["BAY", 22, 3, 16],
  ["CHI", 17, 9, 16],
];

// Points-only standings order for the snapshot: ties (SD/UTA, NC/POR, BOS/HOU)
// share a rank and are listed by team id.
const SNAPSHOT_ORDER = [
  ["GFC", 1, 48], ["WAS", 2, 43], ["SD", 3, 42], ["UTA", 3, 42],
  ["NC", 5, 39], ["POR", 5, 39], ["KC", 7, 38], ["SEA", 8, 37],
  ["LA", 9, 33], ["DEN", 10, 31], ["ORL", 11, 30], ["BOS", 12, 26],
  ["HOU", 12, 26], ["LOU", 14, 23], ["BAY", 15, 22], ["CHI", 16, 17],
];

export const tests = [
  ...CASES.map((c) => ({
    name: `scenarios ${c.name}`,
    fn() {
      for (const t of c.ids) {
        const r = bestWorstFromPoints(c.ids, c.pts, c.open, t);
        assert.deepEqual([r.best, r.worst], c.expect[t], `${c.name} team ${t}`);
        assert.equal(r.bestExact, true, `${c.name} team ${t} bestExact`);
        assert.equal(r.worstExact, true, `${c.name} team ${t} worstExact`);
      }
    },
  })),
  {
    name: "scenarios node cap fallback returns an honest bound",
    fn() {
      const c = CASES[3]; // S4
      let inexact = 0;
      for (const t of c.ids) {
        const r = bestWorstFromPoints(c.ids, c.pts, c.open, t, { nodeCap: 1 });
        // min mode returns an upper bound on the minimum -> best is >= truth;
        // max mode returns a lower bound on the maximum -> worst is <= truth.
        // The bound direction must hold whether or not the cap actually tripped.
        assert.ok(r.best >= c.expect[t][0], `${t} best ${r.best} >= ${c.expect[t][0]}`);
        assert.ok(r.worst <= c.expect[t][1], `${t} worst ${r.worst} <= ${c.expect[t][1]}`);
        if (!r.bestExact) inexact++;
        if (!r.worstExact) inexact++;
      }
      // D's BEST is the only S4 run that has to branch at all (everyone else's
      // contender set collapses in the classification step and finishes inside
      // one node, exactly); with a cap of 1 it must give up and report a bound.
      const d = bestWorstFromPoints(c.ids, c.pts, c.open, "D", { nodeCap: 1 });
      assert.equal(d.bestExact, false, "D bestExact under a 1-node cap");
      // Only an upper bound is promised. Since the witness work landed, a
      // capped run falls back to one greedy descent, which happens to find the
      // optimum here -- so this can be equal, not strictly worse.
      assert.ok(d.best >= c.expect.D[0], "D's capped best is still an upper bound");
      assert.ok(inexact > 0, "at least one S4 run must trip a 1-node cap");
    },
  },
  {
    name: "scenarios flags are suppressed when the search is cut short",
    fn() {
      // Same snapshot state, but starved of nodes: CHI is provably eliminated
      // with a full budget, and must stop claiming so when the bound is inexact.
      const full = computeScenarios(snapshot.teams, snapshot.games, {});
      assert.equal(full.byId.CHI.flags.eliminated, true);
      const starved = computeScenarios(snapshot.teams, snapshot.games, {}, { nodeCap: 1 });
      for (const t of snapshot.teams) {
        const f = starved.byId[t.id].flags;
        const s2 = starved.byId[t.id];
        if (!s2.bestExact) {
          assert.equal(f.eliminated, false, `${t.id} eliminated must be false when inexact`);
          assert.equal(f.cannotWinShield, false, `${t.id} cannotWinShield must be false when inexact`);
        }
        if (!s2.worstExact) {
          assert.equal(f.clinchedPlayoffs, false, `${t.id} clinchedPlayoffs must be false when inexact`);
          assert.equal(f.clinchedShield, false, `${t.id} clinchedShield must be false when inexact`);
        }
      }
    },
  },
  {
    name: "scenarios randomised brute-force cross-check (300 instances)",
    fn() {
      const rnd = mulberry32(12345);
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
      let checks = 0;
      const t0 = Date.now();
      for (let iter = 0; iter < 300; iter++) {
        const n = pick([4, 5, 6]);
        const ids = [];
        for (let i = 0; i < n; i++) ids.push(String.fromCharCode(65 + i));
        const pts = {};
        for (const id of ids) pts[id] = int(0, 12);
        const open = [];
        const k = int(0, 7);
        for (let i = 0; i < k; i++) {
          const a = pick(ids);
          let b = pick(ids);
          while (b === a) b = pick(ids);
          open.push(g(a, b));
        }
        for (const T of ids) {
          const r = bestWorstFromPoints(ids, pts, open, T);
          const [bb, bw] = brute(ids, pts, open, T);
          assert.equal(r.exact === undefined ? true : r.exact, true);
          assert.equal(r.bestExact, true);
          assert.equal(r.worstExact, true);
          assert.deepEqual(
            [r.best, r.worst],
            [bb, bw],
            `mismatch for ${T} pts=${JSON.stringify(pts)} open=${JSON.stringify(open)}`
          );
          checks++;
        }
      }
      const ms = Date.now() - t0;
      assert.ok(checks >= 1200, "ran enough checks");
      assert.ok(ms < 5000, `brute-force cross-check took ${ms} ms (limit 5000)`);
      console.log(`     (brute force: ${checks} team comparisons over 300 instances in ${ms} ms)`);
    },
  },
  {
    name: "scenarios witness realises best/worst on random instances",
    fn() {
      // Same generator and seed as the brute-force cross-check, so the witness
      // is exercised on exactly the instances whose answers are known correct.
      const rnd = mulberry32(12345);
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
      let checked = 0;
      for (let iter = 0; iter < 300; iter++) {
        const n = pick([4, 5, 6]);
        const ids = [];
        for (let i = 0; i < n; i++) ids.push(String.fromCharCode(65 + i));
        const pts = {};
        for (const id of ids) pts[id] = int(0, 12);
        const open = [];
        const k = int(0, 7);
        for (let i = 0; i < k; i++) {
          const a = pick(ids);
          let b = pick(ids);
          while (b === a) b = pick(ids);
          open.push(g(a, b));
        }
        for (const T of ids) {
          const r = bestWorstFromPoints(ids, pts, open, T);
          const ctx = `T=${T} pts=${JSON.stringify(pts)} open=${JSON.stringify(open)}`;

          for (const kind of ["bestWitness", "worstWitness"]) {
            assert.equal(r[kind].length, open.length, `${kind} length ${ctx}`);
            for (const o of r[kind]) assert.ok(["H", "D", "A"].includes(o), `${kind} entry ${o} ${ctx}`);
          }
          // T's own games follow the convention: wins them all for best, loses
          // them all for worst.
          for (let i = 0; i < open.length; i++) {
            if (open[i].home === T) {
              assert.equal(r.bestWitness[i], "H", `best: T wins at home ${ctx}`);
              assert.equal(r.worstWitness[i], "A", `worst: T loses at home ${ctx}`);
            } else if (open[i].away === T) {
              assert.equal(r.bestWitness[i], "A", `best: T wins away ${ctx}`);
              assert.equal(r.worstWitness[i], "H", `worst: T loses away ${ctx}`);
            }
          }

          const [aboveBest] = counts(ids, applyWitness(pts, open, r.bestWitness), T);
          assert.equal(aboveBest + 1, r.best, `best witness realises ${r.best} ${ctx}`);
          const [, atLeastWorst] = counts(ids, applyWitness(pts, open, r.worstWitness), T);
          assert.equal(atLeastWorst + 1, r.worst, `worst witness realises ${r.worst} ${ctx}`);
          checked++;
        }
      }
      assert.ok(checked >= 1200, `checked ${checked} team witnesses`);
    },
  },
  {
    name: "scenarios S4 best witness for D is the all-draw cycle",
    fn() {
      const c = CASES[3];
      const r = bestWorstFromPoints(c.ids, c.pts, c.open, "D");
      // The only assignment that puts D 1st: every cycle game drawn (so A, B
      // and C each finish on 11, one short of D's 11 plus the tie convention),
      // and D beats E at home. This pins the recorded DFS path, not just the count.
      assert.deepEqual(r.bestWitness, ["D", "D", "D", "H"]);
      assert.equal(r.best, 1);
      assert.equal(r.worstWitness[3], "A", "D loses to E in the worst case");
      assert.equal(r.worst, 4);
    },
  },
  {
    name: "scenarios witness on the frozen snapshot for several pick sets",
    fn() {
      const open = snapshot.games.filter((gm) => gm.status !== "played");
      const rnd = mulberry32(777);
      const pickSets = [{}, Object.fromEntries(open.map((gm) => [gm.id, "H"]))];
      for (let i = 0; i < 5; i++) {
        const set = {};
        for (const gm of open) {
          const v = ["", "H", "D", "A"][Math.floor(rnd() * 4)];
          if (v) set[gm.id] = v;
        }
        pickSets.push(set);
      }

      for (const [i, picks] of pickSets.entries()) {
        const undecided = resolveGames(snapshot.games, picks)
          .filter((gm) => !gm.decided)
          .map((gm) => gm.id)
          .sort();
        const { byId } = computeScenarios(snapshot.teams, snapshot.games, picks);
        for (const t of snapshot.teams) {
          const sc = byId[t.id];
          for (const kind of ["bestWitness", "worstWitness"]) {
            assert.deepEqual(
              Object.keys(sc[kind]).sort(),
              undecided,
              `set ${i} ${t.id} ${kind} covers exactly the undecided games`
            );
          }
          // A witness never disturbs a pick the user already made.
          const applied = { ...picks, ...sc.bestWitness };
          for (const [id, v] of Object.entries(picks)) {
            assert.equal(applied[id], v, `set ${i} ${t.id} keeps locked pick ${id}`);
          }
          assertWitnessRealises(snapshot.teams, snapshot.games, picks, sc, t.id, "best");
          assertWitnessRealises(snapshot.teams, snapshot.games, picks, sc, t.id, "worst");
        }
      }
    },
  },
  {
    name: "scenarios witness still realises the reported bound when the search is cut short",
    fn() {
      for (const nodeCap of [1, 25]) {
        const { byId } = computeScenarios(snapshot.teams, snapshot.games, {}, { nodeCap });
        let inexact = 0;
        for (const t of snapshot.teams) {
          const sc = byId[t.id];
          if (!sc.bestExact) inexact++;
          if (!sc.worstExact) inexact++;
          // The reported number is the count of a concrete assignment whether or
          // not the search finished, so the witness must still land on it.
          assertWitnessRealises(snapshot.teams, snapshot.games, {}, sc, t.id, "best");
          assertWitnessRealises(snapshot.teams, snapshot.games, {}, sc, t.id, "worst");
        }
        if (nodeCap === 1) {
          assert.ok(inexact > 0, "a 1-node cap must cut at least one run short");
        }
      }
    },
  },
  {
    name: "scenarios snapshot regression on the frozen 2026-09-13 fixture",
    fn() {
      const { byId } = computeScenarios(snapshot.teams, snapshot.games, {});
      const standings = computeStandings(snapshot.teams, snapshot.games, {});
      for (const [id, pts, best, worst] of SNAPSHOT_EXPECT) {
        assert.equal(standings.byId[id].pts, pts, `${id} points`);
        assert.equal(byId[id].best, best, `${id} best`);
        assert.equal(byId[id].worst, worst, `${id} worst`);
        assert.equal(byId[id].bestExact, true, `${id} bestExact`);
        assert.equal(byId[id].worstExact, true, `${id} worstExact`);
      }
      assert.equal(byId.CHI.flags.eliminated, true);
      for (const t of snapshot.teams) {
        assert.equal(byId[t.id].flags.clinchedPlayoffs, false, `${t.id} must not be clinched yet`);
      }
    },
  },
  {
    name: "scenarios snapshot points-only standings order",
    fn() {
      const { rows, byId } = computeStandings(snapshot.teams, snapshot.games, {});
      assert.deepEqual(
        rows.map((r) => [r.id, r.rank, r.pts]),
        SNAPSHOT_ORDER
      );
      for (const t of snapshot.teams) {
        const expected = ["SEA", "LA", "DEN", "BAY"].includes(t.id) ? 23 : 24;
        assert.equal(byId[t.id].gp, expected, `${t.id} games played`);
      }
      // The three points-level pairs are flagged as tied.
      for (const id of ["SD", "UTA", "NC", "POR", "BOS", "HOU"]) {
        assert.equal(byId[id].tied, true, `${id} tied`);
        assert.equal(byId[id].tiedCount, 2, `${id} tiedCount`);
      }
    },
  },
  {
    name: "scenarios full-season consistency (every game picked -> best/worst = tie bracket)",
    fn() {
      const picks = {};
      for (const gm of snapshot.games) if (gm.status !== "played") picks[gm.id] = "H";
      const { byId } = computeScenarios(snapshot.teams, snapshot.games, picks);
      const standings = computeStandings(snapshot.teams, snapshot.games, picks);
      for (const t of snapshot.teams) {
        const row = standings.byId[t.id];
        const s = byId[t.id];
        assert.equal(s.bestExact, true, `${t.id} bestExact`);
        assert.equal(s.worstExact, true, `${t.id} worstExact`);
        assert.equal(s.best, row.rank, `${t.id} best === rank`);
        assert.equal(s.worst, row.rank + row.tiedCount - 1, `${t.id} worst === bottom of tie group`);
      }
    },
  },
  {
    name: "scenarios performance on the real season state",
    fn() {
      const t0 = Date.now();
      const r = computeScenarios(snapshot.teams, snapshot.games, {});
      const ms = Date.now() - t0;
      console.log(`     (computeScenarios: ${r.totalNodes} nodes, ${ms} ms wall / ${r.ms.toFixed(1)} ms reported)`);
      assert.ok(r.totalNodes < 20000, `totalNodes ${r.totalNodes} < 20000`);
      assert.ok(ms < 200, `computeScenarios took ${ms} ms (limit 200)`);
    },
  },
];
