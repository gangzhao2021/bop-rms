import type { GuestSession } from "@bop/identity";
import { OrderStatusProjectionError } from "@rms/ordering";
import { describe, expect, it, vi } from "vitest";
import {
  composeCustomerDiningSession,
  createCustomerDiningSessionRead,
  type CustomerDiningSessionDependencies,
  type CustomerDiningSessionFacts,
} from "./customer-dining-session-read.js";

const id = (n: number) => "0198b001-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-13T18:00:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const cad = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });

function guest(overrides: Partial<GuestSession> = {}): GuestSession {
  return {
    sessionReference: id(10),
    status: "Active",
    version: 1,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    publicStoreReference: id(11),
    publicTableReference: id(12),
    channel: "DineIn",
    locale: "en-CA",
    qrReference: id(13),
    qrRevocationVersion: 1,
    diningState: "DiningBound",
    diningSessionReference: id(20),
    diningParticipantReference: id(21),
    createdAt: "2026-10-13T17:00:00.000Z",
    lastSeenAt: at,
    idleExpiresAt: "2026-10-13T20:00:00.000Z",
    absoluteExpiresAt: "2026-10-14T17:00:00.000Z",
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  } as unknown as GuestSession;
}

type Order = NonNullable<CustomerDiningSessionFacts["order"]>;
const item = (n: number, name: string, quantity: number, minor: bigint) => ({
  orderItemReference: id(n),
  displayName: name,
  quantity,
  lineTotal: cad(minor),
});
function facts(order: Partial<Order> = {}): CustomerDiningSessionFacts {
  return {
    diningSessionReference: id(20),
    tableLabel: "12",
    checkedAt: at,
    order: {
      orderNumber: "1042",
      batches: [
        { orderBatchReference: id(30), submittedAt: at, items: [item(31, "Ramen", 2, 3000n)] },
        { orderBatchReference: id(40), submittedAt: at, items: [item(41, "Gyoza", 1, 900n)] },
      ],
      authorship: new Map([
        [id(30), true],
        [id(40), false],
      ]),
      delivery: new Map([
        [id(31), { phase: "InProgress", deliveredQuantity: 0 }],
        [id(41), { phase: "Submitted", deliveredQuantity: 0 }],
      ]),
      paymentOutcomes: new Map([[id(30), "Succeeded"]]),
      paymentDeadlines: new Map([
        [id(30), "2026-10-13T18:30:00.000Z"],
        [id(40), "2026-10-13T18:40:00.000Z"],
      ]),
      unpaidCancellations: new Set(),
      staffCancellations: new Map(),
      itemCancellations: [],
      payments: [{ status: "Succeeded", amount: cad(3450n) }],
      refunds: { confirmedMinor: 0n, pendingMinor: 0n },
      ...order,
    },
  };
}

