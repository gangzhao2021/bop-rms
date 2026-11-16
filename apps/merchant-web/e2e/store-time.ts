/**
 * The value a `datetime-local` "Paid at (store time)" field takes for an instant: the wall clock
 * in the Store's IANA time zone, never the test machine's zone (CI runs in UTC, staff in Toronto).
 */
export function storeLocalInput(at: Date | number, timeZone = "America/Toronto"): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
