# Notes: running and updating the site

Working notes for this repo — how to run it locally, how the numbers are
calculated, how the data refresh works, and what to change next season.

Live: <https://watmildon.github.io/nwsl-dreams-and-disasters/>

Static HTML, CSS and ES modules. No build step, no framework, no dependencies,
no CDN — GitHub Pages serves the repository root as-is.

## Running it locally

The page fetches `data/season.json`, and browsers block `fetch` from `file://`,
so open it through a local server rather than double-clicking `index.html`:

```sh
python3 -m http.server 8000       # from the repo root
open http://localhost:8000/
```

## Views

Two tabs over one shared state — a pick made in either shows up in the other
immediately, and the focused team's card stays pinned above both.

- **Standings** — the projected table, plus each team's best and worst possible
  finish.
- **Season grid** — every team's remaining games as a row of compact chips, from
  that team's point of view. Tap a chip to cycle **win → draw → loss → clear**;
  the opponent's chip for the same game mirrors it, because both are drawn from
  the same single stored pick. The team column stays put while the chips scroll.
  Chip colour is never the only cue — each state carries its own `W`/`D`/`L`
  letter (or a blank).

The active tab is remembered, and appears in the link as `v=grid` (the default
Standings view adds nothing to the URL).

## Apply a best or worst case

Clicking a team's **Best** or **Worst** in the standings sets every still-open
game to one set of results that actually produces that finish. The solver hands
back a *witness* — a concrete assignment it found on the way to the answer — so
the number you clicked is the number you get, even in the rare case where the
search was cut short and the value shown is a bound.

There are usually many assignments that produce the same finish; you get one of
them. Games you have already picked are treated as fixed and are never
overwritten — best and worst are always computed relative to your existing
picks. The focus card's **Win out** / **Lose out** buttons do the smaller version
of the same thing for one team's own games.

Every bulk change (apply, win/lose out, and **Clear all**) shows a message with
an **Undo**, which restores the exact picks from before. Undo is one level deep
and lasts as long as that message.

## How the numbers work

Everything is computed from **points only** (3 for a win, 1 for a draw).

- **Standings.** Teams level on points share a rank, shown as `T3`. NWSL's
  official secondary tiebreakers (goal difference, wins, goals scored,
  head-to-head, disciplinary points) are deliberately *not* modelled: picks are
  results, not scores, so there would be nothing honest to break a tie with.
  Within a tie group teams are listed by team id purely so the display is
  stable. Real scores of played games are stored in `data/season.json` but are
  neither shown in the UI nor used in the ranking — only the win/draw/loss
  outcome derived from them counts.
- **Picks.** Each remaining game is a three-way choice — home win, draw, away
  win. No scores are entered or invented.
- **Best.** The team wins all of its remaining unpicked games *and* ranks ahead
  of anyone level with it on points. A rival therefore finishes above it only by
  having strictly more points.
- **Worst.** The team loses all of its remaining unpicked games *and* ranks
  behind anyone level with it on points.
- Both respect your picks: a game you have already picked is fixed, and only
  unpicked games are explored.
- **Flags.** `s` clinched the Shield, `x` clinched a playoff spot (worst finish
  ≤ 8), `e` eliminated (best finish ≥ 9). A flag is only shown when the
  underlying search finished exactly.

Finding the best/worst finish under 3-1-0 scoring is NP-hard in general, so the
solver (`js/engine/scenarios.js`) is a branch-and-bound search: it only branches
on games between teams that are still in contention for the relevant points
threshold, freezes a team the moment it has reached — or can no longer reach —
that threshold, prunes with a matching-based bound, and memoises. The real
season state needs under a thousand search nodes for all 32 runs (best + worst
for 16 teams) and finishes in a couple of milliseconds.

If a search ever exceeds its node budget it stops and reports an honest bound —
`≤3rd` or `≥9th` — rather than a wrong exact number, and all flags for that team
are suppressed.

### Caveats

- Postponed games are treated as still to be played. If the league ever
  *permanently* cancels a game, the calculator will be slightly off — it will
  keep offering it as a pickable fixture.
- In-progress games count only once they are at full time; partial scores are
  ignored.
- Disciplinary points and the coin flip (official tiebreakers 7 and 8) are not
  computable from the public data and are not attempted.

## Sharing and persistence

Your picks are saved in this browser (`localStorage`, keyed by ESPN event id)
and mirrored into the URL hash, which looks like `#s=fXGqvlEvgj52&t=SEA`.

