import { GuestSessionError, type GuestSession } from "@bop/identity";
import { OrderStatusProjectionError } from "@rms/ordering";
import { describe, expect, it, vi } from "vitest";
import { billReductionTaxRoundingShares, computeBillTaxRounding } from "@rms/ordering";
import {
  composeCustomerDiningSession,
  createCustomerDiningSessionRead,
  createProjectionLagWindow,
  customerSplitParts,
  customerTableBillFacts,
  customerTableBillLines,
  mergeBillOrderFacts,
  readCustomerTablePayments,
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

  it("v15 2026-10-30 (item 8 ⑨): a table merged into this one is on its page and its bill", () => {
    const own = facts({
      paymentOutcomes: new Map(),
      payments: [],
      payLaterRounds: new Set([id(30), id(40)]),
    }).order as Order;
    const merged: Order = {
      ...own,
      batches: [
        {
          orderBatchReference: id(60),
          submittedAt: "2026-10-13T18:05:00.000Z",
          items: [item(61, "Mapo tofu", 1, 2303n)],
        },
      ],
      authorship: new Map([[id(60), false]]),
      delivery: new Map([[id(61), { phase: "Fulfilled", deliveredQuantity: 1 }]]),
      paymentDeadlines: new Map(),
      payLaterRounds: new Set([id(60)]),
    };
    const view = composeCustomerDiningSession({
      ...facts(),
      order: {
        ...mergeBillOrderFacts(own, [merged]),
        tableBill: {
          owedMinor: 6203n,
          pointsUsedMinor: 0n,
          takenOffMinor: 0n,
          taxRoundingMinor: 0n,
        },
      },
      paymentTiming: "PayLater",
    });
    // Its round is listed (ordered by "another guest", never this phone) and on the table's bill.
    expect(view.rounds.map((round) => [round.orderedBy, round.payment])).toEqual([
      ["You", "OnTableBill"],
      ["AnotherGuest", "OnTableBill"],
      ["AnotherGuest", "OnTableBill"],
    ]);
    expect(view.summary?.due).toEqual(cad(3900n + 2303n));
  });

  it("WP-2423 table-move-payment: names the table a moved party came from, never the one it sits at", () => {
    const base = facts();
    expect(composeCustomerDiningSession(base).movedFromTableLabel).toBeUndefined();
    expect(
      composeCustomerDiningSession({ ...base, movedFromTableLabel: "T6" }).movedFromTableLabel,
    ).toBe("T6");
    expect(
      composeCustomerDiningSession({ ...base, order: null, movedFromTableLabel: "T6" })
        .movedFromTableLabel,
    ).toBe("T6");
    // A to B and back to A never reads "from A to A".
    expect(
      composeCustomerDiningSession({ ...base, movedFromTableLabel: base.tableLabel as string })
        .movedFromTableLabel,
    ).toBeUndefined();
  });

  it("DEC-DINE-IN-PAY-LATER: a round sent unpaid is in the kitchen, on the bill and never cancelled", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [],
        payLaterRounds: new Set([id(30), id(40)]),
        tableBill: {
          owedMinor: 3900n,
          pointsUsedMinor: 0n,
          takenOffMinor: 0n,
          taxRoundingMinor: 0n,
        },
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

  it("v15 2026-11-02: a table paying at the end owes what its bill owes, with what came off", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [],
        payLaterRounds: new Set([id(30), id(40)]),
        tableBill: {
          owedMinor: 3412n,
          pointsUsedMinor: 339n,
          takenOffMinor: 150n,
          taxRoundingMinor: 1n,
        },
      }),
      paymentTiming: "PayLater",
    });
    expect(view.summary?.due).toEqual(cad(3412n));
    expect(view.summary?.pointsUsed).toEqual(cad(339n));
    expect(view.summary?.takenOff).toEqual(cad(150n));
    // b22: the bill's rounding is in Total ordered's tax, never a line of its own.
    expect(view.summary?.taxRounding).toBeUndefined();
  });

  // v15 b12 live (BR E-style bill): the guest read Tax $6.51, "Taken off −$31.09" and "Rounding
  // $0.01" while staff checkout and the paid bill read Subtotal $22.50 / Tax $2.93 / $25.43.
  it("b13: a table paying at the end reads its bill as checkout prints it, one Tax line, round by round", () => {
    const lines = (
      itemsMinor: bigint,
      takenOffMinor: bigint,
      subtotalMinor: bigint,
      taxMinor: bigint,
    ) => ({
      itemsMinor,
      takenOffMinor,
      pointsMinor: 0n,
      subtotalMinor,
      taxMinor,
      totalMinor: subtotalMinor + taxMinor,
    });
    const rounds = new Map([
      [id(30), lines(3000n, 1250n, 1750n, 228n)],
      [id(40), lines(2000n, 1500n, 500n, 65n)],
    ]);
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [],
        payLaterRounds: new Set([id(30), id(40)]),
        tableBill: {
          owedMinor: 2543n,
          pointsUsedMinor: 0n,
          takenOffMinor: 3109n,
          taxRoundingMinor: 1n,
          bill: lines(5000n, 2750n, 2250n, 293n),
          rounds,
        },
      }),
      paymentTiming: "PayLater",
    });
    expect(view.summary?.bill).toEqual({
      items: cad(5000n),
      takenOff: cad(2750n),
      pointsUsed: cad(0n),
      subtotal: cad(2250n),
      tax: cad(293n),
      total: cad(2543n),
    });
    // One Tax line: no separate rounding when the bill is read whole.
    expect(view.summary?.taxRounding).toBeUndefined();
    expect(view.summary?.due).toEqual(cad(2543n));
    // Each round card says what the bill says of it, so they add up to the Table total.
    expect(view.rounds.map((round) => round.bill?.total)).toEqual([cad(1978n), cad(565n)]);
    expect(view.rounds[1]?.bill?.takenOff).toEqual(cad(1500n));
  });

  // b13 review: a dish priced with an order-time discount or fee has a total these lines have no
  // line for; its round and the whole bill are then not said as lines (the guest's page still
  // reads, with round totals as ordered and the tax rounding line), never the page unavailable.
  it("b13: bill lines are said only where they add up as printed", () => {
    const round = (
      reference: string,
      subtotalMinor: string,
      taxMinor: string,
      totalMinor: string,
      reduction: { amountMinor: string; netMinor: string } | null = null,
    ) => ({
      roundNumber: 1,
      orderReference: id(1),
      orderBatchReference: reference,
      submissionReference: id(2),
      items: [
        {
          orderItemReference: id(3),
          quantity: 1,
          displayName: "Dish (TEST)",
          subtotalMinor: "2000",
          totalMinor: "2260",
          reduction:
            reduction === null ? null : { kind: "Comp" as const, percent: null, ...reduction },
        },
      ],
      subtotalMinor,
      taxMinor,
      totalMinor,
      taxRoundingMinor: "0",
      paid: false,
      orderedBy: null,
      fromTableLabel: null,
      liveOrderedAt: null,
    });
    const even = round(id(30), "1500", "195", "1695", { amountMinor: "565", netMinor: "500" });
    const ok = customerTableBillLines([even]);
    expect(ok.bill).toEqual({
      itemsMinor: 2000n,
      takenOffMinor: 500n,
      pointsMinor: 0n,
      subtotalMinor: 1500n,
      taxMinor: 195n,
      totalMinor: 1695n,
    });
    expect(ok.rounds.get(id(30))?.totalMinor).toBe(1695n);
    // An order-time discount of $2.00 left in the total: subtotal + tax is not the total.
    const discounted = round(id(40), "2000", "234", "2034");
    const mixed = customerTableBillLines([even, discounted]);
    expect(mixed.bill).toBeUndefined();
    expect([...mixed.rounds.keys()]).toEqual([id(30)]);
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [],
        payLaterRounds: new Set([id(30), id(40)]),
        tableBill: {
          owedMinor: 3729n,
          pointsUsedMinor: 0n,
          takenOffMinor: 565n,
          taxRoundingMinor: 1n,
          ...mixed,
        },
      }),
      paymentTiming: "PayLater",
    });
    expect(view.summary?.bill).toBeUndefined();
    // b22: one tax figure: the rounding is in Total ordered, not a line of its own.
    expect(view.summary?.taxRounding).toBeUndefined();
  });

  it("b23 review: what came off the bill is the comp's total with tax and its bill cent", () => {
    // TM2 live (v15 b22): the cucumber comped, net 625, tax 81 with its -1 bill cent, total 706.
    const comp = { kind: "Comp" as const, percent: null, amountMinor: "706", netMinor: "625" };
    const bill = {
      rounds: [
        {
          roundNumber: 1,
          orderReference: id(1),
          orderBatchReference: id(50),
          submissionReference: id(51),
          items: [
            {
              orderItemReference: id(52),
              quantity: 1,
              displayName: "Smashed cucumber",
              subtotalMinor: "625",
              totalMinor: "707",
              reduction: comp,
            },
            {
              orderItemReference: id(53),
              quantity: 1,
              displayName: "Beef noodles (TEST)",
              subtotalMinor: "1250",
              totalMinor: "1413",
              reduction: null,
            },
          ],
          subtotalMinor: "1250",
          taxMinor: "163",
          totalMinor: "1413",
          taxRoundingMinor: "0",
          paid: false,
          orderedBy: null,
          fromTableLabel: null,
          liveOrderedAt: null,
        },
      ],
      owed: { totalMinor: "1413" },
      taxRoundingMinor: "0",
      split: null,
      writeOff: null,
    } as unknown as Parameters<typeof customerTableBillFacts>[0];
    const tableBill = customerTableBillFacts(bill);
    expect(tableBill.takenOffMinor).toBe(706n);
    expect(tableBill.pointsUsedMinor).toBe(0n);
    expect(tableBill.owedMinor).toBe(1413n);
    expect(tableBill.bill?.takenOffMinor).toBe(625n);
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [],
        payLaterRounds: new Set([id(50)]),
        tableBill,
      }),
      paymentTiming: "PayLater",
    });
    expect(view.summary?.takenOff?.amountMinor).toBe(706n);
    expect(view.summary?.bill?.takenOff?.amountMinor).toBe(625n);
  });

  // b39 review (v15 sweep 38): after H6 was merged into H4 the guest's round cards did not say
  // which table a round came from; the table's bill knows (as staff see it).
  it("says the table a merged-in round was ordered at, and nothing on the table's own", () => {
    const round = (batch: number, fromTableLabel: string | null) => ({
      roundNumber: batch,
      orderReference: id(1),
      orderBatchReference: id(batch),
      submissionReference: id(batch + 1),
      items: [],
      subtotalMinor: "0",
      taxMinor: "0",
      totalMinor: "0",
      taxRoundingMinor: "0",
      paid: false,
      orderedBy: null,
      fromTableLabel,
      liveOrderedAt: null,
    });
    const bill = (merged: boolean) =>
      ({
        rounds: [round(30, null), round(40, merged ? "H6" : null)],
        owed: { totalMinor: "900" },
        taxRoundingMinor: "0",
        split: null,
        writeOff: null,
      }) as unknown as Parameters<typeof customerTableBillFacts>[0];
    expect(customerTableBillFacts(bill(false)).fromTables).toBeUndefined();
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [],
        payLaterRounds: new Set([id(30), id(40)]),
        tableBill: customerTableBillFacts(bill(true)),
      }),
      paymentTiming: "PayLater",
    });
    expect(view.rounds.map((entry) => entry.fromTable)).toEqual([undefined, "H6"]);
  });

  it("b13: a split the bill outgrew says nothing of its old parts", () => {
    const base = {
      paymentOutcomes: new Map(),
      payments: [],
      payLaterRounds: new Set([id(30), id(40)]),
      splitParts: { count: 2, paid: 0 },
    };
    const bill = { owedMinor: 1413n, pointsUsedMinor: 0n, takenOffMinor: 0n, taxRoundingMinor: 0n };
    expect(
      composeCustomerDiningSession({
        ...facts({ ...base, tableBill: bill }),
        paymentTiming: "PayLater",
      }).summary?.splitParts,
    ).toEqual({ count: 2, paid: 0 });
    expect(
      composeCustomerDiningSession({
        ...facts({ ...base, tableBill: { ...bill, splitStale: true } }),
        paymentTiming: "PayLater",
      }).summary?.splitParts,
    ).toBeUndefined();
  });

  it("v15 2026-10-29: a round staff cancelled on a table paying at the end was never charged", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [],
        payLaterRounds: new Set([id(30), id(40)]),
        tableBill: {
          owedMinor: 900n,
          pointsUsedMinor: 0n,
          takenOffMinor: 0n,
          taxRoundingMinor: 0n,
        },
        staffCancellations: new Map([
          [id(30), { reason: "SoldOut", refundedMinor: 0n, pendingMinor: 0n }],
        ]),
        itemPrices: new Map([
          [id(31), { subtotal: cad(2655n), tax: cad(345n) }],
          [id(41), { subtotal: cad(796n), tax: cad(104n) }],
        ]),
      }),
      paymentTiming: "PayLater",
    });
    expect(view.rounds.map((round) => [round.status, round.payment])).toEqual([
      ["StoreCancelled", "NotCharged"],
      ["Received", "OnTableBill"],
    ]);
    // v15 b19: the cancelled round was never charged, so Total ordered is what is still to pay.
    expect(view.summary?.ordered?.total).toEqual(cad(900n));
    expect(view.summary?.due).toEqual(cad(900n));
  });

  it("DEC-DINE-IN-PAY-LATER: once the table paid at the end, its rounds read paid and nothing is owed", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [{ status: "Succeeded", amount: cad(4410n) }],
        payLaterRounds: new Set([id(30), id(40)]),
        tableBill: { owedMinor: 0n, pointsUsedMinor: 0n, takenOffMinor: 0n, taxRoundingMinor: 0n },
        settledRounds: new Set([id(30), id(40)]),
      }),
      paymentTiming: "PayLater",
    });
    expect(view.rounds.map((round) => round.payment)).toEqual(["Paid", "Paid"]);
    expect(view.summary?.due).toEqual(cad(0n));
    // What the table paid: rounds, tip and cash rounding.
    expect(view.summary?.paid).toEqual(cad(4410n));
  });

  // Batch 51 (v15 b50 live, G50 Pay): guest A paid only their own dish ($14.13, round 1) by dish;
  // guest C's round 2 ($14.12) was still to pay. A's round 1 kept "On the table's bill" after its
  // only dish was paid, even after a reload. The bill says which rounds are paid in full; a round
  // only partly paid stays on the table's bill.
  it("batch 51: a round paid in full by dish reads Paid; one still (partly) owed stays on the bill", () => {
    const round = (batch: number, totalMinor: string, paid: boolean) => ({
      roundNumber: batch / 10 - 2,
      orderReference: id(1),
      orderBatchReference: id(batch),
      submissionReference: id(batch + 1),
      items: [
        {
          orderItemReference: id(batch + 2),
          quantity: 1,
          displayName: "Beef noodles (TEST)",
          subtotalMinor: "1250",
          totalMinor,
          reduction: null,
        },
      ],
      subtotalMinor: "1250",
      taxMinor: String(Number(totalMinor) - 1250),
      totalMinor,
      taxRoundingMinor: "0",
      paid,
      orderedBy: null,
      fromTableLabel: null,
      liveOrderedAt: null,
    });
    const bill = (firstPaid: boolean) =>
      ({
        rounds: [round(30, "1413", firstPaid), round(40, "1412", false)],
        owed: { totalMinor: firstPaid ? "1412" : "2825" },
        taxRoundingMinor: "0",
        split: null,
        writeOff: null,
      }) as unknown as Parameters<typeof customerTableBillFacts>[0];
    expect(customerTableBillFacts(bill(false)).paidRounds).toBeUndefined();
    const view = (firstPaid: boolean) =>
      composeCustomerDiningSession({
        ...facts({
          paymentOutcomes: new Map(),
          payments: firstPaid ? [{ status: "Succeeded", amount: cad(1413n) }] : [],
          payLaterRounds: new Set([id(30), id(40)]),
          tableBill: customerTableBillFacts(bill(firstPaid)),
          // A part of a by-dish bill settles no round on its own (the bill isn't paid in full).
          settledRounds: new Set(),
          splitParts: firstPaid ? { count: null, paid: 1 } : null,
        }),
        paymentTiming: "PayLater",
      });
    expect(view(false).rounds.map((entry) => entry.payment)).toEqual([
      "OnTableBill",
      "OnTableBill",
    ]);
    const paid = view(true);
    expect(paid.rounds.map((entry) => entry.payment)).toEqual(["Paid", "OnTableBill"]);
    // The paid round still shows its bill lines; the summary agrees with it.
    expect(paid.rounds[0]?.bill?.total).toEqual(cad(1413n));
    expect(paid.summary?.paid).toEqual(cad(1413n));
    expect(paid.summary?.due).toEqual(cad(1412n));
  });

  // WP-2423 M04: the guest page said "已送到厨房" for 8 to 19 minutes while the kitchen had nothing.
  it("says a paid round accepted but not yet in the kitchen was received, never sent", () => {
    const round = (kitchenPending: ReadonlySet<string> | undefined) =>
      composeCustomerDiningSession(
        facts({
          batches: [
            {
              orderBatchReference: id(30),
              submittedAt: at,
              items: [item(31, "Ramen", 2, 3000n)],
            },
          ],
          authorship: new Map([[id(30), true]]),
          delivery: new Map([[id(31), { phase: "Accepted", deliveredQuantity: 0 }]]),
          paymentOutcomes: new Map([[id(30), "Succeeded"]]),
          paymentDeadlines: new Map(),
          ...(kitchenPending === undefined ? {} : { kitchenPending }),
        }),
      ).rounds[0]?.status;
    expect(round(new Set([id(30)]))).toBe("Received");
    // Released to the kitchen (or a round with no payment wait, a table paying at the end): sent.
    expect(round(undefined)).toBe("Queued");
    expect(round(new Set([id(99)]))).toBe("Queued");
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
    // Cancelled when its payment failed: not stopped by its payer.
    expect(view.rounds[2]).not.toHaveProperty("stoppedBeforePaying");
    // v15 batch-5: the same round, stopped by the guest paying for it, says so.
    const stopped = composeCustomerDiningSession(
      facts({
        batches: [
          { orderBatchReference: id(50), submittedAt: at, items: [item(51, "Soda", 1, 250n)] },
        ],
        authorship: new Map([[id(50), true]]),
        delivery: new Map([[id(51), { phase: "Cancelled", deliveredQuantity: 0 }]]),
        unpaidCancellations: new Set([id(50)]),
        guestStoppedRounds: new Set([id(50)]),
      }),
    );
    expect(stopped.rounds[0]).toMatchObject({
      status: "NotPaidCancelled",
      payment: "NotCharged",
      stoppedBeforePaying: true,
    });
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

  it("WP-2423 item 8 ⑧: a phone of a party staff moved is told where the party sits now", async () => {
    const factsPort = vi.fn<CustomerDiningSessionDependencies["facts"]>();
    const readWith = (moved: { tableLabel: string } | null) =>
      createCustomerDiningSessionRead(
        {
          scope,
          credentials: {} as never,
          binding: () => ({}) as never,
          now: () => at,
          transactions: { run: async (work) => work({} as never) },
        },
        () => ({
          // The phone joined the old table: its table check fails.
          identity: () => ({
            authorize: async () => {
              throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
            },
          }),
          facts: factsPort,
          moved: async () => moved,
        }),
      ).read(credentials);
    await expect(readWith({ tableLabel: "T7" })).rejects.toMatchObject({
      name: "DiningTableMovedError",
      tableLabel: "T7",
    });
    // Not moved: the same refusal as before, and no facts read.
    await expect(readWith(null)).rejects.toMatchObject({
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

  it("M126 I.3: a Guest Session store that can't answer is an outage, never 'not joined'", async () => {
    const outage = () =>
      Object.assign(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"), {
        dependencyFailure: true,
      });
    const first = setup(() => {
      throw outage();
    });
    await expect(first.read.read(credentials)).rejects.toMatchObject({
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
    });
    expect(first.factsPort).not.toHaveBeenCalled();
    // The check again after the facts (the guest is still at this table) fails the same way.
    let reads = 0;
    const later = setup(() => {
      reads += 1;
      if (reads > 1) throw outage();
      return guest();
    });
    await expect(later.read.read(credentials)).rejects.toMatchObject({
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
    });
    // A session that really ended is still refused as before.
    const ended = setup(() => {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    });
    await expect(ended.read.read(credentials)).rejects.toMatchObject({
      code: "ORDER_STATUS_PERMISSION_DENIED",
    });
  });

  // v15 b17: a staff round being written while the guest's table page reads: the kitchen moved
  // a round on meanwhile, or a write conflict outlasted its reruns. The table is fine: busy.
  it.each([
    ["the kitchen moved a round on meanwhile", new Error("ORDER_PROGRESS_CHANGED_WHILE_READING")],
    [
      "a write conflict behind a rewrite",
      new Error("ORDER_STATUS_DEPENDENCY_UNAVAILABLE", {
        cause: Object.assign(new Error("conflict"), {
          code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
        }),
      }),
    ],
  ])("v15 b17: %s is busy, never unavailable", async (_name, cause) => {
    const busy = setup(
      () => guest(),
      () => {
        throw cause;
      },
    );
    await expect(busy.read.read(credentials)).rejects.toMatchObject({
      name: "DiningSessionReadBusyError",
      code: "DINING_SESSION_READ_BUSY",
      cause,
    });
  });

  // v15 b17 review: an outage is not "still processing": no connection in time (pool exhausted),
  // a lost or refused connection, or a statement timeout stays unavailable and is logged as such.
  it.each([
    [
      "no database connection in time",
      Object.assign(new Error("busy"), { code: "TENANT_DATABASE_ACQUIRE_FAILED" }),
    ],
    ["a lost connection", Object.assign(new Error("lost"), { diagnostic: { sqlState: "08006" } })],
    [
      "a statement timeout",
      Object.assign(new Error("slow"), { diagnostic: { sqlState: "57014" } }),
    ],
  ])("v15 b17 review: %s is unavailable, never busy", async (_name, cause) => {
    const outage = setup(
      () => guest(),
      () => {
        throw cause;
      },
    );
    await expect(outage.read.read(credentials)).rejects.toMatchObject({
      name: "OrderStatusProjectionError",
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
    });
  });

  // v15 b17 review: the status view behind a newer Order version is caught up within its time;
  // the same version still behind after that is a fault (unavailable), never busy for ever.
  it("v15 b17 review: a status view lag is busy only for its catch-up time", () => {
    const lag = createProjectionLagWindow(30_000, 2);
    expect(lag.catchingUp(id(1), 4, "2026-11-14T10:00:00.000Z")).toBe(true);
    expect(lag.catchingUp(id(1), 4, "2026-11-14T10:00:29.999Z")).toBe(true);
    expect(lag.catchingUp(id(1), 4, "2026-11-14T10:00:30.000Z")).toBe(false);
    // A newer Order version is a new change being caught up.
    expect(lag.catchingUp(id(1), 5, "2026-11-14T10:00:31.000Z")).toBe(true);
    // Kept small: the oldest entry is dropped, so a later sighting starts again.
    expect(lag.catchingUp(id(2), 1, "2026-11-14T10:00:32.000Z")).toBe(true);
    expect(lag.catchingUp(id(1), 4, "2026-11-14T10:01:00.000Z")).toBe(true);
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
          tableBill: {
            owedMinor: 1018n - (paidRoundsMinor ?? 0n),
            pointsUsedMinor: 0n,
            takenOffMinor: 0n,
            taxRoundingMinor: 0n,
          },
          ...(paidRoundsMinor === null ? {} : { splitParts: { count: 3, paid: 2 } }),
        }),
      ).summary;
    expect(summary(null)?.due.amountMinor).toBe(1018n);
    expect(summary(679n)).toMatchObject({
      due: { amountMinor: 339n },
      splitParts: { count: 3, paid: 2 },
    });
  });
  it("v15 b12: a split nothing was paid on, on a bill comped to nothing, is not mentioned", () => {
    const summary = (owedMinor: bigint, paid: number) =>
      composeCustomerDiningSession(
        facts({
          batches: [
            { orderBatchReference: id(30), submittedAt: at, items: [item(31, "Ramen", 1, 1018n)] },
          ],
          authorship: new Map([[id(30), true]]),
          delivery: new Map([[id(31), { phase: "Accepted" as never, deliveredQuantity: 0 }]]),
          paymentDeadlines: new Map(),
          paymentOutcomes: new Map(),
          payments: [],
          payLaterRounds: new Set([id(30)]),
          tableBill: {
            owedMinor,
            pointsUsedMinor: 0n,
            takenOffMinor: 1018n - owedMinor,
            taxRoundingMinor: 0n,
          },
          splitParts: { count: 2, paid },
        }),
      ).summary;
    expect(summary(0n, 0)?.due.amountMinor).toBe(0n);
    expect(summary(0n, 0)).not.toHaveProperty("splitParts");
    expect(summary(1018n, 0)).toMatchObject({ splitParts: { count: 2, paid: 0 } });
  });
});

