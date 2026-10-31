import { describe, expect, it } from "vitest";
import {
  resolveClosedStoreBusinessDateWindow,
  resolveClosedStoreBusinessDateWindowAcross,
  resolveStoreBusinessDateBounds,
} from "../index.js";

const id = (value: number) => `018f5000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const v1 = {
  configurationReference: id(1),
  configurationVersion: 1,
  brandReference: id(2),
  storeReference: id(3),
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  businessDayStartSource: "PlatformDefault",
  contentDigest: `sha256:${"a".repeat(64)}`,
  effectiveFrom: "2026-09-20T08:00:00.000Z",
  effectiveUntil: null,
};
// Hours edit published mid-day 2026-10-10 with the locked time zone and day start.
const v2 = {
  ...v1,
  configurationReference: id(4),
  configurationVersion: 2,
  contentDigest: `sha256:${"b".repeat(64)}`,
  effectiveFrom: "2026-10-10T14:00:00.000Z",
};
const observedAt = "2026-10-12T15:00:00.000Z";
const across = (configurations: readonly unknown[], businessDate = "2026-10-10") =>
  resolveClosedStoreBusinessDateWindowAcross({ businessDate, observedAt, configurations });

describe("closed business day across configuration versions", () => {
  it("is identical to the single-configuration window for one version", () => {
    expect(across([v1], "2026-09-20")).toEqual(
      resolveClosedStoreBusinessDateWindow({
        businessDate: "2026-09-20",
        observedAt,
        configuration: v1,
      }),
    );
  });
  it("settles a day that switched versions with identical boundaries", () => {
    expect(() =>
      resolveClosedStoreBusinessDateWindow({
        businessDate: "2026-10-10",
        observedAt,
        configuration: v2,
      }),
    ).toThrow(expect.objectContaining({ code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE" }));
    expect(across([v1, v2])).toEqual({
      brandReference: id(2),
      storeReference: id(3),
      businessDate: "2026-10-10",
      startsAt: "2026-10-10T08:00:00.000Z",
      endsAt: "2026-10-11T08:00:00.000Z",
      startDisambiguation: "Exact",
      endDisambiguation: "Exact",
      configurationReference: id(4),
      configurationVersion: 2,
      contentDigest: `sha256:${"b".repeat(64)}`,
      timeZone: "America/Toronto",
      businessDayStartLocalTime: "04:00:00",
    });
  });
  it.each<[string, Record<string, unknown>]>([
    [
      "day start",
      { businessDayStartLocalTime: "05:00:00", businessDayStartSource: "StoreOverride" },
    ],
    ["day start source", { businessDayStartSource: "StoreOverride" }],
    ["time zone", { timeZone: "America/Vancouver" }],
  ])("refuses versions with a different %s", (_label, change) => {
    expect(() => across([v1, { ...v2, ...change }])).toThrow(
      expect.objectContaining({ code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE" }),
    );
  });
  it("settles a day with 80 hours edits published inside it (no chain ceiling)", () => {
    const chain = [
      v1,
      ...Array.from({ length: 80 }, (_, n) => ({
        ...v1,
        configurationReference: id(100 + n),
        configurationVersion: 2 + n,
        contentDigest: `sha256:${(n % 16).toString(16).repeat(64)}`,
        effectiveFrom: new Date(Date.parse("2026-10-10T09:00:00.000Z") + n * 600_000).toISOString(),
      })),
    ];
    const window = across(chain);
    expect(window.startsAt).toBe("2026-10-10T08:00:00.000Z");
    expect(window.endsAt).toBe("2026-10-11T08:00:00.000Z");
    expect(window.configurationVersion).toBe(81);
    expect(window.configurationReference).toBe(id(179));
  });
  it("still requires the chain to cover the whole day", () => {
    expect(() => across([v2])).toThrow(
      expect.objectContaining({ code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE" }),
    );
    expect(() => across([v1, { ...v2, effectiveUntil: "2026-10-10T20:00:00.000Z" }])).toThrow(
      expect.objectContaining({ code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE" }),
    );
  });
  it("refuses another Store, an empty chain and an open day", () => {
    for (const input of [[v1, { ...v2, storeReference: id(9) }], []])
      expect(() => across(input)).toThrow(
        expect.objectContaining({ code: "STORE_BUSINESS_DATE_INPUT_INVALID" }),
      );
    expect(() => across([v1, v2], "2026-10-12")).toThrow(
      expect.objectContaining({ code: "STORE_BUSINESS_DATE_INPUT_INVALID" }),
    );
  });
  it("exposes day bounds without requiring effectiveness", () => {
    expect(
      resolveStoreBusinessDateBounds({ businessDate: "2026-10-10", configuration: v2 }),
    ).toEqual({ startsAt: "2026-10-10T08:00:00.000Z", endsAt: "2026-10-11T08:00:00.000Z" });
    expect(() =>
      resolveStoreBusinessDateBounds({ businessDate: "2026-02-30", configuration: v2 }),
    ).toThrow(expect.objectContaining({ code: "STORE_BUSINESS_DATE_INPUT_INVALID" }));
  });
});
