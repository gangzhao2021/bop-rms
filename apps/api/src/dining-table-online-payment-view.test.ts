import { expect, it, vi } from "vitest";

// M89 (v15 batch 8): the staff stop was recorded, then its answer failed to be written (a 503 to
// staff) because the bill it carried held the owner's working rows, whose amounts are bigint.
const m = vi.hoisted(() => ({ bill: null as unknown }));
vi.mock("@rms/payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/payment")>()),
  createPostgresDiningTableSettlementStore: () => ({
    listOnlinePaymentsByOrders: async () => [],
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
