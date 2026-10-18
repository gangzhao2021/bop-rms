import { describe, expect, it } from "vitest";
import {
  PickupCapacityScheduleError,
  pickupCapacityCoverageEnd,
  pickupSlotCapacityLimit,
  planPickupCapacitySchedule,
  type PickupCapacityExistingSlot,
  type PickupCapacityScheduleInput,
} from "../domain/pickup-capacity-schedule.js";

const HOUR = 3_600_000;
const policy = { servicePerHour: 20, outsideServicePerHour: 100 };
const iso = (ms: number) => new Date(ms).toISOString();
/** Toronto business days (04:00 local) covering the window, computed independently. */
function torontoDays(fromDate: string, count: number) {
  const days: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const date = new Date(Date.parse(`${fromDate}T00:00:00.000Z`) + n * 86_400_000)
      .toISOString()
      .slice(0, 10);
    days.push(date);
  }
  const start = (date: string) => {
    // 04:00 local: EDT (UTC-4) until 1 November 2026, EST (UTC-5) after, EDT from 14 March 2027.
    const edt = date < "2026-11-01" || date >= "2027-03-14";
    return `${date}T0${edt ? 8 : 9}:00:00.000Z`;
  };
  return days.map((date, index) => ({
    businessDate: date,
    startsAt: start(date),
    endsAt: start(
      index + 1 < days.length
        ? (days[index + 1] ?? date)
        : new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10),
    ),
  }));
}
function input(overrides: Partial<PickupCapacityScheduleInput> = {}): PickupCapacityScheduleInput {
  return {
    observedAt: "2026-10-19T12:00:00.000Z", // Monday 08:00 EDT
    horizonUntil: "2026-10-20T12:00:00.000Z",
    timeZone: "America/Toronto",
    serviceWindows: [{ startsAt: "2026-10-19T12:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z" }],
    businessDays: torontoDays("2026-10-18", 4),
    existingSlots: [],
    policy,
    ...overrides,
  };
}
const asExisting = (
  plan: ReturnType<typeof planPickupCapacitySchedule>,
  reserved: (index: number) => boolean = () => false,
): PickupCapacityExistingSlot[] =>
  plan.create.map((slot, index) => ({
    slotReference: `0198a700-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    configVersion: 1,
    capacityLimit: slot.capacityLimit,
    reserved: reserved(index),
  }));

describe("planPickupCapacitySchedule (DEC-PICKUP-CAPACITY-SCHEDULE)", () => {
  it("covers every hour ahead without gaps, with service and after-hours capacity", () => {
    const plan = planPickupCapacitySchedule(input());
    expect(plan.create).toHaveLength(24);
    expect(plan.coveredUntil).toBe("2026-10-20T12:00:00.000Z");
    plan.create.forEach((slot, index) => {
      expect(Date.parse(slot.endsAt) - Date.parse(slot.startsAt)).toBe(HOUR);
      if (index > 0) expect(slot.startsAt).toBe(plan.create[index - 1]?.endsAt);
    });
    expect(plan.create.slice(0, 12).every((slot) => slot.capacityLimit === 20)).toBe(true);
    expect(plan.create.slice(12).every((slot) => slot.capacityLimit === 100)).toBe(true);
    // 00:00-04:00 local belongs to Monday's business date, 04:00 onward to Tuesday's.
    expect(
      plan.create.find((slot) => slot.startsAt === "2026-10-20T07:00:00.000Z")?.businessDate,
    ).toBe("2026-10-19");
    expect(
      plan.create.find((slot) => slot.startsAt === "2026-10-20T08:00:00.000Z")?.businessDate,
    ).toBe("2026-10-20");
  });

  it("is idempotent: a second plan over its own slots creates and republishes nothing", () => {
    const first = planPickupCapacitySchedule(input());
    const again = planPickupCapacitySchedule(input({ existingSlots: asExisting(first) }));
    expect(again.create).toEqual([]);
    expect(again.republish).toEqual([]);
    expect(again.coveredUntil).toBe(first.coveredUntil);
  });

  it("ends at the last whole slot before an off-hour horizon, so later runs add whole slots", () => {
    const first = planPickupCapacitySchedule(
      input({ observedAt: "2026-10-19T12:10:00.000Z", horizonUntil: "2026-10-20T12:10:00.000Z" }),
    );
    expect(first.create[0]?.startsAt).toBe("2026-10-19T12:10:00.000Z");
    expect(first.coveredUntil).toBe("2026-10-20T12:00:00.000Z");
    // Five minutes later the horizon moved five minutes: nothing to add yet.
    const later = planPickupCapacitySchedule(
      input({
        observedAt: "2026-10-19T12:15:00.000Z",
        horizonUntil: "2026-10-20T12:15:00.000Z",
        existingSlots: asExisting(first),
      }),
    );
    expect(later.create).toEqual([]);
    // Once the horizon passes the next hour, one whole hour is added.
    const hourLater = planPickupCapacitySchedule(
      input({
        observedAt: "2026-10-19T13:01:00.000Z",
        horizonUntil: "2026-10-20T13:01:00.000Z",
        existingSlots: asExisting(first),
      }),
    );
    expect(hourLater.create.map((slot) => [slot.startsAt, slot.endsAt])).toEqual([
      ["2026-10-20T12:00:00.000Z", "2026-10-20T13:00:00.000Z"],
    ]);
  });

  it("catches up after downtime from the current instant, cut at the next local hour", () => {
    const plan = planPickupCapacitySchedule(
      input({
        observedAt: "2026-10-19T14:26:31.598Z",
        // The last slot of an older schedule ended before the worker came back.
        existingSlots: [
          {
            slotReference: "0198a700-0000-7000-8000-0000000000aa",
            startsAt: "2026-10-19T13:00:00.000Z",
            endsAt: "2026-10-19T14:00:00.000Z",
            configVersion: 1,
            capacityLimit: 20,
            reserved: true,
          },
        ],
      }),
    );
    expect(plan.create[0]).toEqual({
      startsAt: "2026-10-19T14:26:31.598Z",
      endsAt: "2026-10-19T15:00:00.000Z",
      businessDate: "2026-10-19",
      capacityLimit: 12, // 20 an hour for 33.5 minutes, rounded up
    });
    expect(plan.create[1]?.startsAt).toBe("2026-10-19T15:00:00.000Z");
  });

  it("continues an older schedule from where its last slot ends, even off the hour", () => {
    const plan = planPickupCapacitySchedule(
      input({
        existingSlots: [
          {
            slotReference: "0198a700-0000-7000-8000-0000000000ab",
            startsAt: "2026-10-19T11:00:00.000Z",
            endsAt: "2026-10-19T12:26:31.598Z",
            configVersion: 1,
            capacityLimit: 20,
            reserved: true,
          },
        ],
      }),
    );
    expect(plan.create[0]?.startsAt).toBe("2026-10-19T12:26:31.598Z");
    expect(plan.create[0]?.endsAt).toBe("2026-10-19T13:00:00.000Z");
    expect(plan.create.some((slot) => slot.startsAt < "2026-10-19T12:26:31.598Z")).toBe(false);
  });

  it("cuts slots at opening and closing times that are not on the hour", () => {
    const plan = planPickupCapacitySchedule(
      input({
        serviceWindows: [
          { startsAt: "2026-10-19T11:30:00.000Z", endsAt: "2026-10-19T23:45:00.000Z" },
        ],
        observedAt: "2026-10-19T10:00:00.000Z",
      }),
    );
    const at = (startsAt: string) => plan.create.find((slot) => slot.startsAt === startsAt);
    expect(at("2026-10-19T11:00:00.000Z")).toMatchObject({
      endsAt: "2026-10-19T11:30:00.000Z",
      capacityLimit: 50,
    });
    expect(at("2026-10-19T11:30:00.000Z")).toMatchObject({
      endsAt: "2026-10-19T12:00:00.000Z",
      capacityLimit: 10,
    });
    expect(at("2026-10-19T23:00:00.000Z")).toMatchObject({
      endsAt: "2026-10-19T23:45:00.000Z",
      capacityLimit: 15,
    });
    expect(at("2026-10-19T23:45:00.000Z")).toMatchObject({
      endsAt: "2026-10-20T00:00:00.000Z",
      capacityLimit: 25,
    });
  });

  it("treats hours that end at 23:59:59 as end of day, without a one-second slot", () => {
    // TEST hours 00:00-23:59:59 local (EDT): service through the whole local day.
    const plan = planPickupCapacitySchedule(
      input({
        observedAt: "2026-10-19T12:00:00.000Z",
        horizonUntil: "2026-10-21T12:00:00.000Z",
        serviceWindows: [
          { startsAt: "2026-10-19T04:00:00.000Z", endsAt: "2026-10-20T03:59:59.000Z" },
          { startsAt: "2026-10-20T04:00:00.000Z", endsAt: "2026-10-21T03:59:59.000Z" },
          { startsAt: "2026-10-21T04:00:00.000Z", endsAt: "2026-10-22T03:59:59.000Z" },
        ],
      }),
    );
    expect(plan.create).toHaveLength(48);
    plan.create.forEach((slot) => {
      expect(Date.parse(slot.endsAt) - Date.parse(slot.startsAt)).toBe(HOUR);
      expect(slot.capacityLimit).toBe(20);
    });
    expect(plan.create.find((slot) => slot.startsAt === "2026-10-20T03:00:00.000Z")).toMatchObject({
      endsAt: "2026-10-20T04:00:00.000Z",
    });
    // Existing one-second slots from earlier runs stay as they are; nothing is moved or added.
    const existing = asExisting(
      planPickupCapacitySchedule(
        input({
          serviceWindows: [
            { startsAt: "2026-10-19T12:00:00.000Z", endsAt: "2026-10-20T03:59:59.000Z" },
          ],
        }),
      ),
    ).map((slot) =>
      slot.endsAt === "2026-10-20T04:00:00.000Z"
        ? { ...slot, endsAt: "2026-10-20T03:59:59.000Z" }
        : slot,
    );
    existing.push({
      slotReference: "0198a700-0000-7000-8000-0000000000ff",
      startsAt: "2026-10-20T03:59:59.000Z",
      endsAt: "2026-10-20T04:00:00.000Z",
      configVersion: 1,
      capacityLimit: 1,
      reserved: false,
    });
    const again = planPickupCapacitySchedule(
      input({
        existingSlots: existing,
        serviceWindows: [
          { startsAt: "2026-10-19T12:00:00.000Z", endsAt: "2026-10-20T03:59:59.000Z" },
        ],
      }),
    );
    expect(again.create).toHaveLength(0);
    expect(again.coveredUntil).toBe("2026-10-20T12:00:00.000Z");
  });

  it("lays 25 one-hour slots on the autumn daylight-saving day and 23 in spring", () => {
    const fall = planPickupCapacitySchedule(
      input({
        observedAt: "2026-11-01T04:00:00.000Z", // 1 November 00:00 EDT
        horizonUntil: "2026-11-02T05:00:00.000Z", // 2 November 00:00 EST
        serviceWindows: [],
        businessDays: torontoDays("2026-10-31", 3),
      }),
    );
    expect(fall.create).toHaveLength(25); // 01:00 local happens twice
    expect(
      fall.create.every((slot) => Date.parse(slot.endsAt) - Date.parse(slot.startsAt) === HOUR),
    ).toBe(true);
    const spring = planPickupCapacitySchedule(
      input({
        observedAt: "2027-03-14T05:00:00.000Z", // 14 March 00:00 EST
        horizonUntil: "2027-03-15T04:00:00.000Z", // 15 March 00:00 EDT
        serviceWindows: [],
        businessDays: torontoDays("2027-03-13", 3),
      }),
    );
    expect(spring.create).toHaveLength(23);
    expect(spring.create.every((slot) => slot.capacityLimit === 100)).toBe(true);
  });

  it("gives a closed day (holiday or no hours) after-hours capacity only", () => {
    const plan = planPickupCapacitySchedule(input({ serviceWindows: [] }));
    expect(plan.create.every((slot) => slot.capacityLimit === 100)).toBe(true);
  });

  it("follows changed hours on future unreserved slots and never touches reserved or current ones", () => {
    const first = planPickupCapacitySchedule(input({ observedAt: "2026-10-19T11:59:00.000Z" }));
    const existing = asExisting(first, (index) => index === 3);
    // The Store now closes at 18:00 instead of 20:00.
    const changed = planPickupCapacitySchedule(
      input({
        observedAt: "2026-10-19T12:30:00.000Z",
        existingSlots: existing,
        serviceWindows: [
          { startsAt: "2026-10-19T12:00:00.000Z", endsAt: "2026-10-19T22:00:00.000Z" },
        ],
      }),
    );
    expect(changed.create).toEqual([]);
    expect(changed.republish.map((change) => [change.capacityLimit, change.configVersion])).toEqual(
      [
        [100, 2],
        [100, 2],
      ],
    );
    const changedStarts = changed.republish.map(
      (change) => existing.find((slot) => slot.slotReference === change.slotReference)?.startsAt,
    );
    expect(changedStarts).toEqual(["2026-10-19T22:00:00.000Z", "2026-10-19T23:00:00.000Z"]);
    // Opening earlier turns after-hours slots into service; the reserved 14:00 slot keeps its version.
    const before = asExisting(
      planPickupCapacitySchedule(
        input({ observedAt: "2026-10-19T09:00:00.000Z", serviceWindows: [] }),
      ),
      (index) => index === 5,
    );
    const earlier = planPickupCapacitySchedule(
      input({ observedAt: "2026-10-19T11:59:30.000Z", existingSlots: before }),
    );
    expect(earlier.republish).toHaveLength(11);
    expect(earlier.republish.every((change) => change.capacityLimit === 20)).toBe(true);
    expect(
      earlier.republish.some((change) => change.slotReference === before[5]?.slotReference),
    ).toBe(false);
  });

  it("refuses inconsistent input", () => {
    expect(() =>
      planPickupCapacitySchedule(input({ horizonUntil: "2026-10-19T12:00:00.000Z" })),
    ).toThrow(PickupCapacityScheduleError);
    expect(() =>
      planPickupCapacitySchedule(input({ businessDays: torontoDays("2026-10-19", 1) })),
    ).toThrow(PickupCapacityScheduleError);
    expect(() =>
      planPickupCapacitySchedule(
        input({ policy: { servicePerHour: 0, outsideServicePerHour: 1 } }),
      ),
    ).toThrow(PickupCapacityScheduleError);
    expect(() =>
      planPickupCapacitySchedule(
        input({
          serviceWindows: [
            { startsAt: "2026-10-19T12:00:00.000Z", endsAt: "2026-10-19T16:00:00.000Z" },
            { startsAt: "2026-10-19T15:00:00.000Z", endsAt: "2026-10-19T17:00:00.000Z" },
          ],
        }),
      ),
    ).toThrow(PickupCapacityScheduleError);
  });

  it("measures gap-free coverage from an instant", () => {
    const slots = [
      { startsAt: iso(0), endsAt: iso(HOUR) },
      { startsAt: iso(HOUR), endsAt: iso(2 * HOUR) },
      { startsAt: iso(3 * HOUR), endsAt: iso(4 * HOUR) },
    ];
    expect(pickupCapacityCoverageEnd(slots, iso(1_000))).toBe(iso(2 * HOUR));
    expect(pickupCapacityCoverageEnd(slots, iso(2 * HOUR + 1))).toBe(iso(2 * HOUR + 1));
    expect(pickupSlotCapacityLimit(60_000, true, policy)).toBe(1);
  });
});
