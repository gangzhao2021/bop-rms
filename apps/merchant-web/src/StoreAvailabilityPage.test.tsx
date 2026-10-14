import { describe, expect, it } from "vitest";
import {
  availabilityActions,
  createAvailabilityClient,
  floorStaffOnly,
  parseStoreAvailabilityView,
  soldOutText,
} from "./store-availability-page.js";

describe("WP-2423 item availability page helpers", () => {
  it("shows when a sold-out mark ends in the Store's time zone", () => {
    expect(soldOutText("2026-10-09T04:00:00.000Z", "America/Toronto")).toBe(
      "Sold out through 2026-10-08 23:59",
    );
    expect(soldOutText(null, "America/Toronto")).toBe("Sold out until brought back");
  });
  it("accepts only known statuses", () => {
    const view = {
      screenId: "CAT-AVAILABILITY",
      items: [{ status: "SoldOut" }],
    };
    expect(parseStoreAvailabilityView(view).items).toHaveLength(1);
    expect(() => parseStoreAvailabilityView({ ...view, items: [{ status: "Maybe" }] })).toThrow();
  });
  it("maps server refusals to page errors", async () => {
    const client = createAvailabilityClient("csrf", async () =>
      Response.json({ error: "Conflict" }, { status: 409 }),
    );
    await expect(client.load()).rejects.toMatchObject({ code: "Conflict" });
  });
  it("gives Kitchen and Front of House only today's sold-out mark and its return", () => {
    const floor = { mayOffer: false, mayMarkSoldOut: true, mayMarkUntilBack: false };
    const manager = { mayOffer: false, mayMarkSoldOut: true, mayMarkUntilBack: true };
    const brand = { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true };
    const available = { status: "Available", soldOutUntil: null } as const;
    const today = { status: "SoldOut", soldOutUntil: "2026-10-15T04:00:00.000Z" } as const;
    const untilBack = { status: "SoldOut", soldOutUntil: null } as const;
    expect(floorStaffOnly(floor)).toBe(true);
    expect(floorStaffOnly(manager)).toBe(false);
    expect(availabilityActions(available, floor)).toEqual(["SoldOutToday"]);
    expect(availabilityActions(today, floor)).toEqual(["BackInStock"]);
    expect(availabilityActions(untilBack, floor)).toEqual(["ManagerBringsBack"]);
    expect(availabilityActions({ status: "NotOffered", soldOutUntil: null }, floor)).toEqual([]);
    expect(availabilityActions(available, manager)).toEqual(["SoldOutToday", "SoldOutUntilBack"]);
    expect(availabilityActions(untilBack, manager)).toEqual(["BackInStock"]);
    expect(availabilityActions(available, brand)).toEqual([
      "SoldOutToday",
      "SoldOutUntilBack",
      "StopOffering",
    ]);
    // An older server without the field keeps the manager's full sold-out choices.
    expect(availabilityActions(available, { mayOffer: false, mayMarkSoldOut: true })).toEqual([
      "SoldOutToday",
      "SoldOutUntilBack",
    ]);
  });
});
