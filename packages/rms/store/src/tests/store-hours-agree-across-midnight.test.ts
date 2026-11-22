import { describe, expect, it } from "vitest";
import {
  describeStoreBusinessDayClosing,
  describeStoreUpcomingHours,
} from "../domain/describe-store-upcoming-hours.js";
import { evaluateStoreOperatingStatus } from "../domain/evaluate-store-operating-status.js";

/**
 * Batch 36 (v15 2026-11-20 00:49 Toronto): Test Merchant 2 took a guest pickup order while its own
 * Home said the Store had closed. Its hours are 00:00-23:59:59 every day and its business day
 * starts at 04:00, so after midnight the open gate read the new date's hours (open) while Home
 * read the business date's (closed at 23:59:59). The open gate, the guest hours read and the
 * business day's closing must answer the same question the same way at every moment.
 */
interface Interval {
  startLocalTime: string;
  endLocalTime: string;
  endsNextDay: boolean;
  orderCutoffSeconds: number;
}
type Schedule = { isoWeekday: number; intervals: Interval[] }[];
interface Exception {
  localDate: string;
  kind: "Holiday" | "TemporaryClosure" | "Override";
  intervals: Interval[];
}

const p = (start: string, end: string, endsNextDay = false): Interval => ({
  startLocalTime: start,
  endLocalTime: end,
  endsNextDay,
  orderCutoffSeconds: 0,
});
const every = (...intervals: Interval[]): Schedule =>
  [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({ isoWeekday, intervals }));
const DAY = 86_400_000;
const shift = (localDate: string, days: number) =>
  new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
const weekday = (localDate: string) => {
  const day = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
};
const withModes = (intervals: readonly Interval[]) =>
  intervals.map(({ startLocalTime, endLocalTime, endsNextDay }) => ({
    startLocalTime,
    endLocalTime,
    endsNextDay,
    serviceModes: ["Pickup" as const],
  }));

/** Every answer at one Store-local moment (wall clock; the time zone is applied elsewhere). */
function answers(
  schedule: Schedule,
  exceptions: Exception[],
  businessDayStart: string,
  localDate: string,
  localTime: string,
) {
  const gate = evaluateStoreOperatingStatus({
    evaluatedAt: `${localDate}T${localTime}.000Z`,
    localDate,
    localTime,
    isoWeekday: weekday(localDate),
    weeklySchedule: schedule.map((day) => ({
      isoWeekday: day.isoWeekday,
      intervals: withModes(day.intervals),
    })),
    exceptions: exceptions.map((entry) => ({
      localDate: entry.localDate,
      intervals: withModes(entry.intervals),
    })),
    temporaryClosures: [],
  }).state;
  const hours = describeStoreUpcomingHours({
    localDate,
    localTime,
    weeklySchedule: schedule,
    exceptions,
    days: 7,
  });
  const businessDate = localTime < businessDayStart ? shift(localDate, -1) : localDate;
  const closing = describeStoreBusinessDayClosing({
    businessDate,
    businessDayStartLocalTime: businessDayStart,
    weeklySchedule: schedule,
    exceptions,
  });
  const now = `${localDate}T${localTime}`;
  const homeSaysClosed =
    closing.kind === "ClosedToday" ||
    (closing.kind === "Closes" && now >= `${closing.localDate}T${closing.localTime}`);
  return { gate, hours, businessDate, closing, homeSaysClosed };
}

const stores: {
  name: string;
  schedule: Schedule;
  exceptions: Exception[];
  businessDayStart: string;
}[] = [
  {
    name: "open all day, 00:00-23:59:59, business day from 04:00 (Test Merchant 2)",
    schedule: every(p("00:00:00", "23:59:59")),
    exceptions: [],
    businessDayStart: "04:00:00",
  },
  {
    name: "late night written as the next date's own period, 00:00-02:00",
    schedule: every(
      p("11:00:00", "14:30:00"),
      p("17:00:00", "23:59:59"),
      p("00:00:00", "02:00:00"),
    ),
    exceptions: [],
    businessDayStart: "04:00:00",
  },
  {
    name: "overnight 18:00-02:00, a holiday on Christmas Day",
    schedule: every(p("18:00:00", "02:00:00", true)),
    exceptions: [{ localDate: "2026-12-25", kind: "Holiday", intervals: [] }],
    businessDayStart: "04:00:00",
  },
  {
    name: "overnight to 05:00, past the 04:00 business-day start, closed Wednesdays",
    schedule: [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
      isoWeekday,
      intervals: isoWeekday === 3 ? [] : [p("18:00:00", "05:00:00", true)],
    })),
    exceptions: [],
    businessDayStart: "04:00:00",
  },
  {
    name: "lunch and dinner, business day from midnight",
    schedule: every(p("11:00:00", "14:30:00"), p("17:00:00", "22:00:00")),
    exceptions: [],
    businessDayStart: "00:00:00",
  },
];

