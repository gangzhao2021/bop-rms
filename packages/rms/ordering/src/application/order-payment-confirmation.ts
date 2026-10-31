import { parseAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch.js";
import { encodeAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch-codec.js";
import {
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
} from "../domain/order-creation.js";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import { parseOrderAcceptanceRecord } from "./order-acceptance-record.js";
import { parseOrderPaymentPreparationEvidence } from "./order-payment-preparation.js";
import { orderCreatedSourceInput } from "./order-created-source.js";
import {
  parsePaymentSucceededEnvelope,
  parseOrderPaymentOutcomeDisposition,
  createOrderPaymentDispositionBinding,
  OrderPaymentOutcomeError,
} from "./order-payment-outcome.js";

/** Candidate only; caller must authorize current execution and release policy under commit fences. */
export function createOrderPaymentConfirmationCandidate(input: {
  order: unknown;
  submissionKind?: "Additional";
  quoteVersion: 1 | 2;
  preparation: unknown;
  acceptance: unknown;
  paymentEvent: unknown;
  observedAt: string;
  dispositionReference: string;
  confirmationReference: string;
  sha256(value: string): string;
}) {
  try {
    if (input.submissionKind !== undefined && input.submissionKind !== "Additional")
      return invalid();
    const additional =
      input.submissionKind === "Additional"
        ? parseAdditionalDiningBatchSnapshot(input.order)
        : null;
    if (additional && additional.snapshotVersion !== input.quoteVersion) return invalid();
    const initial = additional
      ? null
      : input.quoteVersion === 2
        ? parseConfiguredOrderCreationRecord(input.order)
        : input.quoteVersion === 1
          ? parseOrderCreationRecord(input.order)
          : invalid();
    const brand = additional?.brandReference ?? initial?.order.brandReference;
    const store = additional?.storeReference ?? initial?.order.storeReference;
    const orderReference = additional?.orderReference ?? initial?.order.orderReference;
    const submission = additional?.batch.submissionReference ?? initial?.submissionReference;
    const guest = additional?.guestSessionReference ?? initial?.guestSessionReference;
    const submittedAt = additional?.batch.submittedAt ?? initial?.createdAt;
    const items = additional?.items ?? initial?.items;
    if (!brand || !store || !orderReference || !submission || !guest || !submittedAt || !items)
      return invalid();
    const acceptance = parseOrderAcceptanceRecord(input.acceptance);
    const preparation = parseOrderPaymentPreparationEvidence(input.preparation);
    const event = parsePaymentSucceededEnvelope(input.paymentEvent);
    const observedAt = parseOrderingInstant(input.observedAt);
    const batch =
      additional?.batch ??
      initial?.order.batches.find(
        (item) => item.orderBatchReference === acceptance.orderBatchReference,
      );
    if (
      !batch ||
      acceptance.brandReference !== brand ||
      acceptance.storeReference !== store ||
      acceptance.orderReference !== orderReference ||
      acceptance.orderBatchReference !== batch.orderBatchReference ||
      (additional
        ? acceptance.expectedOrderVersion < additional.expectedOrderVersion + 1
        : initial?.order.orderType === "DineIn"
          ? acceptance.expectedOrderVersion < initial.order.aggregateVersion
          : acceptance.expectedOrderVersion !== initial?.order.aggregateVersion) ||
      preparation.brandReference !== brand ||
      preparation.storeReference !== store ||
      preparation.orderReference !== orderReference ||
      preparation.orderBatchReference !== batch.orderBatchReference ||
      preparation.submissionReference !== submission ||
      preparation.guestSessionReference !== guest ||
      preparation.sourceCartReference !== batch.sourceCartReference ||
      preparation.sourceCartVersion !== batch.sourceCartVersion ||
      preparation.quoteReference !== batch.quoteReference ||
      event.tenantId !== preparation.brandReference ||
      event.storeId !== preparation.storeReference ||
      event.payload.orderReference !== preparation.orderReference ||
      event.payload.amountMinor !== preparation.total.amountMinor.toString() ||
      event.payload.currencyCode !== preparation.total.currencyCode ||
      items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n) !==
        preparation.orderAllocation.amountMinor ||
      Date.parse(observedAt) < Date.parse(event.occurredAt) ||
      observedAt < acceptance.acceptedAt ||
      observedAt < preparation.committedAt ||
      acceptance.acceptedAt < submittedAt
    )
      return invalid();
    const sourceSnapshotDigest = parseOrderingHash(
      input.sha256(
        additional
          ? encodeAdditionalDiningBatchSnapshot(additional)
          : initial
            ? orderCreatedSourceInput(initial, initial.orderNumberAllocation.businessDateResolution)
            : invalid(),
      ),
    );
    const candidate = parseOrderPaymentOutcomeDisposition({
      dispositionReference: parseOrderingReference(input.dispositionReference),
      brandReference: preparation.brandReference,
      storeReference: preparation.storeReference,
      orderReference: preparation.orderReference,
      orderBatchReference: preparation.orderBatchReference,
      submissionReference: preparation.submissionReference,
      paymentTransactionReference: event.payload.paymentTransactionReference,
      paymentIntentReference: event.payload.paymentIntentReference,
      paymentAttemptReference: event.payload.paymentAttemptReference,
      paymentEventReference: event.eventId,
      sourceVersion: acceptance.acceptedOrderVersion,
      sourceCheckpoint: acceptance.acceptanceReference,
      sourceDigest: "sha256:" + "0".repeat(64),
      evaluatedAt: observedAt,
      disposition: "Confirmed",
      confirmationReference: parseOrderingReference(input.confirmationReference),
      sourceSnapshotDigest,
      confirmedAt: observedAt,
    });
    return parseOrderPaymentOutcomeDisposition({
      ...candidate,
      sourceDigest: parseOrderingHash(
        input.sha256(createOrderPaymentDispositionBinding({ event, disposition: candidate })),
      ),
    });
  } catch {
    return invalid();
  }
}
function invalid(): never {
  throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
}
