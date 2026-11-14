import { describe, expect, it } from "vitest";
import type { CustomerCartPortResult, CustomerCartView } from "./customer-cart.js";
import {
  createCustomerPickupCartRestore,
  restoreOperationReference,
} from "./customer-pickup-cart-restore.js";

const id = (n: number) => `01902423-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function view(
  version: number,
  items = 0,
  orderType: "Pickup" | "DineIn" = "Pickup",
): CustomerCartView {
  return {
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version,
      orderType,
      serviceMode: orderType,
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-11-06T13:00:00.000Z",
        absoluteExpiresAt: "2026-11-07T12:00:00.000Z",
      },
      items: Array.from({ length: items }, (_, n) => ({
        cartItemReference: id(100 + n),
        sellableReference: id(200 + n),
        displayName: "Synthetic noodles",
        quantity: 1,
        configuration: [],
        customerNote: null,
        lineEstimate: { status: "Unavailable" as const, reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
        warnings: [],
      })),
      quote: null,
      warnings: [],
      placedOrder: null,
    },
  };
}
const lines = [
  {
    orderItemReference: id(10),
    sellableReference: id(20),
    quantity: 2,
    optionSelections: [{ optionReference: id(30), quantity: 1 }],
    customerNote: "No onions",
  },
  {
    orderItemReference: id(11),
    sellableReference: id(21),
    quantity: 1,
    optionSelections: [],
    customerNote: null,
  },
];
const input = {
  guestCredential: "g".repeat(43),
  csrfCredential: "c".repeat(43),
  operationReference: id(5),
  requestedAt: "2026-11-06T12:00:00.000Z",
  orderReference: id(7),
};
function setup(
  answers: CustomerCartPortResult[] = [],
  restorable: typeof lines | null = lines,
  start = view(3),
) {
  const added: unknown[] = [];
  const asked: unknown[] = [];
  let version = start.cart.version;
  const restore = createCustomerPickupCartRestore({
    cart: {
      getCurrentCart: async () => ({ status: "Found", view: view(version, version - 3) }),
      addItem: async (command) => {
        added.push(command);
        const answer = answers.shift();
        if (answer !== undefined) return answer;
        version++;
        return { status: "Applied", view: view(version, version - 3) };
      },
    },
    orders: {
      findRestorable: async (value) => {
        asked.push(value);
        return restorable === null ? null : { orderNumber: "13", lines: restorable };
      },
    },
  });
  return { restore, added, asked };
}

describe("WP-2423 M03: put an unmade pickup Order's dishes back in the Cart", () => {
  it("adds each ordered dish through the ordinary add, as ordered, one fixed operation per line", async () => {
    const f = setup();
    const result = await f.restore.restore(input);
    expect(result).toMatchObject({ status: "Restored", added: 2, unavailable: 0 });
    expect(f.asked).toEqual([{ cartReference: id(1), orderReference: id(7) }]);
    expect(f.added).toEqual([
      {
        guestCredential: input.guestCredential,
        csrfCredential: input.csrfCredential,
        requestedAt: input.requestedAt,
        operationReference: restoreOperationReference(id(10)),
        cartReference: id(1),
        expectedCartVersion: 3,
        sellableReference: id(20),
        quantity: 2,
        optionSelections: [{ optionReference: id(30), quantity: 1 }],
        customerNote: "No onions",
      },
      expect.objectContaining({
        operationReference: restoreOperationReference(id(11)),
        expectedCartVersion: 4,
        sellableReference: id(21),
      }),
    ]);
    expect(restoreOperationReference(id(10))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(restoreOperationReference(id(10))).not.toBe(restoreOperationReference(id(11)));
  });
  it("leaves out a dish the Store can't sell now and counts it; a second press adds nothing twice", async () => {
    const f = setup([{ status: "SelectionInvalid", issueCodes: ["SELLABLE_UNAVAILABLE"] }]);
    expect(await f.restore.restore(input)).toMatchObject({
      added: 1,
      alreadyPutBack: 0,
      unavailable: 1,
    });
    // Review: after the dishes were put back, ordered again and the Cart emptied, a second press
    // adds nothing and must not say they are back in the Cart.
    const again = setup([{ status: "IdempotencyConflict" }, { status: "IdempotencyConflict" }]);
    expect(await again.restore.restore(input)).toMatchObject({
      status: "Restored",
      added: 0,
      alreadyPutBack: 2,
      unavailable: 0,
    });
  });
  it("refuses an Order that is open, paid or another Cart's, and a table's Cart", async () => {
    const f = setup([], null);
    expect(await f.restore.restore(input)).toEqual({ status: "NotRestorable" });
    expect(f.added).toEqual([]);
    const table = createCustomerPickupCartRestore({
      cart: {
        getCurrentCart: async () => ({ status: "Found", view: view(3, 0, "DineIn") }),
        addItem: async () => {
          throw new Error("never");
        },
      },
      orders: {
        findRestorable: async () => {
          throw new Error("never");
        },
      },
    });
    expect(await table.restore(input)).toEqual({ status: "NotRestorable" });
  });
  it("stops on an expired session or an outage without guessing", async () => {
    expect(await setup([{ status: "SessionExpired" }]).restore.restore(input)).toEqual({
      status: "SessionExpired",
    });
    expect(await setup([{ status: "Unavailable" }]).restore.restore(input)).toEqual({
      status: "Unavailable",
    });
  });
});
