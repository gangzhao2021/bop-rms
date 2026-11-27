import { describe, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseStaffItemCancellationPlan,
  parseStaffItemCancellationRecord,
  parseStaffItemCancellationSelection,
} from "../application/staff-item-cancellation.js";
import {
  createPostgresStaffItemCancellationStore,
  readStaffItemCancellations,
  staffItemCancellationDigest,
} from "../infrastructure/persistence/staff-item-cancellation-store.js";

vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(),
}));

const id = (n: number) => `0190ee34-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const brand = id(1),
  store = id(2),
  order = id(3),
  batch = id(4),
  submission = id(5),
  actor = id(6);
const plan = {
  orderType: "Pickup" as const,
  orderReference: order,
  orderBatchReference: batch,
  submissionReference: submission,
  expectedOrderVersion: 2,
  expectedSourceCheckpoint: id(7),
  lines: [{ orderItemReference: id(8), sourceCartLineReference: id(20), quantity: 2 }],
  remainingOrderItemReferences: [id(9)],
  cancelledOrderItemReferences: [] as string[],
  payment: {
    dispositionReference: id(10),
    paymentTransactionReference: id(11),
    paymentIntentReference: id(12),
    paymentAttemptReference: id(13),
    paymentEventReference: id(14),
  },
};
const record = {
  cancellationReference: id(30),
  operationReference: id(31),
  brandReference: brand,
  storeReference: store,
  orderReference: order,
  orderBatchReference: batch,
  submissionReference: submission,
  orderType: "Pickup",
  expectedOrderVersion: 2,
  cancelledOrderVersion: 3,
  expectedSourceCheckpoint: id(7),
  actorReference: actor,
  reasonCode: "SOLD_OUT",
  paymentDispositionReference: id(10),
  paymentTransactionReference: id(11),
  paymentIntentReference: id(12),
  paymentAttemptReference: id(13),
  paymentEventReference: id(14),
  orderItemReferences: [id(8)],
  kitchenEvidenceDigest: "sha256:" + "a".repeat(64),
  refundRequestReference: id(32),
  refundOperationReference: id(33),
  refundAmountMinor: "565",
  currencyCode: "CAD",
  sourceDigest: "sha256:" + "b".repeat(64),
  auditReference: id(34),
  cancelledAt: "2026-10-11T12:00:00.000Z",
};

describe("staff item cancellation (WP-2423 Q6 step 2a)", () => {
  it("parses a selection into distinct uuid order and refuses empty, duplicate or oversized ones", () => {
    expect(parseStaffItemCancellationSelection([id(9), id(8)])).toEqual([id(8), id(9)]);
    for (const value of [
      [],
      [id(8), id(8)],
      ["not-a-uuid"],
      Array.from({ length: 101 }, (_, n) => id(100 + n)),
      "x",
    ])
      expect(() => parseStaffItemCancellationSelection(value)).toThrow(
        "staff order cancellation is unavailable",
      );
  });

  it("keeps selected, remaining and earlier cancelled lines disjoint", () => {
    expect(parseStaffItemCancellationPlan(plan).lines[0]?.quantity).toBe(2);
    expect(() =>
      parseStaffItemCancellationPlan({ ...plan, remainingOrderItemReferences: [id(8)] }),
    ).toThrow();
    expect(() =>
      parseStaffItemCancellationPlan({
        ...plan,
        lines: [{ ...plan.lines[0], quantity: 0 }],
      }),
    ).toThrow();
    expect(() => parseStaffItemCancellationPlan({ ...plan, extra: true })).toThrow();
  });

  it("parses the append-only record with its refund binding", () => {
    const parsed = parseStaffItemCancellationRecord(record);
    expect(parsed.refundAmountMinor).toBe(565n);
    expect(parsed.cancelledOrderVersion).toBe(3);
    for (const change of [
      { cancelledOrderVersion: 4 },
      { refundAmountMinor: "0" },
      { currencyCode: "USD" },
      { refundRequestReference: id(30) },
      { reasonCode: "OTHER" },
      { orderItemReferences: [] },
    ])
      expect(() => parseStaffItemCancellationRecord({ ...record, ...change })).toThrow();
  });

  it("binds the digest to the plan, reason, kitchen evidence and refund claim", () => {
    const input = {
      plan: parseStaffItemCancellationPlan(plan),
      reasonCode: "SOLD_OUT",
      kitchenEvidenceDigest: "sha256:" + "a".repeat(64),
      refundRequestReference: id(32),
      refundOperationReference: id(33),
      refundAmountMinor: 565n,
    };
    const digest = staffItemCancellationDigest(input);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(staffItemCancellationDigest({ ...input, refundAmountMinor: 566n })).not.toBe(digest);
    expect(staffItemCancellationDigest({ ...input, reasonCode: "STORE_ERROR" })).not.toBe(digest);
  });

  it("refuses to commit the last remaining lines (the whole cancellation ends the Batch)", async () => {
    const tx = { query: vi.fn() } as unknown as ConsumerTransaction;
    const writer = createPostgresStaffItemCancellationStore({
      brandReference: brand,
      storeReference: store,
      authorize: async () => true,
    });
    await expect(
      writer.commit(tx, {
        plan: parseStaffItemCancellationPlan({ ...plan, remainingOrderItemReferences: [] }),
        cancellationReference: id(30),
        operationReference: id(31),
        actorReference: actor,
        reasonCode: "SOLD_OUT",
        kitchenEvidenceDigest: "sha256:" + "a".repeat(64),
        refundRequestReference: id(32),
        refundOperationReference: id(33),
        refundAmountMinor: 565n,
        auditReference: id(34),
        cancelledAt: "2026-10-11T12:00:00.000Z",
      }),
    ).rejects.toThrow();
    expect(tx.query).not.toHaveBeenCalled();
  });

  it("refuses a read where one line appears in two cancellations", async () => {
    const tx = {
      query: vi.fn(async (sql: string) =>
        sql.startsWith("SELECT set_config")
          ? { rows: [], rowCount: 1 }
          : {
              rows: [
                record,
                {
                  ...record,
                  cancellationReference: id(40),
                  operationReference: id(41),
                  refundRequestReference: id(42),
                  refundOperationReference: id(43),
                  auditReference: id(44),
                },
              ],
              rowCount: 2,
            },
      ),
    } as unknown as ConsumerTransaction;
    await expect(
      readStaffItemCancellations(tx, { brandReference: brand, storeReference: store }, [order]),
    ).rejects.toThrow();
  });

  it("refuses prepare when the caller is no longer authorized, before any read", async () => {
    const tx = { query: vi.fn() } as unknown as ConsumerTransaction;
    const writer = createPostgresStaffItemCancellationStore({
      brandReference: brand,
      storeReference: store,
      authorize: async () => false,
    });
    await expect(
      writer.prepare(tx, {
        orderReference: order,
        orderBatchReference: batch,
        orderItemReferences: [id(8)],
        expectedOrderVersion: 2,
        actorReference: actor,
      }),
    ).rejects.toThrow();
    expect(tx.query).not.toHaveBeenCalled();
  });
});
