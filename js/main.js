// Bootstrap: load the data, hold the state, wire the events, recompute on every
// change.  Everything numeric happens in js/engine/*, which is pure and tested.

import { computeStandings } from "./engine/standings.js";
import { computeScenarios } from "./engine/scenarios.js";
import { PICK_VALUES } from "./engine/constants.js";
import { nextOutcome, outcomeFor, pickFor } from "./engine/perspective.js";
import { loadHash, loadLocal, loadView, prunePicks, saveHash, saveLocal, saveView } from "./storage.js";
import {
  hideToast,
  renderFocusCard,
  renderGrid,
  renderHeader,
  renderPickCount,
  renderStandings,
  renderTabs,
  showError,
  showToast,
} from "./render.js";
import { ordinal } from "./util.js";

const VIEWS = ["standings", "grid"];
const DEFAULT_VIEW = "standings";
const TOAST_MS = 6000;

const state = {
  data: null,
  teamsById: {},
  gamesById: {},
  gridOrder: [],
  picks: {},
  focus: null,
  view: DEFAULT_VIEW,
  standings: null,
  scenarios: null,
  undo: null, // { picks: {...snapshot}, focus, label } -- single level, tied to the toast
};

let toastTimer = 0;

async function boot() {
  let data;
  try {
    const res = await fetch("data/season.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    // A file that parses but is not season data would otherwise blow up below,
    // leaving the page stuck on "Loading...".
    if (!data || !Array.isArray(data.teams) || !Array.isArray(data.games) || !data.season) {
      throw new Error("unexpected shape: expected season, teams[] and games[]");
    }
    if (!data.teams.length || !data.games.length) {
      throw new Error("no teams or games in the file");
    }
  } catch (err) {
    showError(
      "Could not load data/season.json (" +
        err.message +
        "). If you opened this file directly from disk, the browser blocks the fetch — " +
        "serve the folder instead, e.g. run `python3 -m http.server` in the project root " +
        "and open http://localhost:8000/."
    );
    return;
  }

  state.data = data;
  state.teamsById = Object.fromEntries(data.teams.map((t) => [t.id, t]));
  state.gamesById = Object.fromEntries(data.games.map((g) => [g.id, g]));
  // Grid row order comes from the REAL table (played games only), computed once,
  // so rows never re-sort under the user's finger while they tap chips.
  state.gridOrder = computeStandings(data.teams, data.games, {}).rows.map((r) => r.id);
  const teamIds = data.teams.map((t) => t.id);

  // A link wins over whatever this browser remembers; otherwise fall back to
  // localStorage.  Either way, stale picks (games now played) are dropped.
  const fromHash = loadHash(data.games, teamIds);
  const hasHashState = Object.keys(fromHash.picks).length > 0 || fromHash.focus;
  // A view in the link wins, then the remembered one, then the default.
  const initialView = [fromHash.view, loadView(), DEFAULT_VIEW].find((v) => VIEWS.includes(v));
  if (hasHashState) {
    state.picks = prunePicks(fromHash.picks, data.games);
    state.focus = fromHash.focus;
    saveLocal(data.season.year, state.picks);
  } else {
    state.picks = prunePicks(loadLocal(data.season.year).picks, data.games);
  }

  document.getElementById("status").hidden = true;
  document.getElementById("tabs").hidden = false;
  document.getElementById("toolbar").hidden = false;
  wireEvents();
  setView(initialView, { persist: false });
  update();
}

/** Switch tabs. Panels are already rendered, so this never recomputes. */
function setView(view, { persist = true } = {}) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  renderTabs(view);
  if (persist) {
    saveView(view);
    saveHash({ picks: state.picks, focus: state.focus }, state.data.games, view);
  }
}

/**
 * Re-run `update` and put keyboard focus back on the control the user just
 * activated.  The standings table and focus card are re-rendered wholesale via
 * innerHTML, which destroys the focused element -- without this, a keyboard user
 * is dumped back to the top of the document and never hears the new
 * aria-pressed state.
 */
function updateAndRefocus(selector) {
  update();
  if (!selector) return;
  const next = document.querySelector(selector);
  // :focus-visible means a mouse user sees no ring from this, so it is safe to
  // do unconditionally. preventScroll keeps the grid's restored scrollLeft (and
  // the page's scrollTop) exactly where they were.
  if (next && typeof next.focus === "function") next.focus({ preventScroll: true });
}

