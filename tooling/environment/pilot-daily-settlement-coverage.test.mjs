import { expect, it, vi } from "vitest";
import {
  DAILY_SETTLEMENT_COVERAGE_BEFORE_STORE_RECORDS,
  createDayEndCheckCoveredFrom,
  resolveDailySettlementCoverage,
} from "./pilot-daily-settlement-coverage.mjs";
import { createCoverageGatedRun } from "./pilot-daily-settlement-execution.mjs";

/**
 * WP-2423 (settlement-coverage): where a Store's day-end settlement starts. The Store's own first
 * business day by default (no file to record), a Pilot Store's issued record kept fail-closed.
 */
const id = (n) => "018f5000-0000-7000-8000-" + String(n).padStart(12, "0");
const binding = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const day = (businessDate, startsAt, endsAt, extra = {}) => ({
  brandReference: binding.brandReference,
  storeReference: binding.storeReference,
  businessDate,
  startsAt,
  endsAt,
  configurationReference: id(9),
  configurationVersion: 1,
  contentDigest: "sha256:" + "a".repeat(64),
  timeZone: "America/Toronto",
  ...extra,
});
const firstDay = day("2026-11-04", "2026-11-04T09:00:00.000Z", "2026-11-05T09:00:00.000Z", {
  opensAt: "2026-11-05T01:13:00.000Z",
});
const recordOf = (window) => ({
  scope: binding,
  firstWindow: {
    businessDate: window.businessDate,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    configurationReference: window.configurationReference,
    configurationVersion: window.configurationVersion,
    contentDigest: window.contentDigest,
  },
});
const installationWith = (recorded) => ({
  loadRecordedDailySettlementCoverage: vi.fn(async () => {
    if (recorded instanceof Error) throw recorded;
    return recorded;
  }),
  loadProfile: async () => ({ binding: { ...binding, validUntil: "2099-01-01T00:00:00.000Z" } }),
});
const daysWith = (first) => ({
  first: vi.fn(async () => {
    if (first instanceof Error) throw first;
    return first;
  }),
});

it("no file and the first day closed: coverage starts on the Store's first day (with opensAt)", async () => {
  const days = daysWith(firstDay);
  expect(
    await resolveDailySettlementCoverage({
      installation: installationWith(null),
      days,
      pilotStore: false,
    }),
  ).toEqual({
    kind: "Covered",
    source: "StoreRecords",
    scope: binding,
    firstWindow: recordOf(firstDay).firstWindow,
    recordedBusinessDate: null,
  });
  expect(days.first).toHaveBeenCalledOnce();
});

it("no file and nothing governs, or the first day still open: not yet", async () => {
  expect(
    await resolveDailySettlementCoverage({
      installation: installationWith(null),
      days: daysWith(null),
      pilotStore: false,
    }),
  ).toEqual({ kind: "NotYet" });
});

it("a record later than the first day never shortens coverage (demo-2: file Oct 31, records Oct 30)", async () => {
  const later = day("2026-11-05", "2026-11-05T09:00:00.000Z", "2026-11-06T09:00:00.000Z");
  const coverage = await resolveDailySettlementCoverage({
    installation: installationWith(recordOf(later)),
    days: daysWith(firstDay),
    pilotStore: false,
  });
  expect(coverage.firstWindow.businessDate).toBe("2026-11-04");
  expect(coverage.recordedBusinessDate).toBe("2026-11-05");
});

it("a record equal to the first day is the same coverage", async () => {
  const coverage = await resolveDailySettlementCoverage({
    installation: installationWith(recordOf(firstDay)),
    days: daysWith(firstDay),
    pilotStore: false,
  });
  expect(coverage.firstWindow).toEqual(recordOf(firstDay).firstWindow);
  expect(coverage.recordedBusinessDate).toBe("2026-11-04");
});

it("a record earlier than the Store's records is refused", async () => {
  const earlier = day("2026-11-03", "2026-11-03T09:00:00.000Z", "2026-11-04T09:00:00.000Z");
  for (const first of [firstDay, null])
    await expect(
      resolveDailySettlementCoverage({
        installation: installationWith(recordOf(earlier)),
        days: daysWith(first),
        pilotStore: false,
      }),
    ).rejects.toThrow(DAILY_SETTLEMENT_COVERAGE_BEFORE_STORE_RECORDS);
});

