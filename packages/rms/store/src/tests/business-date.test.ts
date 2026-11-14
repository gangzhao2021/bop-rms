import { describe, expect, it } from "vitest";
import {
  BusinessDateError,
  defaultBusinessDayStartLocalTime,
  resolveStoreBusinessDate,
  resolveClosedStoreBusinessDateWindow,
} from "../index.js";

const id = (value: number) => `018f5000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;

function configuration(
  start: string = defaultBusinessDayStartLocalTime,
  source: "PlatformDefault" | "StoreOverride" = "PlatformDefault",
) {
  return {
    configurationReference: id(1),
    configurationVersion: 3,
    brandReference: id(2),
    storeReference: id(3),
    timeZone: "America/Toronto",
    businessDayStartLocalTime: start,
    businessDayStartSource: source,
    contentDigest: `sha256:${"a".repeat(64)}`,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
  };
}

describe("Store Business Date", () => {
  it("uses the versioned 04:00 local default across midnight", () => {
    const before = resolveStoreBusinessDate({
      occurredAt: "2026-08-02T07:59:59.000Z",
      configuration: configuration(),
    });
    const boundary = resolveStoreBusinessDate({
      occurredAt: "2026-08-02T08:00:00.000Z",
      configuration: configuration(),
    });
    expect(before.businessDate).toBe("2026-08-01");
    expect(boundary.businessDate).toBe("2026-08-02");
    expect(boundary.businessDateBoundaryAt).toBe("2026-08-02T08:00:00.000Z");
    expect(boundary.boundaryDisambiguation).toBe("Exact");
  });

  it("moves a DST-gap boundary forward to the first valid local instant", () => {
    const config = configuration("02:30:00", "StoreOverride");
    const before = resolveStoreBusinessDate({
      occurredAt: "2026-03-08T06:59:59.000Z",
      configuration: config,
    });
    const after = resolveStoreBusinessDate({
      occurredAt: "2026-03-08T07:00:00.000Z",
      configuration: config,
    });
    expect(before.businessDate).toBe("2026-03-07");
    expect(after.businessDate).toBe("2026-03-08");
    expect(after.businessDateBoundaryAt).toBe("2026-03-08T07:00:00.000Z");
    expect(after.boundaryDisambiguation).toBe("GapForward");
  });

  it("uses the earlier DST-overlap occurrence and never moves the date backward", () => {
    const config = configuration("01:30:00", "StoreOverride");
    const first = resolveStoreBusinessDate({
      occurredAt: "2026-11-01T05:30:00.000Z",
      configuration: config,
    });
    const repeatedHour = resolveStoreBusinessDate({
      occurredAt: "2026-11-01T06:15:00.000Z",
      configuration: config,
    });
    expect(first.businessDateBoundaryAt).toBe("2026-11-01T05:30:00.000Z");
    expect(first.boundaryDisambiguation).toBe("OverlapEarlier");
    expect(repeatedHour.businessDate).toBe("2026-11-01");
  });

  it("fails closed for unknown fields, invalid zones and ineffective versions", () => {
    expect(() =>
      resolveStoreBusinessDate({
        occurredAt: "2026-08-02T08:00:00.000Z",
        configuration: { ...configuration(), hidden: true },
      }),
    ).toThrow(BusinessDateError);
    expect(() =>
      resolveStoreBusinessDate({
        occurredAt: "2026-08-02T08:00:00.000Z",
        configuration: { ...configuration(), timeZone: "Unknown/Zone" },
      }),
    ).toThrow(BusinessDateError);
    expect(() =>
      resolveStoreBusinessDate({
        occurredAt: "2025-12-31T23:59:59.000Z",
        configuration: configuration(),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE" }),
    );
  });
});

describe("Closed Store Business Date window", () => {
  const window = (
    businessDate: string,
    config: unknown = configuration(),
    observedAt = "2027-01-02T00:00:00.000Z",
  ) => resolveClosedStoreBusinessDateWindow({ businessDate, configuration: config, observedAt });
  it.each([
    ["2026-03-07", "2026-03-07T09:00:00.000Z", "2026-03-08T08:00:00.000Z", 23],
    ["2026-10-31", "2026-10-31T08:00:00.000Z", "2026-11-01T09:00:00.000Z", 25],
    ["2026-09-20", "2026-09-20T08:00:00.000Z", "2026-09-21T08:00:00.000Z", 24],
  ])("resolves %s with both local boundaries", (date, startsAt, endsAt, hours) => {
    const result = window(date);
    expect(result).toMatchObject({
      businessDate: date,
      startsAt,
      endsAt,
      timeZone: "America/Toronto",
      configurationVersion: 3,
    });
    expect(Date.parse(result.endsAt) - Date.parse(result.startsAt)).toBe(Number(hours) * 3_600_000);
    expect(
      resolveStoreBusinessDate({ occurredAt: result.startsAt, configuration: configuration() })
        .businessDate,
    ).toBe(date);
    expect(
      resolveStoreBusinessDate({
        occurredAt: new Date(Date.parse(result.endsAt) - 1).toISOString(),
        configuration: configuration(),
      }).businessDate,
    ).toBe(date);
    expect(
      resolveStoreBusinessDate({ occurredAt: result.endsAt, configuration: configuration() })
        .businessDate,
    ).not.toBe(date);
  });
  it("reuses gap-forward and earlier-overlap policy", () => {
    expect(window("2026-03-08", configuration("02:30:00", "StoreOverride"))).toMatchObject({
      startsAt: "2026-03-08T07:00:00.000Z",
      startDisambiguation: "GapForward",
    });
    expect(window("2026-11-01", configuration("01:30:00", "StoreOverride"))).toMatchObject({
      startsAt: "2026-11-01T05:30:00.000Z",
      startDisambiguation: "OverlapEarlier",
    });
  });
  it("requires the complete day but accepts its exact ending instant", () => {
    expect(() => window("2026-09-20", configuration(), "2026-09-21T07:59:59.999Z")).toThrow();
    expect(window("2026-09-20", configuration(), "2026-09-21T08:00:00.000Z").endsAt).toBe(
      "2026-09-21T08:00:00.000Z",
    );
  });
  it.each(["2026-02-29", "2026-04-31", "2026-13-01"])("rejects impossible date %s", (date) => {
    expect(() => window(date)).toThrow();
  });
  it("rejects partially effective configurations and accepts an exact end", () => {
    expect(() =>
      window("2026-09-20", { ...configuration(), effectiveFrom: "2026-09-20T12:00:00.000Z" }),
    ).toThrow("store business date resolution failed");
    expect(() =>
      window("2026-09-20", { ...configuration(), effectiveUntil: "2026-09-21T07:00:00.000Z" }),
    ).toThrow();
    expect(
      window("2026-09-20", { ...configuration(), effectiveUntil: "2026-09-21T08:00:00.000Z" })
        .endsAt,
    ).toBe("2026-09-21T08:00:00.000Z");
  });
});
