import { expect, it } from "vitest";
import { entryTorontoBoundary } from "./pilot-toronto-boundary.mjs";

it.each([
  ["2026-03-08T06:59:59.123Z", "2026-03-08T01:59:59.123", -300],
  ["2026-03-08T07:00:00.000Z", "2026-03-08T03:00:00.000", -240],
  ["2026-11-01T05:59:59.999Z", "2026-11-01T01:59:59.999", -240],
  ["2026-11-01T06:00:00.000Z", "2026-11-01T01:00:00.000", -300],
  ["2026-09-21T03:30:00.456Z", "2026-09-20T23:30:00.456", -240],
])(
  "resolves Toronto boundary %s without losing the UTC identity",
  (instant, localDateTime, utcOffsetMinutes) => {
    expect(entryTorontoBoundary(instant)).toEqual({ instant, localDateTime, utcOffsetMinutes });
  },
);
