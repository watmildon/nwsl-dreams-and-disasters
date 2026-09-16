#!/usr/bin/env python3
"""Fetch the NWSL regular-season schedule from ESPN and write data/season.json.

Standard library only (no pip install step in CI).  Python 3.9+ compatible.

    python3 scripts/update_data.py                 # fetch, validate, write if changed
    python3 scripts/update_data.py --dry-run       # fetch, validate, print summary, write nothing
    python3 scripts/update_data.py --input FILE    # use a saved ESPN JSON dump instead of fetching
    python3 scripts/update_data.py --output PATH   # default <repo>/data/season.json
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

SEASON_YEAR = 2026
LEAGUE = "NWSL"
# A bare season year returns the whole regular season in one response.  The
# YYYYMMDD-YYYYMMDD range form this used to send started returning HTTP 400 from
# ESPN on 2026-09-15; the year form is both working and simpler to maintain.
ESPN_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard"
    "?dates={y}&limit=1000".format(y=SEASON_YEAR)
)
SOURCE_NAME = "ESPN"
USER_AGENT = "nwsl-dreams-and-disasters (github.com/watmildon)"

GAMES_PER_TEAM = 30
PLAYOFF_SPOTS = 8
TEAM_COUNT = 16
TOTAL_GAMES = 240

# The schedule is not guaranteed to stay at exactly 240 games all season: a
# fixture can vanish from ESPN's feed, or reappear under a new event id. A hard
# equality check would turn one such wobble into a nightly failure for the rest
# of the season, so counts below the nominal figure are tolerated within these
# margins and only reported as warnings. Counts ABOVE it are still errors --
# that means duplicate fixtures the dedupe step failed to collapse.
MIN_TOTAL_GAMES = TOTAL_GAMES - 4
MIN_GAMES_PER_TEAM = GAMES_PER_TEAM - 2

# Team metadata is hardcoded on purpose: ESPN's names, colors and logo URLs are
# not used anywhere in this project (its colors in particular are unreliable).
TEAMS = {
    "BAY": ("Bay FC", "Bay FC", "assets/logos/BAY-2024.png", "#1A3C5E"),
    "BOS": ("Boston Legacy FC", "Boston", "assets/logos/BOS-2026.png", "#002244"),
    "CHI": ("Chicago Stars FC", "Chicago", "assets/logos/CHI-2024.png", "#C8102E"),
    "DEN": ("Denver Summit FC", "Denver", "assets/logos/DEN-2026.png", "#006D6F"),
    "GFC": ("Gotham FC", "Gotham", "assets/logos/NJY-2021.png", "#0C2340"),
    "HOU": ("Houston Dash", "Houston", "assets/logos/HOU-2021.png", "#F26722"),
    "KC": ("Kansas City Current", "Kansas City", "assets/logos/KC-2022.png", "#7A2048"),
    "LA": ("Angel City FC", "Angel City", "assets/logos/LA-2022.png", "#000000"),
    "LOU": ("Racing Louisville FC", "Louisville", "assets/logos/LOU-2021.png", "#7B2481"),
    "NC": ("North Carolina Courage", "North Carolina", "assets/logos/NC-2017.png", "#003DA5"),
    "ORL": ("Orlando Pride", "Orlando", "assets/logos/ORL-2016.png", "#633492"),
    "POR": ("Portland Thorns FC", "Portland", "assets/logos/POR-2018.png", "#A4162F"),
    "SD": ("San Diego Wave FC", "San Diego", "assets/logos/SD-2022.png", "#003DA5"),
    "SEA": ("Seattle Reign FC", "Seattle", "assets/logos/SEA-2024.png", "#862633"),
    "UTA": ("Utah Royals FC", "Utah", "assets/logos/UTA-2024.png", "#FFD700"),
    "WAS": ("Washington Spirit", "Washington", "assets/logos/WAS-2023.png", "#C8102E"),
}

# ESPN status.type.name -> normalised status.  `played` means decided; `scheduled`
# and `other` are both still-to-be-played as far as the calculator is concerned.
SCHEDULED_NAMES = {
    "STATUS_SCHEDULED",
    "STATUS_IN_PROGRESS",
    "STATUS_FIRST_HALF",
    "STATUS_HALFTIME",
    "STATUS_SECOND_HALF",
    "STATUS_END_PERIOD",
    "STATUS_DELAYED",
}
OTHER_NAMES = {
    "STATUS_POSTPONED",
    "STATUS_CANCELED",
    "STATUS_SUSPENDED",
    "STATUS_ABANDONED",
}
COMPLETED_NAMES = {"STATUS_FULL_TIME", "STATUS_FINAL"}

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUTPUT = os.path.join(REPO_ROOT, "data", "season.json")

ERRORS = []


def reset_errors():
    """Clear accumulated errors (module-level state; used by main and by tests)."""
    del ERRORS[:]


def error(msg):
    ERRORS.append(msg)
    sys.stderr.write("ERROR: %s\n" % msg)


def warn(msg):
    sys.stderr.write("WARNING: %s\n" % msg)


def fetch_payload(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_date(raw):
    """ESPN emits '2026-03-14T00:00Z'; re-emit everything with seconds."""
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%MZ"):
        try:
            return datetime.datetime.strptime(raw, fmt).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (TypeError, ValueError):
            continue
    return None


def map_status(type_name, completed):
    """-> (status, warning or None)"""
    if completed:
        if type_name in COMPLETED_NAMES:
            return "played", None
        return "played", "unexpected completed status %r" % type_name
    if type_name in SCHEDULED_NAMES:
        return "scheduled", None
    if type_name in OTHER_NAMES:
        return "other", None
    return "scheduled", "unknown status %r; treating as scheduled" % type_name


def transform(payload):
    events = [
        e
        for e in payload.get("events", [])
        if (e.get("season") or {}).get("slug") == "regular-season"
    ]
    games = []
    for ev in events:
        ev_id = str(ev.get("id"))
        date = parse_date(ev.get("date"))
        if date is None:
            error("game %s has an unparseable date %r" % (ev_id, ev.get("date")))
            continue
        comps = ev.get("competitions") or []
        if not comps:
            error("game %s has no competitions" % ev_id)
            continue
        comp = comps[0]
        home = away = None
        home_raw = away_raw = None
        for c in comp.get("competitors") or []:
            abbr = (c.get("team") or {}).get("abbreviation")
            if c.get("homeAway") == "home":
                home, home_raw = abbr, c.get("score")
            elif c.get("homeAway") == "away":
                away, away_raw = abbr, c.get("score")
        status_type = (ev.get("status") or {}).get("type") or {}
        status, msg = map_status(status_type.get("name"), bool(status_type.get("completed")))
        if msg:
            warn("game %s: %s" % (ev_id, msg))
        if status == "played":
            try:
                home_score = int(home_raw)
                away_score = int(away_raw)
            except (TypeError, ValueError):
                error("played game %s has non-integer scores %r/%r" % (ev_id, home_raw, away_raw))
                home_score = away_score = None
        else:
            # Partial scores of in-progress games are deliberately ignored: a game
            # only counts once it is at full time.
            home_score = away_score = None
        games.append(
            {
                "id": ev_id,
                "date": date,
                "home": home,
                "away": away,
                "homeScore": home_score,
                "awayScore": away_score,
                "status": status,
                "rawStatus": status_type.get("name"),
                "venue": (comp.get("venue") or {}).get("fullName") or None,
            }
        )
    return games


# Preference order when the same fixture appears twice: a played game is the
# real one; failing that a scheduled one beats a postponed/cancelled shell.
_STATUS_RANK = {"played": 2, "scheduled": 1, "other": 0}


def dedupe(games):
    """Collapse duplicate fixtures, keeping one game per ordered (home, away).

    The 240-game double round robin plays each ordered pair exactly once, so a
    repeated pair means ESPN has re-issued a fixture -- typically a postponement
    that reappears under a new, larger event id while the original lingers as
    STATUS_POSTPONED. Keeping both would double-count those teams' games.
    """
    by_pair = {}
    for g in games:
        by_pair.setdefault((g["home"], g["away"]), []).append(g)

    kept = []
    for pair, group in by_pair.items():
        if len(group) == 1:
            kept.append(group[0])
            continue
        # Best status wins; among equals the larger (newer) event id wins.
        group = sorted(group, key=lambda g: (_STATUS_RANK.get(g["status"], -1), int(g["id"])))
        winner = group[-1]
        if sum(1 for g in group if g["status"] == "played") > 1:
            error("duplicate fixture %s v %s has more than one played game: %s"
                  % (pair[0], pair[1], ", ".join(g["id"] for g in group)))
        for loser in group[:-1]:
            warn("duplicate fixture %s v %s: keeping %s (%s), dropping %s (%s)"
                 % (pair[0], pair[1], winner["id"], winner["status"], loser["id"], loser["status"]))
        kept.append(winner)
    return kept


def validate(games):
    appearing = {g["home"] for g in games} | {g["away"] for g in games}
    unknown = sorted((a for a in appearing if a not in TEAMS), key=str)
    if unknown:
        error("unknown team abbreviations: %s" % ", ".join(str(a) for a in unknown))

    if len(games) > TOTAL_GAMES:
        error("expected at most %d regular-season games, got %d (duplicate fixtures?)"
              % (TOTAL_GAMES, len(games)))
    elif len(games) < MIN_TOTAL_GAMES:
        error("expected at least %d regular-season games, got %d"
              % (MIN_TOTAL_GAMES, len(games)))
    elif len(games) != TOTAL_GAMES:
        warn("%d regular-season games, expected %d; the schedule may have changed"
             % (len(games), TOTAL_GAMES))

    seen = set()
    for g in games:
        if g["id"] in seen:
            error("duplicate game id %s" % g["id"])
        seen.add(g["id"])
        if g["home"] == g["away"]:
            error("game %s has the same team home and away (%s)" % (g["id"], g["home"]))
        if g["status"] == "played":
            for key in ("homeScore", "awayScore"):
                v = g[key]
                if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                    error("played game %s has a bad %s: %r" % (g["id"], key, v))
        else:
            if g["homeScore"] is not None or g["awayScore"] is not None:
                error("unplayed game %s carries scores" % g["id"])

    if len(appearing) != TEAM_COUNT:
        error("expected %d distinct teams, got %d (%s)"
              % (TEAM_COUNT, len(appearing), ", ".join(sorted(str(a) for a in appearing))))

    counts = {}
    home_counts = {}
    for g in games:
        counts[g["home"]] = counts.get(g["home"], 0) + 1
        counts[g["away"]] = counts.get(g["away"], 0) + 1
        home_counts[g["home"]] = home_counts.get(g["home"], 0) + 1
    over = {t: n for t, n in counts.items() if n > GAMES_PER_TEAM}
    under = {t: n for t, n in counts.items() if n < MIN_GAMES_PER_TEAM}
    light = {t: n for t, n in counts.items() if MIN_GAMES_PER_TEAM <= n < GAMES_PER_TEAM}
    if over:
        error("teams playing more than %d games: %s" % (GAMES_PER_TEAM, over))
    if under:
        error("teams playing fewer than %d games: %s" % (MIN_GAMES_PER_TEAM, under))
    if over or under:
        sys.stderr.write("       per-team counts: %s\n" % json.dumps(counts, sort_keys=True))
    elif light:
        warn("teams with fewer than %d games (tolerated): %s" % (GAMES_PER_TEAM, light))
    for team in sorted(counts):
        h = home_counts.get(team, 0)
        if h * 2 != counts[team]:
            warn("%s has %d home / %d away games (expected an even split)"
                 % (team, h, counts[team] - h))

    return not ERRORS


def check_against_previous(games, previous):
    """Results already recorded must never disappear.

    The count tolerances above let a *future* fixture vanish from the feed
    (cancelled, or briefly missing) without failing the nightly run. They would
    also wave through a truncated or partial response that silently drops games
    already played, which would rewrite history. Anything that was `played` in
    the file we are about to overwrite has to still be there, and still played.
    """
    if not previous:
        return
    old_played = {
        g["id"]: g
        for g in previous.get("games", [])
        if isinstance(g, dict) and g.get("status") == "played"
    }
    if not old_played:
        return
    new_by_id = {g["id"]: g for g in games}
    missing = []
    unplayed = []
    for gid in sorted(old_played, key=lambda x: int(x) if str(x).isdigit() else 0):
        fresh = new_by_id.get(gid)
        if fresh is None:
            missing.append(gid)
        elif fresh["status"] != "played":
            unplayed.append("%s (now %s)" % (gid, fresh["status"]))
    if missing:
        error("%d game(s) already recorded as played are absent from the feed: %s"
              % (len(missing), ", ".join(missing[:10]) + (" ..." if len(missing) > 10 else "")))
    if unplayed:
        error("%d game(s) already recorded as played are no longer played: %s"
              % (len(unplayed), ", ".join(unplayed[:10]) + (" ..." if len(unplayed) > 10 else "")))


def build_object(games, last_updated):
    teams = [
        {"id": tid, "name": meta[0], "short": meta[1], "logo": meta[2], "color": meta[3]}
        for tid, meta in sorted(TEAMS.items())
    ]
    return {
        "season": {
            "year": SEASON_YEAR,
            "league": LEAGUE,
            "teamCount": TEAM_COUNT,
            "gamesPerTeam": GAMES_PER_TEAM,
            # The real count, not the nominal 240: the UI reports "N of M games
            # played" from this, so it must match games[].
            "totalGames": len(games),
            "playoffSpots": PLAYOFF_SPOTS,
            "lastUpdated": last_updated,
            "source": ESPN_URL,
            "sourceName": SOURCE_NAME,
        },
        "teams": teams,
        "games": sorted(games, key=lambda g: int(g["id"])),
    }


def without_timestamp(obj):
    """A copy with season.lastUpdated stripped, for change detection."""
    clone = json.loads(json.dumps(obj))
    clone.get("season", {}).pop("lastUpdated", None)
    return clone


def summarise(games):
    by_status = {}
    for g in games:
        by_status[g["status"]] = by_status.get(g["status"], 0) + 1
    played = by_status.get("played", 0)
    open_games = len(games) - played
    pts = {}
    for g in games:
        if g["status"] != "played":
            continue
        h, a = g["home"], g["away"]
        pts.setdefault(h, 0)
        pts.setdefault(a, 0)
        if g["homeScore"] > g["awayScore"]:
            pts[h] += 3
        elif g["homeScore"] < g["awayScore"]:
            pts[a] += 3
        else:
            pts[h] += 1
            pts[a] += 1
    top = sorted(pts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    print("Games: %d total (%s); %d open."
          % (len(games), ", ".join("%s %d" % (k, by_status[k]) for k in sorted(by_status)), open_games))
    print("Top 3 by points: %s" % ", ".join("%s %d" % (t, p) for t, p in top))
    return played, open_games


def write_atomic(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Refresh data/season.json from ESPN.")
    parser.add_argument("--dry-run", action="store_true", help="validate and summarise, write nothing")
    parser.add_argument("--input", help="read a saved ESPN JSON dump instead of fetching")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="output path (default: data/season.json)")
    args = parser.parse_args(argv)
    reset_errors()

    if args.input:
        try:
            with open(args.input, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
        except Exception as exc:  # noqa: BLE001 - any failure is fatal
            sys.stderr.write("ERROR: could not read %s: %s\n" % (args.input, exc))
            return 1
    else:
        try:
            payload = fetch_payload(ESPN_URL)
        except Exception as exc:  # noqa: BLE001 - urllib raises many types
            sys.stderr.write("ERROR: could not fetch %s: %s\n" % (ESPN_URL, exc))
            return 1

    games = dedupe(transform(payload))

    previous = None
    if os.path.exists(args.output):
        try:
            with open(args.output, "r", encoding="utf-8") as fh:
                previous = json.load(fh)
        except Exception:  # noqa: BLE001 - a corrupt file just means "no baseline"
            previous = None

    ok = validate(games)
    check_against_previous(games, previous)
    if not ok or ERRORS:
        sys.stderr.write("ERROR: validation failed (%d problem(s)); nothing written.\n" % len(ERRORS))
        return 1

    played, open_games = summarise(games)

    # Build and serialise even for --dry-run, so a dry run exercises the whole
    # pipeline (including anything that could only fail at serialisation time)
    # and not just the fetch and the validators.
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    obj = build_object(games, now)
    text = json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False) + "\n"

    if args.dry_run:
        print("Dry run; would write %d bytes to %s. Not writing." % (len(text.encode("utf-8")), args.output))
        return 0

    if previous is not None and without_timestamp(previous) == without_timestamp(obj):
        print("No change (%d played, %d open); not writing." % (played, open_games))
        return 0

    write_atomic(args.output, text)
    print("Wrote %s (%d played, %d open)." % (args.output, played, open_games))
    return 0


if __name__ == "__main__":
    sys.exit(main())
