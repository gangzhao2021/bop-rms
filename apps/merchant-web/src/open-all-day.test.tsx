import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { ServiceHoursSummary } from "./StoreServiceControlPanel.js";
import { openingHoursLines } from "./StoreFirstOpeningPanel.js";
import { openingHoursChanges } from "./StoreSetupDraftPage.js";
import { isOpenAllDay, lastOrdersTime } from "./open-all-day.js";

/**
 * Batch 46 (v15 overnight 45): Test Merchant 2's published hours, as v15 stores them: every day
 * 00:00–23:59:59, Dine-in and Pickup, and on Sunday a 25-minute cut-off. Staff read
 * "12:00\u00a0AM–11:59\u00a0PM" and "last orders 25 minutes before closing" for a Store that never closes.
 */
const day = (isoWeekday: number) => ({
  isoWeekday,
  intervals: [
    {
      startLocalTime: "00:00:00",
      endLocalTime: "23:59:59",
      endsNextDay: false,
      serviceModes: ["DineIn", "Pickup"],
      orderCutoffSeconds: isoWeekday === 7 ? 1500 : 0,
      leadTimeSeconds: 0,
    },
  ],
});
const live = {
  configurationSource: "StoreOverride",
  businessDayStartLocalTime: "04:00:00",
  weeklySchedule: [1, 2, 3, 4, 5, 6, 7].map(day),
  exceptions: [
    {
      localDate: "2026-12-31",
      kind: "Override",
      intervals: [
        { ...day(1).intervals[0], endLocalTime: "12:00:00" },
        { ...day(1).intervals[0], startLocalTime: "12:00:00" },
      ],
    },
  ],
};

afterEach(() => setLanguageForTest("en"));

it("Hours & ordering says a whole day is open 24 hours, and when its orders stop", () => {
  const html = renderToStaticMarkup(
    <ServiceHoursSummary
      timeZone="America/Toronto"
      hours={live as never}
      observedAt="2026-11-22T05:14:00.000Z"
    />,
  );
  expect(html).toContain('<span class="hours-page__period">Open 24 hours · Dine-in, Pickup</span>');
  expect(html).toContain(
    '<span class="hours-page__period">Open 24 hours · Dine-in, Pickup · no orders after 23:34</span>',
  );
  const weekly = html.slice(0, html.indexOf("Special dates and holidays"));
  expect(weekly).not.toContain("23:59");
  expect(html).not.toContain("before closing");
  // Back-to-back periods: said once above them, each period still listed for staff.
  expect(html).toContain(
    '<span class="hours-page__period">Open 24 hours</span><span class="hours-page__period">00:00–12:00 · Dine-in, Pickup</span>',
  );
  setLanguageForTest("zh-Hans");
  const zh = renderToStaticMarkup(
    <ServiceHoursSummary
      timeZone="America/Toronto"
      hours={live as never}
      observedAt="2026-11-22T05:14:00.000Z"
    />,
  );
  expect(zh).toContain(
    '<span class="hours-page__period">24 小时营业 · 堂食、自取 · 23:34 后停止点单</span>',
  );
  expect(zh.slice(0, zh.indexOf("特殊日期和节假日"))).not.toContain("23:59");
});

it("the setup summaries say open 24 hours too", () => {
  expect(openingHoursLines(live.weeklySchedule as never)).toEqual(["Every day: open 24 hours"]);
  const ordinary = [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
    isoWeekday,
    intervals: [{ ...day(1).intervals[0], startLocalTime: "11:00:00", endLocalTime: "22:00:00" }],
  }));
  expect(openingHoursChanges(ordinary as never, live.weeklySchedule as never)[0]).toContain(
    "open 24 hours",
  );
  setLanguageForTest("zh-Hans");
  expect(openingHoursLines(live.weeklySchedule.slice(0, 6) as never)).toEqual([
    "每天：24 小时营业",
  ]);
});

it("a whole day is 00:00–23:59:59, 00:00–23:59 or periods back to back", () => {
  const at = (startLocalTime: string, endLocalTime: string, endsNextDay = false) => ({
    startLocalTime,
    endLocalTime,
    endsNextDay,
  });
  expect(isOpenAllDay([at("00:00:00", "23:59:59")])).toBe(true);
  expect(isOpenAllDay([at("00:00:00", "23:59:00")])).toBe(true);
  expect(isOpenAllDay([at("12:00:00", "23:59:59"), at("00:00:00", "12:00:00")])).toBe(true);
  expect(isOpenAllDay([at("00:00:00", "22:00:00")])).toBe(false);
  expect(isOpenAllDay([at("00:00:00", "11:00:00"), at("12:00:00", "23:59:59")])).toBe(false);
  expect(isOpenAllDay([at("17:00:00", "02:00:00", true)])).toBe(false);
  // Past midnight: staff still see when the extra hours end.
  expect(isOpenAllDay([at("00:00:00", "02:00:00", true)])).toBe(false);
  expect(isOpenAllDay([at("00:00:00", "11:59:59"), at("12:00:00", "02:00:00", true)])).toBe(false);
  expect(isOpenAllDay([at("00:00:00", "11:59:59"), at("12:00:00", "00:00:00", true)])).toBe(true);
  expect(lastOrdersTime(at("00:00:00", "23:59:59"), 1500)).toBe("23:34:59");
  expect(lastOrdersTime(at("17:00:00", "00:30:00", true), 1800)).toBe("00:00:00");
});

it("a period from midnight to 2:00 the next day keeps its end time on staff screens", () => {
  const overnight = [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
    isoWeekday,
    intervals: [{ ...day(1).intervals[0], endLocalTime: "02:00:00", endsNextDay: true }],
  }));
  const html = renderToStaticMarkup(
    <ServiceHoursSummary
      timeZone="America/Toronto"
      hours={{ ...live, weeklySchedule: overnight, exceptions: [] } as never}
      observedAt="2026-11-22T05:14:00.000Z"
    />,
  );
  expect(html).toContain(
    '<span class="hours-page__period">00:00–02:00 (next day) · Dine-in, Pickup</span>',
  );
  expect(html).not.toContain("Open 24 hours");
  expect(openingHoursLines(overnight as never)[0]).not.toContain("open 24 hours");
});
