import { describe, expect, it, vi } from "vitest";

/**
 * Batch 36 (v15 2026-11-20 00:49 Toronto): Test Merchant 2 is open 00:00-23:59:59 every day with
 * its business day starting at 04:00. After midnight the open gate took a guest pickup order,
 * while Home, reading this business day, said the Store had closed at 23:59:59.
 */
const published = vi.hoisted(() => ({
  configuration: {
    weeklySchedule: [] as unknown[],
    exceptions: [] as unknown[],
  },
}));
vi.mock("@rms/store", async (original) => ({
  ...(await original<object>()),
  createPostgresCurrentStorePublicationProof: () => async () => ({
    ...published,
    contentDigest: "sha256:" + "a".repeat(64),
    businessDayStartSource: "Configured",
  }),
  createPostgresStoreBusinessDaySource:
    (options: {
      publicationProof(tx: unknown, candidate: unknown, at: string): Promise<unknown>;
    }) =>
    async (tx: unknown, at: string) => {
      await options.publicationProof(tx, { configurationReference: "c" }, at);
      // 2026-11-19 is the business date from 04:00 that day (09:00Z) to 04:00 the next (09:00Z).
      return {
        businessDate: "2026-11-19",
        startsAt: "2026-11-19T09:00:00.000Z",
        endsAt: "2026-11-20T09:00:00.000Z",
        timeZone: "America/Toronto",
        businessDayStartLocalTime: "04:00:00",
        observedAt: at,
      };
    },
}));

const { createMerchantStoreBusinessDay } = await import("./merchant-store-business-day.js");

const period = (start: string, end: string, endsNextDay = false) => ({
  startLocalTime: start,
  endLocalTime: end,
  endsNextDay,
  serviceModes: ["DineIn", "Pickup"],
  orderCutoffSeconds: 0,
  leadTimeSeconds: 0,
});

function read(weeklySchedule: unknown[]) {
  published.configuration.weeklySchedule = weeklySchedule;
  return createMerchantStoreBusinessDay({
    publication: {} as Parameters<typeof createMerchantStoreBusinessDay>[0]["publication"],
    tenantReference: "t",
    brandReference: "b",
    storeReference: "s",
    timeZone: "America/Toronto",
    authorize: async () => true,
  })({ query: async () => undefined }, "2026-11-20T05:49:00.000Z");
}

describe("Batch 36: Home's closing after midnight follows the Store's open periods", () => {
  it("does not say Test Merchant 2 has closed at 00:49 while it is open", async () => {
    const day = await read(
      [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
        isoWeekday,
        intervals: [period("00:00:00", "23:59:59")],
      })),
    );
    expect(day.closedToday).toBe(false);
    // Batch 47 (v15 b46: closesAt was the end of the next calendar day, 2026-11-21T04:59:59Z,
    // a day after this business day ended): still open when the day ends, it closes with the day.
    expect(day.closesAt).toBe(day.endsAt);
    expect(day.closesAt).toBe("2026-11-20T09:00:00.000Z");
    expect(Date.parse(day.closesAt ?? "")).toBeGreaterThan(Date.parse("2026-11-20T05:49:00.000Z"));
  });

  it("still closes an evening Store's day at the end of its last period", async () => {
    const day = await read(
      [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
        isoWeekday,
        intervals: [period("17:00:00", "22:00:00")],
      })),
    );
    expect(day.closesAt).toBe("2026-11-20T03:00:00.000Z");
  });
});
