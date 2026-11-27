/**
 * Batch 46 (v15 overnight 45): a Store's day open from midnight to midnight. The hours model
 * writes a whole day as 00:00–23:59:59 (a period can't end at the time it starts), and staff may
 * write 00:00–23:59 or periods back to back; each reads "Open 24 hours", never "12:00 AM–11:59 PM".
 * A minute's gap is allowed, as hours are entered in minutes.
 */
export interface DayPeriod {
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly endsNextDay: boolean;
}

const secondsOf = (value: string): number => {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
};

export function isOpenAllDay(periods: readonly DayPeriod[]): boolean {
  const sorted = [...periods].sort(
    (a, b) => secondsOf(a.startLocalTime) - secondsOf(b.startLocalTime),
  );
  if (sorted.length === 0 || secondsOf(sorted[0]?.startLocalTime ?? "") > 0) return false;
  let reached = 0;
  for (const period of sorted) {
    if (secondsOf(period.startLocalTime) > reached + 60) return false;
    const end = secondsOf(period.endLocalTime) + (period.endsNextDay ? 86_400 : 0);
    // A period past midnight ("(next day) 2:00") keeps its own end time in words.
    if (end > 86_400) return false;
    reached = Math.max(reached, end);
  }
  return reached >= 86_400 - 60;
}

/** The local time ("HH:MM:SS") orders stop in a period that stops them before it ends. */
export function lastOrdersTime(period: DayPeriod, cutoffSeconds: number): string {
  const end = secondsOf(period.endLocalTime) + (period.endsNextDay ? 86_400 : 0);
  const at = (((end - cutoffSeconds) % 86_400) + 86_400) % 86_400;
  return [Math.floor(at / 3600), Math.floor((at % 3600) / 60), at % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
