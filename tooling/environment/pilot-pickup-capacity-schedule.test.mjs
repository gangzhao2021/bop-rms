import { expect, it, vi } from "vitest";
import {
  createPickupCapacityScheduleDispatcher,
  pickupScheduleInput,
  pilotDefaultPickupCapacityPolicy,
  readInternalPickupCapacityHorizon,
} from "./pilot-pickup-capacity-schedule.mjs";

const pickup = (start, end) => ({
  startLocalTime: start,
  endLocalTime: end,
  endsNextDay: false,
  serviceModes: ["DineIn", "Pickup"],
});
const calendar = (overrides = {}) => ({
  evaluatedAt: "2026-10-19T12:00:00.000Z",
  configurationReference: "0198a700-0000-7000-8000-000000000001",
  configurationVersion: 3,
  contentDigest: `sha256:${"a".repeat(64)}`,
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  enabledServiceModes: ["DineIn", "Pickup"],
  capacityConfigurationReference: null,
  effectiveUntil: null,
  weeklySchedule: [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
    isoWeekday,
    intervals: isoWeekday <= 5 ? [pickup("08:00:00", "20:00:00")] : [],
  })),
  exceptions: [],
  ...overrides,
});

function setup({ results = [], read = calendar() } = {}) {
  let clock = Date.parse("2026-10-19T12:00:00.000Z");
  const tx = { query: vi.fn() };
  const resources = {
    now: () => new Date(clock).toISOString(),
    scope: { brandReference: "brand", storeReference: "store" },
    operating: { timeZone: "America/Toronto" },
    transactions: { run: vi.fn(async (work) => work(tx)) },
    credentials: { reference: vi.fn(() => "reference") },
    publicProfile: { binding: { validUntil: "2099-01-01T00:00:00.000Z" } },
  };
  const schedule = {
    apply: vi.fn(async () => results.shift()),
  };
  const readCalendar = vi.fn(async () => read);
  const log = vi.fn();
  const dispatcher = createPickupCapacityScheduleDispatcher({
    resources,
    schedule,
    readCalendar,
    allowed: () => true,
    log,
  });
  return { dispatcher, schedule, readCalendar, resources, tx, log, advance: (ms) => (clock += ms) };
}
const applied = (created, republished = 0, keptReserved = 0) => ({
  created,
  republished,
  keptReserved,
  coveredUntil: "2026-11-02T12:00:00.000Z",
});

it("runs at start, then every 5 minutes, with the Store's pickup hours 14 days ahead", async () => {
  const f = setup({ results: [applied(336), applied(0), applied(0, 2, 1)] });
  expect(await f.dispatcher.runOnce()).toBe(336);
  expect(f.readCalendar).toHaveBeenCalledWith(f.tx, "2026-10-19T12:00:00.000Z");
  const run = f.schedule.apply.mock.calls[0][0];
  expect(run).toMatchObject({
    observedAt: "2026-10-19T12:00:00.000Z",
    horizonUntil: "2026-11-02T12:00:00.000Z",
    timeZone: "America/Toronto",
    policy: { servicePerHour: 20, outsideServicePerHour: 100 },
    generateReference: f.resources.credentials.reference,
  });
  // Ten weekdays of 08:00-20:00 Toronto time; Monday 2 November opens after the horizon.
  expect(run.serviceWindows).toHaveLength(10);
  expect(run.serviceWindows[0]).toEqual({
    startsAt: "2026-10-19T12:00:00.000Z",
    endsAt: "2026-10-20T00:00:00.000Z",
  });
  expect(run.serviceWindows.at(-1)).toEqual({
    startsAt: "2026-10-30T12:00:00.000Z",
    endsAt: "2026-10-31T00:00:00.000Z",
  });
  expect(f.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "pickup_capacity_schedule_applied", created: 336 }),
  );
  f.advance(4 * 60_000);
  expect(await f.dispatcher.runOnce()).toBe(0);
  expect(f.schedule.apply).toHaveBeenCalledTimes(1);
  f.advance(60_000);
  expect(await f.dispatcher.runOnce()).toBe(0);
  expect(f.log).toHaveBeenCalledTimes(1); // nothing to do is not logged
  f.advance(5 * 60_000);
  expect(await f.dispatcher.runOnce()).toBe(2);
  expect(await f.dispatcher.stop()).toBe("drained");
});

it("retries at the next poll after a failed run (nothing is assumed written)", async () => {
  const f = setup({ results: [applied(1)] });
  f.schedule.apply.mockRejectedValueOnce(new Error("database"));
  await expect(f.dispatcher.runOnce()).rejects.toThrow("database");
  expect(await f.dispatcher.runOnce()).toBe(1);
});

it("refuses a Store that names its own capacity configuration instead of guessing", async () => {
  const f = setup({
    read: calendar({ capacityConfigurationReference: "0198a700-0000-7000-8000-0000000000cc" }),
  });
  await expect(f.dispatcher.runOnce()).rejects.toThrow("PICKUP_CAPACITY_POLICY_UNAVAILABLE");
  expect(f.schedule.apply).not.toHaveBeenCalled();
});

it("stops at the published configuration's end and lays after-hours capacity without pickup", () => {
  const input = pickupScheduleInput(
    calendar({ effectiveUntil: "2026-10-22T04:00:00.000Z", enabledServiceModes: ["DineIn"] }),
    "2026-10-19T12:00:00.000Z",
  );
  expect(input.horizonUntil).toBe("2026-10-22T04:00:00.000Z");
  expect(input.serviceWindows).toEqual([]);
  expect(input.businessDays[0].businessDate).toBe("2026-10-19");
  expect(() =>
    pickupScheduleInput(
      calendar({ effectiveUntil: "2026-10-19T12:00:00.000Z" }),
      "2026-10-19T12:00:00.000Z",
    ),
  ).toThrow("PICKUP_CAPACITY_CONFIGURATION_ENDED");
  expect(pilotDefaultPickupCapacityPolicy.policyCode).toBe("PILOT_DEFAULT_PICKUP_CAPACITY_V1");
});

it("fails the cycle outside the pilot binding and on bad configuration", async () => {
  const f = setup();
  const closed = createPickupCapacityScheduleDispatcher({
    resources: f.resources,
    schedule: f.schedule,
    readCalendar: f.readCalendar,
    allowed: () => false,
  });
  await expect(closed.runOnce()).rejects.toThrow("INTERNAL_PICKUP_CAPACITY_SCHEDULE_UNAVAILABLE");
  expect(() =>
    createPickupCapacityScheduleDispatcher({
      resources: f.resources,
      schedule: f.schedule,
      intervalMs: 0,
    }),
  ).toThrow("PICKUP_CAPACITY_SCHEDULE_CONFIG_INVALID");
});

it("reports how far ahead pickup capacity is set up for the operations monitor", async () => {
  const f = setup();
  const store = { coverage: vi.fn(async () => ({ coveredUntil: "2026-10-20T00:00:00.000Z" })) };
  expect(await readInternalPickupCapacityHorizon(f.resources, store)).toEqual({
    observedAt: "2026-10-19T12:00:00.000Z",
    coveredMs: 12 * 3_600_000,
  });
});