describe("v15 batch 7 table-pay-by-dish: what the table page says about the parts", () => {
  it("gives staff's split its count, guests paying by dish none, and nothing without a split", () => {
    const paidOne = [{ part: null }, { part: { partNumber: 1 } }];
    expect(customerSplitParts({ mode: "Even", parts: [1, 2, 3] }, paidOne)).toEqual({
      count: 3,
      paid: 1,
    });
    expect(customerSplitParts({ mode: "ByGuests", parts: [1] }, paidOne)).toEqual({
      count: null,
      paid: 1,
    });
    expect(customerSplitParts({ mode: "Whole", parts: [] }, [])).toBeNull();
    expect(customerSplitParts(undefined, [])).toBeNull();
  });

  it("batch 53 (v15 b52 live): a bill paid in full by dish still says it was paid in 2 parts", async () => {
    // v15 b52 live: guest A paid their own dish online (1413), guest C paid the rest (1412); the
    // plan's second part took the last of the bill, so the split is paid in full.
    const plan = "split-plan-1";
    const settlements = [1, 2].map((partNumber) => ({
      part: { splitPlanReference: plan, partNumber },
      tipMinor: 0n,
      roundingMinor: 0n,
    }));
    const store = (mode: "ByGuests" | "Even") => ({
      listByOrders: async () => settlements,
      listCashRefundsByOrders: async () => [],
      listCardRefundsByOrders: async () => [],
      listOnlineRefundsByOrders: async () => [],
      listSplitPlans: async () => [
        {
          splitPlanReference: plan,
          mode,
          parts: [{ partNumber: 1 }, { partNumber: 2 }],
          guestParts: [
            { partNumber: 1, completesBill: false, withdrawn: null },
            { partNumber: 2, completesBill: true, withdrawn: null },
          ],
        },
      ],
    });
    const read = (mode: "ByGuests" | "Even") =>
      readCustomerTablePayments(
        {} as never,
        store(mode) as unknown as Parameters<typeof readCustomerTablePayments>[1],
        "order-1" as never,
      );
    const byDish = await read("ByGuests");
    expect(byDish.splitPaid).toBe(true);
    expect(byDish.splitParts).toEqual({ count: null, paid: 2 });
    expect((await read("Even")).splitParts).toEqual({ count: 2, paid: 2 });
    const summary = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [
          { status: "Succeeded", amount: cad(1413n) },
          { status: "Succeeded", amount: cad(1412n) },
        ],
        payLaterRounds: new Set([id(30), id(40)]),
        tableBill: { owedMinor: 0n, pointsUsedMinor: 0n, takenOffMinor: 0n, taxRoundingMinor: 0n },
        tableSettlement: { tipMinor: 0n, roundingMinor: 0n },
        splitParts: byDish.splitParts,
      }),
      paymentTiming: "PayLater",
    }).summary;
    expect(summary).toMatchObject({
      paid: { amountMinor: 2825n },
      splitParts: { count: null, paid: 2 },
    });
  });
});

