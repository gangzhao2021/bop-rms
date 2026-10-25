import { renderToStaticMarkup as renderStatic } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { groupByProduct, StoreAvailabilityPage } from "./StoreAvailabilityPage.js";
import { KitchenDisplayHeaderControls, kitchenHandoverOffered } from "./KitchenBoardPages.js";
import {
  availabilityActions,
  createAvailabilityClient,
  floorStaffOnly,
  kitchenDisplayPermissions,
  parseStoreAvailabilityView,
  soldOutText,
  stockAmount,
  stockHeldByOrders,
  stockSoldOutText,
} from "./store-availability-page.js";

// v15 run: in-app links are router links, so pages render inside a router as in the app.
const renderToStaticMarkup = (element: ReactElement) =>
  renderStatic(<MemoryRouter>{element}</MemoryRouter>);

describe("WP-2423 item availability page helpers", () => {
  it("shows when a sold-out mark ends in the Store's time zone", () => {
    const evening = new Date("2026-10-15T01:30:00.000Z"); // 21:30 on Oct 14 in Toronto
    // The business day ends at the Store's midnight: the rest of today.
    expect(soldOutText("2026-10-15T04:00:00.000Z", "America/Toronto", evening)).toBe(
      "Sold out for the rest of today",
    );
    // A late business day ends at 4:00 the next morning.
    expect(soldOutText("2026-10-15T08:00:00.000Z", "America/Toronto", evening)).toBe(
      "Sold out until 4:00 AM tomorrow",
    );
    // After midnight, the same business day ends later today.
    expect(
      soldOutText("2026-10-15T08:00:00.000Z", "America/Toronto", new Date("2026-10-15T05:30:00Z")),
    ).toBe("Sold out until 4:00 AM today");
    expect(soldOutText("2026-10-17T08:00:00.000Z", "America/Toronto", evening)).toBe(
      "Sold out until Oct 17, 4:00 AM",
    );
    expect(soldOutText(null, "America/Toronto")).toBe("Sold out until brought back");
    for (const until of ["2026-10-15T04:00:00.000Z", "2026-10-15T08:00:00.000Z"])
      expect(soldOutText(until, "America/Toronto", evening)).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
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
  it("keeps the kitchen display's frame when reached from the kitchen display", () => {
    const html = renderToStaticMarkup(
      <StoreAvailabilityPage
        kitchenDisplay={{
          storeLabel: "Queen Street",
          csrf: "c".repeat(43),
          soldOutHref: "/app/commerce/availability",
          loadOperatorStatus: async () => "Named",
        }}
      />,
    );
    expect(html).toContain("<h1>Queen Street</h1>");
    expect(html).toContain("Kitchen display");
    // The handover appears once the kitchen board's read confirms a kitchen display sign-in.
    expect(html).not.toContain("Hand over / sign out");
    const header = renderToStaticMarkup(
      <KitchenDisplayHeaderControls
        handoverOffered={kitchenHandoverOffered(true, "Named")}
        handover="Idle"
        awake="Released"
        onHandover={() => undefined}
      />,
    );
    expect(header).toContain("Hand over / sign out");
    expect(kitchenHandoverOffered(true, "Unverified")).toBe(false);
    expect(html).toContain('href="/operations/kitchen"');
    expect(html).toContain('href="/app/commerce/availability?from=kitchen"');
    const office = renderToStaticMarkup(<StoreAvailabilityPage />);
    expect(office).not.toContain("Hand over / sign out");
  });
  it("offers the kitchen display today's mark and its return only, whatever the roles allow", () => {
    const brand = { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true };
    const kitchen = { mayOffer: false, mayMarkSoldOut: true, mayMarkUntilBack: false };
    const available = { status: "Available", soldOutUntil: null } as const;
    const untilBack = { status: "SoldOut", soldOutUntil: null } as const;
    for (const operator of ["Named", "Locked", "HandoverRequired", "Unavailable", null] as const)
      expect(kitchenDisplayPermissions(brand, operator), String(operator)).toEqual(kitchen);
    expect(availabilityActions(available, kitchenDisplayPermissions(brand, "Named"))).toEqual([
      "SoldOutToday",
    ]);
    expect(availabilityActions(untilBack, kitchenDisplayPermissions(brand, "Named"))).toEqual([
      "ManagerBringsBack",
    ]);
    // A counter or office sign-in that opened the kitchen route keeps what the server reported.
    expect(kitchenDisplayPermissions(brand, "Unverified")).toBe(brand);
    // Never more than the server reported.
    const none = { mayOffer: false, mayMarkSoldOut: false, mayMarkUntilBack: false };
    expect(kitchenDisplayPermissions(none, "Named")).toEqual(none);
  });
});

describe("WP-2423 (2026-10-16) why guests see an offered item sold out from stock", () => {
  const milk = {
    name: "Whole milk 3.25%",
    unitCode: "L",
    displayPrecision: 3,
    required: "0.24",
    onHand: "2.8",
    reserved: "2.8",
    available: "0",
    openOrderCount: 11,
  };
  it("names the ingredient, the amounts and the open orders in staff words", () => {
    expect(stockSoldOutText({ ingredients: [milk] })).toBe(
      "All 2.8 L of Whole milk 3.25% is set aside for 11 open orders.",
    );
    expect(stockHeldByOrders({ ingredients: [milk] })).toBe(true);
    expect(
      stockSoldOutText({
        ingredients: [{ ...milk, reserved: "2.7", available: "0.1", openOrderCount: 1 }],
      }),
    ).toBe(
      "2.8 L of Whole milk 3.25% is in stock, but 2.7 L is set aside for 1 open order and one needs 0.24 L.",
    );
    expect(
      stockSoldOutText({ ingredients: [{ ...milk, onHand: "0", reserved: "0", available: "0" }] }),
    ).toBe("No Whole milk 3.25% is in stock.");
    expect(stockSoldOutText({ ingredients: [] })).toContain("on hold or past their use-by date");
    expect(stockAmount("0.018", "KG", 3)).toBe("0.018 kg");
    expect(stockAmount("12", "EA", 0)).toBe("12");
  });
  it("shows the reason and a way to Orders on the page, and rejects malformed stock reasons", () => {
    const view = {
      screenId: "CAT-AVAILABILITY",
      sourceAsOf: "2026-10-16T05:00:00.000Z",
      viewer: "0190a7c4-0000-7000-8000-000000000001",
      timeZone: "America/Toronto",
      permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
      items: [
        {
          skuReference: "0190a7c4-0000-7000-8000-000000000002",
          skuCode: "LATTE-M",
          productName: "Latte",
          sizeName: "Latte",
          status: "Available",
          soldOutUntil: null,
          stockSoldOut: { ingredients: [milk] },
        },
      ],
    };
    expect(parseStoreAvailabilityView(view).items[0]?.stockSoldOut?.ingredients).toHaveLength(1);
    expect(() =>
      parseStoreAvailabilityView({
        ...view,
        items: [{ ...view.items[0], stockSoldOut: { ingredients: [{ ...milk, onHand: 2.8 }] } }],
      }),
    ).toThrow();
  });
});

it("Owner 2026-10-25: groups sizes under their product, in the order products first appear", () => {
  const item = (productName: string, sizeName: string) => ({ productName, sizeName });
  expect(
    groupByProduct([item("Latte", "Small"), item("Muffin", "Muffin"), item("Latte", "Large")]).map(
      (group) => [group.productName, group.items.map((entry) => entry.sizeName)],
    ),
  ).toEqual([
    ["Latte", ["Small", "Large"]],
    ["Muffin", ["Muffin"]],
  ]);
});
