import { createHash } from "node:crypto";
import { orderQueryFixture } from "./order-creation-query.fixture.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
export function orderPaymentSourceFixture() {
  const order = orderQueryFixture().record;
  const batch = order.order.batches[0];
  if (!batch) throw new Error("Fixture requires an initial batch");
  const at = order.createdAt;
  const subtotal = order.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
  const preparation = {
    preparationReference: id(10),
    orderReference: order.order.orderReference,
    orderBatchReference: batch.orderBatchReference,
    submissionReference: order.submissionReference,
    sourceCartReference: batch.sourceCartReference,
    sourceCartVersion: batch.sourceCartVersion,
    brandReference: order.order.brandReference,
    storeReference: order.order.storeReference,
    guestSessionReference: order.guestSessionReference,
    quoteReference: batch.quoteReference,
    capacityAllocationReference: id(11),
    readiness: "PaymentPending",
    transactionBoundary: "OrderSubmissionPaymentPreparation",
    orderAllocation: { amountMinor: subtotal, currencyCode: "CAD" },
    tip: { amountMinor: 100n, currencyCode: "CAD" },
    total: { amountMinor: subtotal + 100n, currencyCode: "CAD" },
    committedAt: at,
    capacityExpiresAt: new Date(Date.parse(at) + 1800000).toISOString(),
    sourceDigest: hash("preparation"),
  };
  const acceptance = {
    acceptanceReference: id(12),
    operationReference: id(13),
    brandReference: order.order.brandReference,
    storeReference: order.order.storeReference,
    orderReference: order.order.orderReference,
    orderBatchReference: batch.orderBatchReference,
    expectedOrderVersion: 1,
    acceptedOrderVersion: 2,
    actorType: "User",
    actorReference: id(14),
    purposeCode: "OrderAcceptance",
    permissionCode: "order.accept",
    reasonCode: "SYNTHETIC_TEST",
    workflowVersionReference: id(15),
    transitionReference: id(16),
    sourceDigest: hash("acceptance"),
    acceptedAt: at,
  };
  const paymentEvent = {
    eventId: id(20),
    eventType: "PaymentSucceeded",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/payment",
    tenantId: order.order.brandReference,
    storeId: order.order.storeReference,
    aggregateType: "PaymentIntent",
    aggregateId: id(21),
    aggregateVersion: 2n,
    correlationId: id(22),
    causationId: id(23),
    actor: { type: "System" },
    payload: {
      paymentTransactionReference: id(24),
      paymentIntentReference: id(21),
      paymentAttemptReference: id(25),
      orderReference: order.order.orderReference,
      amountMinor: preparation.total.amountMinor.toString(),
      currencyCode: "CAD",
      evidenceKind: "Captured",
      terminalOccurredAt: at,
    },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
  };
  return {
    order,
    preparation,
    acceptance,
    paymentEvent,
    quoteVersion: 1 as const,
    observedAt: at,
    dispositionReference: id(30),
    confirmationReference: id(31),
    sha256: hash,
  };
}
