import { describe, expect, it } from "vitest";
import {
  expandStoreServiceCalendar,
  StoreServiceCalendarError,
} from "../domain/expand-store-service-calendar.js";
import { evaluateStoreOperatingStatus } from "../domain/evaluate-store-operating-status.js";
import { resolveStoreOperatingLocalFields } from "../application/store-operating-status-service.js";
import { resolveStoreLocalInstant } from "../domain/resolve-business-date.js";

type Mode = "DineIn" | "Pickup" | "Delivery";
const pickup = (
  start: string,
  end: string,
  endsNextDay = false,
  modes: Mode[] = ["DineIn", "Pickup"],
) => ({
  startLocalTime: start,
  endLocalTime: end,
  endsNextDay,
  serviceModes: modes,
});
const weekdays = (
  intervals: ReturnType<typeof pickup>[],
  weekend: ReturnType<typeof pickup>[] = [],
) =>
  [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
    isoWeekday,
    intervals: isoWeekday <= 5 ? intervals : weekend,
  }));
const base = {
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  serviceMode: "Pickup" as const,
};

describe("expandStoreServiceCalendar (DEC-PICKUP-CAPACITY-SCHEDULE)", () => {
  it("lays the pilot's weekday 08:00-20:00 pickup hours out in UTC and skips the weekend", () => {
    const calendar = expandStoreServiceCalendar({
      ...base,
      weeklySchedule: weekdays([pickup("08:00:00", "20:00:00")]),
      exceptions: [],
      from: "2026-10-16T12:00:00.000Z", // Friday 08:00 EDT
      until: "2026-10-20T04:00:00.000Z", // Tuesday 00:00 EDT
    });
    expect(calendar.windows).toEqual([
      { startsAt: "2026-10-16T12:00:00.000Z", endsAt: "2026-10-17T00:00:00.000Z" },
      { startsAt: "2026-10-19T12:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z" },
    ]);
    expect(calendar.businessDays.map((day) => day.businessDate)).toEqual([
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
    ]);
    expect(calendar.businessDays[0]).toEqual({
      businessDate: "2026-10-16",
      startsAt: "2026-10-16T08:00:00.000Z",
      endsAt: "2026-10-17T08:00:00.000Z",
    });
  });

  it("keeps local opening times across both daylight-saving changes (23 and 25 hour days)", () => {
    const fall = expandStoreServiceCalendar({
      ...base,
      weeklySchedule: weekdays([], [pickup("08:00:00", "20:00:00")]),
      exceptions: [],
      from: "2026-10-31T04:00:00.000Z",
      until: "2026-11-02T05:00:00.000Z",
    });
    // Saturday in EDT (UTC-4), Sunday 1 November in EST (UTC-5).
    expect(fall.windows).toEqual([
      { startsAt: "2026-10-31T12:00:00.000Z", endsAt: "2026-11-01T00:00:00.000Z" },
      { startsAt: "2026-11-01T13:00:00.000Z", endsAt: "2026-11-02T01:00:00.000Z" },
    ]);
    // The clocks go back at 02:00, inside Saturday's business day (04:00 to 04:00).
    const long = fall.businessDays.find((day) => day.businessDate === "2026-10-31");
    if (long === undefined) throw Error("missing business day");
    expect(Date.parse(long.endsAt) - Date.parse(long.startsAt)).toBe(25 * 3_600_000);

    const spring = expandStoreServiceCalendar({
      ...base,
      weeklySchedule: weekdays([], [pickup("01:00:00", "04:00:00")]),
      exceptions: [],
      from: "2027-03-14T05:00:00.000Z",
      until: "2027-03-15T04:00:00.000Z",
    });
    // 01:00 EST to 04:00 EDT is two real hours on the spring-forward night.
    expect(spring.windows).toEqual([
      { startsAt: "2027-03-14T06:00:00.000Z", endsAt: "2027-03-14T08:00:00.000Z" },
    ]);
    const short = spring.businessDays.find((day) => day.businessDate === "2027-03-13");
    if (short === undefined) throw Error("missing business day");
    expect(Date.parse(short.endsAt) - Date.parse(short.startsAt)).toBe(23 * 3_600_000);
  });

  it("carries a late interval past midnight, merges touching intervals and filters by service", () => {
    const calendar = expandStoreServiceCalendar({
      ...base,
      weeklySchedule: weekdays(
        [
          pickup("11:00:00", "14:00:00"),
          pickup("14:00:00", "15:00:00"),
          pickup("17:00:00", "02:00:00", true),
          pickup("15:00:00", "17:00:00", false, ["DineIn"]),
        ],
        [],
      ),
      exceptions: [],
      from: "2026-10-16T04:00:00.000Z", // Friday 00:00 EDT
      until: "2026-10-17T12:00:00.000Z",
    });
    expect(calendar.windows).toEqual([
      { startsAt: "2026-10-16T04:00:00.000Z", endsAt: "2026-10-16T06:00:00.000Z" }, // Thursday tail
      { startsAt: "2026-10-16T15:00:00.000Z", endsAt: "2026-10-16T19:00:00.000Z" },
      { startsAt: "2026-10-16T21:00:00.000Z", endsAt: "2026-10-17T06:00:00.000Z" }, // into Saturday
    ]);
  });

  it("closes a holiday, replaces a day by its override and cuts the previous night's tail", () => {
    const calendar = expandStoreServiceCalendar({
      ...base,
      weeklySchedule: weekdays([
        pickup("08:00:00", "20:00:00"),
        pickup("22:00:00", "01:00:00", true),
      ]),
      exceptions: [
        { localDate: "2026-10-13", intervals: [] }, // Tuesday holiday
        { localDate: "2026-10-14", intervals: [pickup("10:00:00", "12:00:00")] },
      ],
      from: "2026-10-12T04:00:00.000Z",
      until: "2026-10-15T04:00:00.000Z",
    });
    expect(calendar.windows).toEqual([
      { startsAt: "2026-10-12T12:00:00.000Z", endsAt: "2026-10-13T00:00:00.000Z" },
      // Monday 22:00 runs only to the holiday's midnight, the holiday has no hours.
      { startsAt: "2026-10-13T02:00:00.000Z", endsAt: "2026-10-13T04:00:00.000Z" },
      { startsAt: "2026-10-14T14:00:00.000Z", endsAt: "2026-10-14T16:00:00.000Z" },
    ]);
  });

  it("agrees with the Store's operating evaluation at every quarter hour over a DST fortnight", () => {
    const weeklySchedule = weekdays(
      [pickup("07:30:00", "11:00:00"), pickup("16:45:00", "01:30:00", true)],
      [pickup("00:30:00", "03:15:00"), pickup("09:00:00", "23:00:00", false, ["Pickup"])],
    );
    const exceptions = [
      { localDate: "2026-10-28", intervals: [] },
      { localDate: "2026-11-02", intervals: [pickup("12:00:00", "13:00:00")] },
    ];
    const from = "2026-10-24T00:00:00.000Z",
      until = "2026-11-07T00:00:00.000Z";
    const calendar = expandStoreServiceCalendar({
      ...base,
      weeklySchedule,
      exceptions,
      from,
      until,
    });
    for (let at = Date.parse(from); at < Date.parse(until); at += 15 * 60_000) {
      const evaluatedAt = new Date(at).toISOString();
      const local = resolveStoreOperatingLocalFields(evaluatedAt as never, base.timeZone);
      const scheduled = evaluateStoreOperatingStatus({
        evaluatedAt,
        ...local,
        weeklySchedule,
        exceptions,
        temporaryClosures: [],
      }).availableServiceModes.includes("Pickup");
      const inWindow = calendar.windows.some(
        (window) => Date.parse(window.startsAt) <= at && at < Date.parse(window.endsAt),
      );
      expect([evaluatedAt, inWindow]).toEqual([evaluatedAt, scheduled]);
    }
  });

  it("resolves skipped and repeated local times like the business day does", () => {
    expect(
      resolveStoreLocalInstant({
        timeZone: "America/Toronto",
        localDate: "2027-03-14",
        localTime: "02:30:00",
      }),
    ).toEqual({ instant: "2027-03-14T07:00:00.000Z", disambiguation: "GapForward" });
    expect(
      resolveStoreLocalInstant({
        timeZone: "America/Toronto",
        localDate: "2026-11-01",
        localTime: "01:30:00",
      }),
    ).toEqual({ instant: "2026-11-01T05:30:00.000Z", disambiguation: "OverlapEarlier" });
  });

  it.each([
    ["an unknown zone", { timeZone: "Mars/Base" }],
    ["an incomplete week", { weeklySchedule: weekdays([]).slice(0, 6) }],
    ["a reversed window", { from: "2026-10-20T00:00:00.000Z", until: "2026-10-19T00:00:00.000Z" }],
    ["a window over 62 days", { until: "2027-01-01T00:00:00.000Z" }],
    [
      "a duplicate exception",
      {
        exceptions: [
          { localDate: "2026-10-20", intervals: [] },
          { localDate: "2026-10-20", intervals: [] },
        ],
      },
    ],
  ])("refuses %s", (_name, override) => {
    expect(() =>
      expandStoreServiceCalendar({
        ...base,
        weeklySchedule: weekdays([pickup("08:00:00", "20:00:00")]),
        exceptions: [],
        from: "2026-10-19T00:00:00.000Z",
        until: "2026-10-26T00:00:00.000Z",
        ...override,
      } as never),
    ).toThrow(StoreServiceCalendarError);
  });
});