describe("WP-2423 Q8 composeCustomerDiningSession", () => {
  it("lists each round with who ordered it only as you or another guest, and what is still due", () => {
    const view = composeCustomerDiningSession(facts());
    expect(view.tableLabel).toBe("12");
    expect(view.orderNumber).toBe("1042");
    expect(view.rounds.map((round) => [round.roundNumber, round.orderedBy, round.status])).toEqual([
      [1, "You", "Preparing"],
      [2, "AnotherGuest", "AwaitingPayment"],
    ]);
    expect(view.rounds[0]?.payment).toBe("Paid");
    expect(view.rounds[1]?.payment).toBe("Awaiting");
    expect(view.summary).toEqual({
      paid: cad(3450n),
      refunded: cad(0n),
      refundPending: cad(0n),
      due: cad(900n),
    });
    // No owner references, guest or participant identity leave the composition.
    const serialized = JSON.stringify(view, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    for (const n of [10, 20, 21, 30, 31, 40, 41]) expect(serialized).not.toContain(id(n));
  });

  it("DEC-DINE-IN-PAY-LATER: a round sent unpaid is in the kitchen, on the bill and never cancelled", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [],
        payLaterRounds: new Set([id(30), id(40)]),
        delivery: new Map([
          [id(31), { phase: "InProgress", deliveredQuantity: 0 }],
          [id(41), { phase: "Accepted", deliveredQuantity: 0 }],
        ]),
      }),
      paymentTiming: "PayLater",
    });
    expect(view.paymentTiming).toBe("PayLater");
    expect(view.rounds.map((round) => [round.status, round.payment, round.cancelsAt])).toEqual([
      ["Preparing", "OnTableBill", null],
      ["Queued", "OnTableBill", null],
    ]);
    // Everything ordered is still owed until the table pays.
    expect(view.summary?.due).toEqual(cad(3900n));
    expect(view.summary?.paid).toEqual(cad(0n));
  });

  it("v15 2026-10-29: a round staff cancelled on a table paying at the end was never charged", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [],
        payLaterRounds: new Set([id(30), id(40)]),
        staffCancellations: new Map([
          [id(30), { reason: "SoldOut", refundedMinor: 0n, pendingMinor: 0n }],
        ]),
      }),
      paymentTiming: "PayLater",
    });
    expect(view.rounds.map((round) => [round.status, round.payment])).toEqual([
      ["StoreCancelled", "NotCharged"],
      ["Received", "OnTableBill"],
    ]);
  });

  it("DEC-DINE-IN-PAY-LATER: once the table paid at the end, its rounds read paid and nothing is owed", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [{ status: "Succeeded", amount: cad(4410n) }],
        payLaterRounds: new Set([id(30), id(40)]),
        settledRounds: new Set([id(30), id(40)]),
      }),
      paymentTiming: "PayLater",
    });
    expect(view.rounds.map((round) => round.payment)).toEqual(["Paid", "Paid"]);
    expect(view.summary?.due).toEqual(cad(0n));
    // What the table paid: rounds, tip and cash rounding.
    expect(view.summary?.paid).toEqual(cad(4410n));
  });

  it("follows the kitchen and service of a paid round", () => {
    const status = (entries: [number, string, number][]) =>
      composeCustomerDiningSession(
        facts({
          batches: [
            {
              orderBatchReference: id(30),
              submittedAt: at,
              items: [item(31, "Ramen", 2, 3000n), item(32, "Tea", 1, 300n)],
            },
          ],
          authorship: new Map([[id(30), false]]),
          delivery: new Map(
            entries.map(([n, phase, delivered]) => [
              id(n),
              { phase: phase as never, deliveredQuantity: delivered },
            ]),
          ),
          paymentDeadlines: new Map(),
        }),
      ).rounds[0]?.status;
    expect(
      status([
        [31, "Submitted", 0],
        [32, "Submitted", 0],
      ]),
    ).toBe("Received");
    expect(
      status([
        [31, "Accepted", 0],
        [32, "Accepted", 0],
      ]),
    ).toBe("Queued");
    expect(
      status([
        [31, "Ready", 0],
        [32, "Ready", 0],
      ]),
    ).toBe("Ready");
    expect(
      status([
        [31, "Ready", 1],
        [32, "Ready", 0],
      ]),
    ).toBe("Serving");
    expect(
      status([
        [31, "Fulfilled", 2],
        [32, "Fulfilled", 1],
      ]),
    ).toBe("Served");
    expect(
      status([
        [31, "Fulfilled", 2],
        [32, "Cancelled", 0],
      ]),
    ).toBe("Served");
  });

  it("explains failed, unpaid-cancelled and store-cancelled rounds and the table's refunds", () => {
    const view = composeCustomerDiningSession(
      facts({
        batches: [
          { orderBatchReference: id(30), submittedAt: at, items: [item(31, "Ramen", 2, 3000n)] },
          { orderBatchReference: id(40), submittedAt: at, items: [item(41, "Gyoza", 1, 900n)] },
          { orderBatchReference: id(50), submittedAt: at, items: [item(51, "Soda", 1, 250n)] },
          {
            orderBatchReference: id(60),
            submittedAt: at,
            items: [item(61, "Rice", 1, 400n), item(62, "Egg", 1, 200n)],
          },
        ],
        authorship: new Map([
          [id(30), true],
          [id(40), false],
          [id(50), true],
          [id(60), false],
        ]),
        delivery: new Map([
          [id(31), { phase: "Cancelled", deliveredQuantity: 0 }],
          [id(41), { phase: "Submitted", deliveredQuantity: 0 }],
          [id(51), { phase: "Cancelled", deliveredQuantity: 0 }],
          [id(61), { phase: "Cancelled", deliveredQuantity: 0 }],
          [id(62), { phase: "Accepted", deliveredQuantity: 0 }],
        ]),
        paymentOutcomes: new Map([
          [id(30), "Succeeded"],
          [id(40), "Failed"],
          [id(50), "Failed"],
          [id(60), "Succeeded"],
        ]),
        unpaidCancellations: new Set([id(50)]),
        staffCancellations: new Map([
          [id(30), { reason: "SoldOut", refundedMinor: 3450n, pendingMinor: 0n }],
        ]),
        itemCancellations: [
          { orderItemReferences: [id(61)], refunded: false, refundAmount: cad(452n) },
        ],
        payments: [
          { status: "Succeeded", amount: cad(3450n) },
          { status: "Failed", amount: null },
          { status: "Succeeded", amount: cad(678n) },
        ],
        refunds: { confirmedMinor: 3450n, pendingMinor: 452n },
      }),
    );
    expect(view.rounds.map((round) => [round.status, round.payment])).toEqual([
      ["StoreCancelled", "Refunded"],
      ["PaymentFailed", "Failed"],
      ["NotPaidCancelled", "NotCharged"],
      ["Queued", "Paid"],
    ]);
    expect(view.rounds[0]?.storeCancellationReason).toBe("SoldOut");
    expect(view.rounds[1]?.cancelsAt).toBe("2026-10-13T18:40:00.000Z");
    expect(view.rounds[2]?.cancelsAt).toBeNull();
    expect(view.rounds[3]?.items.map((entry) => entry.cancelled)).toEqual([true, false]);
    expect(view.summary).toEqual({
      paid: cad(4128n),
      refunded: cad(3450n),
      refundPending: cad(452n),
      due: cad(900n),
    });
  });

  it("shows the table with no rounds before anyone orders, and fails closed on inconsistent facts", () => {
    expect(composeCustomerDiningSession({ ...facts(), order: null })).toEqual({
      tableLabel: "12",
      orderNumber: null,
      checkedAt: at,
      paymentTiming: "PayFirst",
      rounds: [],
      summary: null,
    });
    for (const broken of [
      facts({ authorship: new Map([[id(30), true]]) }),
      facts({ delivery: new Map([[id(31), { phase: "Ready", deliveredQuantity: 0 }]]) }),
      facts({
        payments: [{ status: "Succeeded", amount: { amountMinor: 1n, currencyCode: "USD" } }],
      }),
      // More refunded than was ever paid is not a state to show.
      facts({ refunds: { confirmedMinor: 4000n, pendingMinor: 0n } }),
    ])
      expect(() => composeCustomerDiningSession(broken)).toThrow(OrderStatusProjectionError);
  });
});

