// All DOM rendering.  No computation lives here: everything it needs arrives
// pre-computed from main.js.

import { escapeHtml, formatDate, formatTime, ordinal } from "./util.js";
import { outcomeFor } from "./engine/perspective.js";

/**
 * "3rd" / "\u22643rd", with a bare "3" / "\u22643" alongside it; CSS shows the
 * long form at >= 720 px and the compact one below, where the table is tight.
 * Pass `longOnly` where there is room at every width (the focus card).
 */
function position(n, exact, mode, longOnly) {
  const prefix = exact ? "" : mode === "best" ? "\u2264" : "\u2265";
  const title = exact ? "" : ' title="Search cut short; bound only"';
  const cls = (exact ? "pos" : "pos bound") + (longOnly ? " pos-always-long" : "");
  const visual = `<span class="pos-long">${prefix}${ordinal(n)}</span><span class="pos-short">${prefix}${n}</span>`;
  if (exact) return `<span class="${cls}">${visual}</span>`;
  // A bare "<=" / ">=" glyph means nothing read aloud, so hide the visual pair
  // from assistive tech and give it the whole statement in words -- the number
  // included, or the cell would read as a qualifier with nothing to qualify.
  const sr = `${ordinal(n)} ${mode === "best" ? "or better" : "or worse"}; bound only, exact value not computed`;
  return `<span class="${cls}"${title}><span aria-hidden="true">${visual}</span><span class="sr-only">${sr}</span></span>`;
}

function markerFor(flags) {
  if (flags.clinchedShield) return { ch: "s", label: "clinched Shield" };
  if (flags.clinchedPlayoffs) return { ch: "x", label: "clinched playoff spot" };
  if (flags.eliminated) return { ch: "e", label: "eliminated" };
  return null;
}

/** A single-letter table marker: the glyph for sighted users, words for others. */
function markerHtml(marker) {
  if (!marker) return "";
  return `<span class="marker" title="${escapeHtml(marker.label)}"><span aria-hidden="true">${marker.ch}</span><span class="sr-only">, ${escapeHtml(marker.label)}</span></span>`;
}

/** True when the last playoff place and the first missed one are level on points. */
function isCutStraddled(rows, playoffSpots) {
  const last = rows[playoffSpots - 1];
  const first = rows[playoffSpots];
  return Boolean(last && first && last.pts === first.pts);
}

/**
 * One line describing the focused team's distance from the playoff cut, e.g.
 * "3 pts clear of 9th (Angel City)" or "5 pts behind 8th (Kansas City)".
 */
function cutGapText(row, rows, playoffSpots, teamsById) {
  const lastIn = rows[playoffSpots - 1];
  const firstOut = rows[playoffSpots];
  if (!lastIn || !firstOut) return "";
  // Position in the table, not rank: a shared rank can span the cut.
  const inside = rows.indexOf(row) < playoffSpots;
  // Compare against the team on the other side of the line from this one.
  const other = inside ? firstOut : lastIn;
  if (other.id === row.id) return "";
  const name = teamsById[other.id] ? teamsById[other.id].short : other.id;
  const place = ordinal(inside ? playoffSpots + 1 : playoffSpots);
  const diff = Math.abs(row.pts - other.pts);
  if (diff === 0) return `Level on points with ${place} (${name})`;
  const pts = `${diff} pt${diff === 1 ? "" : "s"}`;
  return inside ? `${pts} clear of ${place} (${name})` : `${pts} behind ${place} (${name})`;
}

/** Show exactly one panel and mark exactly one tab selected. */
export function renderTabs(view) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const on = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(on));
    // Roving tabindex: only the active tab is in the Tab order.
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
    panel.hidden = panel.id !== "panel-" + view;
  }
}

export function renderHeader(season, standings) {
  // Everything year-specific comes from the data file, so a new season needs no
  // edits to index.html.  The <h1> is the site name and stays put; the year
  // rides in the meta line under it.
  document.title = `NWSL ${season.year} Dreams and Disasters Calculator`;
  const seasonLine = document.getElementById("season-line");
  if (seasonLine) seasonLine.textContent = `${season.year} season`;
  const caption = document.getElementById("standings-caption");
  if (caption) {
    caption.textContent = `Projected NWSL ${season.year} standings from played games plus your picks, ranked by points.`;
  }

  const el = document.getElementById("last-updated");
  if (el) {
    el.dateTime = season.lastUpdated;
    el.textContent = `${formatDate(season.lastUpdated, { month: "short", day: "numeric", year: "numeric" })}, ${formatTime(season.lastUpdated)}`;
  }
  const prog = document.getElementById("progress");
  if (prog) {
    const played = standings.playedCount;
    prog.textContent = `${played} of ${season.totalGames} games played`;
  }
}

/**
 * A Best/Worst cell: the position, as a button that applies a set of results
 * producing it. Disabled when there is nothing left to set.
 */
