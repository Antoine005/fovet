/**
 * Returns a human-readable relative time string in French.
 * e.g. "il y a 2 min", "il y a 30s", "il y a 3h"
 *
 * @param dateOrIso  Date object or ISO-8601 string
 * @param now        Reference timestamp in ms (defaults to Date.now())
 */
export function relativeTime(dateOrIso: Date | string, now = Date.now()): string {
  const ts = typeof dateOrIso === "string"
    ? new Date(dateOrIso).getTime()
    : dateOrIso.getTime();

  const diff = Math.max(0, now - ts);
  const s    = Math.floor(diff / 1_000);
  const m    = Math.floor(diff / 60_000);
  const h    = Math.floor(diff / 3_600_000);
  const d    = Math.floor(diff / 86_400_000);

  if (s  < 10)  return "à l'instant";
  if (s  < 60)  return `il y a ${s}s`;
  if (m  < 60)  return `il y a ${m} min`;
  if (h  < 24)  return `il y a ${h}h`;
  return              `il y a ${d}j`;
}
