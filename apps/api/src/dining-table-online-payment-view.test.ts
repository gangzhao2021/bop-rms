import { expect, it, vi } from "vitest";

// M89 (v15 batch 8): the staff stop was recorded, then its answer failed to be written (a 503 to
// staff) because the bill it carried held the owner's working rows, whose amounts are bigint.
const m = vi.hoisted(() => ({
  bill: null as unknown,
  payments: [] as unknown[],
  refunds: [] as unknown[],
  refundReads: 0,
}));
vi.mock("@rms/payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/payment")>()),
  createPostgresDiningTableSettlementStore: () => ({
    listOnlinePaymentsByOrders: async () => m.payments,
    listOnlineRefundsByOrders: async () => {
      m.refundReads += 1;
      return m.refunds;
    },
  }),
}));
vi.mock("./merchant-dining-table-checkout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./merchant-dining-table-checkout.js")>()),
  readDiningTableBill: async () => m.bill,
}));
const { createDiningTableOnlinePayments } = await import("./dining-table-online-payment.js");

const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");

it("M89: the table payment's view carries only the bill's public fields, so it can be answered as JSON", async () => {
  m.bill = {
    diningSessionReference: id(1),
    orderReference: id(2),
    sessionPhase: "Closing",
    rounds: [],
    owed: { subtotalMinor: "2500", taxMinor: "325", totalMinor: "2825" },
    split: null,
    settlement: null,
    guestChoices: null,
    waitingRounds: [],
    // The owner's working rows: never on the wire.
    settlementRecord: null,
    splitPlanRecord: null,
    splitDishes: [
      {
        orderBatchReference: id(3),
        orderItemReference: id(4),
        quantity: 2,
        subtotalMinor: 2500n,
        taxMinor: 325n,
        totalMinor: 2825n,
      },
    ],
    dishAdders: new Map(),
    splitRounds: [{ orderBatchReference: id(3), roundMinor: 2825n }],
  };
  const payments = createDiningTableOnlinePayments({
    scope: { tenantReference: id(10), brandReference: id(11), storeReference: id(12) },
    providerAccountReference: id(13),
    environment: "Test",
    provider: {} as never,
    transactions: { run: async (work) => work({} as never) },
    now: () => "2026-11-11T21:29:30.000Z",
    nextReference: () => id(20),
  });
  const view = await payments.read({
    diningSessionReference: id(1),
    guestSessionReference: null,
    allowed: async () => true,
  });
  const wire = JSON.parse(JSON.stringify(view.bill)) as Record<string, unknown>;
  expect(wire.owed).toEqual({ subtotalMinor: "2500", taxMinor: "325", totalMinor: "2825" });
  for (const internal of [
    "splitDishes",
    "splitRounds",
    "dishAdders",
    "settlementRecord",
    "splitPlanRecord",
  ])
    expect(wire).not.toHaveProperty(internal);
});

it("batch 50: a guest whose own dishes can't be priced now is told so, not that nothing of theirs is left", async () => {
  const guest = id(30);
  const at = (roundSubtotalMinor: bigint) => ({
    diningSessionReference: id(1),
    orderReference: id(2),
    sessionPhase: "Closing",
    rounds: [],
    owed: { subtotalMinor: "2500", taxMinor: "325", totalMinor: "2825" },
    split: null,
    settlement: null,
    guestChoices: {
      defaultScope: "WholeTable",
      dishes: [
        {
          orderItemReference: id(4),
          displayName: "Dumplings",
          roundNumber: 1,
          orderedBy: null,
          unitMinor: ["1413", "1412"],
          unitSubtotalMinor: ["1250", "1250"],
        },
      ],
      rounds: [],
    },
    waitingRounds: [],
    settlementRecord: null,
    splitPlanRecord: null,
    splitDishes: [
      {
        orderBatchReference: id(3),
        orderItemReference: id(4),
        quantity: 2,
        subtotalMinor: 2500n,
        taxMinor: 325n,
        totalMinor: 2825n,
      },
    ],
    dishAdders: new Map([[id(4), guest]]),
    // A round whose dishes don't add up to it (the bill changed under it): no part can be priced.
    splitRounds: [
      {
        orderBatchReference: id(3),
        submissionReference: id(5),
        sequence: 1,
        roundMinor: 2825n,
        subtotalMinor: roundSubtotalMinor,
        taxMinor: 325n,
      },
    ],
  });
  const payments = createDiningTableOnlinePayments({
    scope: { tenantReference: id(10), brandReference: id(11), storeReference: id(12) },
    providerAccountReference: id(13),
    environment: "Test",
    provider: {} as never,
    transactions: { run: async (work) => work({} as never) },
    now: () => "2026-11-11T21:29:30.000Z",
    nextReference: () => id(20),
  });
  const read = async () =>
    (
      await payments.read({
        diningSessionReference: id(1),
        guestSessionReference: id(31),
        participantReference: guest,
        allowed: async () => true,
      })
    ).choices;
  m.bill = at(2500n);
  expect(await read()).toMatchObject({
    mine: { count: 2, amountMinor: "2825" },
    addedAny: true,
    mineUnavailable: false,
  });
  m.bill = at(9999n);
  expect(await read()).toMatchObject({ mine: null, addedAny: true, mineUnavailable: true });
});

