import { describe, expect, it } from "vitest";
import {
  createMenuClient,
  MenuPageError,
  menuStage,
  parseMenuRouteReference,
  priceText,
  sectionCode,
} from "./store-menu-pages.js";

const status = (state: string) => ({
  lifecycleReference: "l",
  lifecycleVersion: 1,
  state,
  snapshotDigest: "d",
  changedAt: "2026-10-08T00:00:00.000Z",
});
describe("WP-2423 menu page helpers", () => {
  it("derives section codes, stages, prices and route references", () => {
    expect(sectionCode("Café drinks & tea")).toBe("CAFE_DRINKS_TEA");
    expect(sectionCode("2 for 1")).toBe("FOR_1");
    expect(menuStage(null)).toBe("Editing");
    expect(menuStage(status("InReview"))).toBe("InReview");
    expect(menuStage(status("Approved"))).toBe("Approved");
    expect(menuStage(status("Published"))).toBe("Published");
    expect(priceText("525")).toBe("5.25");
    expect(priceText("5")).toBe("0.05");
    expect(priceText(null)).toBeNull();
    expect(parseMenuRouteReference("0190fa20-0000-7000-8000-000000000001")).toBe(
      "0190fa20-0000-7000-8000-000000000001",
    );
    expect(parseMenuRouteReference("all-day")).toBeNull();
  });
  it("maps server refusals and lost connections to page errors", async () => {
    const refused = createMenuClient("csrf", async () =>
      Response.json({ error: "Frozen" }, { status: 409 }),
    );
    await expect(refused.load(null)).rejects.toMatchObject({ code: "Frozen" });
    const forbidden = createMenuClient("csrf", async () => new Response("", { status: 403 }));
    await expect(forbidden.load(null)).rejects.toMatchObject({ code: "PermissionDenied" });
    const offline = createMenuClient("csrf", async () => {
      throw new TypeError("network");
    });
    await expect(offline.load(null)).rejects.toBeInstanceOf(MenuPageError);
  });
});
