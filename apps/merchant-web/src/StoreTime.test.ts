import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import {
  CheckedTime,
  SourceTime,
  StoreTimeZoneContext,
  friendlyStoreTime,
  storeLocalInputValue,
  storeTime,
} from "./StoreTime.js";

it("writes staff-facing instants in Store-local time without raw ISO text", () => {
  const now = new Date("2026-10-14T20:00:00.000Z");
  expect(friendlyStoreTime("2026-10-14T19:00:27.165Z", "America/Toronto", now)).toBe(
    "Oct 14, 3:00 PM",
  );
  expect(friendlyStoreTime("2025-12-31T23:30:00.000Z", "America/Toronto", now)).toBe(
    "Dec 31, 2025, 6:30 PM",
  );
  expect(friendlyStoreTime("2026-10-14T19:00:27.165Z", undefined, now)).toBe("Oct 14, 7:00 PM UTC");
});

it("WP-2423: dated store times read as words, never a machine date such as 2026-10-14 22:11", () => {
  expect(storeTime("2026-10-15T02:11:00.000Z", "America/Toronto", true)).toBe(
    "Oct 14, 2026, 10:11 PM",
  );
  expect(storeTime("2026-10-15T02:11:00.000Z", undefined, true)).toBe("Oct 15, 2026, 2:11 AM UTC");
  expect(storeTime("2026-10-15T02:11:00.000Z", "America/Toronto")).toBe("22:11");
  // A datetime-local input keeps the machine form it needs (an input value, not visible text).
  expect(storeLocalInputValue("2026-10-15T02:11:00.000Z", "America/Toronto")).toBe(
    "2026-10-14T22:11",
  );
  const zoned = (node: ReturnType<typeof createElement>, zone: string | undefined) =>
    renderToStaticMarkup(createElement(StoreTimeZoneContext.Provider, { value: zone }, node));
  for (const zone of ["America/Toronto", undefined]) {
    const html = zoned(createElement(SourceTime, { instant: "2026-10-15T02:11:00.000Z" }), zone);
    expect(findInternalText([staticText(html)]).map((f) => f.rule)).not.toContain("timestamp");
  }
});

it("WP-2423: the sold-out page says when it was checked in store time", () => {
  vi.useFakeTimers({ now: new Date("2026-10-15T02:30:00.000Z") });
  try {
    const html = renderToStaticMarkup(
      createElement(CheckedTime, {
        instant: "2026-10-15T02:11:00.000Z",
        timeZone: "America/Toronto",
      }),
    );
    expect(staticText(html)).toContain("Checked 10:11 PM today");
    expect(html).toContain('dateTime="2026-10-15T02:11:00.000Z"');
    expect(findInternalText([staticText(html)])).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
