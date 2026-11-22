import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { parseStoreProfile, type StoreProfile } from "./store-profile-client.js";
import {
  StoreIdentityCard,
  storeHoursLine,
  storeHoursLineShown,
  storeStatusLine,
} from "./StoreIdentity.js";
import { formatClockTime, formatStoreLocalTime, keepTimeTogether } from "../journey/format.js";
import { intervalsText, isOpenAllDay, opensAgainAtMidnight } from "./store-hours-text.js";

/**
 * Batch 46 (v15 overnight 45): Test Merchant 2 publishes 00:00–23:59:59 every day (the only way
 * the hours model writes a whole day) with a 25-minute Sunday cut-off. Guests read "Open now ·
 * until 11:59 p.m. · last orders 11:34 p.m." and "Today 12:00 a.m.–11:59 p.m."; it reopens one
 * second later, so the Store is open 24 hours. The store read below is the live one at 00:14.
 */
const live = () => ({
  schemaVersion: 1,
  store: {
    storeDisplayName: "Test Merchant 2 Main - not production",
    brandDisplayName: "Test Merchant 2 - not production",
    timeZone: "America/Toronto",
    address: {
      addressLines: ["1 Test Street"],
      locality: "Toronto",
      regionCode: "ON",
      postalCode: "M5V 0A1",
      countryCode: "CA",
    },
    phone: null,
    kitchenStatement: null,
    hours: {
      status: "Open",
      todayHours: [{ startLocalTime: "00:00:00", endLocalTime: "23:59:59", endsNextDay: false }],
      closesAt: "23:59:59",
      opensAt: null,
      localDate: "2026-11-22",
      todayKind: null,
      lastOrdersAt: "23:34:59",
      pausedUntil: null,
      ordersStopped: false,
      nextOpening: null,
      tonight: null,
      upcoming: [],
    },
  },
});

function hoursOf(patch: Record<string, unknown> = {}): NonNullable<StoreProfile["hours"]> {
  const body = live();
  const hours = parseStoreProfile({
    ...body,
    store: { ...body.store, hours: { ...body.store.hours, ...patch } },
  }).hours;
  if (hours === null) throw new Error("hours are published");
  return hours;
}

const chinese = () =>
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
afterEach(() => {
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
});

it("a Store open 00:00–23:59:59 reads open 24 hours, with the cut-off it really has", () => {
  const hours = hoursOf();
  expect(storeStatusLine(hours)).toEqual({
    label: "Open 24 hours today",
    detail: "last orders 11:34\u00a0p.m.",
  });
  expect(storeHoursLine(hours)).toBe("open 24 hours");
  // Batch 47 (v15 b46: "Today open 24 hours" under the status that already says it): no line.
  expect(storeHoursLineShown(hours)).toBeNull();
  const card = renderToStaticMarkup(
    <StoreIdentityCard
      load={Object.assign(async () => parseStoreProfile(live()), {
        last: () => parseStoreProfile(live()),
      })}
    />,
  );
  expect(card).toContain("Open 24 hours today");
  expect(card.match(/24 hours/gu)).toHaveLength(1);
  expect(card).not.toContain("store-identity__hours");
  expect(card).not.toContain("11:59");
  expect(card).not.toContain("12:00 a.m.");
  // A day without a cut-off has no last orders to name.
  expect(storeStatusLine(hoursOf({ lastOrdersAt: null })).detail).toBeNull();
});

it("in Chinese a whole day reads 24 小时营业, never 营业至 23:59", () => {
  chinese();
  const hours = hoursOf();
  expect(storeStatusLine(hours)).toEqual({
    label: "今天 24 小时营业",
    detail: "厨房 23:34 停止接单",
  });
  const card = renderToStaticMarkup(
    <StoreIdentityCard
      load={Object.assign(async () => parseStoreProfile(live()), {
        last: () => parseStoreProfile(live()),
      })}
    />,
  );
  expect(card.match(/24 小时营业/gu)).toHaveLength(1);
  expect(card).not.toContain("store-identity__hours");
  expect(card).not.toContain("23:59");
  expect(card).not.toContain("营业至");
});