A pick in the hash is identified by its **fixture** — the ordered `(home, away)`
pair — not by the ESPN event id. The season is a double round robin, so each
ordered pair is played exactly once (verified: 240 games, 240 distinct pairs),
and the update script's dedupe step keeps it that way. That matters because
event ids are *not* stable: ESPN re-issues a postponed fixture under a brand-new
id, and a link keyed by id loses those picks. A link keyed by fixture keeps them.

Each pick costs one 8-bit pair index plus a 2-bit result, after a 16-bit check
value. The bits are packed tight and base64url-encoded. Comparing payload with
payload, a full 50-game slate is 87 characters against the old explicit-id
format's 549, and a single pick is 6 against 10; as whole hashes including
`&t=SEA`, 95 against 557. A zero result code is never emitted, so the zero
padding in the final byte terminates the stream. Corrupt or truncated payloads
decode to fewer picks rather than throwing.

The check value covers the season scope (year plus the sorted team ids) *and*
the pick bytes, so one test rejects two different ways a link can be wrong:

- **Wrong season.** The same 16 clubs play the same 240 ordered pairs every
  year, so without this a 2026 link would apply cleanly — and wrongly — to the
  2027 schedule. Renaming a club, or adding one, is caught the same way.
  `localStorage` is already year-scoped (`nwsl-calc-<year>`); this is the
  equivalent guard for links.
- **Damage in transit.** A mangled character otherwise decodes into a different
  set of perfectly valid picks, since with 16 teams almost every 8-bit value
  names a real fixture. Over 99% of single-character corruptions are now
  rejected outright (measured in `tests/picks.test.js`).

Either way the link is refused whole rather than misapplied, and the page says
so.

Links written by the build before this change used an explicit
`#p=401854084H.401854085D` form. Those are still decoded, so old links keep
working; nothing writes that format any more.

### What happens as the data moves underneath a link

A shared link describes games that had not been played when it was made, so time
changes what it means:

- **A picked game has since been played.** The real result wins — the pick is
  dropped, because reality is not a scenario. The page counts these and says so
  once, above the table: *"3 games in this link have been played since it was
  made. The real results replaced those picks."* Without that line the link would
  quietly show different standings than its author saw, which is the failure mode
  worth avoiding.
- **A picked fixture was re-issued under a new id.** The pick survives, because
  the hash names the fixture, not the id.
- **A picked fixture vanished from the schedule.** The pick is dropped and
  counted as `unknown`, which the notice also reports — under fixture keying an
  unknown pair means a genuine mismatch between the link and the schedule.
- **The link is for another season, or arrived damaged.** The check value fails,
  no picks are applied at all, and the notice says so.
- **Unpicked games were played.** Nothing is dropped and no notice appears. The
  link still says exactly what its author meant — *if these games go this way* —
  and the newer results are correctly folded in. This is the desired behaviour,
  not drift.

`Copy link` puts the current URL on your clipboard, and pasting a scenario link
into an already-open tab reloads that scenario. A link that carries picks wins
over whatever this browser remembers.

## Data updates

`data/season.json` is generated from ESPN's public scoreboard endpoint by a
stdlib-only Python script:

```sh
python3 scripts/update_data.py                 # fetch, validate, write if anything changed
python3 scripts/update_data.py --dry-run       # fetch, validate, print a summary, write nothing
python3 scripts/update_data.py --input FILE    # use a saved ESPN dump instead of fetching
python3 scripts/update_data.py --output PATH   # write somewhere else
```

Before writing anything it first **deduplicates** fixtures — each ordered
(home, away) pair is played exactly once in a 240-game double round robin, so a
repeated pair means ESPN has re-issued a postponed match under a new event id
while the original lingers; the script keeps the real one (played beats
scheduled beats postponed, newer id breaks ties) and warns about the other.

Then it validates: known teams only, unique ids, `home != away`, scores present
exactly when a game is played, parseable dates, and sane counts. The counts are
deliberately *tolerant* — at most 240 games and at least 236, at most 30 per team
and at least 28 — because a fixture occasionally vanishes from the feed, and a
hard equality check would turn one such wobble into a nightly failure for the
rest of the season.

That tolerance is bounded by one hard rule: **results already recorded may not
disappear.** Every game that is `played` in the existing `data/season.json` must
still be present, and still played, in the incoming data. A future fixture going
missing is tolerated; a truncated or partial response that would erase a result
already in the file is rejected outright.