/** The one recompute pipeline. */
function update() {
  const { data } = state;
  const standings = computeStandings(data.teams, data.games, state.picks);
  const scenarios = computeScenarios(data.teams, data.games, state.picks, {
    playoffSpots: data.season.playoffSpots,
  });
  // Cached so the apply-best/worst buttons can reuse the witnesses without
  // recomputing on click.
  state.standings = standings;
  state.scenarios = scenarios;
  console.debug(`[nwsl] scenarios: ${scenarios.totalNodes} nodes in ${scenarios.ms.toFixed(1)} ms`);

  const playedCount = data.games.filter((g) => g.status === "played").length;
  renderHeader(data.season, { playedCount });
  renderStandings({
    rows: standings.rows,
    scenarios: scenarios.byId,
    teamsById: state.teamsById,
    focus: state.focus,
    playoffSpots: data.season.playoffSpots,
  });
  renderFocusCard({
    focus: state.focus,
    teamsById: state.teamsById,
    standings,
    scenarios: scenarios.byId,
    playoffSpots: data.season.playoffSpots,
    // Win out / Lose out overwrite existing picks, so they stay live as long as
    // the team has any unplayed game -- `remaining` only counts unpicked ones.
    openCount: state.focus ? openGamesForTeam(state.focus).length : 0,
  });

  const openGames = data.games.filter((g) => g.status !== "played");
  renderPickCount(Object.keys(state.picks).length, openGames.length);

  // The grid is cheap to rebuild (16 rows, ~100 chips), so it is always redrawn;
  // only its horizontal scroll position needs preserving.
  const gridScroll = document.getElementById("grid-scroll");
  const left = gridScroll ? gridScroll.scrollLeft : 0;
  renderGrid({
    order: state.gridOrder,
    games: data.games,
    picks: state.picks,
    teamsById: state.teamsById,
    standings,
    focus: state.focus,
  });
  if (gridScroll) gridScroll.scrollLeft = left;

  saveLocal(data.season.year, state.picks);
  saveHash({ picks: state.picks, focus: state.focus }, data.games, state.view);
}

function setPick(gameId, value) {
  if (value && PICK_VALUES.includes(value)) state.picks[gameId] = value;
  else delete state.picks[gameId];
}

