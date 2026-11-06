import { describe, expect, it } from "vitest";
import { tableCartChange } from "./table-cart-change.js";
import type { CartItemView, CartView } from "./types.js";
import { tableCartChangedDishes, checkoutText } from "../journey/messages.js";

const id = (n: number) => `01902423-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const line = (n: number, displayName: string, quantity = 1): CartItemView =>
  ({
    cartItemReference: id(n),
    sellableReference: id(100 + n),
    displayName,
    quantity,
    configuration: [],
    customerNote: null,
    lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
    warnings: [],
  }) as CartItemView;
const view = (
  version: number,
  items: readonly CartItemView[],
  recentRounds?: CartView["cart"]["recentRounds"],
): CartView =>
  ({
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: "Synthetic", storeName: "Synthetic" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-11-06T20:00:00.000Z",
        absoluteExpiresAt: "2026-11-07T16:00:00.000Z",
      },
      items,
      quote: null,
      warnings: [],
      ...(recentRounds === undefined ? {} : { recentRounds }),
    },
  }) as CartView;

describe("WP-2423 same-table-ordering: what happened at the table while this phone checks out", () => {
  const mine = line(10, "Dumplings", 2);
  it("nothing, while the cart's version stands", () => {
    expect(tableCartChange(view(3, [mine]), view(3, [mine]))).toEqual({ kind: "unchanged" });
  });
  it("names the dishes someone added, and the extra of a dish already there", () => {
    const change = tableCartChange(
      view(3, [mine]),
      view(5, [line(10, "Dumplings", 3), line(11, "Sesame soup")], []),
    );
    expect(change).toEqual({
      kind: "changed",
      added: [
        { displayName: "Dumplings", quantity: 1 },
        { displayName: "Sesame soup", quantity: 1 },
      ],
      removed: [],
      reduced: [],
    });
    if (change.kind !== "changed") throw new Error("synthetic");
    expect(checkoutText.tableCartChangedBy(tableCartChangedDishes(change))).toBe(
      "Someone at your table changed the cart: added Dumplings ×1, Sesame soup ×1.",
    );
    expect(checkoutText.tableCartChangedBy("")).toBe("Someone at your table changed the cart.");
  });
  it("names a removed dish and a smaller quantity, and does not repeat an increase (M37)", () => {
    const change = tableCartChange(
      view(3, [mine, line(11, "Tea", 2), line(12, "Rice", 3), line(13, "Soup")]),
      view(6, [line(10, "Dumplings", 4), line(12, "Rice", 1), line(13, "Soup")], []),
    );
    expect(change).toEqual({
      kind: "changed",
      added: [{ displayName: "Dumplings", quantity: 2 }],
      removed: [{ displayName: "Tea", quantity: 2 }],
      reduced: [{ displayName: "Rice", quantity: 1 }],
    });
    if (change.kind !== "changed") throw new Error("synthetic");
    expect(checkoutText.tableCartChangedBy(tableCartChangedDishes(change))).toBe(
      "Someone at your table changed the cart: added Dumplings ×2; removed Tea ×2; Rice now ×1.",
    );
    const removedOnly = tableCartChange(view(3, [mine, line(11, "Tea")]), view(4, [mine], []));
    if (removedOnly.kind !== "changed") throw new Error("synthetic");
    expect(checkoutText.tableCartChangedBy(tableCartChangedDishes(removedOnly))).toBe(
      "Someone at your table changed the cart: removed Tea ×1.",
    );
  });
  it("says another phone's round took these dishes, even after more dishes were added", () => {
    // Review: the round was followed by an add, so the cart is two versions on.
    const current = view(
      6,
      [line(12, "Tea")],
      [
        {
          roundNumber: 2,
          sentAt: "2026-11-06T16:00:00.000Z",
          sentByThisPhone: false,
          cartItemReferences: [id(10), id(13)],
        },
      ],
    );
    expect(tableCartChange(view(3, [mine]), current)).toEqual({
      kind: "sent",
      roundNumber: 2,
      byThisPhone: false,
      cartHasDishes: true,
    });
    expect(checkoutText.tableCartSent(2, false, false)).toBe(
      "These dishes were paid and sent by someone at your table (round 2).",
    );
    expect(checkoutText.tableCartSent(2, false, true)).toBe(
      "These dishes were sent to the kitchen by someone at your table (round 2).",
    );
  });
  it("never claims a round took dishes it didn't, nor when the rounds can't be read", () => {
    const rounds = [
      {
        roundNumber: 1,
        sentAt: "2026-11-06T16:00:00.000Z",
        sentByThisPhone: false,
        cartItemReferences: [id(99)],
      },
    ];
    expect(tableCartChange(view(3, [mine]), view(4, [], rounds)).kind).toBe("changed");
    expect(tableCartChange(view(3, [mine]), view(4, [])).kind).toBe("changed");
    expect(tableCartChange(view(3, [mine]), null).kind).toBe("changed");
  });
});
