import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import {
  CheckedTime,
  Freshness,
  SourceTime,
  StoreTimeZoneContext,
  friendlyStoreTime,
  storeLocalInputValue,
  storeTime,
} from "./StoreTime.js";

it("writes staff-facing instants in Store-local time without raw ISO text", () => {
  const now = new Date("2026-10-14T20:00:00.000Z");
  // Batch 64: the staff clock, with the weekday; the year only when it is not this year.
  expect(friendlyStoreTime("2026-10-14T19:00:27.165Z", "America/Toronto", now)).toBe(
    "Wed, Oct 14 15:00",
  );
  expect(friendlyStoreTime("2025-12-31T23:30:00.000Z", "America/Toronto", now)).toBe(
    "Wed, Dec 31, 2025 18:30",
  );
  expect(friendlyStoreTime("2026-10-14T19:00:27.165Z", undefined, now)).toBe(
    "Wed, Oct 14 19:00 UTC",
  );
});

it("WP-2423: dated store times read as words, never a machine date such as 2026-10-14 22:11", () => {
  vi.useFakeTimers({ now: new Date("2027-01-05T12:00:00.000Z") });
  try {
    expect(storeTime("2026-10-15T02:11:00.000Z", "America/Toronto", true)).toBe(
      "Wed, Oct 14, 2026 22:11",
    );
    expect(storeTime("2026-10-15T02:11:00.000Z", undefined, true)).toBe(
      "Thu, Oct 15, 2026 02:11 UTC",
    );
  } finally {
    vi.useRealTimers();
  }
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
    expect(staticText(html)).toContain("Checked 22:11 today");
    expect(html).toContain('dateTime="2026-10-15T02:11:00.000Z"');
    expect(findInternalText([staticText(html)])).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("batch 63 (F24): every page says when it was read the same way, 'Updated 01:36' / '已更新 01:36'", () => {
  const stamp = (props: Parameters<typeof Freshness>[0]) =>
    renderToStaticMarkup(
      createElement(
        StoreTimeZoneContext.Provider,
        { value: "America/Toronto" },
        createElement(Freshness, props),
      ),
    ).replace(/<[^>]+>/gu, "");
  try {
    expect(stamp({ status: "Fresh", at: "2026-11-25T06:36:00.000Z" })).toBe("Updated 01:36");
    // A screen that rereads on its own says when it last read, in the same words.
    expect(
      stamp({
        status: "Current",
        at: "2026-11-25T05:00:00.000Z",
        checkedAt: "2026-11-25T06:52:00.000Z",
      }),
    ).toBe("Updated 01:52");
    expect(stamp({ status: "Stale", at: "2026-11-25T06:36:00.000Z" })).toBe(
      "Data may be out of date · last checked 01:36",
    );
    setLanguageForTest("zh-Hans");
    expect(stamp({ status: "Fresh", at: "2026-11-25T06:36:00.000Z" })).toBe("已更新 01:36");
  } finally {
    setLanguageForTest("en");
  }
});

it("batch 64: before the Store's zone is known, the stamp reads this device's clock, unlabelled", () => {
  // A brand-level page (Points) has no Store zone; a store tablet's clock is the Store's.
  const at = "2026-11-25T06:36:00.000Z";
  const device = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = new Intl.DateTimeFormat("en-CA", {
    timeZone: device,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
  const text = renderToStaticMarkup(createElement(Freshness, { status: "Fresh", at })).replace(
    /<[^>]+>/gu,
    "",
  );
  expect(text).toBe(`Updated ${clock}`);
  expect(text).not.toMatch(/UTC/u);
});

it("batch 65: a read that names its Store's zone is stamped in that zone, over the page's and the device's", () => {
  // Item availability (also on the kitchen display, which has no Store zone around it) and Table
  // QR codes pass the zone their read names; 01:26 UTC is 20:26 in Toronto the evening before.
  const stamp = (context: string | undefined) =>
    renderToStaticMarkup(
      createElement(
        StoreTimeZoneContext.Provider,
        { value: context },
        createElement(Freshness, {
          status: "Fresh",
          at: "2026-11-26T01:26:00.000Z",
          timeZone: "America/Toronto",
        }),
      ),
    ).replace(/<[^>]+>/gu, "");
  expect(stamp(undefined)).toBe("Updated 20:26");
  expect(stamp("Asia/Shanghai")).toBe("Updated 20:26");
});
