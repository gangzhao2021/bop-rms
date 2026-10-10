import { expect, it } from "vitest";
import { dailySettlementRunReference } from "./pilot-daily-settlement-reference.mjs";

const day = {
  brandReference: "00000000-0000-7000-8000-000000000002",
  storeReference: "00000000-0000-7000-8000-000000000003",
  businessDate: "2026-10-08",
  startsAt: "2026-10-08T08:00:00.000Z",
  endsAt: "2026-10-09T08:00:00.000Z",
};

it("WP-2423 settlement page: derives the scheduler's run reference for a business day", () => {
  // The reference the v15 pilot scheduler recorded for this day (DailySettlement run of 2026-10-09 08:00Z).
  expect(dailySettlementRunReference(day).runReference).toBe(
    "01a11fad-1800-7dc4-9697-e64085df1553",
  );
  expect(dailySettlementRunReference({ ...day, businessDate: "2026-10-09" }).runReference).not.toBe(
    dailySettlementRunReference(day).runReference,
  );
  expect(dailySettlementRunReference(day).key).toBe(
    JSON.stringify([
      day.brandReference,
      day.storeReference,
      day.businessDate,
      day.startsAt,
      day.endsAt,
    ]),
  );
});

it("WP-2423 settlement page: rejects an invalid day", () => {
  expect(() => dailySettlementRunReference({ ...day, businessDate: "2026-10-8" })).toThrow(
    "DAILY_SETTLEMENT_WINDOW_INVALID",
  );
  expect(() => dailySettlementRunReference({ ...day, endsAt: day.startsAt })).toThrow(
    "DAILY_SETTLEMENT_WINDOW_INVALID",
  );
  expect(() => dailySettlementRunReference({ ...day, brandReference: "brand" })).toThrow();
});
