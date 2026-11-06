import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), window: vi.fn(), first: vi.fn() }));
// Controlled owner reads. The closed-day source is modelled over the same reads at the
// day's start and last instant; its SQL change-point enumeration is covered by the
// database acceptance suite (store-historical-publication-acceptance).
vi.mock("../../packages/rms/store/src/index.ts", async (original) => {
  const store = await original();
  return {
    ...store,
    createPostgresStoreBusinessDateConfigurationSource: () => mocks.read,
    readStoreFirstConfigurationGoverningFrom: (...args) => mocks.first(...args),
    createPostgresStoreClosedBusinessDateWindowSource: () =>
      mocks.window.mockImplementation(async (tx, input) => {
        const anchor = await mocks.read(tx, input.anchorAt);
        const bounds = store.resolveStoreBusinessDateBounds({
          businessDate: input.businessDate,
          configuration: anchor,
        });
        const configurations = [];
        for (const at of [bounds.startsAt, new Date(Date.parse(bounds.endsAt) - 1).toISOString()]) {
          const value = await mocks.read(tx, at);
          if (JSON.stringify(configurations.at(-1)) !== JSON.stringify(value))
            configurations.push(value);
        }
        return store.resolveClosedStoreBusinessDateWindowAcross({
          businessDate: input.businessDate,
          observedAt: input.observedAt,
          configurations,
        });
      }),
  };
});
import {
  createInternalClosedSettlementWindow,
  createInternalSettlementDays,
} from "./pilot-settlement-window.mjs";
const id = (n) => "018f5000-0000-7000-8000-" + String(n).padStart(12, "0");
function fixture() {
  const configuration = {
    configurationReference: id(1),
    configurationVersion: 1,
    brandReference: id(2),
    storeReference: id(3),
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    businessDayStartSource: "PlatformDefault",
    contentDigest: "sha256:" + "a".repeat(64),
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
  };
  mocks.read.mockReset().mockResolvedValue(configuration);
  mocks.window.mockClear();
  const tx = {},
    active = vi.fn(async () => true);
  const resources = {
    scope: { brandReference: id(2), storeReference: id(3) },
    operating: { timeZone: configuration.timeZone, authorize: async () => true },
    now: () => "2026-09-22T04:30:00.000Z",
    transactions: { run: async (work) => work(tx) },
  };
  return {
    configuration,
    resources,
    tx,
    active,
    run: createInternalClosedSettlementWindow({ resources, active }),
  };
}
it("resolves the last closed local day and checks both endpoints in the retained transaction", async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({
    businessDate: "2026-09-20",
    startsAt: "2026-09-20T08:00:00.000Z",
    endsAt: "2026-09-21T08:00:00.000Z",
  });
  expect(mocks.window.mock.calls).toEqual([
    [
      f.tx,
      {
        businessDate: "2026-09-20",
        anchorAt: "2026-09-21T07:59:59.999Z",
        observedAt: "2026-09-22T04:30:00.000Z",
      },
    ],
  ]);
  expect(mocks.read.mock.calls.slice(0, 2)).toEqual([
    [f.tx, "2026-09-22T04:30:00.000Z"],
    [f.tx, "2026-09-21T07:59:59.999Z"],
  ]);
});
it("settles a day spanning versions with identical boundaries under the closing version", async () => {
  const f = fixture();
  const v2 = {
    ...f.configuration,
    configurationReference: "018f5000-0000-7000-8000-000000000009",
    configurationVersion: 2,
    contentDigest: "sha256:" + "b".repeat(64),
    effectiveFrom: "2026-09-20T18:00:00.000Z",
  };
  mocks.read.mockImplementation(async (_tx, at) => (at >= v2.effectiveFrom ? v2 : f.configuration));
  expect(await f.run()).toMatchObject({
    businessDate: "2026-09-20",
    startsAt: "2026-09-20T08:00:00.000Z",
    endsAt: "2026-09-21T08:00:00.000Z",
    configurationReference: v2.configurationReference,
    configurationVersion: 2,
  });
});
it("refuses a day whose versions place different boundaries", async () => {
  const f = fixture();
  const v2 = {
    ...f.configuration,
    configurationVersion: 2,
    businessDayStartLocalTime: "05:00:00",
    businessDayStartSource: "StoreOverride",
    effectiveFrom: "2026-09-20T18:00:00.000Z",
  };
  mocks.read.mockImplementation(async (_tx, at) => (at >= v2.effectiveFrom ? v2 : f.configuration));
  await expect(f.run()).rejects.toMatchObject({
    code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE",
  });
});
it("rejects a configuration that became effective inside the historical day", async () => {
  const f = fixture();
  mocks.read.mockResolvedValue({ ...f.configuration, effectiveFrom: "2026-09-20T12:00:00.000Z" });
  await expect(f.run()).rejects.toThrow();
});
it("rejects revoked installation before returning a window", async () => {
  const f = fixture();
  f.active.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.run()).rejects.toThrow("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
});

