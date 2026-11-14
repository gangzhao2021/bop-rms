import { describe, expect, it } from "vitest";
import {
  StoreBusinessDateBeforeRecordsError,
  businessDateErrorCodes,
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
      opensAt: null,
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

/**
 * WP-2423 M160 (v15 2026-11-06): a Store set up mid-shift — its first configuration took effect at
 * 20:51 on business day 11-04 (America/Toronto, 04:00 day start) — could not read that day at all,
 * so every report range touching it and the "last closed day" settlement failed.
 */
describe("the Store's first business day opens inside it", () => {
  const opening = "2026-11-05T01:51:48.000Z";
  const first = { ...v1, effectiveFrom: opening };
  const at = "2026-11-06T15:00:00.000Z";
  const firstDay = (
    configurations: readonly unknown[],
    opensAt: unknown,
    businessDate = "2026-11-04",
  ) =>
    resolveClosedStoreBusinessDateWindowAcross({
      businessDate,
      observedAt: at,
      configurations,
      opensAt,
    });
  it("reads the whole nominal day from 04:00 to 04:00 and carries the opening instant", () => {
    expect(firstDay([first], opening)).toMatchObject({
      businessDate: "2026-11-04",
      startsAt: "2026-11-04T09:00:00.000Z",
      endsAt: "2026-11-05T09:00:00.000Z",
      configurationReference: id(1),
      opensAt: opening,
    });
  });
  it("still refuses the same day without the opening instant (an ordinary day needs full coverage)", () => {
    expect(() => firstDay([first], undefined)).toThrow(
      expect.objectContaining({ code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE" }),
    );
    expect(() => firstDay([first], null)).toThrow(
      expect.objectContaining({ code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE" }),
    );
  });
  it("refuses an opening instant outside the day or before the first version governs", () => {
    for (const opensAt of [
      "2026-11-04T08:59:59.999Z",
      "2026-11-05T09:00:00.000Z",
      "2026-11-05T01:51:47.999Z",
    ])
      expect(() => firstDay([first], opensAt)).toThrow(
        expect.objectContaining({ code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE" }),
      );
  });
  it("opens on the 25-hour day clocks fall back (business day 2026-10-31)", () => {
    // 01:31 EDT on 11-01, before the 04:00 day start: business day 10-31, which ends in EST.
    const dst = { ...v1, effectiveFrom: "2026-11-01T05:31:00.000Z" };
    expect(firstDay([dst], "2026-11-01T05:31:00.000Z", "2026-10-31")).toMatchObject({
      startsAt: "2026-10-31T08:00:00.000Z",
      endsAt: "2026-11-01T09:00:00.000Z",
      opensAt: "2026-11-01T05:31:00.000Z",
    });
  });
  it("opens with a second version published later that day (same boundaries)", () => {
    const second = { ...v2, effectiveFrom: "2026-11-05T03:10:00.000Z" };
    expect(firstDay([first, second], opening)).toMatchObject({
      startsAt: "2026-11-04T09:00:00.000Z",
      endsAt: "2026-11-05T09:00:00.000Z",
      configurationReference: id(4),
      opensAt: opening,
    });
    expect(() =>
      firstDay(
        [
          first,
          {
            ...second,
            businessDayStartLocalTime: "05:00:00",
            businessDayStartSource: "StoreOverride",
          },
        ],
        opening,
      ),
    ).toThrow(expect.objectContaining({ code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE" }));
  });
  it("an earlier day is a typed answer naming the first business day", () => {
    const error = new StoreBusinessDateBeforeRecordsError("2026-11-04");
    expect(error).toMatchObject({
      code: "STORE_BUSINESS_DATE_BEFORE_RECORDS",
      firstBusinessDate: "2026-11-04",
    });
    expect(businessDateErrorCodes).toContain("STORE_BUSINESS_DATE_BEFORE_RECORDS");
  });
});