function applyCell(sc, team, kind) {
  // Nothing to apply once every game is decided, so the cell is a plain number.
  const n = Object.keys((kind === "best" ? sc.bestWitness : sc.worstWitness) || {}).length;
  const value = kind === "best" ? sc.best : sc.worst;
  const exact = kind === "best" ? sc.bestExact : sc.worstExact;
  const label = exact
    ? `Apply ${kind} case for ${team.name}: ${ordinal(value)}`
    : `Apply ${kind} case found for ${team.name}: ${ordinal(value)} (search cut short)`;
  return `<button type="button" class="pos-btn" data-apply="${kind}" data-team="${escapeHtml(team.id)}" aria-label="${escapeHtml(label)}"${
    n === 0 ? " disabled" : ""
  }>${position(value, exact, kind)}</button>`;
}

export function renderStandings({ rows, scenarios, teamsById, focus, playoffSpots }) {
  const body = document.getElementById("standings-body");
  const straddled = isCutStraddled(rows, playoffSpots);
  const html = rows
    .map((row, i) => {
      const team = teamsById[row.id];
      const sc = scenarios[row.id];
      const marker = markerFor(sc.flags);
      const classes = [];
      if (sc.flags.clinchedPlayoffs) classes.push("clinched");
      if (sc.flags.eliminated) classes.push("eliminated");
      if (row.tied) classes.push("tied");
      if (focus === row.id) classes.push("focused");
      // The cut line always sits after the 8th row. When the 8th and 9th teams
      // are level on points the real cut is undecided, so draw it dashed and say
      // so rather than implying a clean separation.
      if (i === playoffSpots - 1) {
        classes.push("playoff-line");
        if (straddled) classes.push("playoff-line-straddled");
      }

      const rankText = row.tied ? `T${row.rank}` : String(row.rank);
      const rankTitle = row.tied
        ? ` title="Level on points with ${row.tiedCount - 1} other team${row.tiedCount > 2 ? "s" : ""}; official tiebreakers not modelled"`
        : "";

      return `<tr class="${classes.join(" ")}" data-row-team="${escapeHtml(row.id)}">
  <td class="col-rank"${rankTitle}>${rankText}</td>
  <td class="team-cell" style="box-shadow: inset 4px 0 0 ${escapeHtml(team.color)}">
    <button type="button" class="team-btn" data-team="${escapeHtml(row.id)}" aria-pressed="${focus === row.id}">
      <img class="logo" src="${escapeHtml(team.logo)}" alt="" width="24" height="24" loading="lazy">
      <span class="name">${escapeHtml(team.name)}</span>
      <span class="abbr">${escapeHtml(row.id)}</span>
      ${markerHtml(marker)}
    </button>
  </td>
  <td class="num">${row.gp}</td>
  <td class="num">${row.w}</td>
  <td class="num">${row.d}</td>
  <td class="num">${row.l}</td>
  <td class="num"><strong>${row.pts}</strong></td>
  <td class="num">${applyCell(sc, team, "best")}</td>
  <td class="num">${applyCell(sc, team, "worst")}</td>
</tr>`;
    })
    .join("\n");
  body.innerHTML = html;

  document.getElementById("legend").innerHTML =
    "<strong>s</strong> – clinched Shield · <strong>x</strong> – clinched playoff spot · " +
    "<strong>e</strong> – eliminated · <strong>T</strong> – level on points · " +
    "line = playoff cut (top 8) · <strong>Best</strong>/<strong>Worst</strong> = best and worst possible " +
    "finish given your picks; click one to set the games that produce it";
}

export function renderFocusCard({ focus, teamsById, standings, scenarios, playoffSpots, openCount = 0 }) {
  const card = document.getElementById("focus-card");
  if (!focus) {
    card.hidden = true;
    card.innerHTML = "";
    return;
  }
  const team = teamsById[focus];
  const row = standings.byId[focus];
  const sc = scenarios[focus];

  let verdict = "Still alive";
  if (sc.flags.clinchedShield) verdict = "Clinched the Shield";
  else if (sc.flags.clinchedPlayoffs) verdict = "Clinched a playoff spot";
  else if (sc.flags.eliminated) verdict = "Eliminated from the playoffs";

  const spots = playoffSpots === undefined ? 8 : playoffSpots;
  const rows = standings.rows;
  const rankText = row.tied ? `${ordinal(row.rank)} (tied)` : ordinal(row.rank);
  const gap = cutGapText(row, rows, spots, teamsById);
  // Teams level with the last playoff place are in genuine limbo, so say so.
  const lastIn = rows[spots - 1];
  const inStraddle = isCutStraddled(rows, spots) && lastIn && row.pts === lastIn.pts;
  card.hidden = false;
  card.innerHTML = `
<div class="focus-head">
  <img class="logo" src="${escapeHtml(team.logo)}" alt="" width="40" height="40">
  <div>
    <h3>${escapeHtml(team.name)}</h3>
    <p class="focus-line">Now ${rankText} · ${row.pts} pts · ${row.remaining} game${row.remaining === 1 ? "" : "s"} left</p>
  </div>
</div>
${gap ? `<p class="focus-gap">${escapeHtml(gap)}</p>` : ""}
<p class="focus-verdict">Best ${position(sc.best, sc.bestExact, "best", true)} · Worst ${position(sc.worst, sc.worstExact, "worst", true)} — ${escapeHtml(verdict)}${
  inStraddle ? " (tied for the last spot)" : ""
}</p>
<div class="focus-actions">
  <button type="button" id="btn-win-out"${openCount ? "" : " disabled"}>Win out</button>
  <button type="button" id="btn-lose-out"${openCount ? "" : " disabled"}>Lose out</button>
  <button type="button" id="btn-clear-focus">Clear focus</button>
</div>`;
}

