// Best / worst possible finishing position, points-only.
//
// Conventions (§5.1 of the plan):
//   BEST(T)  -- T wins all its remaining open games AND ranks ahead of anyone
//               level with it on points.  So X finishes above T iff
//               pts(X) >= maxPts(T) + 1.
//   WORST(T) -- T loses all its remaining open games AND ranks behind anyone
//               level with it on points.  So X finishes above T iff
//               pts(X) >= minPts(T).
//
// Both therefore reduce to a single question:
//
//   "how many teams other than T can be made to finish on >= `threshold`
//    points, minimised (BEST) or maximised (WORST)?"
//
// and position = 1 + that count.  The counting problem is NP-hard in general
// under 3-1-0 scoring, so `countTeamsReaching` is a branch-and-bound DFS with
// status freezing, a matching-based bound, memoisation and a node cap.

import { DEFAULT_NODE_CAP } from "./constants.js";
import { resolveGames } from "./standings.js";

const OPEN = 0;
const DONE = 1; // max: reached the threshold.  min: pushed over the cap.
const OUT = 2; // max: can no longer reach the threshold.  (unused in min)

function now() {
  const perf = globalThis.performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

/**
 * Count teams (other than `teamId`) that can end on >= `threshold` points.
 *
 * @param {string[]} teamIds   all team ids (including teamId)
 * @param {Object} pointsById  { [id]: number } points already banked
 * @param {Array} openGames    [{home, away}]; must NOT involve `teamId`
 * @param {string} teamId      the team whose position we are computing
 * @param {number} threshold   points a rival needs to finish above/level
 * @param {"min"|"max"} mode   minimise (BEST) or maximise (WORST) the count
 * @param {number} nodeCap     search budget; exceeding it returns exact:false
 * @returns {{count, exact, nodes, outcomes}} `outcomes` is a witness: one of
 *   "H"|"D"|"A" per entry of `openGames`, an assignment under which exactly
 *   `count` teams other than T finish on >= `threshold` points.
 */
export function countTeamsReaching(teamIds, pointsById, openGames, teamId, threshold, mode, nodeCap) {
  const cap = nodeCap === undefined || nodeCap === null ? DEFAULT_NODE_CAP : nodeCap;
  const thr = threshold;
  const isMax = mode === "max";
  const P = pointsById;

  // --- Step A: classify the other teams -----------------------------------
  const others = teamIds.filter((t) => t !== teamId);
  const rem = Object.create(null);
  for (const t of teamIds) rem[t] = 0;
  for (const g of openGames) {
    rem[g.home] = (rem[g.home] || 0) + 1;
    rem[g.away] = (rem[g.away] || 0) + 1;
  }

  let fixedAbove = 0; // already at/over the threshold, counts regardless
  const contenders = []; // below, but could still get there
  for (const t of others) {
    const pts = P[t] || 0;
    if (pts >= thr) fixedAbove++;
    else if (pts + 3 * (rem[t] || 0) >= thr) contenders.push(t);
    // else: fixedBelow -- can never get there, ignore entirely
  }

  const idx = new Map(contenders.map((t, i) => [t, i]));
  const n = contenders.length;

  // --- Step B: greedily resolve games with at most one contender ----------
  // Dominance: extra points never hurt a team we want above the line (max) and
  // never help one we want below it (min); the non-contender's own status is
  // already fixed either way, so this is exact.
  const P2 = new Array(n);
  for (let i = 0; i < n; i++) P2[i] = P[contenders[i]] || 0;
  // The witness: one result per input game. Games that the search never
  // branches on are decided here, consistently with the points Step B applies.
  const outcomes = new Array(openGames.length).fill("D");
  const G = []; // contender-vs-contender games, as [homeIdx, awayIdx, inputIdx]
  for (let k = 0; k < openGames.length; k++) {
    const g = openGames[k];
    const xi = idx.has(g.home) ? idx.get(g.home) : -1;
    const yi = idx.has(g.away) ? idx.get(g.away) : -1;
    if (xi >= 0 && yi >= 0) {
      G.push([xi, yi, k]); // decided by the search; outcomes[k] filled at the end
    } else if (xi >= 0 || yi >= 0) {
      // Exactly one contender. max: it takes the win (+3, as applied below).
      // min: it loses, so the non-contender takes the win (+0 for the contender).
      const contenderIsHome = xi >= 0;
      if (isMax) {
        if (xi >= 0) P2[xi] += 3;
        if (yi >= 0) P2[yi] += 3;
        outcomes[k] = contenderIsHome ? "H" : "A";
      } else {
        outcomes[k] = contenderIsHome ? "A" : "H";
      }
    }
    // No contender at all: a draw is safe either way (a fixedAbove team stays
    // above; a fixedBelow team has P + 3*rem < thr, so +1 cannot lift it), and
    // it keeps the witness deterministic. outcomes[k] is already "D".
  }

  // --- Step C: per-contender targets --------------------------------------
  // max: `need[i]` points still to gain.  min: `capv[i]` points it may gain
  // while staying strictly below the threshold (>= 0 by classification).
  const need = new Array(n);
  const capv = new Array(n);
  for (let i = 0; i < n; i++) {
    need[i] = thr - P2[i];
    capv[i] = thr - 1 - P2[i];
  }
  const gcount = new Array(n).fill(0);
  for (const [x, y] of G) {
    gcount[x]++;
    gcount[y]++;
  }

  // --- Step D: static game ordering ---------------------------------------
  // Tightest teams first, so the search hits contradictions early.
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  if (isMax) {
    order.sort((a, b) => tightMax(b) - tightMax(a));
  } else {
    order.sort((a, b) => tightMin(a) - tightMin(b));
  }
  function tightMax(i) {
    return gcount[i] ? need[i] / (3 * gcount[i]) : -1;
  }
  function tightMin(i) {
    return gcount[i] ? capv[i] / (3 * gcount[i]) : 9;
  }
  const rank = new Array(n).fill(0);
  order.forEach((teamIndex, r) => {
    rank[teamIndex] = r;
  });
  G.sort((a, b) => {
    const amin = Math.min(rank[a[0]], rank[a[1]]);
    const bmin = Math.min(rank[b[0]], rank[b[1]]);
    if (amin !== bmin) return amin - bmin;
    return Math.max(rank[a[0]], rank[a[1]]) - Math.max(rank[b[0]], rank[b[1]]);
  });

  const m = G.length;
  // suffix[i][t] = how many of G[i..] involve contender t.
  const suffix = new Array(m + 1);
  suffix[m] = new Array(n).fill(0);
  for (let i = m - 1; i >= 0; i--) {
    const row = suffix[i + 1].slice();
    row[G[i][0]]++;
    row[G[i][1]]++;
    suffix[i] = row;
  }

  // --- Step E: mutable search state ---------------------------------------
  const gain = new Array(n).fill(0);
  const status = new Array(n).fill(OPEN);
  if (isMax) {
    for (let i = 0; i < n; i++) {
      if (need[i] <= 0) status[i] = DONE; // step-B freebies already got it there
      else if (need[i] > 3 * gcount[i]) status[i] = OUT;
    }
  }
  let initialDone = 0;
  if (isMax) for (let i = 0; i < n; i++) if (status[i] === DONE) initialDone++;

  const initialDc = isMax ? initialDone : 0;
  let best = isMax ? initialDone : n;
  let nodes = 0;
  let exact = true;
  const memo = new Map();
  const used = new Array(n); // scratch for the matching bound

  // Witness recording: `path[i]` is [homePoints, awayPoints] for G[i] on the
  // branch currently being explored (null for a game both of whose teams were
  // already frozen); `bestPath` is a snapshot taken at the best leaf found.
  const path = new Array(m);
  let bestPath = null;
  // Greedy mode: one straight-line descent used only when the search finished
  // without ever reaching a leaf. It ignores the cap, the bound and the memo
  // and takes the first outcome at every game, purely to obtain a concrete
  // assignment to report.
  let greedy = false;

  // --- Step F: optimistic bound -------------------------------------------
  // Each matched edge forces at least one distinct extra failure (max) or one
  // distinct extra bust (min); a greedy maximal matching is a valid lower
  // bound on the minimum vertex cover, hence a valid bound here.
  function bound(i, dc) {
    used.fill(false);
    let mm = 0;
    if (isMax) {
      let reach = 0;
      for (let t = 0; t < n; t++) if (status[t] === OPEN) reach++;
      const suf = suffix[i];
      for (let j = i; j < m; j++) {
        const x = G[j][0];
        const y = G[j][1];
        if (status[x] !== OPEN || status[y] !== OPEN || used[x] || used[y]) continue;
        // Points each side must take from *this* game to stay reachable.
        const px = need[x] - gain[x] - 3 * (suf[x] - 1);
        const py = need[y] - gain[y] - 3 * (suf[y] - 1);
        // A draw can satisfy two teams that each need exactly 1, so that is
        // not a conflict; anything greedier is.
        if (px >= 1 && py >= 1 && (px >= 2 || py >= 2)) {
          used[x] = true;
          used[y] = true;
          mm++;
        }
      }
      return dc + reach - mm;
    }
    for (let j = i; j < m; j++) {
      const x = G[j][0];
      const y = G[j][1];
      if (status[x] !== OPEN || status[y] !== OPEN || used[x] || used[y]) continue;
      const rx = capv[x] - gain[x];
      const ry = capv[y] - gain[y];
      // "Forced": no outcome of this game keeps both teams under their cap.
      if (!(rx >= 3 || ry >= 3 || (rx >= 1 && ry >= 1))) {
        used[x] = true;
        used[y] = true;
        mm++;
      }
    }
    return dc + mm;
  }

  // --- Step G: the search -------------------------------------------------
  function rec(i, dc) {
    if (!greedy) {
      nodes++;
      if (nodes > cap) {
        exact = false;
        return;
      }
      const b = bound(i, dc);
      if (isMax ? b <= best : b >= best) return;
    }
    if (i === m) {
      // bound(m, dc) === dc, so outside greedy mode a leaf is only reached when
      // it strictly improves `best` -- bestPath therefore always matches best.
      best = dc;
      bestPath = path.slice();
      return;
    }
    // Memo key: position in the game list + every contender's gain (or its
    // frozen status).  Future cost depends only on that.
    if (!greedy) {
      let key = String(i);
      for (let t = 0; t < n; t++) key += "," + (status[t] === OPEN ? gain[t] : "s" + status[t]);
      const prev = memo.get(key);
      if (prev !== undefined && (isMax ? prev >= dc : prev <= dc)) return;
      memo.set(key, dc);
    }

    const x = G[i][0];
    const y = G[i][1];
    // A frozen team's own remaining games no longer matter to it, so we resolve
    // them in whichever way helps the objective -- this freezing is what keeps
    // the search small.
    if (status[x] !== OPEN && status[y] !== OPEN) {
      // Neither side cares any more; a draw is the safe, deterministic filler
      // (DONE teams only gain, and an OUT team was frozen on the assumption it
      // takes 3 from every later game, so 1 cannot rescue it).
      path[i] = null;
      rec(i + 1, dc);
      return;
    }
    let branchOutcomes;
    if (isMax) {
      if (status[x] !== OPEN) {
        apply(i, dc, y, 3, x, 0); // the still-open opponent takes the win
        return;
      }
      if (status[y] !== OPEN) {
        apply(i, dc, x, 3, y, 0);
        return;
      }
      branchOutcomes = need[x] - gain[x] >= need[y] - gain[y] ? [[3, 0], [0, 3], [1, 1]] : [[0, 3], [3, 0], [1, 1]];
    } else {
      if (status[x] !== OPEN) {
        apply(i, dc, x, 3, y, 0); // the already-over team takes the win
        return;
      }
      if (status[y] !== OPEN) {
        apply(i, dc, y, 3, x, 0);
        return;
      }
      const rx = capv[x] - gain[x];
      const ry = capv[y] - gain[y];
      // Give the 3 to whichever side has more room, and try outcomes that bust
      // fewer teams first (stable sort keeps the draw last among equals).
      branchOutcomes = rx <= ry ? [[0, 3], [3, 0], [1, 1]] : [[3, 0], [0, 3], [1, 1]];
      const cost = (o) => (o[0] > rx ? 1 : 0) + (o[1] > ry ? 1 : 0);
      branchOutcomes = branchOutcomes
        .map((o, k) => [o, k])
        .sort((a, b2) => cost(a[0]) - cost(b2[0]) || a[1] - b2[1])
        .map((pair) => pair[0]);
    }
    for (const [gx, gy] of branchOutcomes) {
      apply(i, dc, x, gx, y, gy);
      if (greedy) return; // one straight-line descent, first branch only
    }
  }

  function apply(i, dc, x, gx, y, gy) {
    // The auto-resolve branches call this with the away side first, so record
    // the points in fixed (home, away) order rather than argument order.
    path[i] = x === G[i][0] ? [gx, gy] : [gy, gx];
    const changed = [];
    let d = 0;
    const pairs = [[x, gx], [y, gy]];
    for (const [t, g] of pairs) {
      gain[t] += g;
      if (status[t] !== OPEN) continue;
      if (isMax) {
        if (gain[t] >= need[t]) {
          status[t] = DONE;
          changed.push(t);
          d++;
        } else if (gain[t] + 3 * suffix[i + 1][t] < need[t]) {
          status[t] = OUT;
          changed.push(t);
        }
      } else if (gain[t] > capv[t]) {
        status[t] = DONE;
        changed.push(t);
        d++;
      }
    }
    rec(i + 1, dc + d);
    for (const t of changed) status[t] = OPEN;
    gain[x] -= gx;
    gain[y] -= gy;
  }

  rec(0, initialDc);

  if (bestPath === null) {
    // No leaf was ever reached: either the cap tripped first, or every leaf was
    // pruned because none could beat the starting value. Take one greedy
    // descent purely to obtain a concrete assignment. In the pruned case every
    // assignment scores the same as the starting value, so `best` is unchanged;
    // in the capped case this is a real assignment, so the reported count stays
    // an honest bound in the same direction -- and now it is realisable.
    greedy = true;
    rec(0, initialDc);
    greedy = false;
  }

  // Translate the recorded branch points into results for the input games.
  for (let i = 0; i < m; i++) {
    const k = G[i][2];
    const step = bestPath ? bestPath[i] : null;
    if (!step) outcomes[k] = "D";
    else if (step[0] > step[1]) outcomes[k] = "H";
    else if (step[0] < step[1]) outcomes[k] = "A";
    else outcomes[k] = "D";
  }

  return { count: fixedAbove + best, exact, nodes, outcomes };
}

/**
 * Best and worst possible finishing position for one team, from raw points.
 *
 * @param {string[]} teamIds
 * @param {Object} pointsById
 * @param {Array} openGames  [{home, away}] -- may involve `teamId`
 * @param {string} teamId
 * @param {{nodeCap?: number}} opts
 * @returns {{best, worst, bestExact, worstExact, nodes, bestWitness, worstWitness}}
 *   The two witnesses are arrays parallel to `openGames`: assignments of every
 *   open game that actually produce the reported `best` / `worst` position.
 */
export function bestWorstFromPoints(teamIds, pointsById, openGames, teamId, opts = {}) {
  const cap = opts.nodeCap === undefined ? DEFAULT_NODE_CAP : opts.nodeCap;

  // BEST: T wins everything left; rivals must beat its total outright.
  const Pb = { ...pointsById };
  // WORST: T loses everything left; every opponent banks the 3 points.
  const Pw = { ...pointsById };
  const openNoT = [];
  const noTIndex = []; // input index of each game handed to the solver
  const bestWitness = new Array(openGames.length);
  const worstWitness = new Array(openGames.length);
  for (let k = 0; k < openGames.length; k++) {
    const g = openGames[k];
    if (g.home === teamId || g.away === teamId) {
      const tIsHome = g.home === teamId;
      Pb[teamId] = (Pb[teamId] || 0) + 3;
      Pw[tIsHome ? g.away : g.home] = (Pw[tIsHome ? g.away : g.home] || 0) + 3;
      // The conventions made concrete: T wins all of them for BEST, loses all
      // of them for WORST.
      bestWitness[k] = tIsHome ? "H" : "A";
      worstWitness[k] = tIsHome ? "A" : "H";
    } else {
      noTIndex.push(k);
      openNoT.push(g);
    }
  }

  const rb = countTeamsReaching(teamIds, Pb, openNoT, teamId, (Pb[teamId] || 0) + 1, "min", cap);
  const rw = countTeamsReaching(teamIds, Pw, openNoT, teamId, Pw[teamId] || 0, "max", cap);
  for (let j = 0; j < noTIndex.length; j++) {
    bestWitness[noTIndex[j]] = rb.outcomes[j];
    worstWitness[noTIndex[j]] = rw.outcomes[j];
  }

  return {
    best: 1 + rb.count,
    worst: 1 + rw.count,
    bestExact: rb.exact,
    worstExact: rw.exact,
    nodes: { best: rb.nodes, worst: rw.nodes },
    bestWitness,
    worstWitness,
  };
}

/**
 * Best/worst plus derived flags for every team, from the season data + picks.
 *
 * Each `byId[team]` also carries `bestWitness` / `worstWitness`: objects
 * `{ [gameId]: "H"|"D"|"A" }` covering exactly the undecided games, which
 * realise the reported position when merged over the current picks.
 *
 * @returns {{byId: Object, totalNodes: number, ms: number}}
 */
export function computeScenarios(teams, games, picks, opts = {}) {
  const t0 = now();
  const cap = opts.nodeCap === undefined ? DEFAULT_NODE_CAP : opts.nodeCap;
  const playoffSpots = opts.playoffSpots === undefined ? 8 : opts.playoffSpots;

  const teamIds = teams.map((t) => t.id);
  const pointsById = Object.create(null);
  for (const id of teamIds) pointsById[id] = 0;

  const resolved = resolveGames(games, picks);
  const openGames = [];
  for (const g of resolved) {
    if (!g.decided) {
      openGames.push({ id: g.id, home: g.home, away: g.away });
      continue;
    }
    if (g.result === "H") pointsById[g.home] += 3;
    else if (g.result === "A") pointsById[g.away] += 3;
    else {
      pointsById[g.home] += 1;
      pointsById[g.away] += 1;
    }
  }

  const byId = {};
  let totalNodes = 0;
  for (const id of teamIds) {
    const r = bestWorstFromPoints(teamIds, pointsById, openGames, id, { nodeCap: cap });
    totalNodes += r.nodes.best + r.nodes.worst;
    // Witnesses keyed by game id for the app; only undecided games appear, so a
    // witness can never overwrite a locked pick or a played result.
    const bestWitness = {};
    const worstWitness = {};
    for (let k = 0; k < openGames.length; k++) {
      bestWitness[openGames[k].id] = r.bestWitness[k];
      worstWitness[openGames[k].id] = r.worstWitness[k];
    }
    byId[id] = {
      best: r.best,
      worst: r.worst,
      bestExact: r.bestExact,
      worstExact: r.worstExact,
      bestWitness,
      worstWitness,
      // Flags are only claimed when the underlying bound is exact.
      flags: {
        clinchedPlayoffs: r.worstExact && r.worst <= playoffSpots,
        eliminated: r.bestExact && r.best > playoffSpots,
        clinchedShield: r.worstExact && r.worst === 1,
        cannotWinShield: r.bestExact && r.best > 1,
      },
    };
  }

  return { byId, totalNodes, ms: now() - t0 };
}