describe("batch 58 (v15 b57 live): the table total after staff refunded a payment", () => {
  // v15 b57 live, TM2 L57R A (order 2) and L57R B (order 6): even split in 2, phone A paid part 1
  // online (1413), staff wrote off the rest (1412), then a manager refunded 800 of part 1 (A) or
  // all 1413 (B) to the card; the Provider answered Succeeded. Every phone's Table total still
  // said "Paid $14.13". The refund records are Payment's (rms_payment.dining_table_online_refund
  // and _outcome) in the store's read shape.
  const online = (amountMinor: bigint, status: "Succeeded" | "Failed" | null) => ({
    onlineRefundReference: "online-refund-" + amountMinor,
    operationReference: "operation-" + amountMinor,
    intentDigest: "sha256:" + "0".repeat(64),
    settlementReference: "settlement-1",
    onlinePaymentReference: "online-payment-1",
    orderReference: "order-1",
    amountMinor,
    reasonCode: "CUSTOMER_REQUEST",
    approvedByActorReference: "actor-1",
    providerIdempotencyKey: "table-online-refund:operation-" + amountMinor,
    requestedAt: "2026-11-24T09:09:12.104Z",
    outcome:
      status === null
        ? null
        : {
            status,
            providerRefundReference: status === "Succeeded" ? "re_TEST" : null,
            providerCreatedAt: null,
            recordedAt: "2026-11-24T09:09:12.123Z",
          },
  });
  const read = (refunds: {
    cash?: readonly { amountMinor: bigint }[];
    card?: readonly { amountMinor: bigint }[];
    online?: readonly ReturnType<typeof online>[];
    settled?: boolean;
  }) =>
    readCustomerTablePayments(
      {} as never,
      {
        listByOrders: async () =>
          refunds.settled === false
            ? []
            : [{ part: { splitPlanReference: "plan-1", partNumber: 1 }, tipMinor: 0n }],
        listSplitPlans: async () => [
          {
            splitPlanReference: "plan-1",
            mode: "Even",
            parts: [{ partNumber: 1 }, { partNumber: 2 }],
            guestParts: [],
          },
        ],
        listCashRefundsByOrders: async () => refunds.cash ?? [],
        listCardRefundsByOrders: async () => refunds.card ?? [],
        listOnlineRefundsByOrders: async () => refunds.online ?? [],
      } as unknown as Parameters<typeof readCustomerTablePayments>[1],
      "order-1" as never,
    );
  const summaryWith = (refundedMinor: bigint) =>
    composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [{ status: "Succeeded", amount: cad(1413n) }],
        payLaterRounds: new Set([id(30), id(40)]),
        tableBill: {
          owedMinor: 0n,
          pointsUsedMinor: 0n,
          takenOffMinor: 0n,
          taxRoundingMinor: 0n,
          closedByStaff: true,
        },
        tableSettlement: {
          tipMinor: 0n,
          roundingMinor: 0n,
          ...(refundedMinor === 0n ? {} : { refundedMinor }),
        },
        splitParts: { count: 2, paid: 1 },
      }),
      paymentTiming: "PayLater",
    }).summary;

  it("reads Payment's refunds of the table's payments: on its way or back counts, refused not", async () => {
    expect((await read({ online: [online(800n, "Succeeded")] })).refundedMinor).toBe(800n);
    expect((await read({ online: [online(1413n, "Succeeded")] })).refundedMinor).toBe(1413n);
    expect(
      (
        await read({
          online: [online(500n, "Succeeded"), online(300n, null), online(200n, "Failed")],
        })
      ).refundedMinor,
    ).toBe(800n);
    // Cash given back and card-machine refunds are the table's refunds too.
    expect(
      (await read({ cash: [{ amountMinor: 100n }], card: [{ amountMinor: 50n }] })).refundedMinor,
    ).toBe(150n);
    expect((await read({})).refundedMinor).toBe(0n);
    // Nothing paid at the table: nothing to have been refunded (and nothing read).
    expect((await read({ settled: false, online: [online(1n, "Succeeded")] })).refundedMinor).toBe(
      0n,
    );
  });

  it("the table says what it paid after refunds once any went back, and only then", () => {
    expect(summaryWith(800n)).toMatchObject({
      paid: { amountMinor: 1413n },
      paidAfterRefunds: { amountMinor: 613n },
    });
    expect(summaryWith(1413n)).toMatchObject({ paidAfterRefunds: { amountMinor: 0n } });
    expect(summaryWith(0n)).not.toHaveProperty("paidAfterRefunds");
    // More back than was paid is never shown.
    expect(() => summaryWith(1414n)).toThrow();
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

  // WP-2423 item 8b, hotpot: 再来一份 on the sauce bar fee, which the guest cart then refuses.
  it("a charge line is never offered again and its round says it is a charge", () => {
    const again = (n: number) => ({ sellableReference: id(n), optionSelections: [] });
    const view = composeCustomerDiningSession(
      facts({
        batches: [
          // Only a charge: the round reads as one.
          { orderBatchReference: id(30), submittedAt: at, items: [item(31, "Sauce bar", 4, 800n)] },
          // A dish beside a charge: the round stays a dish's, and the dish keeps its button.
          {
            orderBatchReference: id(40),
            submittedAt: at,
            items: [item(41, "Corkage", 1, 1500n), item(42, "Ramen", 1, 1500n)],
          },
        ],
        authorship: new Map([
          [id(30), false],
          [id(40), false],
        ]),
        delivery: new Map([
          [id(31), { phase: "Submitted" as never, deliveredQuantity: 0 }],
          [id(41), { phase: "Submitted" as never, deliveredQuantity: 0 }],
          [id(42), { phase: "Submitted" as never, deliveredQuantity: 0 }],
        ]),
        paymentDeadlines: new Map(),
        orderAgain: new Map([
          [id(31), again(50)],
          [id(41), again(51)],
          [id(42), again(52)],
        ]),
        chargeLines: new Set([id(31), id(41)]),
      }),
    );
    expect(view.rounds[0]?.charge).toBe(true);
    expect(view.rounds[0]?.items[0]).not.toHaveProperty("orderAgain");
    expect(view.rounds[1]).not.toHaveProperty("charge");
    expect(view.rounds[1]?.items[0]).not.toHaveProperty("orderAgain");
    expect(view.rounds[1]?.items[1]?.orderAgain).toEqual(again(52));
  });

  // The menu's "already ordered" hint and a combo's dishes and allergens come from orderAgain, so a
  // failed read of which lines are charges must not take those away.
  it("a failed charge read keeps combo dishes and table counts", () => {
    const again = { sellableReference: id(50), optionSelections: [] };
    const view = composeCustomerDiningSession(
      facts({
        batches: [
          { orderBatchReference: id(30), submittedAt: at, items: [item(31, "Combo", 1, 2880n)] },
        ],
        authorship: new Map([[id(30), true]]),
        delivery: new Map([[id(31), { phase: "Submitted" as never, deliveredQuantity: 0 }]]),
        paymentDeadlines: new Map(),
        orderAgain: new Map([[id(31), again]]),
      }),
    );
    expect(view.rounds[0]?.items[0]?.orderAgain).toEqual(again);
    expect(view.rounds[0]).not.toHaveProperty("charge");
  });

  it("a merged table's charges stay charges on the table's bill", () => {
    const merged = mergeBillOrderFacts(facts({ chargeLines: new Set([id(31)]) }).order as Order, [
      facts({ chargeLines: new Set([id(41)]) }).order as Order,
    ]);
    expect([...(merged.chargeLines ?? [])].sort()).toEqual([id(31), id(41)]);
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
    // The note carries the Store's own name for the charge (item 8b): never just "tea".
    expect(view.summary?.teaCharge).toEqual({ perGuest: cad(796n), guests: 1, name: "Gyoza" });
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

  it("v15 b19: a round the store refused and refunded is not in Total ordered; the refund is its own line", () => {
    // Round 1 (Ramen, paid $30.00) refused and refunded; round 2 (Gyoza $9.00) waits for payment.
    const view = composeCustomerDiningSession(
      facts({
        ...threeRounds,
        batches: threeRounds.batches.slice(0, 2),
        itemPrices: prices,
        unpaidCancellations: new Set(),
        paymentOutcomes: new Map([[id(30), "Succeeded" as const]]),
        delivery: new Map([
          [id(31), { phase: "Cancelled" as const, deliveredQuantity: 0 }],
          [id(41), { phase: "Submitted" as const, deliveredQuantity: 0 }],
        ]),
        staffCancellations: new Map([
          [id(30), { reason: "CustomerRequest", refundedMinor: 3000n, pendingMinor: 0n }],
        ]),
        refunds: { confirmedMinor: 3000n, pendingMinor: 0n },
      }),
    );
    expect(view.rounds.map((round) => [round.status, round.payment])).toEqual([
      ["StoreCancelled", "Refunded"],
      ["AwaitingPayment", "Awaiting"],
    ]);
    expect(view.summary?.ordered).toEqual({
      subtotal: cad(796n),
      tax: cad(104n),
      total: cad(900n),
    });
    // Paid less refunded, plus what is waiting, is what the table has on order.
    expect(view.summary?.paid).toEqual(cad(3000n));
    expect(view.summary?.refunded).toEqual(cad(3000n));
    expect(view.summary?.due).toEqual(cad(900n));
  });

  it("v15 b19: a paid round's dish cancelled and refunded leaves Total ordered; paid − refunded is it", () => {
    // One round paid $39.00: Ramen $30.00 and Gyoza $9.00; staff cancelled the Gyoza, $9.00 back.
    const view = composeCustomerDiningSession(
      facts({
        batches: [
          {
            orderBatchReference: id(30),
            submittedAt: at,
            items: [item(31, "Ramen", 2, 3000n), item(41, "Gyoza", 1, 900n)],
          },
        ],
        authorship: new Map([[id(30), true]]),
        itemPrices: prices,
        paymentOutcomes: new Map([[id(30), "Succeeded" as const]]),
        delivery: new Map([
          [id(31), { phase: "InProgress" as const, deliveredQuantity: 0 }],
          [id(41), { phase: "Cancelled" as const, deliveredQuantity: 0 }],
        ]),
        itemCancellations: [
          { orderItemReferences: [id(41)], refunded: true, refundAmount: cad(900n) },
        ],
        payments: [{ status: "Succeeded" as const, amount: cad(3900n) }],
        refunds: { confirmedMinor: 900n, pendingMinor: 0n },
      }),
    );
    expect(view.rounds.map((round) => [round.status, round.payment])).toEqual([
      ["Preparing", "Paid"],
    ]);
    expect(view.summary?.ordered).toEqual({
      subtotal: cad(2655n),
      tax: cad(345n),
      total: cad(3000n),
    });
    const summary = view.summary;
    expect(
      (summary?.paid.amountMinor ?? 0n) -
        (summary?.refunded.amountMinor ?? 0n) -
        (summary?.refundPending.amountMinor ?? 0n) +
        (summary?.due.amountMinor ?? 0n),
    ).toBe(summary?.ordered?.total.amountMinor);
  });

  it("v15 b20: a paid round with a dish cancelled and refunded says on that round what went back", () => {
    // Round 1 paid $39.00 (Ramen $30.00 + Gyoza $9.00), the Gyoza cancelled with $9.00 back;
    // round 2 paid $9.00, nothing cancelled. A refund still on its way says so instead.
    const view = (refunded: boolean) =>
      composeCustomerDiningSession(
        facts({
          batches: [
            {
              orderBatchReference: id(30),
              submittedAt: at,
              items: [item(31, "Ramen", 2, 3000n), item(41, "Gyoza", 1, 900n)],
            },
            { orderBatchReference: id(50), submittedAt: at, items: [item(51, "Soda", 1, 900n)] },
          ],
          authorship: new Map([
            [id(30), true],
            [id(50), true],
          ]),
          paymentOutcomes: new Map([
            [id(30), "Succeeded" as const],
            [id(50), "Succeeded" as const],
          ]),
          delivery: new Map([
            [id(31), { phase: "InProgress" as const, deliveredQuantity: 0 }],
            [id(41), { phase: "Cancelled" as const, deliveredQuantity: 0 }],
            [id(51), { phase: "InProgress" as const, deliveredQuantity: 0 }],
          ]),
          itemCancellations: [{ orderItemReferences: [id(41)], refunded, refundAmount: cad(900n) }],
          payments: [
            { status: "Succeeded" as const, amount: cad(3900n) },
            { status: "Succeeded" as const, amount: cad(900n) },
          ],
          refunds: refunded
            ? { confirmedMinor: 900n, pendingMinor: 0n }
            : { confirmedMinor: 0n, pendingMinor: 900n },
        }),
      );
    const done = view(true);
    expect(done.rounds.map((round) => [round.payment, round.itemsTotal])).toEqual([
      ["Paid", cad(3900n)],
      ["Paid", cad(900n)],
    ]);
    expect(done.rounds[0]?.refunded).toEqual(cad(900n));
    expect(done.rounds[0]?.refundPending).toBeUndefined();
    expect(done.rounds[1]).not.toHaveProperty("refunded");
    expect(done.rounds[1]).not.toHaveProperty("refundPending");
    // The table's totals are as before: the refund is counted once, on its own line.
    expect(done.summary?.refunded).toEqual(cad(900n));
    const pending = view(false);
    expect(pending.rounds[0]?.refundPending).toEqual(cad(900n));
    expect(pending.rounds[0]).not.toHaveProperty("refunded");
  });

  it("v15 b20: a round whose dishes were all taken off before the table paid at the end is never charged", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [{ status: "Succeeded", amount: cad(3000n) }],
        delivery: new Map([
          [id(31), { phase: "InProgress", deliveredQuantity: 0 }],
          [id(41), { phase: "Cancelled", deliveredQuantity: 0 }],
        ]),
        payLaterRounds: new Set([id(30), id(40)]),
        itemCancellations: [
          {
            orderItemReferences: [id(41)],
            refunded: false,
            refundAmount: cad(0n),
            notCharged: true,
          },
        ],
        tableBill: { owedMinor: 0n, pointsUsedMinor: 0n, takenOffMinor: 0n, taxRoundingMinor: 0n },
        settledRounds: new Set([id(30), id(40)]),
      }),
      paymentTiming: "PayLater",
    });
    expect(view.rounds.map((round) => [round.status, round.payment])).toEqual([
      ["Preparing", "Paid"],
      ["StoreCancelled", "NotCharged"],
    ]);
    expect(view.rounds[1]).not.toHaveProperty("refundPending");
  });

  // b25 final: the guest page says "Taken off the bill · not charged" only from `takenOff`.
  describe("b25 final: takenOff marks only a dish staff took off the table's bill", () => {
    const bill = { owedMinor: 3900n, pointsUsedMinor: 0n, takenOffMinor: 0n, taxRoundingMinor: 0n };
    const payLater = (order: Partial<Order>) =>
      composeCustomerDiningSession({
        ...facts({
          paymentOutcomes: new Map(),
          payments: [],
          payLaterRounds: new Set([id(30), id(40)]),
          tableBill: bill,
          ...order,
        }),
        paymentTiming: "PayLater",
      });
    const flags = (view: ReturnType<typeof composeCustomerDiningSession>) =>
      view.rounds.map((round) =>
        round.items.map((entry) => [entry.cancelled, "takenOff" in entry ? entry.takenOff : null]),
      );

    it("a dish taken off before the table paid at the end, and a round staff cancelled unpaid", () => {
      const view = payLater({
        delivery: new Map([
          [id(31), { phase: "InProgress", deliveredQuantity: 0 }],
          [id(41), { phase: "Cancelled", deliveredQuantity: 0 }],
        ]),
        itemCancellations: [
          {
            orderItemReferences: [id(41)],
            refunded: false,
            refundAmount: cad(0n),
            notCharged: true,
          },
        ],
      });
      expect(flags(view)).toEqual([[[false, null]], [[true, true]]]);
      // Still true after the table paid the rest at the end.
      const settled = payLater({
        delivery: new Map([
          [id(31), { phase: "InProgress", deliveredQuantity: 0 }],
          [id(41), { phase: "Cancelled", deliveredQuantity: 0 }],
        ]),
        itemCancellations: [
          {
            orderItemReferences: [id(41)],
            refunded: false,
            refundAmount: cad(0n),
            notCharged: true,
          },
        ],
        settledRounds: new Set([id(30), id(40)]),
      });
      expect(flags(settled)).toEqual([[[false, null]], [[true, true]]]);
      const round = payLater({
        staffCancellations: new Map([
          [id(30), { reason: "SoldOut", refundedMinor: 0n, pendingMinor: 0n }],
        ]),
      });
      expect(flags(round)).toEqual([[[true, true]], [[false, null]]]);
    });

    it("a dish the kitchen refused with no take-off stays on the bill, never taken off", () => {
      const view = payLater({
        batches: [
          {
            orderBatchReference: id(30),
            submittedAt: at,
            items: [item(31, "Ramen", 2, 3000n), item(32, "Rice", 1, 300n)],
          },
          { orderBatchReference: id(40), submittedAt: at, items: [item(41, "Gyoza", 1, 900n)] },
        ],
        delivery: new Map([
          [id(31), { phase: "InProgress", deliveredQuantity: 0 }],
          [id(32), { phase: "Rejected", deliveredQuantity: 0 }],
          [id(41), { phase: "Rejected", deliveredQuantity: 0 }],
        ]),
      });
      expect(flags(view)).toEqual([
        [
          [false, null],
          [true, null],
        ],
        [[true, null]],
      ]);
      // The round the kitchen refused whole is still on the table's bill, not "not charged".
      expect(view.rounds.map((round) => [round.status, round.payment])).toEqual([
        ["Preparing", "OnTableBill"],
        ["StoreCancelled", "OnTableBill"],
      ]);
      expect(view.summary?.due).toEqual(cad(3900n));
    });

    it("a pay-first round never paid is not charged, but nothing was taken off a bill", () => {
      const view = composeCustomerDiningSession(facts({ unpaidCancellations: new Set([id(40)]) }));
      expect(view.rounds[1]?.status).toBe("NotPaidCancelled");
      expect(view.rounds[1]?.payment).toBe("NotCharged");
      expect(flags(view)).toEqual([[[false, null]], [[true, null]]]);
    });
  });

  it("v15 b19: a paid dish the kitchen refused with no refund recorded stays in Total ordered", () => {
    // Both rounds paid ($30.00 and $9.00); the kitchen refused the Gyoza, nothing went back yet.
    const view = composeCustomerDiningSession(
      facts({
        batches: threeRounds.batches.slice(0, 2),
        itemPrices: prices,
        paymentOutcomes: new Map([
          [id(30), "Succeeded" as const],
          [id(40), "Succeeded" as const],
        ]),
        delivery: new Map([
          [id(31), { phase: "InProgress" as const, deliveredQuantity: 0 }],
          [id(41), { phase: "Rejected" as const, deliveredQuantity: 0 }],
        ]),
        payments: [
          { status: "Succeeded" as const, amount: cad(3000n) },
          { status: "Succeeded" as const, amount: cad(900n) },
        ],
      }),
    );
    // b26 (live25): no refund exists for it, so none is claimed: it reads Paid (and the page says
    // no refund was made), never "being refunded to the card that paid".
    expect(view.rounds.map((round) => [round.status, round.payment])).toEqual([
      ["Preparing", "Paid"],
      ["StoreCancelled", "Paid"],
    ]);
    // It was charged and nothing has gone back: what was paid is what the table has on order.
    expect(view.summary?.ordered).toEqual({
      subtotal: cad(3451n),
      tax: cad(449n),
      total: cad(3900n),
    });
    expect(view.summary?.paid).toEqual(cad(3900n));
    expect(view.summary?.refunded).toEqual(cad(0n));
    expect(view.summary?.refundPending).toEqual(cad(0n));
    expect(view.summary?.due).toEqual(cad(0n));
  });

  it("b26 (live25): a table that paid at the end, round refused whole with no take-off or refund, reads Paid", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [{ status: "Succeeded", amount: cad(3900n) }],
        delivery: new Map([
          [id(31), { phase: "Fulfilled", deliveredQuantity: 2 }],
          [id(41), { phase: "Rejected", deliveredQuantity: 0 }],
        ]),
        payLaterRounds: new Set([id(30), id(40)]),
        settledRounds: new Set([id(30), id(40)]),
        tableBill: { owedMinor: 0n, pointsUsedMinor: 0n, takenOffMinor: 0n, taxRoundingMinor: 0n },
      }),
      paymentTiming: "PayLater",
    });
    expect(view.rounds.map((round) => [round.status, round.payment])).toEqual([
      ["Served", "Paid"],
      ["StoreCancelled", "Paid"],
    ]);
    // A refund the store has started on the order is said as on its way.
    const pending = composeCustomerDiningSession({
      ...facts({
        paymentOutcomes: new Map(),
        payments: [{ status: "Succeeded", amount: cad(3900n) }],
        delivery: new Map([
          [id(31), { phase: "Fulfilled", deliveredQuantity: 2 }],
          [id(41), { phase: "Rejected", deliveredQuantity: 0 }],
        ]),
        payLaterRounds: new Set([id(30), id(40)]),
        settledRounds: new Set([id(30), id(40)]),
        refunds: { confirmedMinor: 0n, pendingMinor: 900n },
        tableBill: { owedMinor: 0n, pointsUsedMinor: 0n, takenOffMinor: 0n, taxRoundingMinor: 0n },
      }),
      paymentTiming: "PayLater",
    });
    expect(pending.rounds[1]?.payment).toBe("RefundPending");
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