// Batch 57 (WP-2423 Q36): a guest paid part 1 of a split on their phone and staff refunded part of
// it to the card. The view's own payments carry Payment's refund records of that payment only (in
// the shapes v15 holds: Succeeded, no answer yet, Failed), never a refund of another guest's.
it("batch 57: this phone's own payment carries its own refunds, and only those", async () => {
  const mine = id(30),
    other = id(31);
  const captured = (payment: number, guest: string, partNumber: number) => ({
    onlinePaymentReference: id(payment),
    operationReference: id(payment + 1),
    guestSessionReference: guest,
    roundsMinor: 1413n,
    tipMinor: 0n,
    totalMinor: 1413n,
    part: { splitPlanReference: id(50), partNumber },
    outcome: {
      status: "Captured",
      capturedMinor: 1413n,
      providerTransactionReference: null,
      occurredAt: "2026-11-24T00:34:40.000Z",
      recordedAt: "2026-11-24T00:34:40.000Z",
    },
  });
  const refund = (payment: number, amountMinor: bigint, status: "Succeeded" | "Failed" | null) => ({
    onlineRefundReference: id(60 + Number(amountMinor % 31n)),
    onlinePaymentReference: id(payment),
    orderReference: id(2),
    amountMinor,
    reasonCode: "FOOD_ISSUE",
    approvedByActorReference: id(70),
    requestedAt: "2026-11-24T00:40:17.521Z",
    outcome:
      status === null
        ? null
        : {
            status,
            providerRefundReference: status === "Succeeded" ? "re_TEST0001" : null,
            providerCreatedAt: null,
            recordedAt: "2026-11-24T00:40:17.565Z",
          },
  });
  m.bill = {
    diningSessionReference: id(1),
    orderReference: id(2),
    sessionPhase: "Closing",
    rounds: [],
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    split: null,
    settlement: null,
    guestChoices: null,
    waitingRounds: [],
    settlementRecord: null,
    splitPlanRecord: { splitPlanReference: id(50), guestParts: [] },
    splitDishes: [],
    dishAdders: new Map(),
    splitRounds: [],
  };
  m.payments = [captured(80, mine, 1), captured(90, other, 2)];
  m.refunds = [
    refund(80, 500n, "Succeeded"),
    refund(90, 400n, "Succeeded"),
    refund(80, 300n, null),
    refund(80, 200n, "Failed"),
  ];
  const payments = createDiningTableOnlinePayments({
    scope: { tenantReference: id(10), brandReference: id(11), storeReference: id(12) },
    providerAccountReference: id(13),
    environment: "Test",
    provider: {} as never,
    transactions: { run: async (work) => work({} as never) },
    now: () => "2026-11-24T00:45:00.000Z",
    nextReference: () => id(20),
  });
  const at = (guestSessionReference: string | null) =>
    payments.read({
      diningSessionReference: id(1),
      guestSessionReference,
      allowed: async () => true,
    });
  const view = await at(mine);
  expect(view.ownPayments?.map((payment) => payment.refunds)).toEqual([
    [
      {
        amountMinor: "500",
        status: "Refunded",
        requestedAt: "2026-11-24T00:40:17.521Z",
        answeredAt: "2026-11-24T00:40:17.565Z",
      },
      {
        amountMinor: "300",
        status: "Pending",
        requestedAt: "2026-11-24T00:40:17.521Z",
        answeredAt: null,
      },
      {
        amountMinor: "200",
        status: "Failed",
        requestedAt: "2026-11-24T00:40:17.521Z",
        answeredAt: "2026-11-24T00:40:17.565Z",
      },
    ],
  ]);
  expect(JSON.stringify(view.ownPayments)).not.toMatch(/400|re_TEST|FOOD_ISSUE|01909988/u);
  // A phone that paid nothing here: no refund records are read for it.
  m.refundReads = 0;
  expect((await at(id(32))).ownPayments).toEqual([]);
  expect((await at(null)).ownPayments).toEqual([]);
  expect(m.refundReads).toBe(0);
});