it("back-to-back periods and 00:00–23:59 cover the day; a gap or a late start does not", () => {
  const at = (start: string, end: string, endsNextDay = false) => ({
    startLocalTime: start,
    endLocalTime: end,
    endsNextDay,
  });
  expect(isOpenAllDay([at("00:00:00", "23:59:59")])).toBe(true);
  expect(isOpenAllDay([at("00:00:00", "23:59:00")])).toBe(true);
  expect(isOpenAllDay([at("12:00:00", "23:59:59"), at("00:00:00", "12:00:00")])).toBe(true);
  expect(isOpenAllDay([at("00:00:00", "11:59:59"), at("12:00:00", "00:00:00", true)])).toBe(true);
  // Open past midnight: the end time still matters to a guest, so it stays written out.
  expect(isOpenAllDay([at("00:00:00", "11:59:59"), at("12:00:00", "02:00:00", true)])).toBe(false);
  expect(isOpenAllDay([at("00:00:00", "02:00:00", true)])).toBe(false);
  expect(intervalsText([at("00:00:00", "02:00:00", true)])).toBe(
    "12:00\u00a0a.m.–2:00\u00a0a.m. (next day)",
  );
  expect(isOpenAllDay([at("00:00:00", "22:00:00")])).toBe(false);
  expect(isOpenAllDay([at("00:00:00", "11:00:00"), at("12:00:00", "23:59:59")])).toBe(false);
  expect(isOpenAllDay([at("06:00:00", "23:59:59")])).toBe(false);
  expect(isOpenAllDay([])).toBe(false);
  expect(intervalsText([at("00:00:00", "12:00:00"), at("12:00:00", "23:59:59")])).toBe(
    "open 24 hours",
  );
  // An ordinary day is still written out.
  const ordinary = hoursOf({
    todayHours: [{ startLocalTime: "07:00:00", endLocalTime: "22:00:00", endsNextDay: false }],
    closesAt: "22:00:00",
    lastOrdersAt: "21:30:00",
  });
  expect(storeStatusLine(ordinary).label).toBe("Open now");
  expect(storeStatusLine(ordinary).detail).toContain("until 10:00\u00a0p.m.");
  expect(storeHoursLineShown(ordinary)).toEqual({
    lead: "Today",
    text: "7:00\u00a0a.m.–10:00\u00a0p.m.",
  });
});

it("a whole day closed tomorrow on its weekly hours never promises more than today", () => {
  // 23:50 on a 00:00–23:59:59 day; tomorrow is an ordinary closed day, which an open profile
  // doesn't carry (nextOpening is null while open, upcoming lists only holidays).
  const hours = hoursOf({ lastOrdersAt: null });
  expect(storeStatusLine(hours).label).toBe("Open 24 hours today");
  chinese();
  expect(storeStatusLine(hoursOf({ lastOrdersAt: null })).label).toBe("今天 24 小时营业");
});

it("after a 24-hour day's last orders, ordering opens again at midnight, not 'closes at 11:59 p.m.'", () => {
  expect(
    opensAgainAtMidnight(
      "23:59:59",
      { localDate: "2026-11-23", startLocalTime: "00:00:00" },
      "2026-11-22",
    ),
  ).toBe(true);
  expect(
    opensAgainAtMidnight(
      "23:59:59",
      { localDate: "2026-11-24", startLocalTime: "00:00:00" },
      "2026-11-22",
    ),
  ).toBe(false);
  expect(
    opensAgainAtMidnight(
      "22:00:00",
      { localDate: "2026-11-23", startLocalTime: "00:00:00" },
      "2026-11-22",
    ),
  ).toBe(false);
  expect(
    opensAgainAtMidnight(
      "23:59:59",
      { localDate: "2026-11-23", startLocalTime: "11:00:00" },
      "2026-11-22",
    ),
  ).toBe(false);
});

it("batch 47: a 24-hour day while ordering is paused says it once, as one phrase", () => {
  const paused = hoursOf({ status: "Paused", pausedUntil: "12:30:00" });
  expect(storeStatusLine(paused).label).toBe("Online ordering paused");
  expect(storeHoursLineShown(paused)).toEqual({ lead: null, text: "Open 24 hours today" });
  chinese();
  expect(storeHoursLineShown(hoursOf())).toBeNull();
  expect(storeHoursLineShown(paused)).toEqual({ lead: null, text: "今天 24 小时营业" });
});

it("batch 47: a written time keeps its a.m./p.m. on its line (no-break space)", () => {
  expect(formatStoreLocalTime("23:34:59", "en-CA")).toBe("11:34\u00a0p.m.");
  expect(formatClockTime("2026-11-22T04:34:00.000Z", "en-CA")).toMatch(
    /^\d{1,2}:34\u00a0[ap]\.m\.$/u,
  );
  expect(formatStoreLocalTime("23:34:59", "zh-CN")).toBe("23:34");
  expect(keepTimeTogether("until 9:30 p.m. · last orders 9:00 a.m.")).toBe(
    "until 9:30\u00a0p.m. · last orders 9:00\u00a0a.m.",
  );
  // en-US's own narrow no-break space and words after a time are left as they are.
  expect(keepTimeTogether("9:30\u202fPM")).toBe("9:30\u202fPM");
  expect(keepTimeTogether("2 apples")).toBe("2 apples");
});