describe("M91/M41: each dish's progress and a paid round nobody accepted", () => {
  const view = (entries: [number, string, number][], paid = true) =>
    composeCustomerDiningSession(
      facts({
        batches: [
          {
            orderBatchReference: id(30),
            submittedAt: at,
            items: [
              item(31, "Ramen", 2, 3000n),
              item(32, "Tea", 1, 300n),
              item(33, "Rice", 1, 200n),
            ],
          },
        ],
        authorship: new Map([[id(30), true]]),
        delivery: new Map(
          entries.map(([n, phase, delivered]) => [
            id(n),
            { phase: phase as never, deliveredQuantity: delivered },
          ]),
        ),
        paymentOutcomes: paid ? new Map([[id(30), "Succeeded"]]) : new Map(),
        paymentDeadlines: new Map(),
      }),
    ).rounds[0];
  it("says per dish whether it is waiting, being made, ready or served", () => {
    const round = view([
      [31, "Ready", 1],
      [32, "InProgress", 0],
      [33, "Fulfilled", 1],
    ]);
    expect(round?.items.map((entry) => entry.progress)).toEqual(["Ready", "Making", "Served"]);
    expect(
      view([
        [31, "Accepted", 0],
        [32, "Submitted", 0],
        [33, "Cancelled", 0],
      ])?.items.map((entry) => entry.progress),
    ).toEqual(["Waiting", "Waiting", undefined]);
  });
  it("marks a paid round the store has not accepted, and only that one", () => {
    const waiting = view([
      [31, "Submitted", 0],
      [32, "Submitted", 0],
      [33, "Submitted", 0],
    ]);
    expect(waiting?.status).toBe("Received");
    expect(waiting?.awaitingStore).toBe(true);
    const accepted = view([
      [31, "Accepted", 0],
      [32, "Submitted", 0],
      [33, "Submitted", 0],
    ]);
    expect(accepted?.awaitingStore).toBeUndefined();
  });
});