it("walks to the preceding historical day with current evidence time", async () => {
  const f = fixture(),
    latest = await f.run(),
    previous = await f.run({ endingAt: latest.startsAt });
  expect(previous).toMatchObject({
    businessDate: "2026-09-19",
    startsAt: "2026-09-19T08:00:00.000Z",
    endsAt: latest.startsAt,
  });
});
it.each([
  ["2026-03-08T08:00:00.000Z", "2026-03-07", 23],
  ["2026-11-01T09:00:00.000Z", "2026-10-31", 25],
])("uses owner DST boundaries ending %s", async (endingAt, businessDate, hours) => {
  const f = fixture();
  f.resources.now = () => "2026-11-03T12:00:00.000Z";
  const result = await f.run({ endingAt });
  expect(result.businessDate).toBe(businessDate);
  expect(Date.parse(result.endsAt) - Date.parse(result.startsAt)).toBe(hours * 3600000);
});
it.each([
  null,
  {},
  { endingAt: "invalid" },
  { endingAt: "2026-09-23T08:00:00.000Z" },
  { endingAt: "2026-09-20T08:01:00.000Z" },
  { endingAt: "2026-09-20T08:00:00Z" },
  { endingAt: "2026-09-20T08:00:00.000Z", extra: true },
])("rejects unsafe or non-boundary historical cursors %j", async (input) => {
  await expect(fixture().run(input)).rejects.toThrow("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
});

// WP-2423 v15: discovery finds a day by its bounds even when its window is refused.
it("gives a day's bounds without verifying every version that governed it", async () => {
  const f = fixture();
  const v2 = {
    ...f.configuration,
    configurationVersion: 2,
    businessDayStartLocalTime: "05:00:00",
    businessDayStartSource: "StoreOverride",
    effectiveFrom: "2026-09-20T18:00:00.000Z",
  };
  mocks.read.mockImplementation(async (_tx, at) => (at >= v2.effectiveFrom ? v2 : f.configuration));
  const days = createInternalSettlementDays({ resources: f.resources, active: f.active });
  await expect(days.window()).rejects.toMatchObject({
    code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE",
  });
  mocks.read.mockImplementation(async () => f.configuration);
  expect(await days.bounds()).toEqual({
    brandReference: f.resources.scope.brandReference,
    storeReference: f.resources.scope.storeReference,
    businessDate: "2026-09-20",
    startsAt: "2026-09-20T08:00:00.000Z",
    endsAt: "2026-09-21T08:00:00.000Z",
  });
  expect(await days.bounds({ endingAt: "2026-09-20T08:00:00.000Z" })).toMatchObject({
    businessDate: "2026-09-19",
    endsAt: "2026-09-20T08:00:00.000Z",
  });
  f.active.mockResolvedValue(false);
  await expect(days.bounds()).rejects.toThrow("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
});

// WP-2423 (settlement-coverage): the Store's own first business day, never the latest closed one.
it.each([
  // Opened mid-day on a Wednesday; three days have closed since.
  [
    "2026-11-05T01:13:00.000Z",
    "2026-11-07T12:00:00.000Z",
    "2026-11-04",
    "2026-11-04T09:00:00.000Z",
    "2026-11-05T09:00:00.000Z",
  ],
  // demo-3: opened Sun Nov 1 (the clocks went back at 02:00, inside business day Oct 31), so its
  // first day starts 04:00 EST.
  [
    "2026-11-01T18:37:00.000Z",
    "2026-11-05T12:00:00.000Z",
    "2026-11-01",
    "2026-11-01T09:00:00.000Z",
    "2026-11-02T09:00:00.000Z",
  ],
  // Opened inside the DST fall-back business day (25 h: 04:00 EDT to 04:00 EST).
  [
    "2026-10-31T20:15:00.000Z",
    "2026-11-03T12:00:00.000Z",
    "2026-10-31",
    "2026-10-31T08:00:00.000Z",
    "2026-11-01T09:00:00.000Z",
  ],
])(
  "first() is the day the Store opened in (%s), read late at %s",
  async (opening, now, businessDate, startsAt, endsAt) => {
    const f = fixture();
    f.resources.now = () => now;
    mocks.first.mockReset().mockResolvedValue(opening);
    const days = createInternalSettlementDays({ resources: f.resources, active: f.active });
    expect(await days.first()).toMatchObject({ businessDate, startsAt, endsAt });
    expect(mocks.first).toHaveBeenCalledWith(f.tx, f.resources.scope);
    // The window was verified for that day, anchored inside it.
    expect(mocks.window.mock.calls.at(-1)[1]).toMatchObject({
      businessDate,
      anchorAt: new Date(Date.parse(endsAt) - 1).toISOString(),
      observedAt: now,
    });
  },
);
it("first() is null while nothing governs or the first day is still open", async () => {
  const f = fixture();
  const days = createInternalSettlementDays({ resources: f.resources, active: f.active });
  mocks.first.mockReset().mockResolvedValue(null);
  expect(await days.first()).toBeNull();
  // now is 2026-09-22T04:30Z: a Store opened at 2026-09-21T20:00Z is in its first day until 08:00Z.
  mocks.first.mockResolvedValue("2026-09-21T20:00:00.000Z");
  expect(await days.first()).toBeNull();
  mocks.first.mockResolvedValue("2026-09-23T20:00:00.000Z");
  expect(await days.first()).toBeNull();
  expect(mocks.window).not.toHaveBeenCalled();
});
it("first() never answers for a refused or failed read", async () => {
  const f = fixture();
  const days = createInternalSettlementDays({ resources: f.resources, active: f.active });
  const refused = new Error("STORE_BUSINESS_DATE_UNAVAILABLE");
  mocks.first.mockReset().mockRejectedValue(refused);
  await expect(days.first()).rejects.toBe(refused);
  f.active.mockResolvedValue(false);
  mocks.first.mockResolvedValue(null);
  await expect(days.first()).rejects.toThrow("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
});
