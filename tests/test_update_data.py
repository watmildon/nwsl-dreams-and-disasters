"""Unit tests for scripts/update_data.py — run with: python3 -m unittest discover -s tests

Deliberately small: it covers the parts of the pipeline that protect the nightly
job from a schedule change (dedupe and the count tolerances), not the whole
script. The data-file invariants are checked by `node tests/run.js`.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

import update_data as ud  # noqa: E402


def game(gid, home, away, status="scheduled", hs=None, aw=None):
    return {
        "id": str(gid),
        "date": "2026-10-01T00:00:00Z",
        "home": home,
        "away": away,
        "homeScore": hs,
        "awayScore": aw,
        "status": status,
        "rawStatus": "STATUS_SCHEDULED",
        "venue": None,
    }


def full_season(**overrides):
    """A valid 240-game double round robin over the 16 real team ids."""
    teams = sorted(ud.TEAMS)
    games = []
    gid = 401850000
    for home in teams:
        for away in teams:
            if home == away:
                continue
            games.append(game(gid, home, away))
            gid += 1
    assert len(games) == 240
    return games


def drop_spread(n):
    """Remove n games chosen so that no single team loses more than one."""
    games = full_season()
    dropped = []
    touched = set()
    for g in games:
        if len(dropped) == n:
            break
        if g["home"] in touched or g["away"] in touched:
            continue
        touched.add(g["home"])
        touched.add(g["away"])
        dropped.append(g)
    assert len(dropped) == n, "could not spread %d drops" % n
    return [g for g in games if g not in dropped]


class DedupeTests(unittest.TestCase):
    def test_leaves_unique_fixtures_alone(self):
        games = [game(1, "SEA", "POR"), game(2, "POR", "SEA")]
        self.assertEqual(len(ud.dedupe(games)), 2)

    def test_reissued_fixture_collapses_to_the_new_scheduled_one(self):
        # The real failure mode: a postponement lingers under its old id while
        # the rematch appears under a new, larger one.
        old = game(401854084, "DEN", "BAY", status="other")
        new = game(402754084, "DEN", "BAY", status="scheduled")
        kept = ud.dedupe([old, new])
        self.assertEqual([g["id"] for g in kept], ["402754084"])

    def test_played_beats_scheduled_regardless_of_id(self):
        played = game(1, "SEA", "POR", status="played", hs=2, aw=1)
        ghost = game(999, "SEA", "POR", status="scheduled")
        kept = ud.dedupe([ghost, played])
        self.assertEqual([g["id"] for g in kept], ["1"])

    def test_ties_break_on_the_larger_id(self):
        kept = ud.dedupe([game(5, "SEA", "POR"), game(7, "SEA", "POR")])
        self.assertEqual([g["id"] for g in kept], ["7"])

    def test_dedupe_rescues_an_otherwise_invalid_season(self):
        games = full_season()
        dup = dict(games[0])
        dup["id"] = str(int(dup["id"]) + 900000)
        games[0] = dict(games[0], status="other")
        ud.reset_errors()
        self.assertFalse(ud.validate(games + [dup]), "241 games must not validate")
        ud.reset_errors()
        self.assertTrue(ud.validate(ud.dedupe(games + [dup])), "dedupe makes it valid again")


class ToleranceTests(unittest.TestCase):
    def setUp(self):
        ud.reset_errors()

    def test_exact_season_validates(self):
        self.assertTrue(ud.validate(full_season()))

    def test_a_few_missing_games_are_tolerated(self):
        # A fixture vanishing from the feed must not break the nightly run.
        self.assertTrue(ud.validate(full_season()[:-1]), "239 games should validate")
        ud.reset_errors()
        # Four gone, spread over eight different teams so no team falls below 28.
        self.assertTrue(ud.validate(drop_spread(4)), "236 games should validate")

    def test_too_many_missing_games_is_an_error(self):
        self.assertFalse(ud.validate(drop_spread(5)), "235 games must not validate")

    def test_one_team_missing_too_many_games_is_an_error(self):
        # The per-team floor bites even while the total is still in tolerance:
        # these four all involve the same home team.
        games = full_season()
        victim = games[-1]["home"]
        drop = [g for g in games if g["home"] == victim][:4]
        self.assertFalse(ud.validate([g for g in games if g not in drop]))

    def test_extra_games_for_one_team_is_an_error(self):
        games = full_season()
        extra = dict(games[0])
        extra["id"] = "999999999"
        extra["away"] = "LOU" if games[0]["away"] != "LOU" else "CHI"
        self.assertFalse(ud.validate(games + [extra]))

    def test_unknown_team_is_an_error(self):
        games = full_season()
        games[0] = dict(games[0], home="ZZZ")
        self.assertFalse(ud.validate(games))


class PreviousFileGuardTests(unittest.TestCase):
    """Results already recorded must survive; future fixtures may come and go."""

    def setUp(self):
        ud.reset_errors()
        self.games = full_season()
        # Pretend the first 100 games have been played.
        for g in self.games[:100]:
            g["status"] = "played"
            g["homeScore"] = 1
            g["awayScore"] = 0
        self.previous = ud.build_object(self.games, "2026-09-14T06:00:00Z")

    def test_identical_feed_passes(self):
        ud.check_against_previous(self.games, self.previous)
        self.assertEqual(ud.ERRORS, [])

    def test_missing_scheduled_game_is_not_an_error(self):
        # A future fixture vanishing is tolerated (it may have been cancelled).
        fresh = [g for g in self.games if g["status"] != "played"][1:]
        fresh = [g for g in self.games if g["status"] == "played"] + fresh
        ud.check_against_previous(fresh, self.previous)
        self.assertEqual(ud.ERRORS, [])

    def test_missing_played_game_is_an_error(self):
        # A truncated feed that drops a recorded result would rewrite history.
        fresh = [g for g in self.games if g["id"] != self.games[0]["id"]]
        ud.check_against_previous(fresh, self.previous)
        self.assertEqual(len(ud.ERRORS), 1)
        self.assertIn("absent from the feed", ud.ERRORS[0])
        self.assertIn(self.games[0]["id"], ud.ERRORS[0])

    def test_played_game_reverting_to_scheduled_is_an_error(self):
        fresh = [dict(g) for g in self.games]
        fresh[0] = dict(fresh[0], status="scheduled", homeScore=None, awayScore=None)
        ud.check_against_previous(fresh, self.previous)
        self.assertEqual(len(ud.ERRORS), 1)
        self.assertIn("no longer played", ud.ERRORS[0])

    def test_no_previous_file_is_fine(self):
        ud.check_against_previous(self.games, None)
        ud.check_against_previous(self.games, {})
        self.assertEqual(ud.ERRORS, [])

    def test_first_ever_run_has_no_played_games_to_protect(self):
        empty = ud.build_object([g for g in self.games if g["status"] != "played"], "2026-03-01T00:00:00Z")
        ud.check_against_previous(self.games, empty)
        self.assertEqual(ud.ERRORS, [])


class BuildObjectTests(unittest.TestCase):
    def test_total_games_reflects_the_actual_count(self):
        games = full_season()[:-1]
        obj = ud.build_object(games, "2026-09-14T06:00:00Z")
        self.assertEqual(obj["season"]["totalGames"], 239)
        self.assertEqual(obj["season"]["totalGames"], len(obj["games"]))
        self.assertEqual(len(obj["teams"]), 16)


if __name__ == "__main__":
    unittest.main()
