import { t } from "./i18n/i18n.js";

/**
 * WP-2423 follow-up: how long something has been open, in words staff read at a glance — minutes
 * for the first hour, then hours and minutes, then days. b39: shared by Tables and the reports, so a
 * table left from two weeks ago reads "14 days", never "21563 min".
 */
export function elapsedText(minutes: number): string {
  if (minutes < 60) return t("{minutes} min", { minutes: String(Math.max(0, minutes)) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0
      ? t("{hours} h", { hours: String(hours) })
      : t("{hours} h {rest} min", { hours: String(hours), rest: String(rest) });
  }
  const days = Math.floor(hours / 24);
  return t("{days} day{value}", { days: String(days), value: days === 1 ? "" : "s" });
}
