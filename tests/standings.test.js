import assert from "node:assert/strict";
import { computeStandings, resolveGames } from "../js/engine/standings.js";

const TEAMS = ["A", "B", "C", "D"].map((id) => ({ id }));

let seq = 0;
function played(home, away, hs, as) {
  return { id: "p" + ++seq, home, away, homeScore: hs, awayScore: as, status: "played", date: "2026-05-01T00:00:00Z", venue: null };
}
function open(id, home, away) {
  return { id, home, away, homeScore: null, awayScore: null, status: "scheduled", date: "2026-10-01T00:00:00Z", venue: null };
}
// A win expressed as a played game with a nominal 1-0 scoreline.
const beat = (h, a) => played(h, a, 1, 0);

function shape(rows) {
  return rows.map((r) => [r.rank, r.tied, r.id]);
}

export const tests = [
  {
    name: "standings R1 basic: winless teams share rank 2",
    fn() {
      const { rows, byId } = computeStandings(TEAMS, [played("A", "B", 1, 0)], {});
      assert.deepEqual(shape(rows), [
        [1, false, "A"],
        [2, true, "B"],
        [2, true, "C"],
        [2, true, "D"],
      ]);
      assert.equal(byId.B.tiedCount, 3);
      assert.equal(byId.A.tiedCount, 1);
      // B's negative goal difference is irrelevant under points-only ranking.
      assert.equal(byId.B.pts, 0);
      assert.equal(byId.C.pts, 0);
    },
  },
  {
    name: "standings R2 shared rank in the middle (1, 2, 2, 4)",
    fn() {
      const games = [
        beat("A", "D"), beat("A", "B"), beat("A", "C"),
        beat("B", "D"), beat("B", "C"),
        beat("C", "D"), beat("C", "B"),
        beat("D", "B"),
      ];
      const { rows, byId } = computeStandings(TEAMS, games, {});
      assert.deepEqual([byId.A.pts, byId.B.pts, byId.C.pts, byId.D.pts], [9, 6, 6, 3]);
      assert.deepEqual(shape(rows), [
        [1, false, "A"],
        [2, true, "B"],
        [2, true, "C"],
        [4, false, "D"],
      ]);
      assert.equal(byId.B.tiedCount, 2);
      assert.equal(byId.C.tiedCount, 2);
      assert.equal(byId.D.tiedCount, 1);
    },
  },
  {
    name: "standings R3 display order inside a tie is by team id",
    fn() {
      // C beat B head-to-head and has the better goal difference; neither
      // matters -- B still lists first because its id sorts first.
      const games = [played("C", "B", 5, 0), played("B", "C", 1, 0)];
      const { rows } = computeStandings(TEAMS, games, {});
      assert.deepEqual(shape(rows), [
        [1, true, "B"],
        [1, true, "C"],
        [3, true, "A"],
        [3, true, "D"],
      ]);
    },
  },
  {
    name: "standings R4 draws: everyone level on 1 point",
    fn() {
      const { rows, byId } = computeStandings(TEAMS, [played("A", "B", 2, 2), played("C", "D", 0, 0)], {});
      assert.deepEqual(shape(rows), [
        [1, true, "A"],
        [1, true, "B"],
        [1, true, "C"],
        [1, true, "D"],
      ]);
      for (const id of ["A", "B", "C", "D"]) {
        assert.equal(byId[id].pts, 1);
        assert.equal(byId[id].tiedCount, 4);
        assert.equal(byId[id].d, 1);
      }
    },
  },
  {
    name: "standings R5 picks drive W/D/L; picks on played games are ignored",
    fn() {
      const g1 = played("A", "B", 1, 0);
      const g2 = open("g2", "C", "D");
      const games = [g1, g2];

      const none = computeStandings(TEAMS, games, {}).byId;
      assert.deepEqual(
        [none.C.gp, none.C.remaining, none.D.gp, none.D.remaining],
        [0, 1, 0, 1]
      );

      const h = computeStandings(TEAMS, games, { g2: "H" }).byId;
      assert.deepEqual({ gp: h.C.gp, w: h.C.w, d: h.C.d, l: h.C.l, pts: h.C.pts }, { gp: 1, w: 1, d: 0, l: 0, pts: 3 });
      assert.deepEqual({ gp: h.D.gp, w: h.D.w, d: h.D.d, l: h.D.l, pts: h.D.pts }, { gp: 1, w: 0, d: 0, l: 1, pts: 0 });

      const d = computeStandings(TEAMS, games, { g2: "D" }).byId;
      assert.deepEqual([d.C.d, d.C.pts, d.D.d, d.D.pts], [1, 1, 1, 1]);

      const a = computeStandings(TEAMS, games, { g2: "A" }).byId;
      assert.deepEqual([a.D.w, a.D.pts, a.C.l, a.C.pts], [1, 3, 1, 0]);

      // A pick on an already-played game must not change anything.
      const ignored = computeStandings(TEAMS, games, { [g1.id]: "A" }).byId;
      assert.equal(ignored.A.pts, 3);
      assert.equal(ignored.B.pts, 0);

      const resolved = resolveGames(games, { g2: "D", [g1.id]: "A" });
      assert.deepEqual(
        { result: resolved[0].result, source: resolved[0].source, homeScore: resolved[0].homeScore, awayScore: resolved[0].awayScore, decided: resolved[0].decided },
        { result: "H", source: "played", homeScore: 1, awayScore: 0, decided: true }
      );
      assert.deepEqual(
        { result: resolved[1].result, source: resolved[1].source, homeScore: resolved[1].homeScore, awayScore: resolved[1].awayScore, decided: resolved[1].decided },
        { result: "D", source: "pick", homeScore: null, awayScore: null, decided: true }
      );
      const noPick = resolveGames(games, {})[1];
      assert.deepEqual({ result: noPick.result, source: noPick.source, decided: noPick.decided }, { result: null, source: "open", decided: false });
    },
  },
  {
    name: "standings R6 rank numbering after a tie at the top (1, 1, 3)",
    fn() {
      const teams = ["A", "B", "C"].map((id) => ({ id }));
      // A and B on 6, C on 3.
      const games = [beat("A", "C"), beat("A", "C"), beat("B", "C"), beat("B", "C"), beat("C", "A")];
      const { rows, byId } = computeStandings(teams, games, {});
      assert.deepEqual([byId.A.pts, byId.B.pts, byId.C.pts], [6, 6, 3]);
      assert.deepEqual(shape(rows), [
        [1, true, "A"],
        [1, true, "B"],
        [3, false, "C"],
      ]);
    },
  },
];
