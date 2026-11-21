import { beforeEach, describe, expect, it, vi } from "vitest";
import { readPayFirstRoundStandings, tonightTableStanding } from "./merchant-tonight-summary.js";

const base = {
  writtenOff: false,
  owedMinor: 0n,
  unpaidRounds: 0,
  tableMoneyTaken: false,
  keptPaidRounds: 0,
  ordered: true,
};

it("M40: only a table whose money was really taken and kept reads as paid", () => {
  // Pay-at-end table settled, or a split part paid with nothing left owing.
  expect(tonightTableStanding({ ...base, tableMoneyTaken: true })).toBe("Paid");
  // Pay-first table with a paid round still kept.
  expect(tonightTableStanding({ ...base, keptPaidRounds: 1 })).toBe("Paid");
  // Pay-first table whose only paid round was refunded with "Can't make it · refund".
  expect(tonightTableStanding({ ...base, keptPaidRounds: 0 })).toBe("NothingToCollect");
  // Seated, never ordered.
  expect(tonightTableStanding({ ...base, ordered: false })).toBe("NothingOrdered");
  // Walkout.
  expect(tonightTableStanding({ ...base, writtenOff: true, tableMoneyTaken: true })).toBe(
    "WrittenOff",
  );
  // A pay-first round nobody paid yet, even after an earlier paid one.
  expect(tonightTableStanding({ ...base, keptPaidRounds: 1, unpaidRounds: 1 })).toBe("RoundUnpaid");
  // A bill still owing, even after one part was paid.
  expect(tonightTableStanding({ ...base, owedMinor: 2346n, tableMoneyTaken: true })).toBe("Owes");
});

// M40: how the pay-first rounds of the open tables are put together, with Ordering's and
// Payment's reads mocked (the database acceptance covers the reads themselves).
const reads = vi.hoisted(() => ({
  waiting: [] as { diningSessionReference: string; orderBatchReference: string }[],
  justPaid: new Set<string>(),
  outcomes: [] as { orderReference: string; orderBatchReference: string; status: string }[],
  machine: new Map<string, unknown[]>(),
  cancelled: [] as { orderBatchReference: string }[],
  terminated: new Set<string>(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  listStoreUnpaidGuestDiningRounds: async () => reads.waiting,
  readStaffOrderCancellations: async () => reads.cancelled,
  listStoreTerminatedOrderBatches: async () => reads.terminated,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  listStoreOrderBatchesPaidOnline: async () => reads.justPaid,
  listStoreOrderBatchPaymentOutcomes: async () => reads.outcomes,
  createPostgresCardMachinePaymentStore: () => ({ listByOrders: async () => reads.machine }),
}));

const ref = (n: number) => "019a0000-0000-7000-8000-" + String(n).padStart(12, "0");
const scope = { tenantReference: ref(1), brandReference: ref(2), storeReference: ref(3) };
const [order, batchA, batchB, session] = [ref(10), ref(11), ref(12), ref(20)];
const table = {
  paymentTiming: "PayFirst" as const,
  diningSessionReference: session,
  orderReference: order,
};
const noLedger = { payments: [], refundedPayments: [], refunds: [] };
const onlinePayment = (batch: string, intent: string, totalMinor: bigint) =>
  ({
    channel: "Online",
    paymentIntentReference: intent,
    orderReference: order,
    orderBatchReference: batch,
    orderAllocationMinor: totalMinor,
    tipMinor: 0n,
    totalMinor,
    roundingMinor: 0n,
    paymentCount: 1,
    takenAt: "2026-11-06T23:00:00.000Z",
  }) as const;
const onlineRefund = (intent: string, amountMinor: bigint) =>
  ({
    channel: "Online",
    kind: "Ordinary",
    refundReference: ref(90),
    orderReference: order,
    paymentIntentReference: intent,
    amountMinor,
    refundedAt: "2026-11-06T23:10:00.000Z",
    items: null,
  }) as const;
const machinePaid = (batch: string, totalMinor: bigint, refunds: bigint[]) => ({
  payment: { orderBatchReference: batch, preparation: { total: { amountMinor: totalMinor } } },
  refunds: refunds.map((amountMinor) => ({ amountMinor })),
});
const standings = (ledger: Parameters<typeof readPayFirstRoundStandings>[3] = noLedger) =>
  readPayFirstRoundStandings({} as never, scope, [table], ledger, async () => true);

beforeEach(() => {
  reads.waiting = [];
  reads.justPaid = new Set();
  reads.outcomes = [];
  reads.machine = new Map();
  reads.cancelled = [];
  reads.terminated = new Set();
});

describe("M40: pay-first rounds read for tonight's open tables", () => {
  it("counts a round still waiting, but not one whose payment just arrived", async () => {
    reads.waiting = [
      { diningSessionReference: session, orderBatchReference: batchA },
      { diningSessionReference: session, orderBatchReference: batchB },
    ];
    reads.justPaid = new Set([batchB]);
    expect((await standings()).unpaid.get(session)).toBe(1);
  });

  it("keeps a round paid online, and one paid on the card machine", async () => {
    reads.outcomes = [{ orderReference: order, orderBatchReference: batchA, status: "Succeeded" }];
    reads.machine = new Map([[order, [machinePaid(batchB, 2346n, [])]]]);
    expect((await standings()).kept.get(order)).toBe(2);
  });

  it("does not keep a round refunded in full on the card machine; a part refund keeps it", async () => {
    reads.machine = new Map([[order, [machinePaid(batchA, 2346n, [1000n, 1346n])]]]);
    expect((await standings()).kept.get(order)).toBeUndefined();
    reads.machine = new Map([[order, [machinePaid(batchA, 2346n, [1000n])]]]);
    expect((await standings()).kept.get(order)).toBe(1);
  });

  it("does not keep a round refunded in full online (an ordinary refund request)", async () => {
    reads.outcomes = [{ orderReference: order, orderBatchReference: batchA, status: "Succeeded" }];
    const intent = ref(30);
    const ledger = {
      payments: [onlinePayment(batchA, intent, 2346n)],
      refundedPayments: [],
      refunds: [onlineRefund(intent, 2346n)],
    };
    expect((await standings(ledger)).kept.get(order)).toBeUndefined();
    const part = { ...ledger, refunds: [onlineRefund(intent, 500n)] };
    expect((await standings(part)).kept.get(order)).toBe(1);
    // The ledger's capture counts even before its status projection is written.
    reads.outcomes = [];
    expect((await standings({ ...ledger, refunds: [] })).kept.get(order)).toBe(1);
  });

  it("does not keep a round Ordering terminated, or one staff cancelled for a refund", async () => {
    reads.outcomes = [
      { orderReference: order, orderBatchReference: batchA, status: "Succeeded" },
      { orderReference: order, orderBatchReference: batchB, status: "Succeeded" },
    ];
    reads.terminated = new Set([batchA]);
    reads.cancelled = [{ orderBatchReference: batchB }];
    expect((await standings()).kept.get(order)).toBeUndefined();
  });

  it("never counts a failed payment as kept", async () => {
    reads.outcomes = [{ orderReference: order, orderBatchReference: batchA, status: "Failed" }];
    expect((await standings()).kept.get(order)).toBeUndefined();
  });
});
