import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeStandings, resolveGames } from "../js/engine/standings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const FILES = [
  ["data/season.json", path.join(ROOT, "data", "season.json")],
  ["tests/fixtures/season-2026-09-13.json", path.join(HERE, "fixtures", "season-2026-09-13.json")],
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const STATUSES = new Set(["played", "scheduled", "other"]);

// The schedule is nominally 240 games / 30 per team, but a fixture can vanish
// from ESPN's feed mid-season. scripts/update_data.py tolerates a small
// shortfall rather than failing the nightly run, so these bounds match it.
const EXPECTED_YEAR = 2026;
const NOMINAL_GAMES = 240;
const MIN_GAMES = 236;
const NOMINAL_PER_TEAM = 30;
const MIN_PER_TEAM = 28;

function checkFile(label, file) {
  assert.ok(fs.existsSync(file), `${label} exists`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));

  // --- season block -------------------------------------------------------
  const s = data.season;
  assert.equal(s.year, EXPECTED_YEAR, `${label} season.year`);
  assert.equal(s.teamCount, 16, `${label} season.teamCount`);
  assert.equal(s.gamesPerTeam, 30, `${label} season.gamesPerTeam`);
  assert.equal(s.playoffSpots, 8, `${label} season.playoffSpots`);
  assert.equal(s.totalGames, data.games.length, `${label} totalGames === games.length`);
  assert.ok(
    data.games.length >= MIN_GAMES && data.games.length <= NOMINAL_GAMES,
    `${label} game count ${data.games.length} within [${MIN_GAMES}, ${NOMINAL_GAMES}]`
  );
  assert.ok(DATE_RE.test(s.lastUpdated), `${label} lastUpdated format`);

  // --- teams --------------------------------------------------------------
  assert.equal(data.teams.length, 16, `${label} 16 teams`);
  const ids = data.teams.map((t) => t.id);
  assert.deepEqual(ids, [...ids].sort(), `${label} teams sorted by id`);
  assert.equal(new Set(ids).size, 16, `${label} team ids unique`);
  for (const t of data.teams) {
    assert.ok(t.name && t.short, `${label} ${t.id} has a name`);
    assert.ok(/^#[0-9A-F]{6}$/.test(t.color), `${label} ${t.id} color ${t.color}`);
    assert.ok(t.logo.endsWith(".png"), `${label} ${t.id} logo is a png`);
    assert.ok(fs.existsSync(path.join(ROOT, t.logo)), `${label} ${t.id} logo file ${t.logo} exists`);
  }

  // --- games --------------------------------------------------------------
  const gameIds = data.games.map((g) => g.id);
  assert.equal(new Set(gameIds).size, gameIds.length, `${label} game ids unique`);
  const numeric = data.games.map((g) => Number(g.id));
  for (let i = 1; i < numeric.length; i++) {
    assert.ok(numeric[i] > numeric[i - 1], `${label} games sorted by numeric id at index ${i}`);
  }

  const counts = new Map(ids.map((id) => [id, 0]));
  let playedCount = 0;
  let draws = 0;
  for (const g of data.games) {
    assert.ok(counts.has(g.home), `${label} game ${g.id} home ${g.home} is a known team`);
    assert.ok(counts.has(g.away), `${label} game ${g.id} away ${g.away} is a known team`);
    assert.notEqual(g.home, g.away, `${label} game ${g.id} home !== away`);
    counts.set(g.home, counts.get(g.home) + 1);
    counts.set(g.away, counts.get(g.away) + 1);
    assert.ok(STATUSES.has(g.status), `${label} game ${g.id} status ${g.status}`);
    assert.ok(DATE_RE.test(g.date), `${label} game ${g.id} date ${g.date}`);
    assert.ok(!Number.isNaN(Date.parse(g.date)), `${label} game ${g.id} date parses`);
    if (g.status === "played") {
      playedCount++;
      for (const k of ["homeScore", "awayScore"]) {
        assert.ok(Number.isInteger(g[k]) && g[k] >= 0, `${label} game ${g.id} ${k} = ${g[k]}`);
      }
      if (g.homeScore === g.awayScore) draws++;
    } else {
      assert.equal(g.homeScore, null, `${label} game ${g.id} homeScore null`);
      assert.equal(g.awayScore, null, `${label} game ${g.id} awayScore null`);
    }
  }
  for (const [id, n] of counts) {
    assert.ok(
      n >= MIN_PER_TEAM && n <= NOMINAL_PER_TEAM,
      `${label} ${id} plays ${n} games, expected ${MIN_PER_TEAM}-${NOMINAL_PER_TEAM}`
    );
  }

  // Each ordered (home, away) pair is played exactly once in a double round
  // robin; a repeat means the update script's dedupe step missed something.
  const pairs = new Set();
  for (const g of data.games) {
    const key = `${g.home}>${g.away}`;
    assert.ok(!pairs.has(key), `${label} duplicate fixture ${key}`);
    pairs.add(key);
  }

  // --- derived standings invariants ---------------------------------------
  const { rows } = computeStandings(data.teams, data.games, {});
  const sum = (f) => rows.reduce((acc, r) => acc + f(r), 0);
  assert.equal(sum((r) => r.w), sum((r) => r.l), `${label} total wins === total losses`);
  assert.equal(sum((r) => r.pts), 3 * (playedCount - draws) + 2 * draws, `${label} total points`);
  assert.equal(sum((r) => r.gp), 2 * playedCount, `${label} total games played`);
  assert.equal(sum((r) => r.d), 2 * draws, `${label} total draws`);

  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].rank >= rows[i - 1].rank, `${label} ranks non-decreasing at ${i}`);
  }
  for (const r of rows) {
    const above = rows.filter((o) => o.pts > r.pts).length;
    assert.equal(r.rank, 1 + above, `${label} ${r.id} rank === 1 + teams with more points`);
    assert.ok(r.gp + r.remaining <= NOMINAL_PER_TEAM, `${label} ${r.id} gp + remaining <= ${NOMINAL_PER_TEAM}`);
    assert.equal(r.gp + r.remaining, counts.get(r.id), `${label} ${r.id} gp + remaining === its fixture count`);
  }

  // resolveGames must mirror the file exactly.
  const resolved = resolveGames(data.games, {});
  assert.equal(resolved.filter((g) => g.decided).length, playedCount, `${label} decided === played`);
  assert.equal(resolved.length, data.games.length, `${label} resolveGames preserves length`);
}

export const tests = FILES.map(([label, file]) => ({
  name: `data invariants: ${label}`,
  fn: () => checkFile(label, file),
}));
