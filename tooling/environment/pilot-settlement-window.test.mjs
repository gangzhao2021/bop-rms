import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../packages/rms/store/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresStoreBusinessDateConfigurationSource: () => mocks.read,
}));
import { createInternalClosedSettlementWindow } from "./pilot-settlement-window.mjs";
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
  expect(mocks.read.mock.calls).toEqual([
    [f.tx, "2026-09-22T04:30:00.000Z"],
    [f.tx, "2026-09-21T07:59:59.999Z"],
    [f.tx, "2026-09-20T08:00:00.000Z"],
    [f.tx, "2026-09-21T07:59:59.999Z"],
  ]);
});
it("rejects an endpoint configuration replacement instead of merging distinct policies", async () => {
  const f = fixture();
  mocks.read
    .mockResolvedValueOnce(f.configuration)
    .mockResolvedValueOnce(f.configuration)
    .mockResolvedValueOnce({ ...f.configuration, configurationVersion: 2 });
  await expect(f.run()).rejects.toThrow("SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE");
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