// b22 (v15 live21, TM2 pay-at-end table, staff rounds Beef noodles / Soy milk + Smashed cucumber /
// Beef noodles): the session JSON said ordered.total 3900 while bill.total and due were 3899 (and
// 3193 vs 3192 after the cucumber came off), because ordered added each dish's own tax and the bill
// works its tax out once. The receipt is the bill: paid − refunded − refund pending + due = ordered.
describe("b22 DEC-TAX-WHOLE-RECEIPT: what the guest's page says adds up to the bill to the cent", () => {
  const hst = (taxAmountMinor: bigint) => ({
    taxComponentCode: "SYNTHETIC_TAX",
    treatment: "Taxable" as const,
    rate: "0.13",
    roundingMode: "HalfUp" as const,
    calculationOrder: 1,
    compoundOnPriorTax: false,
    taxAmountMinor,
  });
  interface Dish {
    n: number;
    name: string;
    net: bigint;
    tax: bigint;
  }
  const beef = (n: number): Dish => ({ n, name: "Beef noodles (TEST)", net: 1250n, tax: 163n });
  const soy = (n: number): Dish => ({ n, name: "Soy milk", net: 325n, tax: 42n });
  const cucumber = (n: number): Dish => ({ n, name: "Smashed cucumber", net: 625n, tax: 82n });
  /** The table's rounds as the session read and the bill read them (the bill's own algorithm). */
  function table(
    rounds: readonly (readonly Dish[])[],
    takenOff: ReadonlySet<number> = new Set(),
    unprinted: number | null = null,
  ) {
    const batch = (index: number) => id(300 + index);
    const rounding = computeBillTaxRounding(
      rounds.map((dishes, index) => ({
        orderReference: id(1),
        orderBatchReference: batch(index),
        items: dishes
          .filter((dish) => !takenOff.has(dish.n))
          .map((dish) => ({
            orderItemReference: id(dish.n),
            netMinor: dish.net,
            taxComponents: [hst(dish.tax)],
            reduction: null,
          })),
      })),
    );
    const share = (index: number) =>
      rounding.lines
        .filter((line) => line.orderBatchReference === batch(index))
        .reduce((sum, line) => sum + line.amountMinor, 0n);
    const billRounds = rounds.map((dishes, index) => {
      const on = dishes.filter((dish) => !takenOff.has(dish.n));
      const subtotal = on.reduce((sum, dish) => sum + dish.net, 0n);
      const tax = on.reduce((sum, dish) => sum + dish.tax, 0n) + share(index);
      return {
        roundNumber: index + 1,
        orderReference: id(1),
        orderBatchReference: batch(index),
        submissionReference: id(400 + index),
        items: on.map((dish) => ({
          orderItemReference: id(dish.n),
          quantity: 1,
          displayName: dish.name,
          subtotalMinor: String(dish.net),
          totalMinor: String(dish.net + dish.tax),
          reduction: null,
        })),
        subtotalMinor: String(subtotal),
        taxMinor: String(tax),
        totalMinor: String(subtotal + tax),
        taxRoundingMinor: String(share(index)),
        paid: false,
        orderedBy: null,
        fromTableLabel: null,
        liveOrderedAt: null,
      };
    });
    const lines = customerTableBillLines(billRounds);
    // A round whose lines don't add up as printed (an order-time fee): no lines for it or the bill.
    const printed =
      unprinted === null
        ? lines
        : {
            rounds: new Map([...lines.rounds].filter(([key]) => key !== batch(unprinted))),
          };
    const owed = billRounds.reduce((sum, round) => sum + BigInt(round.totalMinor), 0n);
    const dishes = rounds.flat();
    const removed = dishes.filter((dish) => takenOff.has(dish.n));
    return composeCustomerDiningSession({
      diningSessionReference: id(20),
      tableLabel: "L21 TML A (TEST)",
      checkedAt: at,
      paymentTiming: "PayLater",
      order: {
        orderNumber: "9",
        batches: rounds.map((round, index) => ({
          orderBatchReference: batch(index),
          submittedAt: at,
          items: round.map((dish) => item(dish.n, dish.name, 1, dish.net + dish.tax)),
        })),
        authorship: new Map(rounds.map((_, index) => [batch(index), false])),
        staffRounds: new Set(rounds.map((_, index) => batch(index))),
        delivery: new Map(
          dishes.map((dish) => [
            id(dish.n),
            { phase: takenOff.has(dish.n) ? "Cancelled" : "Accepted", deliveredQuantity: 0 },
          ]),
        ),
        itemPrices: new Map(
          dishes.map((dish) => [id(dish.n), { subtotal: cad(dish.net), tax: cad(dish.tax) }]),
        ),
        paymentOutcomes: new Map(),
        paymentDeadlines: new Map(),
        payLaterRounds: new Set(rounds.map((_, index) => batch(index))),
        unpaidCancellations: new Set(),
        staffCancellations: new Map(),
        itemCancellations: removed.map((dish) => ({
          orderItemReferences: [id(dish.n)],
          refunded: false,
          refundAmount: cad(0n),
          notCharged: true as const,
        })),
        payments: [],
        refunds: { confirmedMinor: 0n, pendingMinor: 0n },
        tableBill: {
          owedMinor: owed,
          pointsUsedMinor: 0n,
          takenOffMinor: 0n,
          taxRoundingMinor: rounding.totalMinor,
          ...printed,
          roundTaxRounding: new Map(billRounds.map((_, index) => [batch(index), share(index)])),
        },
      } as Order,
    });
  }
  const reconciles = (view: ReturnType<typeof composeCustomerDiningSession>) => {
    const summary = view.summary;
    const minor = (value: { amountMinor: bigint } | undefined) => value?.amountMinor ?? 0n;
    // The API's own check: what was paid, given back and still owed is what was ordered.
    expect(
      minor(summary?.paid) -
        minor(summary?.refunded) -
        minor(summary?.refundPending) +
        minor(summary?.due) +
        minor(summary?.takenOff) +
        minor(summary?.pointsUsed),
    ).toBe(minor(summary?.ordered?.total));
    // Every round card adds up to the Table total, and that is what is still to pay.
    const rounds = view.rounds
      .filter((round) => round.payment !== "NotCharged")
      .reduce(
        (sum, round) => sum + (round.bill?.total.amountMinor ?? round.itemsTotal.amountMinor),
        0n,
      );
    expect(rounds).toBe(minor(summary?.bill?.total));
    expect(minor(summary?.ordered?.total)).toBe(minor(summary?.bill?.total));
    expect(summary?.taxRounding).toBeUndefined();
  };

  it("Total ordered is the bill (3899, not 3900) and the round totals add up to it", () => {
    const view = table([[beef(31)], [soy(41), cucumber(42)], [beef(51)]]);
    expect(view.summary?.bill?.total).toEqual(cad(3899n));
    expect(view.summary?.due).toEqual(cad(3899n));
    expect(view.summary?.ordered).toEqual({
      subtotal: cad(3450n),
      tax: cad(449n),
      total: cad(3899n),
    });
    // The bill's cent sits on one round: the last (b28; largest remainder put it on round 2).
    expect(view.rounds.map((round) => round.bill?.total.amountMinor)).toEqual([
      1413n,
      1074n,
      1412n,
    ]);
    reconciles(view);
  });

  it("after the cucumber came off: 3192 ordered, 3192 to pay", () => {
    const view = table([[beef(31)], [soy(41), cucumber(42)], [beef(51)]], new Set([42]));
    expect(view.summary?.due).toEqual(cad(3192n));
    expect(view.summary?.ordered?.total).toEqual(cad(3192n));
    reconciles(view);
  });

  it("four rounds, round 3 taken off: the round totals ($14.13 / $10.74 / $3.66) add up to the bill", () => {
    const view = table([[beef(31)], [soy(41), cucumber(42)], [beef(51)], [soy(61)]], new Set([51]));
    expect(view.rounds.map((round) => round.bill?.total.amountMinor)).toEqual([
      1413n,
      1074n,
      undefined,
      366n,
    ]);
    // Round 3 reads "Not charged" (nothing of it is on the bill).
    expect(view.rounds[2]?.payment).toBe("NotCharged");
    expect(view.summary?.ordered?.total).toEqual(cad(2853n));
    reconciles(view);
  });

  it("a round whose lines can't be printed as the bill's still totals the bill's share", () => {
    const view = table([[beef(31)], [soy(41), cucumber(42)], [beef(51)]], new Set(), 2);
    expect(view.summary?.bill).toBeUndefined();
    // Round 3's card (it carries the bill's cent, b28): its dishes before tax, its tax with its
    // share of the bill's rounding.
    expect(view.rounds[2]?.bill).toBeUndefined();
    expect(view.rounds[2]?.subtotal).toEqual(cad(1250n));
    expect(view.rounds[2]?.tax).toEqual(cad(162n));
    expect(view.rounds[2]?.itemsTotal).toEqual(cad(1412n));
    expect(view.summary?.ordered?.total).toEqual(cad(3899n));
    expect(view.summary?.taxRounding).toBeUndefined();
    const cards = view.rounds.reduce(
      (sum, round) => sum + (round.bill?.total.amountMinor ?? round.itemsTotal.amountMinor),
      0n,
    );
    expect(cards).toBe(3899n);
  });

  // DEMO Store 2 (pay-first table): the guest paid Steamed rice + Lemon tea ($8.19); staff took the
  // Lemon tea off with a $5.37 refund. Each round is its own receipt: ordered is the rice.
  it("a paid round with a refunded dish: paid − refunded is Total ordered", () => {
    const view = composeCustomerDiningSession({
      ...facts({
        batches: [
          {
            orderBatchReference: id(30),
            submittedAt: at,
            items: [item(31, "Steamed rice", 1, 282n), item(32, "Lemon tea", 1, 537n)],
          },
        ],
        authorship: new Map([[id(30), true]]),
        delivery: new Map([
          [id(31), { phase: "Fulfilled", deliveredQuantity: 1 }],
          [id(32), { phase: "Cancelled", deliveredQuantity: 0 }],
        ]),
        itemPrices: new Map([
          [id(31), { subtotal: cad(250n), tax: cad(32n) }],
          [id(32), { subtotal: cad(475n), tax: cad(62n) }],
        ]),
        paymentOutcomes: new Map([[id(30), "Succeeded"]]),
        paymentDeadlines: new Map(),
        itemCancellations: [
          { orderItemReferences: [id(32)], refunded: true, refundAmount: cad(537n) },
        ],
        payments: [{ status: "Succeeded", amount: cad(819n) }],
        refunds: { confirmedMinor: 537n, pendingMinor: 0n },
      }),
    });
    expect(view.summary?.ordered?.total).toEqual(cad(282n));
    expect(view.rounds[0]?.refunded).toEqual(cad(537n));
    const summary = view.summary;
    expect(
      (summary?.paid.amountMinor ?? 0n) -
        (summary?.refunded.amountMinor ?? 0n) -
        (summary?.refundPending.amountMinor ?? 0n) +
        (summary?.due.amountMinor ?? 0n),
    ).toBe(summary?.ordered?.total.amountMinor);
  });
});

