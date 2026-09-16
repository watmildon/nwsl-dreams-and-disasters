// Small formatting helpers.  No DOM state, no app knowledge.

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th" ... */
export function ordinal(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const rem100 = v % 100;
  if (rem100 >= 11 && rem100 <= 13) return v + "th";
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[v % 10] || "th";
  return v + suffix;
}

/** "2026-11-01T22:00:00Z" -> "Sun, Nov 1" in the viewer's local time zone. */
export function formatDate(iso, opts) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, opts || { weekday: "short", month: "short", day: "numeric" });
}

/** "2026-11-01T22:00:00Z" -> "3:00 PM" in the viewer's local time zone. */
export function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Escape text for safe interpolation into an HTML template string. */
export function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
