import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { CurrentOrderLines } from "./CurrentOrderQueuePage.js";
import { paymentWindowNotice } from "./counter-payment.js";
import { compRecordText } from "./ItemCompAction.js";
import { clockTime, setLanguageForTest, wallClockTime } from "./i18n/i18n.js";
import {
  friendlyStoreTime,
  SourceTime,
  storeDayTime,
  StoreTimeZoneContext,
  storeTime,
  storeWhen,
} from "./StoreTime.js";
import { StaleReadNotice, type StaleRead } from "./stale-read.js";

// Batch 64 (v15 b63: staff screens wrote one moment three ways — Hours "Updated 12:32 p.m.", Tables
// rounds "12:15 p.m." beside Orders "12:15", and "Nov 25, 2026, 12:28 PM by You" under Paid). Every
// time on a staff screen, Tables and Hours & ordering included, is the Store's 24-hour clock, in
// English and Chinese; a date adds its weekday, and the year only when it is not this year. (b40
// had Tables write the guests' "12:30 a.m."; guests' own pages keep that style.)
const zone = "America/Toronto";
const halfPastMidnight = "2026-11-21T05:30:00.000Z";
const sameDay = new Date("2026-11-21T20:00:00.000Z");
const nextDay = new Date("2026-11-22T20:00:00.000Z");
const nextYear = new Date("2027-01-05T20:00:00.000Z");

afterEach(() => setLanguageForTest("en"));

it("writes every staff time on the Store's 24-hour clock, with its day when it has one", () => {
  expect(storeTime(halfPastMidnight, zone)).toBe("00:30");
  expect(storeTime(halfPastMidnight, undefined)).toBe("05:30 UTC");
  expect(clockTime(Date.parse(halfPastMidnight), zone)).toBe("00:30");
  expect(wallClockTime("17:00:00")).toBe("17:00");
  expect(wallClockTime("04:00:00")).toBe("04:00");
  expect(friendlyStoreTime(halfPastMidnight, zone, nextDay)).toBe("Sat, Nov 21 00:30");
  expect(friendlyStoreTime(halfPastMidnight, zone, nextYear)).toBe("Sat, Nov 21, 2026 00:30");
  // A line of a record says today's time alone ("22:42 by Mei"), another day's with its day.
  expect(storeWhen(halfPastMidnight, zone, sameDay)).toBe("00:30");
  expect(storeWhen(halfPastMidnight, zone, nextDay)).toBe("Sat, Nov 21 00:30");
  expect(storeDayTime(halfPastMidnight, zone, sameDay)).toBe("00:30 today");
  for (const text of [
    storeTime(halfPastMidnight, zone, true),
    friendlyStoreTime(halfPastMidnight, zone, nextYear),
  ])
    expect(text).not.toMatch(/[AP]M|[ap]\.m\.|, \d{1,2}:\d\d/u);
  setLanguageForTest("zh-Hans");
  expect(storeTime(halfPastMidnight, zone)).toBe("00:30");
  expect(clockTime(Date.parse(halfPastMidnight), zone)).toBe("00:30");
  expect(friendlyStoreTime(halfPastMidnight, zone, nextDay)).toBe("11月21日周六 00:30");
  expect(friendlyStoreTime(halfPastMidnight, zone, nextYear)).toBe("2026年11月21日周六 00:30");
});

it("the shared order lines and record times say 00:30, wherever they are shown", () => {
  const html = renderToStaticMarkup(
    <StoreTimeZoneContext.Provider value={zone}>
      <CurrentOrderLines
        lines={
          {
            items: [],
            totals: {
              subtotal: { amountMinor: "0", currencyCode: "CAD" },
              discount: { amountMinor: "0", currencyCode: "CAD" },
              tax: { amountMinor: "0", currencyCode: "CAD" },
              fee: { amountMinor: "0", currencyCode: "CAD" },
              total: { amountMinor: "0", currencyCode: "CAD" },
              taxRounding: { amountMinor: "0", currencyCode: "CAD" },
              tip: null,
            },
          } as never
        }
        rounds={
          {
            timeZone: zone,
            today: "2026-11-21",
            batches: [
              {
                orderBatchReference: "00000000-0000-4000-8000-000000000051",
                sequence: 1,
                submittedAt: halfPastMidnight,
                staffRound: null,
                paymentDue: null,
                kitchenRelease: null,
                compedItems: [],
              },
            ],
          } as never
        }
      />
      <SourceTime instant={halfPastMidnight} withDate={false} />
    </StoreTimeZoneContext.Provider>,
  );
  expect(html).toContain(">00:30</time>");
  expect(html).not.toMatch(/a\.m\.|AM/u);
});

it("a sentence ending in a time ends once, and comps say their time alike", () => {
  const ended = paymentWindowNotice({
    payBy: halfPastMidnight,
    now: Date.parse(halfPastMidnight) + 60_000,
    tableMode: true,
    timeZone: zone,
  });
  expect(ended.text).toContain("ended at 00:30. It was not sent");
  expect(
    compRecordText(
      { kind: "Comp", percent: null, decidedAt: halfPastMidnight, byLabel: "Li" },
      zone,
    ),
  ).toBe("Comped · by Li, 00:30");
});

it("no staff screen asks for another clock style any more", () => {
  for (const name of readdirSync(import.meta.dirname)) {
    if (!/\.tsx?$/u.test(name) || /\.test\.|\.fixture/u.test(name)) continue;
    const source = readFileSync(join(import.meta.dirname, name), "utf8");
    expect(source, name).not.toMatch(/ClockStyle|, "Guest"\)|guestLocale\(/u);
    // The browser's own 12-hour clock is never asked for.
    expect(source, name).not.toMatch(/hour: "numeric"/u);
  }
});

it("the offline and server-problem notice says its time on the staff clock", () => {
  const html = (stale: StaleRead) =>
    renderToStaticMarkup(
      <StoreTimeZoneContext.Provider value={zone}>
        <StaleReadNotice stale={stale} />
      </StoreTimeZoneContext.Provider>,
    );
  for (const reason of ["Offline", "ServerProblem"] as const) {
    const stale = { reason, lastLoadedAt: halfPastMidnight, attempts: 1 };
    expect(html(stale)).toContain(">00:30</time>. Actions are paused");
    expect(html(stale)).not.toContain("a.m.");
  }
});

it("b41 (v15 b40 live): the Chinese offline notice is one natural sentence with the time inside", () => {
  setLanguageForTest("zh-Hans");
  const html = (reason: StaleRead["reason"]) =>
    renderToStaticMarkup(
      <StoreTimeZoneContext.Provider value={zone}>
        <StaleReadNotice
          stale={{ reason, lastLoadedAt: "2026-11-21T11:07:00.000Z", attempts: 1 }}
        />
      </StoreTimeZoneContext.Provider>,
    ).replace(/<[^>]+>/gu, "");
  expect(html("Offline")).toContain("离线 — 显示的是 06:07 的最近更新，网络恢复前操作暂停。");
  expect(html("ServerProblem")).toContain("显示的是 06:07 的最近更新，恢复前操作暂停。");
  for (const reason of ["Offline", "ServerProblem"] as const) {
    expect(html(reason)).not.toContain("以下时间");
    expect(html(reason)).not.toMatch(/：\s/u);
  }
});