/**
 * b23 (DEC-TAX-WHOLE-RECEIPT, live22 money-comp-and-takeoff): a manager's comp on a table paying at
 * the end. Total ordered is what the table ordered (the comped dish stays in it, with the bill's
 * tax worked out once); `summary.takenOff` is what the comps took off the bill, tax included (the
 * reduction records, which carry the bill's tax cent: DEC-COMP-BILL-CENT); `summary.bill.takenOff`
 * is the printed bill's line before tax (dishes − taken off − points = Subtotal). So
 *   paid − refunded − refund pending + still to pay + takenOff + points used = Total ordered
 * to the cent, and the bill's total + takenOff + points = Total ordered.
 */
describe("b23 DEC-TAX-WHOLE-RECEIPT: with a comp, what was paid and owed plus what came off is Total ordered", () => {
  const hst = (taxAmountMinor: bigint) => ({
    taxComponentCode: "SYNTHETIC_TAX",
    treatment: "Taxable" as const,
    rate: "0.13",
    roundingMode: "HalfUp" as const,
    calculationOrder: 1,
    compoundOnPriorTax: false,
    taxAmountMinor,
  });
  interface Dish {
    n: number;
    name: string;
    net: bigint;
    tax: bigint;
  }
  const beef = (n: number): Dish => ({ n, name: "Beef noodles (TEST)", net: 1250n, tax: 163n });
  const soy = (n: number): Dish => ({ n, name: "Soy milk", net: 325n, tax: 42n });
  const cucumber = (n: number): Dish => ({ n, name: "Smashed cucumber", net: 625n, tax: 82n });
  type Step = { readonly off: number } | { readonly comp: number };
  /** TM2's four staff rounds: Beef noodles / Soy milk + cucumber / Beef noodles / Soy milk + cucumber. */
  const tm2: readonly (readonly Dish[])[] = [
    [beef(31)],
    [soy(41), cucumber(42)],
    [beef(51)],
    [soy(61), cucumber(62)],
  ];
  const batch = (index: number) => id(300 + index);
  /**
   * The table after these steps, in order, as the session read and the bill read it (the bill's own
   * algorithms: a comp takes its share of the bill's tax cent when it is decided, then the bill's
   * tax rounding is worked out on what stands). `paid`: the table then paid its bill in full.
   */
  function table(steps: readonly Step[], paid = false, layout = tm2) {
    const removed = new Set<number>();
    const comps = new Map<number, { net: bigint; tax: bigint; share: bigint }>();
    const dishes = layout.flat();
    const roundingRounds = () =>
      layout.map((round, index) => ({
        orderReference: id(1),
        orderBatchReference: batch(index),
        items: round
          .filter((dish) => !removed.has(dish.n))
          .map((dish) => {
            const comp = comps.get(dish.n);
            return {
              orderItemReference: id(dish.n),
              netMinor: dish.net,
              taxComponents: [hst(dish.tax)],
              reduction:
                comp === undefined
                  ? null
                  : { netMinor: comp.net, taxMinor: comp.tax, taxRoundingMinor: comp.share },
            };
          }),
      }));
    for (const step of steps) {
      if ("off" in step) {
        removed.add(step.off);
        continue;
      }
      const dish = dishes.find((entry) => entry.n === step.comp) as Dish;
      const share =
        billReductionTaxRoundingShares(roundingRounds(), [
          { orderItemReference: id(dish.n), netMinor: dish.net, taxMinor: dish.tax },
        ]).get(id(dish.n)) ?? 0n;
      comps.set(dish.n, { net: dish.net, tax: dish.tax + share, share });
    }
    const rounding = computeBillTaxRounding(roundingRounds());
    const share = (index: number) =>
      rounding.lines
        .filter((line) => line.orderBatchReference === batch(index))
        .reduce((sum, line) => sum + line.amountMinor, 0n);
    const billRounds = layout.map((round, index) => {
      const on = round.filter((dish) => !removed.has(dish.n));
      const off = (dish: Dish) => comps.get(dish.n);
      const subtotal = on.reduce((sum, dish) => sum + dish.net - (off(dish)?.net ?? 0n), 0n);
      const tax =
        on.reduce((sum, dish) => sum + dish.tax - (off(dish)?.tax ?? 0n), 0n) + share(index);
      return {
        roundNumber: index + 1,
        orderReference: id(1),
        orderBatchReference: batch(index),
        submissionReference: id(400 + index),
        items: on.map((dish) => {
          const comp = off(dish);
          return {
            orderItemReference: id(dish.n),
            quantity: 1,
            displayName: dish.name,
            subtotalMinor: String(dish.net),
            totalMinor: String(
              dish.net + dish.tax - (comp === undefined ? 0n : comp.net + comp.tax),
            ),
            reduction:
              comp === undefined
                ? null
                : {
                    kind: "Comp" as const,
                    percent: null,
                    amountMinor: String(comp.net + comp.tax),
                    netMinor: String(comp.net),
                  },
          };
        }),
        subtotalMinor: String(subtotal),
        taxMinor: String(tax),
        totalMinor: String(subtotal + tax),
        taxRoundingMinor: String(share(index)),
        paid,
        orderedBy: null,
        fromTableLabel: null,
        liveOrderedAt: null,
      };
    });
    const billTotal = billRounds.reduce((sum, round) => sum + BigInt(round.totalMinor), 0n);
    const takenOff = [...comps.values()].reduce((sum, comp) => sum + comp.net + comp.tax, 0n);
    // What the reductions table holds for these comps (net, tax, total: total = net + tax).
    const view = composeCustomerDiningSession({
      diningSessionReference: id(20),
      tableLabel: "L22 MCC A (TEST)",
      checkedAt: at,
      paymentTiming: "PayLater",
      order: {
        orderNumber: "1",
        batches: layout.map((round, index) => ({
          orderBatchReference: batch(index),
          submittedAt: at,
          items: round.map((dish) => item(dish.n, dish.name, 1, dish.net + dish.tax)),
        })),
        authorship: new Map(layout.map((_, index) => [batch(index), false])),
        staffRounds: new Set(layout.map((_, index) => batch(index))),
        delivery: new Map(
          dishes.map((dish) => [
            id(dish.n),
            { phase: removed.has(dish.n) ? "Cancelled" : "Accepted", deliveredQuantity: 0 },
          ]),
        ),
        itemPrices: new Map(
          dishes.map((dish) => [id(dish.n), { subtotal: cad(dish.net), tax: cad(dish.tax) }]),
        ),
        paymentOutcomes: new Map(),
        paymentDeadlines: new Map(),
        payLaterRounds: new Set(layout.map((_, index) => batch(index))),
        // The table's payment lines are its rounds the bill charges for (never a $0 round).
        ...(paid
          ? {
              settledRounds: new Set(
                billRounds
                  .filter((round) => round.totalMinor !== "0")
                  .map((round) => round.orderBatchReference),
              ),
            }
          : {}),
        unpaidCancellations: new Set(),
        staffCancellations: new Map(),
        itemCancellations: [...removed].map((n) => ({
          orderItemReferences: [id(n)],
          refunded: false,
          refundAmount: cad(0n),
          notCharged: true as const,
        })),
        payments: paid ? [{ status: "Succeeded", amount: cad(billTotal) }] : [],
        refunds: { confirmedMinor: 0n, pendingMinor: 0n },
        ...(paid ? { tableSettlement: { tipMinor: 0n, roundingMinor: 0n } } : {}),
        tableBill: {
          owedMinor: paid ? 0n : billTotal,
          pointsUsedMinor: 0n,
          takenOffMinor: takenOff,
          taxRoundingMinor: rounding.totalMinor,
          ...customerTableBillLines(billRounds),
          roundTaxRounding: new Map(billRounds.map((_, index) => [batch(index), share(index)])),
        },
      } as Order,
    });
    return { view, comps };
  }
  const minor = (value: { amountMinor: bigint } | undefined) => value?.amountMinor ?? 0n;
  const reconciles = (view: ReturnType<typeof composeCustomerDiningSession>) => {
    const summary = view.summary;
    expect(
      minor(summary?.paid) -
        minor(summary?.refunded) -
        minor(summary?.refundPending) +
        minor(summary?.due) +
        minor(summary?.takenOff) +
        minor(summary?.pointsUsed),
    ).toBe(minor(summary?.ordered?.total));
    // The bill (what is charged) and what came off it, tax included, are what was ordered.
    expect(
      minor(summary?.bill?.total) + minor(summary?.takenOff) + minor(summary?.pointsUsed),
    ).toBe(minor(summary?.ordered?.total));
    // The printed bill adds up before tax: dishes − taken off − points = Subtotal; + Tax = Total.
    const bill = summary?.bill;
    expect(minor(bill?.items) - minor(bill?.takenOff) - minor(bill?.pointsUsed)).toBe(
      minor(bill?.subtotal),
    );
    expect(minor(bill?.subtotal) + minor(bill?.tax)).toBe(minor(bill?.total));
    // Every round card adds up to the Table total.
    const cards = view.rounds
      .filter((round) => round.payment !== "NotCharged")
      .reduce(
        (sum, round) => sum + (round.bill?.total.amountMinor ?? round.itemsTotal.amountMinor),
        0n,
      );
    expect(cards).toBe(minor(summary?.bill?.total));
  };

  // live22 reporter: cucumber off round 2, round 3 off whole, then Soy milk of round 4 comped
  // ($3.67, Goodwill). The JSON read ordered 2853 and bill/due 2486; 325 was the printed bill's
  // "Taken off" before tax, while summary.takenOff is the $3.67 the comp took off the bill.
  it("comp Soy milk $3.67: ordered 2853 = still to pay 2486 + taken off 367, before and after paying", () => {
    const steps: Step[] = [{ off: 42 }, { off: 51 }, { comp: 61 }];
    const { view, comps } = table(steps);
    expect(comps.get(61)).toEqual({ net: 325n, tax: 42n, share: 0n });
    expect(view.summary?.ordered?.total).toEqual(cad(2853n));
    expect(view.summary?.takenOff).toEqual(cad(367n));
    expect(view.summary?.bill?.takenOff).toEqual(cad(325n));
    expect(view.summary?.bill?.total).toEqual(cad(2486n));
    expect(view.summary?.due).toEqual(cad(2486n));
    reconciles(view);
    const after = table(steps, true).view;
    expect(after.summary?.paid).toEqual(cad(2486n));
    expect(after.summary?.due).toEqual(cad(0n));
    expect(after.summary?.ordered?.total).toEqual(cad(2853n));
    reconciles(after);
  });

  // live22 verifier: Smashed cucumber of round 2 comped ($7.06: its own $7.07 less the bill's tax
  // cent, recorded on the comp), then Soy milk taken off round 4. Ordered 4605, paid 3899; the
  // printed bill's "Taken off" was 625 before tax, summary.takenOff 706 (tax and cent included).
  it("comp cucumber $7.06 then take-off: ordered 4605 = paid 3899 + taken off 706", () => {
    const steps: Step[] = [{ comp: 42 }, { off: 61 }];
    const { view, comps } = table(steps);
    expect(comps.get(42)).toEqual({ net: 625n, tax: 81n, share: -1n });
    expect(view.summary?.ordered?.total).toEqual(cad(4605n));
    expect(view.summary?.takenOff).toEqual(cad(706n));
    expect(view.summary?.bill?.takenOff).toEqual(cad(625n));
    expect(view.summary?.due).toEqual(cad(3899n));
    reconciles(view);
    const after = table(steps, true).view;
    expect(after.summary?.paid).toEqual(cad(3899n));
    expect(after.summary?.due).toEqual(cad(0n));
    expect(after.summary?.ordered?.total).toEqual(cad(4605n));
    reconciles(after);
  });
  // b26 (v15 live25, TM2 'L25 TCP (TEST)'): three staff rounds of Soy milk + Smashed cucumber;
  // round 1's Soy milk and round 2 taken off, round 1's cucumber comped ($7.06), the table paid
  // $10.74. Round 1 is $0.00 on the bill: once the table paid it has nothing to pay.
  const live25: readonly (readonly Dish[])[] = [
    [soy(31), cucumber(32)],
    [soy(41), cucumber(42)],
    [soy(51), cucumber(52)],
  ];
  const live25Steps: Step[] = [{ off: 31 }, { off: 41 }, { off: 42 }, { comp: 32 }];
  it("live25: a comped $0.00 round reads nothing to pay once the table paid, never On the table's bill", () => {
    const before = table(live25Steps, false, live25).view;
    expect(before.summary?.due).toEqual(cad(1074n));
    expect(before.rounds.map((round) => round.payment)).toEqual([
      "OnTableBill",
      "NotCharged",
      "OnTableBill",
    ]);
    reconciles(before);
    const after = table(live25Steps, true, live25).view;
    expect(after.summary?.paid).toEqual(cad(1074n));
    expect(after.summary?.ordered?.total).toEqual(cad(1780n));
    expect(after.rounds.map((round) => [round.status, round.payment])).toEqual([
      ["Queued", "NotCharged"],
      ["StoreCancelled", "NotCharged"],
      ["Queued", "Paid"],
    ]);
    // Round 1 still shows what the bill says of it: its cucumber $6.25 less the comp, $0.00.
    expect(after.rounds[0]?.bill?.total).toEqual(cad(0n));
    reconciles(after);
  });
});
