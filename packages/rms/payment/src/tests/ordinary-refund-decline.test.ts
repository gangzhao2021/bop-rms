import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { ordinaryRefundRequestNote } from "../infrastructure/ordinary-refund-request-runtime.js";
import { createPostgresOrdinaryRefundDeclineStore } from "../infrastructure/persistence/ordinary-refund-approval-store.js";
import { createPostgresOrdinaryRefundRequestPositionSource } from "../infrastructure/persistence/ordinary-refund-request-store.js";
import { encodeOrdinaryRefundRequest } from "../application/ordinary-refund-request.js";
import {
  ordinaryRefundRequestFixture,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";

it("WP-2423 Q5: an Other note is trimmed, 1-200 characters and free of control characters", () => {
  expect(ordinaryRefundRequestNote("  Customer left early  ")).toBe("Customer left early");
  for (const bad of ["", "   ", "a".repeat(201), "line\nbreak", 7, null])
    expect(() => ordinaryRefundRequestNote(bad)).toThrow();
  expect(ordinaryRefundRequestNote("é".repeat(200))).toHaveLength(200);
});

const request = ordinaryRefundRequestFixture("2026-10-12T15:00:00.000Z");
const scope = {
  tenantReference: request.tenantReference,
  brandReference: request.brandReference,
  storeReference: request.storeReference,
};
function decline(rows: { operations: number; prior?: Record<string, unknown>[] }) {
  const calls: string[] = [];
  const tx = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("clock_timestamp"))
        return { rows: [{ now: new Date("2026-10-12T15:10:00.000Z") }], rowCount: 1 };
      if (sql.includes("ORDER BY claim_version"))
        return {
          rows: [{ version: "1", record: encodeOrdinaryRefundRequest(request) }],
          rowCount: 1,
        };
      if (
        sql.includes(
          "FROM rms_payment.ordinary_refund_decline WHERE brand_id=$1 AND store_id=$2 AND (operation_id",
        )
      )
        return { rows: rows.prior ?? [], rowCount: 0 };
      if (sql.includes("FROM rms_payment.ordinary_refund_operation"))
        return { rows: [{ n: rows.operations }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as ConsumerTransaction;
  const authority = vi.fn(async () => {
    throw new Error("authority must not be read");
  });
  const store = createPostgresOrdinaryRefundDeclineStore({
    scope,
    authorize: async () => true,
    authority,
  });
  const command = (patch = {}) => ({
    orderReference: request.orderReference,
    requestReference: request.requestReference,
    declineReference: id(90),
    operationReference: id(91),
    auditReference: id(92),
    declinerReference: id(93),
    reasonCode: "NOT_ELIGIBLE",
    ...patch,
  });
  const policy = { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 };
  return { tx, store, command, policy, authority, calls };
}

it("WP-2423 Q5: refuses an unknown reason, a prepared request and the requester themself", async () => {
  const unknown = decline({ operations: 0 });
  await expect(
    unknown.store(unknown.tx, unknown.command({ reasonCode: "FREE_TEXT" }), unknown.policy),
  ).rejects.toMatchObject({ code: "ORDINARY_REFUND_DECLINE_DENIED" });
  const prepared = decline({ operations: 1 });
  await expect(
    prepared.store(prepared.tx, prepared.command(), prepared.policy),
  ).rejects.toMatchObject({ code: "ORDINARY_REFUND_DECLINE_ALREADY_PREPARED" });
  const self = decline({ operations: 0 });
  await expect(
    self.store(self.tx, self.command({ declinerReference: request.actorReference }), self.policy),
  ).rejects.toMatchObject({ code: "ORDINARY_REFUND_DECLINE_SAME_PERSON" });
  for (const f of [prepared, self]) {
    expect(f.authority).not.toHaveBeenCalled();
    expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  }
  const other = decline({
    operations: 0,
    prior: [{ operation: id(99), request: request.requestReference }],
  });
  await expect(other.store(other.tx, other.command(), other.policy)).rejects.toMatchObject({
    code: "ORDINARY_REFUND_DECLINE_ALREADY_DECLINED",
  });
});

it("WP-2423 Q5: a declined request no longer counts as pending refund occupancy", async () => {
  const payment = request.payments[0];
  if (!payment) throw new Error("fixture");
  const position = (declined: boolean) => {
    const tx = {
      query: async (sql: string) => {
        if (sql.includes("ORDER BY claim_version"))
          return {
            rows: [{ version: "1", record: encodeOrdinaryRefundRequest(request) }],
            rowCount: 1,
          };
        if (sql.includes("FROM rms_payment.ordinary_refund_decline") && declined)
          return {
            rows: [
              {
                decline: id(90),
                request: request.requestReference,
                requester: request.actorReference,
                decliner: id(93),
                reason_code: "NOT_ELIGIBLE",
                claims: "1",
                declined_at: new Date("2026-10-12T15:05:00.000Z"),
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as ConsumerTransaction;
    return createPostgresOrdinaryRefundRequestPositionSource({
      scope,
      authorize: async () => true,
      readOutcome: async () => null,
    })(tx, {
      orderReference: request.orderReference,
      paymentTransactionReference: payment.paymentTransactionReference,
      paymentIntentReference: payment.paymentIntentReference,
      paymentAttemptReference: payment.paymentAttemptReference,
      observedAt: "2026-10-12T15:10:00.000Z",
    });
  };
  expect((await position(false)).pendingMinor).toBeGreaterThan(0n);
  expect((await position(true)).pendingMinor).toBe(0n);
});
