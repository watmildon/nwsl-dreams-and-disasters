// Shared constants for the pure engine.  No DOM, no side effects.

export const POINTS = { win: 3, draw: 1, loss: 0 };

// A pick is a *result*, never a score: home win, draw, away win.
export const PICK_VALUES = ["H", "D", "A"];

// Per-solver-run node budget (see engine/scenarios.js §5).  When it is exceeded
// the solver returns an honest bound with `exact: false` instead of a value.
export const DEFAULT_NODE_CAP = 150000;
