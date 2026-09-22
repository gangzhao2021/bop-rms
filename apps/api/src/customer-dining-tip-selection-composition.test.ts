import type { ConsumerTransaction } from "@bop/eventing";
import { expect, it, vi, beforeEach } from "vitest";
import { type PaymentTipSelection, type PaymentTipSelectionPorts } from "@rms/payment";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import {
  createCustomerDiningTipSelectionComposition,
  createPersistentAdditionalDiningTipSelection,
} from "./customer-dining-tip-selection-composition.js";

const tipStore = vi.hoisted(() => vi.fn());
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresPaymentTipSelectionStore: tipStore,
}));
beforeEach(() => tipStore.mockReset());

async function fixture() {
  const f = orderSubmissionFixture();
  await f.orderService().create(f.orderInput);
  let saved: PaymentTipSelection | null = null,
    writes = 0,
    loseAck = false;
  const tip: Pick<PaymentTipSelectionPorts, "repository" | "audit"> = {
    repository: {
      load: async (reference) => (saved?.selectionReference === reference ? saved : null),
      append: async ({ record }) => {
        saved = record;
        writes++;
        if (loseAck) throw new Error("synthetic tip acknowledgement loss");
        return { status: "Created", record };
      },
    },
    audit: {
      create: async (record) => ({
        auditId: id(900),
        brandId: id(2),
        storeId: id(3),
        actor: { type: "System" },
        actionCode: "PAYMENT_TIP_SELECT",
        targetType: "PaymentTipSelection",
        targetId: record.selectionReference,
        reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
        correlationId: id(901),
        occurredAt: record.selectedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
  };
  tipStore.mockReturnValue(tip.repository);
  const { expectedCartVersion, ...input } = f.orderInput;
  return {
    ...f,
    tip,
    input: {
      ...input,
      cartVersion: expectedCartVersion,
      selectionReference: id(800),
      tip: { amountMinor: 150n, currencyCode: "CAD" },
    },
    service: () => createCustomerDiningTipSelectionComposition({ submission: f.options, tip }),
    tipWrites: () => writes,
    loseTipAck: () => {
      loseAck = true;
    },
  };
}
it("binds an explicit tip to actual Identity and original Dining/Ordering services", async () => {
  const f = await fixture(),
    result = await f.service().select(f.input);
  expect(result.record.guestSessionReference).toBe(id(9));
  expect(result.record.paymentOperationReference).toBe(f.savedLink()?.paymentOperationReference);
  expect(result.record.tip.amountMinor).toBe(150n);
  expect(f.tipWrites()).toBe(1);
  expect(f.orderWrites()).toBe(1);
});
it("denies bad CSRF and caller identity/operation before tip writes", async () => {
  const f = await fixture();
  for (const changed of [
    { csrfCredential: f.credentials.generateCredential("Csrf") },
    { paymentOperationReference: id(999) },
    { guestSessionReference: id(999) },
    { selectedAt: "2026-09-10T12:00:00.000Z" },
  ])
    await expect(f.service().select({ ...f.input, ...changed })).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
  expect(f.tipWrites()).toBe(0);
});
it("recovers original selection after preparation expiry but denies a fresh choice", async () => {
  const f = await fixture(),
    original = await f.service().select(f.input);
  f.setTime("2026-09-10T12:06:00.000Z");
  expect((await f.service().select(f.input)).record).toEqual(original.record);
  await expect(f.service().select({ ...f.input, selectionReference: id(801) })).rejects.toThrow();
  expect(f.tipWrites()).toBe(1);
});
it("recovers a lost tip acknowledgement without replacing operation or selection time", async () => {
  const f = await fixture();
  f.loseTipAck();
  const result = await f.service().select(f.input);
  expect(result.status).toBe("Existing");
  expect((await f.service().select(f.input)).record).toEqual(result.record);
  expect(f.tipWrites()).toBe(1);
});
it("requires positive original Order and matching stored linkage for a new choice", async () => {
  const f = await fixture(),
    repository = f.options.repository;
  const service = createCustomerDiningTipSelectionComposition({
    submission: {
      ...f.options,
      repository: (link) => ({ ...repository(link), resolveCapacityLink: async () => null }),
    },
    tip: f.tip,
  });
  await expect(service.select(f.input)).rejects.toThrow();
  expect(f.tipWrites()).toBe(0);
});
it("denies revoked Identity on original recovery", async () => {
  const f = await fixture();
  await f.service().select(f.input);
  f.revoke();
  await expect(f.service().select(f.input)).rejects.toThrow();
  expect(f.tipWrites()).toBe(1);
});
it("denies Dining Closing and Identity revocation during a tip Audit wait", async () => {
  const f = await fixture(),
    audit = f.tip.audit.create;
  f.tip.audit.create = async (record) => {
    f.revoke();
    return audit(record);
  };
  await expect(f.service().select(f.input)).rejects.toThrow();
  expect(f.tipWrites()).toBe(0);
  const other = await fixture(),
    read = other.options.preparation.dining.current.readCurrent;
  other.options.preparation.dining.current.readCurrent = async (request) => {
    const result = await read(request);
    if (result === null) return result;
    return { ...result, session: { ...result.session, phase: "Closing", version: 6 } };
  };
  await expect(other.service().select(other.input)).rejects.toThrow();
  expect(other.tipWrites()).toBe(0);
});

it.each([1, 2])(
  "checks the actual parent reader for pre-submission tip (expected=%s)",
  async (expectedOrderVersion) => {
    const f = await fixture();
    const link = f.savedLink();
    if (!link) throw new Error("missing synthetic linkage");
    const record = await f.options.repository(link).resolveSubmission(link.submissionReference);
    if (!record) throw new Error("missing synthetic parent");
    const batch = record.order.batches[0];
    const calls: string[] = [];
    const transaction: ConsumerTransaction = {
      async query<Row = Record<string, unknown>>(sql: string) {
        calls.push(sql);
        const rows = sql.startsWith("SELECT h.order_type")
          ? [
              {
                order_type: "DineIn",
                dining_session_id: record.order.diningSessionReference,
                order_batch_id: batch.orderBatchReference,
              },
            ]
          : sql.startsWith("SELECT r.revision_id")
            ? [
                {
                  revision_id: record.submissionReference,
                  version: 1,
                  expected_version: 0,
                  previous_revision_id: null,
                  initial_submission_id: record.submissionReference,
                  kind: "Initial",
                  occurred_at: record.createdAt,
                  operation_bound: true,
                },
              ]
            : sql.startsWith("SELECT h.aggregate_version")
              ? [
                  {
                    aggregate_version: 1,
                    canonical_phase: "Submitted",
                    submission_id: record.submissionReference,
                    submitted_at: record.createdAt,
                  },
                ]
              : sql.startsWith("SELECT revision_id")
                ? [
                    {
                      revision_id: record.submissionReference,
                      version: 1,
                      occurred_at: record.createdAt,
                    },
                  ]
                : [];
        return { rows: rows as Row[], rowCount: rows.length };
      },
    };
    const service = createPersistentAdditionalDiningTipSelection({
      preparation: f.options.preparation,
      tip: f.tip,
      transactions: { run: async (work) => work(transaction) },
      authorizeOrder: async (tx) => tx === transaction,
    });
    expect(tipStore).toHaveBeenCalledOnce();
    expect(tipStore.mock.calls[0]?.[1]).toEqual(f.options.preparation.scope);
    const input = { ...f.input, orderReference: record.order.orderReference, expectedOrderVersion };
    if (expectedOrderVersion === 1) {
      const result = await service.select(input);
      expect(result.record.tip.amountMinor).toBe(150n);
      expect(f.tipWrites()).toBe(1);
      // Existing selection recovery does not need the stale parent version to be reusable.
      expect((await service.select({ ...input, expectedOrderVersion: 2 })).record).toEqual(
        result.record,
      );
      expect(f.tipWrites()).toBe(1);
    } else {
      await expect(service.select(input)).rejects.toThrow();
      expect(f.tipWrites()).toBe(0);
    }
    expect(calls.some((sql) => sql.startsWith("SELECT r.revision_id"))).toBe(true);
  },
);
