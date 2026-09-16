// Turning a game result into "what happened to *this* team", and back.
//
// The season grid shows one row per team, so a game appears twice -- once from
// each side. A pick is stored once, as a home-relative "H"/"D"/"A"; these
// helpers translate it to and from the row team's own "W"/"D"/"L".

/** Chip cycle order: blank -> win -> draw -> loss -> blank. */
export const OUTCOMES = ["", "W", "D", "L"];

/**
 * @param {{home: string, away: string}} game
 * @param {string} teamId  a team in `game`
 * @param {string} pick    "H" | "D" | "A" | undefined
 * @returns {""|"W"|"D"|"L"} "" when unpicked, or when the team is not in the game
 */
export function outcomeFor(game, teamId, pick) {
  if (!game || (game.home !== teamId && game.away !== teamId)) return "";
  if (pick === "D") return "D";
  const isHome = game.home === teamId;
  if (pick === "H") return isHome ? "W" : "L";
  if (pick === "A") return isHome ? "L" : "W";
  return "";
}

/**
 * Exact inverse of `outcomeFor`.
 *
 * @returns {""|"H"|"D"|"A"} "" means "clear the pick"
 */
export function pickFor(game, teamId, outcome) {
  if (!game || (game.home !== teamId && game.away !== teamId)) return "";
  if (outcome === "D") return "D";
  const isHome = game.home === teamId;
  if (outcome === "W") return isHome ? "H" : "A";
  if (outcome === "L") return isHome ? "A" : "H";
  return "";
}

/** One step around the chip cycle. Anything unrecognised restarts at "W". */
export function nextOutcome(outcome) {
  const i = OUTCOMES.indexOf(outcome);
  if (i === -1) return "W";
  return OUTCOMES[(i + 1) % OUTCOMES.length];
}