describe("WP-2423 Q8 createCustomerDiningSessionRead authorization", () => {
  const credentials = { sessionCredential: "a".repeat(43), csrfCredential: "b".repeat(43) };
  function setup(
    current: () => GuestSession,
    loaded: (context: { diningSessionReference: string }) => CustomerDiningSessionFacts = () =>
      facts(),
  ) {
    const factsPort = vi.fn<CustomerDiningSessionDependencies["facts"]>(async (_tx, context) =>
      loaded(context),
    );
    const read = createCustomerDiningSessionRead(
      {
        scope,
        credentials: {} as never,
        binding: () => ({}) as never,
        now: () => at,
        transactions: { run: async (work) => work({} as never) },
      },
      () => ({
        identity: () => ({ authorize: async () => current() }),
        facts: factsPort,
      }),
    );
    return { read, factsPort };
  }

  it("reads only the asking participant's own dining session", async () => {
    const { read, factsPort } = setup(() => guest());
    const view = await read.read(credentials);
    expect(view.rounds).toHaveLength(2);
    expect(factsPort).toHaveBeenCalledOnce();
    expect(factsPort.mock.calls[0]?.[1]).toMatchObject({
      diningSessionReference: id(20),
      guestSessionReference: id(10),
    });
  });

  it.each([
    ["a pickup guest", guest({ channel: "Pickup" as never })],
    [
      "a dine-in guest who has not joined the table",
      guest({
        diningState: "ContextOnly" as never,
        diningSessionReference: null,
        diningParticipantReference: null,
      }),
    ],
    ["a guest of another Store", guest({ storeReference: id(99) as never })],
  ])("refuses %s before any owner read", async (_name, refused) => {
    const { read, factsPort } = setup(() => refused);
    await expect(read.read(credentials)).rejects.toMatchObject({
      code: "ORDER_STATUS_PERMISSION_DENIED",
    });
    expect(factsPort).not.toHaveBeenCalled();
  });

  it("refuses another table's session facts", async () => {
    const { read } = setup(
      () => guest(),
      () => ({ ...facts(), diningSessionReference: id(77) }),
    );
    await expect(read.read(credentials)).rejects.toMatchObject({
      code: "ORDER_STATUS_PERMISSION_DENIED",
    });
  });

  it("refuses when the guest leaves or moves table during the read", async () => {
    let moved = false;
    const { read } = setup(
      () => (moved ? guest({ diningSessionReference: id(78) as never }) : guest()),
      () => {
        moved = true;
        return facts();
      },
    );
    await expect(read.read(credentials)).rejects.toMatchObject({
      code: "ORDER_STATUS_PERMISSION_DENIED",
    });
  });

  it("rejects malformed credentials and maps owner failures to unavailable", async () => {
    const { read } = setup(() => guest());
    await expect(read.read({ ...credentials, extra: true })).rejects.toMatchObject({
      code: "ORDER_STATUS_INPUT_INVALID",
    });
    const failing = setup(
      () => guest(),
      () => {
        throw new Error("DINING_ORDER_AUTHORSHIP_UNAVAILABLE");
      },
    );
    await expect(failing.read.read(credentials)).rejects.toMatchObject({
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
    });
  });
});

