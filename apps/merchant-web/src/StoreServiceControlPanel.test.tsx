import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { ServiceHoursSummary, operatingDate, serviceTime } from "./StoreServiceControlPanel.js";

afterEach(() => setLanguageForTest("en"));

const text = (html: string) => html.replace(/<[^>]+>/gu, "\n");

it("WP-2423 Q4, batch 46: writes published hours in staff language, as guests read times", () => {
  expect(serviceTime("09:00:00")).toBe("9:00 a.m.");
  expect(serviceTime("00:00:00")).toBe("12:00 a.m.");
  expect(serviceTime("12:30:00")).toBe("12:30 p.m.");
  expect(serviceTime("23:59:59")).toBe("11:59 p.m.");
  const interval = {
    startLocalTime: "11:00:00",
    endLocalTime: "21:30:00",
    endsNextDay: false,
    serviceModes: ["DineIn", "Pickup"],
    orderCutoffSeconds: 900,
    leadTimeSeconds: 0,
  };
  const html = renderToStaticMarkup(
    <ServiceHoursSummary
      timeZone="America/Toronto"
      observedAt="2026-12-01T17:00:00.000Z"
      hours={
        {
          configurationSource: "StoreOverride",
          businessDayStartLocalTime: "04:00:00",
          weeklySchedule: [
            { isoWeekday: 1, intervals: [interval] },
            { isoWeekday: 2, intervals: [] },
          ],
          exceptions: [{ localDate: "2026-12-25", kind: "TemporaryClosure", intervals: [] }],
        } as never
      }
    />,
  );
  expect(html).toContain(
    "11:00 a.m.–9:30 p.m. · Dine-in, Pickup · last orders 15 minutes before closing",
  );
  expect(html).toContain("Business day starts at 4:00 a.m.<");
  expect(html).not.toContain("DineIn");
  expect(html).not.toContain("0 seconds");
  expect(html).toContain("<h3>Tuesday</h3><p>Closed</p>");
  expect(text(html)).toContain("Fri, Dec 25\n · Temporary closure");
  expect(html).not.toContain("2026-12-25<");
  expect(html).not.toContain("TemporaryClosure");
});

// The v15 overnight check (Fireside Hotpot, 00:12 on Sun Nov 22 in Toronto).
const dinner = {
  startLocalTime: "17:00:00",
  endLocalTime: "00:00:00",
  endsNextDay: true,
  serviceModes: ["DineIn"],
  orderCutoffSeconds: 1800,
  leadTimeSeconds: 900,
};
const hotpot = {
  configurationSource: "StoreOverride",
  businessDayStartLocalTime: "04:00:00",
  weeklySchedule: [{ isoWeekday: 7, intervals: [dinner] }],
  exceptions: [
    { localDate: "2026-11-05", kind: "Override", intervals: [dinner] },
    { localDate: "2026-11-21", kind: "Override", intervals: [dinner] },
    { localDate: "2026-12-25", kind: "Holiday", intervals: [] },
  ],
} as never;

it("batch 46: Chinese hours read as whole Chinese phrases with full-width brackets", () => {
  setLanguageForTest("zh-Hans");
  const html = renderToStaticMarkup(
    <ServiceHoursSummary
      timeZone="America/Toronto"
      observedAt="2026-11-22T05:12:00.000Z"
      hours={hotpot}
    />,
  );
  expect(html).toContain("17:00–0:00（次日）· 堂食 · 打烊前 30 分钟停止点单 · 预计 15 分钟做好");
  expect(html).toContain("营业日从 4:00 开始。");
  // Place names are translated when the module loads (a language switch reloads the app).
  expect(html).toMatch(/门店配置 · 北美东部时间（[^（）()]+）</u);
  expect(html).not.toContain("最后点单");
  expect(html).not.toContain("00:00");
  expect(text(html)).toContain("今天 · 11月21日周六\n · 特殊营业时间");
  expect(text(html)).toContain("12月25日周五\n · 节假日");
  expect(html).not.toContain("Holiday");
});

it("batch 46: special dates before today's operating day are no longer listed", () => {
  const html = renderToStaticMarkup(
    <ServiceHoursSummary
      timeZone="America/Toronto"
      observedAt="2026-11-22T05:12:00.000Z"
      hours={hotpot}
    />,
  );
  expect(html).not.toContain("2026-11-05");
  expect(html).not.toContain("Nov 5");
  expect(text(html)).toContain("Today · Sat, Nov 21\n · Special hours");
  const later = renderToStaticMarkup(
    <ServiceHoursSummary
      timeZone="America/Toronto"
      observedAt="2026-12-26T15:00:00.000Z"
      hours={hotpot}
    />,
  );
  expect(later).toContain("No special dates or holidays coming up.");
});

it("batch 46: the operating day runs until the business-day start, in the Store's zone", () => {
  expect(operatingDate("2026-11-22T05:12:00.000Z", "America/Toronto", "04:00:00")).toBe(
    "2026-11-21",
  );
  expect(operatingDate("2026-11-22T09:00:00.000Z", "America/Toronto", "04:00:00")).toBe(
    "2026-11-22",
  );
  expect(operatingDate("2026-03-01T05:00:00.000Z", "America/Vancouver", "00:00:00")).toBe(
    "2026-02-28",
  );
  expect(operatingDate("2026-01-01T06:30:00.000Z", "America/Toronto", "04:00:00")).toBe(
    "2025-12-31",
  );
});