/** Quote a team id for use inside a CSS attribute selector. */
function cssEscape(value) {
  const esc = globalThis.CSS && globalThis.CSS.escape;
  return esc ? esc(String(value)) : String(value).replace(/["\\]/g, "\\$&");
}

/**
 * Run a bulk pick change with one level of undo, announced by the toast.
 * Individual picks deliberately do not snapshot: "Undo" on the toast means
 * "undo that bulk action", which is what the button is offering.
 */
function bulkChange(label, mutate) {
  // Snapshot everything a bulk action can move: applyScenario also sets the
  // focus, so restoring picks alone would leave the UI in a state the user
  // never chose.
  state.undo = { picks: { ...state.picks }, focus: state.focus, label };
  mutate();
  showToast(label, { undo: true });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, TOAST_MS);
}

function undoBulk() {
  if (!state.undo) return;
  const snap = state.undo;
  state.picks = snap.picks;
  state.focus = snap.focus;
  state.undo = null;
  clearTimeout(toastTimer);
  hideToast();
  // The toast just vanished from under the keyboard user; put them back on the
  // active tab rather than at the top of the document.
  updateAndRefocus("#tab-" + state.view);
}

/** Undo is available exactly while the toast is visible. */
function dismissToast() {
  clearTimeout(toastTimer);
  hideToast();
  state.undo = null;
}

/** Focus a team, or clear focus when it is already focused. */
function toggleFocus(team, refocusSelector) {
  state.focus = state.focus === team ? null : team;
  updateAndRefocus(refocusSelector);
}

/** Every not-yet-played game involving `team`, picked or not. */
function openGamesForTeam(team) {
  return state.data.games.filter((g) => g.status !== "played" && (g.home === team || g.away === team));
}

/** Set every open game of `team` to a win or a loss for them. */
function setOutcomeForTeam(team, outcome) {
  const games = openGamesForTeam(team);
  if (!games.length) return;
  const short = state.teamsById[team].short;
  const label = `Set ${games.length} game${games.length === 1 ? "" : "s"}: ${short} ${
    outcome === "W" ? "wins" : "loses"
  } out`;
  bulkChange(label, () => {
    for (const g of games) setPick(g.id, pickFor(g, team, outcome));
  });
  updateAndRefocus(outcome === "W" ? "#btn-win-out" : "#btn-lose-out");
}

/**
 * Apply the solver's witness for a team's best or worst case: one concrete set
 * of results for every still-open game that produces exactly that finish.
 */
function applyScenario(team, kind) {
  const sc = state.scenarios && state.scenarios.byId[team];
  if (!sc) return;
  const witness = kind === "best" ? sc.bestWitness : sc.worstWitness;
  const n = Object.keys(witness || {}).length;
  if (!n) return;

  const pos = ordinal(kind === "best" ? sc.best : sc.worst);
  const exact = kind === "best" ? sc.bestExact : sc.worstExact;
  const short = state.teamsById[team].short;
  const label = `Set ${n} game${n === 1 ? "" : "s"} so ${short} finishes ${pos} (${kind} case${exact ? "" : " found"})`;
  bulkChange(label, () => {
    Object.assign(state.picks, witness);
  });
  // Focus the team so the row highlights and the card shows the new position.
  state.focus = team;
  // Not the .pos-btn that was clicked: applying decides every game, so it
  // re-renders disabled and focus() would silently drop to <body>. The row's
  // team button is never disabled and sits in the same row.
  updateAndRefocus(`#standings-body .team-btn[data-team="${cssEscape(team)}"]`);
}

function wireEvents() {
  // Tabs: click, plus APG keyboard support with automatic activation (panels
  // are already rendered, so moving focus can safely switch view).
  const tabs = document.getElementById("tabs");
  tabs.addEventListener("click", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) setView(tab.dataset.view);
  });
  tabs.addEventListener("keydown", (e) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1 };
    let next = null;
    const i = VIEWS.indexOf(state.view);
    if (e.key in keys) next = VIEWS[(i + keys[e.key] + VIEWS.length) % VIEWS.length];
    else if (e.key === "Home") next = VIEWS[0];
    else if (e.key === "End") next = VIEWS[VIEWS.length - 1];
    if (!next) return;
    e.preventDefault();
    setView(next);
    const btn = document.getElementById("tab-" + next);
    if (btn) btn.focus();
  });

  // Standings: team buttons toggle focus; Best/Worst apply a scenario.
  document.getElementById("standings-body").addEventListener("click", (e) => {
    const apply = e.target.closest(".pos-btn");
    if (apply) {
      if (!apply.disabled) applyScenario(apply.dataset.team, apply.dataset.apply);
      return;
    }
    const btn = e.target.closest(".team-btn");
    if (!btn) return;
    toggleFocus(btn.dataset.team, `.team-btn[data-team="${cssEscape(btn.dataset.team)}"]`);
  });

  // Season grid: chips cycle the row team's result; team cells toggle focus.
  document.getElementById("grid-table").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) {
      const game = state.gamesById[chip.dataset.game];
      const team = chip.dataset.team;
      if (!game) return;
      const next = nextOutcome(outcomeFor(game, team, state.picks[game.id]));
      setPick(game.id, pickFor(game, team, next));
      // The opponent's chip re-renders from the same picks, so both always agree.
      updateAndRefocus(`.chip[data-game="${cssEscape(game.id)}"][data-team="${cssEscape(team)}"]`);
      return;
    }
    const teamBtn = e.target.closest(".grid-team-btn");
    if (teamBtn) {
      toggleFocus(teamBtn.dataset.team, `.grid-team-btn[data-team="${cssEscape(teamBtn.dataset.team)}"]`);
    }
  });

  // Toast.
  document.getElementById("toast-undo").addEventListener("click", undoBulk);
  document.getElementById("toast-close").addEventListener("click", dismissToast);

  // Focus card buttons are re-created on every render, so delegate.
  document.getElementById("focus-card").addEventListener("click", (e) => {
    if (e.target.closest("#btn-win-out")) {
      setOutcomeForTeam(state.focus, "W");
      return;
    }
    if (e.target.closest("#btn-lose-out")) {
      setOutcomeForTeam(state.focus, "L");
      return;
    }
    if (e.target.closest("#btn-clear-focus")) {
      const team = state.focus;
      state.focus = null;
      // The card itself disappears, so hand focus back to that team's row.
      updateAndRefocus(team ? `.team-btn[data-team="${cssEscape(team)}"]` : null);
    }
  });

  // Clear all: undoable, and a no-op offers no toast.
  document.getElementById("btn-clear").addEventListener("click", () => {
    const picked = Object.keys(state.picks).length;
    if (!picked) return;
    bulkChange(`Cleared ${picked} pick${picked === 1 ? "" : "s"}`, () => {
      state.picks = {};
    });
    update();
  });

  const copyBtn = document.getElementById("btn-copy");
  // Captured once, before any "Copied" flash can overwrite it; a rapid second
  // click cancels the pending restore rather than stacking two timers.
  const copyLabel = copyBtn.textContent;
  let copyTimer = 0;
  copyBtn.addEventListener("click", async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = "Copied";
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyBtn.textContent = copyLabel;
      }, 1500);
    } catch {
      window.prompt("Copy this link", url);
    }
  });

  // Pasting a scenario link into an already-open tab. Our own saveHash() uses
  // replaceState, which does not fire hashchange, so this only ever responds to
  // a real navigation (a paste, back/forward, or following a link).
  window.addEventListener("hashchange", () => {
    const teamIds = state.data.teams.map((t) => t.id);
    const fromHash = loadHash(state.data.games, teamIds);
    // A view in the link applies even when it carries no picks (#v=grid).
    if (VIEWS.includes(fromHash.view)) setView(fromHash.view);
    // Same guard as boot(): an empty fragment carries no scenario, so treat it
    // as "nothing to apply" rather than as an instruction to erase everything.
    if (!Object.keys(fromHash.picks).length && !fromHash.focus) return;
    state.picks = prunePicks(fromHash.picks, state.data.games);
    state.focus = fromHash.focus;
    update();
  });
}

boot();