it("an unreadable record or a failed read throws: never 'not yet'", async () => {
  const unreadable = new Error("PILOT_INSTALLATION_UNAVAILABLE");
  await expect(
    resolveDailySettlementCoverage({
      installation: installationWith(unreadable),
      days: daysWith(firstDay),
      pilotStore: false,
    }),
  ).rejects.toBe(unreadable);
  const refused = new Error("STORE_BUSINESS_DATE_UNAVAILABLE");
  await expect(
    resolveDailySettlementCoverage({
      installation: installationWith(null),
      days: daysWith(refused),
      pilotStore: false,
    }),
  ).rejects.toBe(refused);
});

it("a Pilot Store keeps its issued record and never derives a start", async () => {
  const issued = day("2026-11-05", "2026-11-05T09:00:00.000Z", "2026-11-06T09:00:00.000Z");
  const days = daysWith(firstDay);
  expect(
    await resolveDailySettlementCoverage({
      installation: installationWith(recordOf(issued)),
      days,
      pilotStore: true,
    }),
  ).toMatchObject({
    kind: "Covered",
    source: "Recorded",
    firstWindow: recordOf(issued).firstWindow,
  });
  // A lost file (a restore that dropped it) stays unavailable: no pre-issue TEST capture is settled.
  await expect(
    resolveDailySettlementCoverage({
      installation: installationWith(null),
      days,
      pilotStore: true,
    }),
  ).rejects.toThrow("PILOT_INSTALLATION_UNAVAILABLE");
  expect(days.first).not.toHaveBeenCalled();
});

it("the worker is Idle until the first day closes, then settles day 1 and day 2", async () => {
  let now = "2026-11-05T02:00:00.000Z",
    coverage = { kind: "NotYet" };
  const resolveCoverage = vi.fn(async () => coverage);
  const settled = [];
  const build = vi.fn((covered) => {
    const queue = [covered.firstWindow.businessDate, "2026-11-05"];
    return async () => {
      const next = queue.shift();
      if (next === undefined) return { status: "Idle", checkCount: 0 };
      settled.push(next);
      return { status: "Created", checkCount: 1 };
    };
  });
  const run = createCoverageGatedRun({ resolveCoverage, build, now: () => now, recheckMs: 60_000 });
  expect(await run()).toEqual({ status: "Idle", checkCount: 0 });
  // Asked again at most once a minute while not yet.
  now = "2026-11-05T02:00:30.000Z";
  expect(await run()).toEqual({ status: "Idle", checkCount: 0 });
  expect(resolveCoverage).toHaveBeenCalledOnce();
  coverage = { kind: "Covered", source: "StoreRecords", firstWindow: firstDay };
  now = "2026-11-05T09:01:00.000Z";
  expect(await run()).toEqual({ status: "Created", checkCount: 1 });
  expect(await run()).toEqual({ status: "Created", checkCount: 1 });
  expect(settled).toEqual(["2026-11-04", "2026-11-05"]);
  expect(build).toHaveBeenCalledOnce();
});

it("a coverage read that fails fails the cycle (health attention), and is asked again next cycle", async () => {
  const refused = new Error("STORE_BUSINESS_DATE_UNAVAILABLE");
  const resolveCoverage = vi.fn(async () => {
    throw refused;
  });
  const run = createCoverageGatedRun({
    resolveCoverage,
    build: () => async () => ({ status: "Created", checkCount: 1 }),
    now: () => "2026-11-05T12:00:00.000Z",
  });
  await expect(run()).rejects.toBe(refused);
  await expect(run()).rejects.toBe(refused);
  expect(resolveCoverage).toHaveBeenCalledTimes(2);
});

it("Settlement learns where a Pilot Store's day-end checks start; any other Store from its first day", async () => {
  const recorded = recordOf(firstDay);
  const pilot = createDayEndCheckCoveredFrom({
    installation: installationWith(recorded),
    pilotStore: true,
  });
  await expect(pilot(binding)).resolves.toBe(firstDay.startsAt);
  // Another Store's read, or a Pilot Store without its record, never gets an answer.
  await expect(pilot({ ...binding, storeReference: id(4) })).rejects.toThrow();
  await expect(
    createDayEndCheckCoveredFrom({ installation: installationWith(null), pilotStore: true })(
      binding,
    ),
  ).rejects.toThrow();
  // InternalTest and hosted Stores are covered from their own first business day: no file read.
  const load = vi.fn();
  await expect(
    createDayEndCheckCoveredFrom({
      installation: { loadRecordedDailySettlementCoverage: load },
      pilotStore: false,
    })(binding),
  ).resolves.toBeNull();
  expect(load).not.toHaveBeenCalled();
});
