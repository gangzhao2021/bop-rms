import { describe, expect, it } from "vitest";
import {
  BusinessDateError,
  defaultBusinessDayStartLocalTime,
  resolveStoreBusinessDay,
} from "../index.js";

const id = (value: number) => `018f5000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;

function configuration(start: string = defaultBusinessDayStartLocalTime) {
  return {
    configurationReference: id(1),
    configurationVersion: 2,
    brandReference: id(2),
    storeReference: id(3),
    timeZone: "America/Toronto",
    businessDayStartLocalTime: start,
    businessDayStartSource:
      start === defaultBusinessDayStartLocalTime ? "PlatformDefault" : "StoreOverride",
    contentDigest: `sha256:${"b".repeat(64)}`,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
  };
}
const day = (observedAt: string, start?: string) =>
  resolveStoreBusinessDay({ occurredAt: observedAt, configuration: configuration(start) });
const hours = (value: { startsAt: string; endsAt: string }) =>
  (Date.parse(value.endsAt) - Date.parse(value.startsAt)) / 3_600_000;

describe("Store business day (WP-2423 Q21)", () => {
  it("keeps service after midnight in the business day that started at 04:00, not the calendar day", () => {
    // 23:30 and 01:30 local (EDT) belong to the same Oct 14 business day; calendar dates differ.
    const evening = day("2026-10-15T03:30:00.000Z");
    const afterMidnight = day("2026-10-15T05:30:00.000Z");
    for (const value of [evening, afterMidnight]) {
      expect(value.businessDate).toBe("2026-10-14");
      expect(value.startsAt).toBe("2026-10-14T08:00:00.000Z");
      expect(value.endsAt).toBe("2026-10-15T08:00:00.000Z");
      expect(value.timeZone).toBe("America/Toronto");
    }
    expect(afterMidnight.observedAt).toBe("2026-10-15T05:30:00.000Z");
  });

  it("starts the next business day exactly at the business-day start time", () => {
    expect(day("2026-10-15T07:59:59.999Z").businessDate).toBe("2026-10-14");
    const next = day("2026-10-15T08:00:00.000Z");
    expect(next.businessDate).toBe("2026-10-15");
    expect(next.startsAt).toBe("2026-10-15T08:00:00.000Z");
    expect(next.endsAt).toBe("2026-10-16T08:00:00.000Z");
  });

  it("is 25 hours long when the clocks fall back overnight in America/Toronto", () => {
    // 01:30 EST on Nov 1 (after the fall-back) is still the Oct 31 business day.
    const value = day("2026-11-01T06:30:00.000Z");
    expect(value.businessDate).toBe("2026-10-31");
    expect(value.startsAt).toBe("2026-10-31T08:00:00.000Z");
    expect(value.endsAt).toBe("2026-11-01T09:00:00.000Z");
    expect(hours(value)).toBe(25);
    expect(hours(day("2026-11-01T09:00:00.000Z"))).toBe(24);
  });

  it("is 23 hours long when the clocks spring forward overnight in America/Toronto", () => {
    const value = day("2026-03-08T07:30:00.000Z"); // 03:30 EDT, before the 04:00 start
    expect(value.businessDate).toBe("2026-03-07");
    expect(value.startsAt).toBe("2026-03-07T09:00:00.000Z");
    expect(value.endsAt).toBe("2026-03-08T08:00:00.000Z");
    expect(hours(value)).toBe(23);
  });

  it("moves a start inside the spring-forward gap to the first valid local instant", () => {
    const value = day("2026-03-08T06:30:00.000Z", "02:30:00"); // 01:30 EST
    expect(value.businessDate).toBe("2026-03-07");
    expect(value.startsAt).toBe("2026-03-07T07:30:00.000Z");
    expect(value.endsAt).toBe("2026-03-08T07:00:00.000Z"); // 03:00 EDT
    expect(day("2026-03-08T07:00:00.000Z", "02:30:00").businessDate).toBe("2026-03-08");
  });

  it("uses a Store's own business-day start", () => {
    const value = day("2026-10-15T09:30:00.000Z", "06:00:00"); // 05:30 local
    expect(value.businessDate).toBe("2026-10-14");
    expect(value.startsAt).toBe("2026-10-14T10:00:00.000Z");
    expect(value.endsAt).toBe("2026-10-15T10:00:00.000Z");
    expect(value.businessDayStartLocalTime).toBe("06:00:00");
  });

  it("refuses an instant before the configuration is in force", () => {
    expect(() => day("2025-12-31T12:00:00.000Z")).toThrow(BusinessDateError);
  });
});
