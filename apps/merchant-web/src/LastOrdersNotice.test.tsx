import { expect, it } from "vitest";
import { lastOrdersText, lastOrdersWarningMs } from "./LastOrdersNotice.js";
import { parseStoreBusinessDay } from "./StoreBusinessDay.js";

const day = {
  businessDate: "2026-10-28",
  startsAt: "2026-10-28T08:00:00.000Z",
  endsAt: "2026-10-29T08:00:00.000Z",
  timeZone: "America/Toronto",
  observedAt: "2026-10-29T01:00:00.000Z",
};

it("WP-2423 item 8 ③ follow-up: reads last orders with the business day, or none", () => {
  expect(parseStoreBusinessDay(day).lastOrdersAt).toBeNull();
  expect(
    parseStoreBusinessDay({ ...day, lastOrdersAt: "2026-10-29T01:30:00.000Z" }).lastOrdersAt,
  ).toBe("2026-10-29T01:30:00.000Z");
  expect(parseStoreBusinessDay({ ...day, lastOrdersAt: null }).lastOrdersAt).toBeNull();
  expect(() => parseStoreBusinessDay({ ...day, lastOrdersAt: "21:30" })).toThrow();
});

it("WP-2423 item 8 ③ follow-up: warns servers 30 minutes before last orders and after", () => {
  const at = Date.parse("2026-10-29T01:30:00.000Z"); // 21:30 in Toronto
  const iso = new Date(at).toISOString();
  expect(lastOrdersText(iso, at - lastOrdersWarningMs - 1, "America/Toronto")).toBeNull();
  expect(lastOrdersText(iso, at - 60_000, "America/Toronto")).toEqual({
    tone: "soon",
    text: "Last orders at 9:30 PM. After that guests can't order from their phones; you can still add a round for a table.",
  });
  expect(lastOrdersText(iso, at + 60_000, "America/Toronto")?.tone).toBe("past");
  expect(lastOrdersText(null, at, "America/Toronto")).toBeNull();
});
