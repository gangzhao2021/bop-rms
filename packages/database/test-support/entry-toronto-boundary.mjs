/** Resolve the Toronto local boundary for synthetic current-time acceptance policies. */
export function entryTorontoBoundary(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const localDateTime =
    parts.year +
    "-" +
    parts.month +
    "-" +
    parts.day +
    "T" +
    parts.hour +
    ":" +
    parts.minute +
    ":" +
    parts.second +
    "." +
    instant.slice(20, 23);
  return {
    instant,
    localDateTime,
    utcOffsetMinutes: (Date.parse(localDateTime + "Z") - Date.parse(instant)) / 60000,
  };
}
