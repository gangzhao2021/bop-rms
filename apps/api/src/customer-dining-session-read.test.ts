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
