// Points-only standings.
//
// Deliberately simple: teams are ranked by points alone and teams level on
// points share a rank (displayed "T3").  NWSL's official secondary tiebreakers
// (goal difference, wins, goals scored, head-to-head, disciplinary points) are
// NOT modelled -- picks carry no scores, so there is nothing honest to break a
// tie with.  If tiebreakers are ever wanted, this file is the only place to
// change.

import { POINTS, PICK_VALUES } from "./constants.js";

/**
 * Merge real results and user picks into one decided/undecided view of a game.
 *
 * @param {Array} games   raw games from season.json
 * @param {Object} picks  { [gameId]: "H" | "D" | "A" }
 * @returns {Array} same order as `games`
 */
export function resolveGames(games, picks) {
  const p = picks || {};
  return games.map((g) => {
    const base = {
      id: g.id,
      home: g.home,
      away: g.away,
      date: g.date,
      status: g.status,
      venue: g.venue === undefined ? null : g.venue,
    };
    if (g.status === "played") {
      // Real scores are kept for display only; they never affect ranking.
      const hs = g.homeScore;
      const as = g.awayScore;
      const result = hs > as ? "H" : hs === as ? "D" : "A";
      return { ...base, result, homeScore: hs, awayScore: as, decided: true, source: "played" };
    }
    const pick = p[g.id];
    if (PICK_VALUES.includes(pick)) {
      return { ...base, result: pick, homeScore: null, awayScore: null, decided: true, source: "pick" };
    }
    return { ...base, result: null, homeScore: null, awayScore: null, decided: false, source: "open" };
  });
}

/**
 * Points table from played games plus the user's picks.
 *
 * @returns {{rows: Array, byId: Object}} rows ordered by rank; each row is
 *   { id, gp, w, d, l, pts, remaining, rank, tied, tiedCount }
 */
export function computeStandings(teams, games, picks) {
  const rows = new Map();
  for (const t of teams) {
    rows.set(t.id, { id: t.id, gp: 0, w: 0, d: 0, l: 0, pts: 0, remaining: 0, rank: 0, tied: false, tiedCount: 1 });
  }

  for (const g of resolveGames(games, picks)) {
    const home = rows.get(g.home);
    const away = rows.get(g.away);
    if (!home || !away) continue; // ignore games referencing unknown teams
    if (!g.decided) {
      home.remaining += 1;
      away.remaining += 1;
      continue;
    }
    home.gp += 1;
    away.gp += 1;
    if (g.result === "H") {
      home.w += 1;
      home.pts += POINTS.win;
      away.l += 1;
      away.pts += POINTS.loss;
    } else if (g.result === "A") {
      away.w += 1;
      away.pts += POINTS.win;
      home.l += 1;
      home.pts += POINTS.loss;
    } else {
      home.d += 1;
      away.d += 1;
      home.pts += POINTS.draw;
      away.pts += POINTS.draw;
    }
  }

  // Points descending; ties broken by team id purely so the display order is
  // stable -- it carries no sporting meaning.
  const ordered = [...rows.values()].sort((a, b) => b.pts - a.pts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Walk runs of equal points: every team in a run of size k gets the same
  // rank, and the next run starts at pos + k (so 1, 2, 2, 4).
  let pos = 1;
  let i = 0;
  while (i < ordered.length) {
    let j = i;
    while (j < ordered.length && ordered[j].pts === ordered[i].pts) j++;
    const k = j - i;
    for (let x = i; x < j; x++) {
      ordered[x].rank = pos;
      ordered[x].tied = k > 1;
      ordered[x].tiedCount = k;
    }
    pos += k;
    i = j;
  }

  return { rows: ordered, byId: Object.fromEntries(ordered.map((r) => [r.id, r])) };
}