describe("WP-2423 Q26 a dish being remade at the table", () => {
  it("marks the item and keeps the round from reading served or ready", () => {
    const view = (phase: string, delivered: number) =>
      composeCustomerDiningSession(
        facts({
          batches: [
            { orderBatchReference: id(30), submittedAt: at, items: [item(31, "Ramen", 2, 3000n)] },
          ],
          authorship: new Map([[id(30), true]]),
          delivery: new Map([[id(31), { phase: phase as never, deliveredQuantity: delivered }]]),
          paymentDeadlines: new Map(),
          remakes: new Set([id(31)]),
        }),
      ).rounds[0];
    const served = view("Fulfilled", 2);
    expect(served?.status).toBe("Serving");
    expect(served?.items[0]).toMatchObject({ beingRemade: true });
    expect(view("Ready", 0)?.status).toBe("Preparing");
    const plain = composeCustomerDiningSession(facts()).rounds[0]?.items[0];
    expect(plain).not.toHaveProperty("beingRemade");
  });
});

describe("WP-2423 item 8 ④ v15 a: a split bill paid part by part", () => {
  it("takes the paid parts off what is still to pay and says how many parts are paid", () => {
    const summary = (paidRoundsMinor: bigint | null) =>
      composeCustomerDiningSession(
        facts({
          batches: [
            { orderBatchReference: id(30), submittedAt: at, items: [item(31, "Ramen", 1, 1018n)] },
          ],
          authorship: new Map([[id(30), true]]),
          delivery: new Map([[id(31), { phase: "Accepted" as never, deliveredQuantity: 0 }]]),
          paymentDeadlines: new Map(),
          paymentOutcomes: new Map(),
          payments: [{ status: "Succeeded", amount: cad(679n) }],
          payLaterRounds: new Set([id(30)]),
          ...(paidRoundsMinor === null
            ? {}
            : { splitParts: { count: 3, paid: 2, paidRoundsMinor } }),
        }),
      ).summary;
    expect(summary(null)?.due.amountMinor).toBe(1018n);
    expect(summary(679n)).toMatchObject({
      due: { amountMinor: 339n },
      splitParts: { count: 3, paid: 2 },
    });
  });
});

describe("WP-2423 item 8 ③ decision 13: order a dish again", () => {
  it("gives each dish its published menu item and options, and nothing without them", () => {
    const again = {
      sellableReference: id(40),
      optionSelections: [{ optionReference: id(41), quantity: 1 }],
    };
    const round = composeCustomerDiningSession(
      facts({
        batches: [
          { orderBatchReference: id(30), submittedAt: at, items: [item(31, "Ramen", 2, 3000n)] },
        ],
        authorship: new Map([[id(30), false]]),
        delivery: new Map([[id(31), { phase: "Accepted" as never, deliveredQuantity: 0 }]]),
        paymentDeadlines: new Map(),
        orderAgain: new Map([[id(31), again]]),
      }),
    ).rounds[0];
    // Another guest's dish too: the table orders together; no note or author is given.
    expect(round?.items[0]?.orderAgain).toEqual(again);
    const plain = composeCustomerDiningSession(facts()).rounds[0]?.items[0];
    expect(plain).not.toHaveProperty("orderAgain");
  });
});

