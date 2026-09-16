import assert from "node:assert/strict";
import { OUTCOMES, nextOutcome, outcomeFor, pickFor } from "../js/engine/perspective.js";

const GAME = { id: "g1", home: "SEA", away: "POR" };

export const tests = [
  {
    name: "perspective outcomeFor maps H/D/A from both sides",
    fn() {
      assert.equal(outcomeFor(GAME, "SEA", "H"), "W");
      assert.equal(outcomeFor(GAME, "SEA", "D"), "D");
      assert.equal(outcomeFor(GAME, "SEA", "A"), "L");
      assert.equal(outcomeFor(GAME, "SEA", undefined), "");

      assert.equal(outcomeFor(GAME, "POR", "H"), "L");
      assert.equal(outcomeFor(GAME, "POR", "D"), "D");
      assert.equal(outcomeFor(GAME, "POR", "A"), "W");
      assert.equal(outcomeFor(GAME, "POR", undefined), "");

      // A team that is not in the game, and junk input.
      assert.equal(outcomeFor(GAME, "GFC", "H"), "");
      assert.equal(outcomeFor(GAME, "SEA", "X"), "");
      assert.equal(outcomeFor(null, "SEA", "H"), "");
    },
  },
  {
    name: "perspective pickFor inverts outcomeFor",
    fn() {
      for (const team of ["SEA", "POR"]) {
        for (const o of OUTCOMES) {
          const pick = pickFor(GAME, team, o);
          assert.equal(outcomeFor(GAME, team, pick), o, `${team} round trip for ${o || "(blank)"}`);
        }
      }
      // Explicit home/away mapping, so the round trip cannot hide a swap.
      assert.equal(pickFor(GAME, "SEA", "W"), "H");
      assert.equal(pickFor(GAME, "SEA", "L"), "A");
      assert.equal(pickFor(GAME, "POR", "W"), "A");
      assert.equal(pickFor(GAME, "POR", "L"), "H");
      assert.equal(pickFor(GAME, "SEA", "D"), "D");
      assert.equal(pickFor(GAME, "SEA", ""), "");

      assert.equal(pickFor(GAME, "XXX", "W"), "");
      assert.equal(pickFor(GAME, "SEA", "Z"), "");
    },
  },
  {
    name: "perspective nextOutcome cycles blank -> W -> D -> L -> blank",
    fn() {
      assert.equal(nextOutcome(""), "W");
      assert.equal(nextOutcome("W"), "D");
      assert.equal(nextOutcome("D"), "L");
      assert.equal(nextOutcome("L"), "");
      assert.equal(nextOutcome("nonsense"), "W");
      assert.equal(nextOutcome(undefined), "W");
    },
  },
  {
    name: "perspective both sides of a game always agree",
    fn() {
      // Cycling one team's chip must leave the opponent's chip consistent --
      // this is what lets the grid render both rows from the same picks object.
      let outcome = "";
      for (let step = 0; step < 8; step++) {
        outcome = nextOutcome(outcome);
        const pick = pickFor(GAME, "SEA", outcome);
        const mirror = outcomeFor(GAME, "POR", pick);
        const expected = { W: "L", L: "W", D: "D", "": "" }[outcome];
        assert.equal(mirror, expected, `SEA ${outcome || "(blank)"} -> POR ${expected || "(blank)"}`);
      }
    },
  },
];
