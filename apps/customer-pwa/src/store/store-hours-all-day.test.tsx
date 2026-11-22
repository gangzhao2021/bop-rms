import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { parseStoreProfile, type StoreProfile } from "./store-profile-client.js";
import { StoreIdentityCard, storeHoursLine, storeStatusLine } from "./StoreIdentity.js";
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
    label: "Open 24 hours",
    detail: "last orders 11:34 p.m.",
  });
  expect(storeHoursLine(hours)).toBe("open 24 hours");
  const card = renderToStaticMarkup(
    <StoreIdentityCard
      load={Object.assign(async () => parseStoreProfile(live()), {
        last: () => parseStoreProfile(live()),
      })}
    />,
  );
  expect(card).toContain("Open 24 hours");
  expect(card).toContain("<span>Today</span> open 24 hours");
  expect(card).not.toContain("11:59");
  expect(card).not.toContain("12:00 a.m.");
  // A day without a cut-off has no last orders to name.
  expect(storeStatusLine(hoursOf({ lastOrdersAt: null })).detail).toBeNull();
});

it("in Chinese a whole day reads 24 小时营业, never 营业至 23:59", () => {
  chinese();
  const hours = hoursOf();
  expect(storeStatusLine(hours)).toEqual({ label: "24 小时营业", detail: "厨房 23:34 停止接单" });
  const card = renderToStaticMarkup(
    <StoreIdentityCard
      load={Object.assign(async () => parseStoreProfile(live()), {
        last: () => parseStoreProfile(live()),
      })}
    />,
  );
  expect(card).toContain("<span>今天</span> 24 小时营业");
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
  expect(isOpenAllDay([at("00:00:00", "11:59:59"), at("12:00:00", "02:00:00", true)])).toBe(true);
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
  expect(storeStatusLine(ordinary).detail).toContain("until 10:00 p.m.");
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