describe("WP-2423 D5 item prices before tax at the table", () => {
  // Ramen 2 × $13.27 + 13% tax = $30.00 (26.55 + 3.45); Gyoza $7.96 + $1.04 = $9.00;
  // Soda $2.21 + $0.29 = $2.50 (its round was never paid and is cancelled).
  const prices = new Map([
    [id(31), { subtotal: cad(2655n), tax: cad(345n) }],
    [id(41), { subtotal: cad(796n), tax: cad(104n) }],
    [id(51), { subtotal: cad(221n), tax: cad(29n) }],
  ]);
  const threeRounds = {
    batches: [
      { orderBatchReference: id(30), submittedAt: at, items: [item(31, "Ramen", 2, 3000n)] },
      { orderBatchReference: id(40), submittedAt: at, items: [item(41, "Gyoza", 1, 900n)] },
      { orderBatchReference: id(50), submittedAt: at, items: [item(51, "Soda", 1, 250n)] },
    ],
    authorship: new Map([
      [id(30), true],
      [id(40), false],
      [id(50), true],
    ]),
    delivery: new Map([
      [id(31), { phase: "InProgress" as const, deliveredQuantity: 0 }],
      [id(41), { phase: "Submitted" as const, deliveredQuantity: 0 }],
      [id(51), { phase: "Cancelled" as const, deliveredQuantity: 0 }],
    ]),
    paymentOutcomes: new Map([
      [id(30), "Succeeded" as const],
      [id(50), "Failed" as const],
    ]),
    unpaidCancellations: new Set([id(50)]),
    payments: [{ status: "Succeeded" as const, amount: cad(3000n) }],
  };

  it("prints item prices before tax, then each round's and the table's subtotal, tax and total", () => {
    const before = composeCustomerDiningSession(facts(threeRounds));
    const view = composeCustomerDiningSession(facts({ ...threeRounds, itemPrices: prices }));
    expect(view.rounds.map((round) => round.items.map((entry) => entry.priceBeforeTax))).toEqual([
      [cad(2655n)],
      [cad(796n)],
      [cad(221n)],
    ]);
    expect(view.rounds.map((round) => [round.subtotal, round.tax, round.itemsTotal])).toEqual([
      [cad(2655n), cad(345n), cad(3000n)],
      [cad(796n), cad(104n), cad(900n)],
      [cad(221n), cad(29n), cad(250n)],
    ]);
    // The table ordered rounds 1 and 2 (round 3 was never paid and never charged).
    expect(view.summary?.ordered).toEqual({
      subtotal: cad(3451n),
      tax: cad(449n),
      total: cad(3900n),
    });
    // What guests pay, have paid and still owe is unchanged by printing prices before tax.
    expect(view.summary?.paid).toEqual(before.summary?.paid);
    expect(view.summary?.due).toEqual(before.summary?.due);
    expect(view.summary?.due).toEqual(cad(900n));
    expect(view.rounds.map((round) => round.itemsTotal)).toEqual(
      before.rounds.map((round) => round.itemsTotal),
    );
    expect(view.rounds.flatMap((round) => round.items.map((entry) => entry.lineTotal))).toEqual(
      before.rounds.flatMap((round) => round.items.map((entry) => entry.lineTotal)),
    );
    // Without prices (an older read) nothing before tax is invented.
    expect(before.rounds[0]?.items[0]).not.toHaveProperty("priceBeforeTax");
    expect(before.rounds[0]).not.toHaveProperty("subtotal");
    expect(before.summary).not.toHaveProperty("ordered");
  });

  it("v15 2026-10-29: the tea note is per guest before tax, counting only tea still on the bill", () => {
    // Gyoza stands for the tea here ($7.96 before tax); the soda line was cancelled.
    const tea = new Set([id(41), id(51)]);
    const view = composeCustomerDiningSession(
      facts({ ...threeRounds, itemPrices: prices, teaItems: tea }),
    );
    expect(view.summary?.teaCharge).toEqual({ perGuest: cad(796n), guests: 1 });
    // A round that is only the tea (taken off or not) says so; the guest page folds those
    // taken off into one line.
    const marked = composeCustomerDiningSession(
      facts({ ...threeRounds, itemPrices: prices, teaItems: tea, teaLines: tea }),
    );
    expect(marked.rounds.map((round) => round.tea === true)).toEqual([false, true, true]);
    // No prices before tax: no note (never a price with tax in it).
    expect(
      composeCustomerDiningSession(facts({ ...threeRounds, teaItems: tea })).summary,
    ).not.toHaveProperty("teaCharge");
  });

  it("never mixes priced and unpriced items", () => {
    const partial = new Map([...prices].filter(([reference]) => reference !== id(41)));
    const view = composeCustomerDiningSession(facts({ ...threeRounds, itemPrices: partial }));
    expect(view.rounds[0]?.items[0]).not.toHaveProperty("priceBeforeTax");
    expect(view.summary).not.toHaveProperty("ordered");
    const usd = new Map(prices);
    usd.set(id(41), { subtotal: { amountMinor: 796n, currencyCode: "USD" }, tax: cad(104n) });
    expect(
      composeCustomerDiningSession(facts({ ...threeRounds, itemPrices: usd })).summary,
    ).not.toHaveProperty("ordered");
  });
});