Shortfalls inside the margins are warnings; anything outside them, a vanished
result, or any other problem exits 1 and leaves the existing file untouched. `season.totalGames` records the real count, and the page header reads
"N of M games played" from it rather than assuming 240.

It also skips the write when nothing but the timestamp changed, so the workflow
only produces a commit on a real change.

`.github/workflows/update-data.yml` runs it at **06:00 UTC** daily (about 2am ET
/ 11pm PT, after the last West-coast kickoff has finished) and on manual
dispatch. It runs the test suite against the fresh data before committing as
`github-actions[bot]`.

## Tests

```sh
node tests/run.js                      # or: npm test
python3 -m unittest discover -s tests  # the update script's own tests
```

The JavaScript suite has zero dependencies and uses plain `node:assert/strict`.
Coverage: points-only ranking and shared ranks, the best/worst solver against
hand-checked fixtures and against a brute-force enumeration of 300 randomised
instances, the witness assignments (that applying one really does land the team
on the reported position), the W/D/L perspective helpers, node-cap fallback
behaviour, URL-hash round trips, and data-file invariants — checked on both the live `data/season.json` and the frozen snapshot
in `tests/fixtures/`. The Python suite covers the update script's fixture dedupe
and its count tolerances. The nightly workflow runs both.

## Publishing

1. Push the repository to GitHub as
   <https://github.com/watmildon/nwsl-dreams-and-disasters>.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, then pick
   **`main`** and **`/ (root)`**. There is no build step; the files are served
   as they are. `.nojekyll` stops Pages from running them through Jekyll.
3. **Settings → Actions → General** must allow workflows to run, and workflow
   permissions must include write access, or the nightly data commit will fail.
4. GitHub **disables scheduled workflows after 60 days with no repository
   activity**, and emails the repo admin when it does. If the data stops
   refreshing, that is the first thing to check: re-enable it on the Actions tab
   (or push any commit) and it resumes. Running it once via **workflow_dispatch**
   is a good way to confirm it works before relying on the schedule.

## Layout

```
index.html                 UI shell
README.md                  short intro for the repo front page
notes/README.md            this file
package.json               name/type only — there are no dependencies
.nojekyll                  stops GitHub Pages running the files through Jekyll
.gitignore
css/style.css              single stylesheet (mobile-first; 720px breakpoint)
js/main.js                 bootstrap, state, event wiring, recompute pipeline
js/render.js               DOM rendering only
js/storage.js              localStorage + URL hash
js/util.js                 formatting helpers
js/engine/                 pure logic — no DOM, imported unchanged by the tests
  constants.js               points, pick values, node cap
  standings.js               resolveGames(), computeStandings()
  scenarios.js               best/worst search, and the witness that realises it
  perspective.js             a game result seen from one team's side (W/D/L)
  picks.js                   encode/decode picks and the URL hash
data/season.json           generated season data (the only data file)
scripts/update_data.py     stdlib-only fetch + validate + write
tests/                     node tests/run.js, plus a frozen season snapshot
assets/icon.svg            site icon (a calendar marked D&D)
assets/logos/              team logos (PNG)
.github/workflows/         nightly data refresh
```

## Next season

Most year-specific things are read from `data/season.json` at runtime — the page
title, the season line under the heading, the table caption, and the
`localStorage` key (`nwsl-calc-<year>`,
so a new season starts with a clean slate instead of inheriting last year's
picks). That leaves two places to edit:

| What | Where |
|---|---|
| `SEASON_YEAR` (drives the ESPN URL and the data file) | `scripts/update_data.py` |
| The expected year in the data invariants | `tests/data.test.js` (`EXPECTED_YEAR`) |

Also worth a look if the league changes shape: `GAMES_PER_TEAM`, `TEAM_COUNT`,
`TOTAL_GAMES`, `PLAYOFF_SPOTS` and the `TEAMS` table in `scripts/update_data.py`
(expansion, a new crest, a rename), and the matching bounds in
`tests/data.test.js`. Regenerate the frozen fixture under `tests/fixtures/` and
update the snapshot expectations in `tests/scenarios.test.js` if you want the
regression test pinned to the new season.

## Credits

Schedule and results from [ESPN](https://www.espn.com/soccer/league/_/name/usa.nwsl)'s
public scoreboard endpoint. Club crests belong to their respective clubs; they
are used here for identification only.