function storeNamed(prefix: string) {
  const store = stores.find((entry) => entry.name.startsWith(prefix));
  if (store === undefined) throw new Error(prefix);
  return store;
}

describe("Batch 36: the open gate, the guest hours and Home agree at every moment", () => {
  for (const store of stores)
    it(store.name, () => {
      // Every 15 minutes (and the second before each boundary) from 2026-12-21 to 2026-12-28.
      for (let minute = 0; minute < 7 * 24 * 60; minute += 15) {
        const localDate = shift("2026-12-21", Math.floor(minute / 1440));
        for (const offset of [0, 15 * 60 - 1]) {
          const total = (minute % 1440) * 60 + offset;
          const localTime = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
            .map((part) => String(part).padStart(2, "0"))
            .join(":");
          const at = answers(
            store.schedule,
            store.exceptions,
            store.businessDayStart,
            localDate,
            localTime,
          );
          const where = `${store.name} at ${localDate} ${localTime}`;
          // Never take guest orders while Home says the Store has closed for the day...
          if (at.gate === "Open") expect(at.homeSaysClosed, where).toBe(false);
          // ...and Home's closed matches the gate once the day's last period has ended.
          if (at.homeSaysClosed) expect(at.gate, where).toBe("Closed");
          // The guest hours read names a current period exactly when the gate is open.
          expect(at.hours.currentPeriod !== null, where).toBe(at.gate === "Open");
        }
      }
    });

  it("keeps Test Merchant 2's day open at 00:49 after midnight", () => {
    const at = answers(every(p("00:00:00", "23:59:59")), [], "04:00:00", "2026-11-20", "00:49:00");
    expect(at.gate).toBe("Open");
    expect(at.businessDate).toBe("2026-11-19");
    // Batch 47: its business day (Nov 19 4:00 to Nov 20 4:00) closes when it ends, not at the end
    // of Nov 20 as v15 sent (closesAt 2026-11-24T04:59:59Z for the Nov 22 business day).
    expect(at.closing).toEqual({ kind: "Closes", localDate: "2026-11-20", localTime: "04:00:00" });
  });

  it("closes the business day at the end of a period carried past its start", () => {
    const closedWednesday = storeNamed("overnight to 05:00");
    // Tuesday 2026-12-22 18:00 to Wednesday 05:00; Wednesday's business day starts at 04:00.
    expect(
      describeStoreBusinessDayClosing({
        businessDate: "2026-12-23",
        businessDayStartLocalTime: "04:00:00",
        weeklySchedule: closedWednesday.schedule,
        exceptions: [],
      }),
    ).toEqual({ kind: "Closes", localDate: "2026-12-23", localTime: "05:00:00" });
    expect(answers(closedWednesday.schedule, [], "04:00:00", "2026-12-23", "04:30:00").gate).toBe(
      "Open",
    );
  });

  it("ends Christmas Eve's overnight period at midnight, as the open gate does", () => {
    const holiday = storeNamed("overnight 18:00-02:00");
    expect(
      describeStoreBusinessDayClosing({
        businessDate: "2026-12-24",
        businessDayStartLocalTime: "04:00:00",
        weeklySchedule: holiday.schedule,
        exceptions: holiday.exceptions,
      }),
    ).toEqual({ kind: "Closes", localDate: "2026-12-25", localTime: "00:00:00" });
    const after = answers(
      holiday.schedule,
      holiday.exceptions,
      "04:00:00",
      "2026-12-25",
      "01:00:00",
    );
    expect(after.gate).toBe("Closed");
    expect(after.hours.currentPeriod).toBeNull();
    expect(after.hours.pastLastOrders).toBe(false);
  });
});
