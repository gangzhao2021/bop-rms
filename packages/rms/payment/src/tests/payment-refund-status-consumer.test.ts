import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPaymentRefundStatusConsumer,
  parsePaymentRefundedEnvelope,
  type PaymentRefundedEnvelope,
} from "../index.js";
const id = (n: number) => "0190ed70-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-12T12:00:00.000Z";
const event = () =>
  parsePaymentRefundedEnvelope({
    eventId: id(1),
    eventType: "PaymentRefunded",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/payment",
    tenantId: id(2),
    storeId: id(3),
    aggregateType: "PaymentTransaction",
    aggregateId: id(4),
    aggregateVersion: 1n,
    correlationId: id(5),
    causationId: id(6),
    actor: { type: "System" },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
    payload: {
      refundReference: id(7),
      compensationCaseReference: id(5),
      paymentTransactionReference: id(4),
      paymentIntentReference: id(8),
      paymentAttemptReference: id(9),
      orderReference: id(10),
      amountMinor: "1250",
      currencyCode: "CAD",
      refundKind: "PaidWithoutFulfillableOrderCompensation",
      providerConfirmedAt: at,
    },
  });
function fixture() {
  let stored: PaymentRefundedEnvelope | null = null;
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as ConsumerTransaction;
  const authorize = vi.fn(async () => true);
  const write = vi.fn(async (_tx: ConsumerTransaction, value: PaymentRefundedEnvelope) => {
    stored = value;
  });
  const service = createPaymentRefundStatusConsumer({
    scope: { brandReference: id(2), storeReference: id(3) },
    authorize,
    projections: { load: async () => stored, write },
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  });
  return {
    service,
    tx,
    write,
    authorize,
    set: (value: PaymentRefundedEnvelope) => {
      stored = value;
    },
  };
}
it("stores the exact confirmed refund and replays without rewriting the capture terminal", async () => {
  const f = fixture(),
    envelope = event();
  const handle = () => f.service.registration.handler({ transaction: f.tx, envelope });
  const result = await handle();
  expect(result).toMatchObject({ status: "completed" });
  expect(await handle()).toEqual(result);
  expect(f.write).toHaveBeenCalledOnce();
  expect(f.write).toHaveBeenCalledWith(f.tx, envelope);
});
it("rejects a refund identity collision before any write", async () => {
  const f = fixture(),
    envelope = event();
  f.set(
    parsePaymentRefundedEnvelope({
      ...envelope,
      payload: { ...envelope.payload, amountMinor: "1251" },
    }),
  );
  await expect(f.service.consume(f.tx, envelope)).rejects.toMatchObject({
    code: "PAYMENT_STATUS_VERSION_CONFLICT",
  });
  expect(f.write).not.toHaveBeenCalled();
});
it("rejects another Store before reading or creating Inbox state", async () => {
  const f = fixture(),
    envelope = event();
  await expect(f.service.consume(f.tx, { ...envelope, storeId: id(30) })).rejects.toMatchObject({
    code: "PAYMENT_STATUS_PERMISSION_DENIED",
  });
  expect(f.tx.query).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
});
it("requires current authorization again after writing the projection", async () => {
  const f = fixture(),
    envelope = event();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(
    f.service.registration.handler({ transaction: f.tx, envelope }),
  ).rejects.toMatchObject({ code: "PAYMENT_STATUS_PERMISSION_DENIED" });
  expect(f.write).toHaveBeenCalledOnce();
});
