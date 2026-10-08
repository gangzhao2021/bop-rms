import { describe, expect, it } from "vitest";
import {
  createAvailabilityClient,
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
});