export function renderPickCount(pickCount, openCount) {
  const el = document.getElementById("pick-count");
  if (el) el.textContent = `${pickCount} of ${openCount} picked`;
}

export function showError(message) {
  const status = document.getElementById("status");
  status.hidden = false;
  status.className = "error";
  status.textContent = message;
}

/**
 * The season grid: one row per team, one chip per remaining game, seen from
 * that team's side. A game therefore appears twice; both chips are rendered
 * from the same `picks`, so they can never disagree.
 */
export function renderGrid({ order, games, picks, teamsById, standings, focus }) {
  const table = document.getElementById("grid-table");
  if (!table) return;

  const open = games.filter((g) => g.status !== "played");
  const byTeam = new Map(order.map((id) => [id, []]));
  for (const g of open) {
    if (byTeam.has(g.home)) byTeam.get(g.home).push(g);
    if (byTeam.has(g.away)) byTeam.get(g.away).push(g);
  }
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Number(a.id) - Number(b.id));

  const head = `<caption class="sr-only">Remaining games for every team, earliest first. Activate a game to cycle that team's result.</caption>
<thead><tr><th scope="col" class="grid-team-h">Team</th><th scope="col" class="grid-games-h">Remaining games</th></tr></thead>`;

  if (!open.length) {
    table.innerHTML = `${head}<tbody><tr><td colspan="2" class="grid-empty">Season complete \u2014 no remaining games.</td></tr></tbody>`;
    return;
  }

  const rows = order.map((id) => {
    const team = teamsById[id];
    const row = standings.byId[id];
    const summary = `${row.tied ? "T" : ""}${ordinal(row.rank)} \u00b7 ${row.pts}`;
    const spoken = `${team.name}, ${row.tied ? "tied " : ""}${ordinal(row.rank)}, ${row.pts} points: focus`;
    const chips = byTeam
      .get(id)
      .slice()
      .sort(byDate)
      .map((g) => chipHtml(g, id, team, teamsById, picks, focus))
      .join("");
    return `<tr data-row-team="${escapeHtml(id)}"${focus === id ? ' class="focused"' : ""}>
  <th scope="row" class="grid-team" style="box-shadow: inset 4px 0 0 ${escapeHtml(team.color)}">
    <button type="button" class="team-btn grid-team-btn" data-team="${escapeHtml(id)}" aria-pressed="${focus === id}" aria-label="${escapeHtml(spoken)}">
      <span class="grid-team-top"><img class="logo" src="${escapeHtml(team.logo)}" alt="" width="20" height="20" loading="lazy"><span class="abbr">${escapeHtml(id)}</span></span>
      <span class="grid-team-sum">${escapeHtml(summary)}</span>
    </button>
  </th>
  <td class="grid-cells"><div class="chips">${chips}</div></td>
</tr>`;
  });

  table.innerHTML = `${head}<tbody>${rows.join("")}</tbody>`;
}

function chipHtml(game, teamId, team, teamsById, picks, focus) {
  const isHome = game.home === teamId;
  const oppId = isHome ? game.away : game.home;
  const opp = teamsById[oppId];
  const outcome = outcomeFor(game, teamId, picks[game.id]);
  const ppd = game.status === "other";
  const desc =
    outcome === "W" ? `${team.short} win` : outcome === "D" ? "draw" : outcome === "L" ? `${team.short} loss` : "no pick";
  const when = ppd ? "postponed" : formatDate(game.date, { month: "short", day: "numeric" });
  const label = `${team.name} ${isHome ? "vs" : "at"} ${opp ? opp.name : oppId}, ${when} \u2014 pick: ${desc}`;
  // Involving the focused team but shown in someone else's row: worth flagging.
  const involvesFocus = focus && focus !== teamId && (game.home === focus || game.away === focus);
  return `<button type="button" class="chip${involvesFocus ? " involves-focus" : ""}" data-game="${escapeHtml(game.id)}" data-team="${escapeHtml(teamId)}" data-outcome="${outcome}" aria-label="${escapeHtml(label)}">
  <span class="chip-opp">${isHome ? "vs" : "@"} ${escapeHtml(oppId)}</span>
  <span class="chip-foot"><span class="chip-res">${outcome}</span><span class="chip-date">${
    ppd ? "PPD" : escapeHtml(formatDate(game.date, { month: "numeric", day: "numeric" }))
  }</span></span>
</button>`;
}

/** Show the undo toast. Timers and state live in main.js; this only touches DOM. */
export function showToast(text, { undo = false } = {}) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  document.getElementById("toast-text").textContent = text;
  document.getElementById("toast-undo").hidden = !undo;
  toast.hidden = false;
}

export function hideToast() {
  const toast = document.getElementById("toast");
  if (toast) toast.hidden = true;
}
