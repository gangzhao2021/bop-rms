import { describe, expect, it } from "vitest";
import { describeStoreUpcomingHours } from "../domain/describe-store-upcoming-hours.js";

const period = (start: string, end: string, cutoffMinutes = 0, endsNextDay = false) => ({
  startLocalTime: start,
  endLocalTime: end,
  endsNextDay,
  orderCutoffSeconds: cutoffMinutes * 60,
});
// Synthetic store: lunch and dinner Tuesday to Sunday, closed Mondays; last orders 30 min early.
const weeklySchedule = [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
  isoWeekday,
  intervals:
    isoWeekday === 1
      ? []
      : [period("11:00:00", "14:30:00", 30), period("17:00:00", "22:00:00", 30)],
}));
const exceptions = [
  {
    localDate: "2026-12-24",
    kind: "Override" as const,
    intervals: [period("11:00:00", "16:00:00")],
  },
  { localDate: "2026-12-25", kind: "Holiday" as const, intervals: [] },
  { localDate: "2027-01-10", kind: "TemporaryClosure" as const, intervals: [] },
];
const at = (localDate: string, localTime: string) =>
  describeStoreUpcomingHours({ localDate, localTime, weeklySchedule, exceptions, days: 7 });

describe("WP-2423 item 8 ③ decision 16: the Store's hours ahead", () => {
  it("gives last orders in the current period and the next opening today", () => {
    // 2026-12-22 is a Tuesday.
    expect(at("2026-12-22", "21:10:00")).toMatchObject({
      todayKind: null,
      lastOrdersAt: "21:30:00",
      nextOpening: { localDate: "2026-12-23", startLocalTime: "11:00:00" },
    });
    expect(at("2026-12-22", "15:00:00")).toMatchObject({
      lastOrdersAt: null,
      nextOpening: { localDate: "2026-12-22", startLocalTime: "17:00:00" },
    });
  });
  it("lists holidays and special hours in the next 7 days, and none beyond", () => {
    const result = at("2026-12-22", "12:00:00");
    expect(result.upcoming.map((day) => [day.localDate, day.kind, day.intervals.length])).toEqual([
      ["2026-12-24", "Override", 1],
      ["2026-12-25", "Holiday", 0],
    ]);
  });
  it("on a holiday says so and opens next on the first published day after it", () => {
    const result = at("2026-12-25", "12:00:00");
    expect(result.todayKind).toBe("Holiday");
    expect(result.lastOrdersAt).toBeNull();
    // Saturday 26th opens at 11:00 as usual.
    expect(result.nextOpening).toEqual({ localDate: "2026-12-26", startLocalTime: "11:00:00" });
  });
  it("skips a closed Monday, and has no next opening when nothing is published", () => {
    // 2026-12-28 is a Monday.
    expect(at("2026-12-28", "10:00:00").nextOpening).toEqual({
      localDate: "2026-12-29",
      startLocalTime: "11:00:00",
    });
    const closed = describeStoreUpcomingHours({
      localDate: "2026-12-22",
      localTime: "12:00:00",
      weeklySchedule: weeklySchedule.map((day) => ({ ...day, intervals: [] })),
      exceptions: [],
      days: 7,
    });
    expect(closed.nextOpening).toBeNull();
  });
  it("reads last orders from an overnight period carried over from yesterday", () => {
    const late = describeStoreUpcomingHours({
      localDate: "2026-12-23",
      localTime: "00:40:00",
      weeklySchedule: weeklySchedule.map((day) => ({
        ...day,
        intervals: [period("18:00:00", "02:00:00", 45, true)],
      })),
      exceptions: [],
      days: 7,
    });
    expect(late.lastOrdersAt).toBe("01:15:00");
    expect(late.nextOpening).toEqual({ localDate: "2026-12-23", startLocalTime: "18:00:00" });
  });
  it("follow-up: says when last orders have passed, across midnight too", () => {
    expect(at("2026-12-22", "21:29:59")).toMatchObject({
      pastLastOrders: false,
      lastOrders: { localDate: "2026-12-22", localTime: "21:30:00" },
    });
    expect(at("2026-12-22", "21:30:00").pastLastOrders).toBe(true);
    expect(at("2026-12-22", "21:59:00").pastLastOrders).toBe(true);
    // Between periods, and in a period without a cut-off, nothing has passed.
    expect(at("2026-12-22", "15:00:00").pastLastOrders).toBe(false);
    expect(at("2026-12-24", "15:00:00")).toMatchObject({ pastLastOrders: false, lastOrders: null });
    const overnight = (localDate: string, localTime: string) =>
      describeStoreUpcomingHours({
        localDate,
        localTime,
        weeklySchedule: weeklySchedule.map((day) => ({
          ...day,
          intervals: [period("18:00:00", "02:00:00", 45, true)],
        })),
        exceptions: [],
        days: 7,
      });
    expect(overnight("2026-12-22", "23:30:00")).toMatchObject({
      pastLastOrders: false,
      lastOrders: { localDate: "2026-12-23", localTime: "01:15:00" },
    });
    expect(overnight("2026-12-23", "01:20:00")).toMatchObject({
      pastLastOrders: true,
      lastOrders: { localDate: "2026-12-23", localTime: "01:15:00" },
    });
  });
});
