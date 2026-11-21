/**
 * b39 (v15 b38 dinner sweep, Owner delegated the choice): a table left open from an earlier
 * business day is not today's work. Owner-hotpot had eight tables from two weeks before at the top
 * of Tables, Home and the day's report every day, burying the evening's tables. Nothing closes or
 * writes off such a table by itself (money is never moved without a person); every screen lists it
 * apart, "from earlier days", with what to do: take its payment or record that the guests left
 * without paying, then close it.
 *
 * A party seated before the business day began and open for more than `lateServiceHours` is an
 * earlier day's. A late service that runs past the day's turn (seated at 23:00, the day turning at
 * 04:00) stays today's work, as on the kitchen board.
 */
export const lateServiceHours = 12;

export function openedOnEarlierDay(
  openMinutes: number | null,
  /** When `openMinutes` was counted up to. */
  at: number,
  /** Start of the Store's current business day. */
  dayStartsAt: number,
): boolean {
  if (openMinutes === null || !Number.isFinite(at) || !Number.isFinite(dayStartsAt)) return false;
  return at - openMinutes * 60_000 < dayStartsAt && openMinutes > lateServiceHours * 60;
}
