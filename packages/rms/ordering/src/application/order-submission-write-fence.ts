import type { StoreBusinessDateResolution } from "@rms/store";
import { parseOrderingInstant } from "../domain/cart.js";
import {
  parseCheckoutValidationEvidence,
  type CheckoutValidationEvidence,
} from "../domain/checkout-validation.js";
import {
  OrderCreationError,
  parseOrderCreationRecord,
  type OrderCreationRecord,
} from "../domain/order-creation.js";
import { createOrderNumberAllocation } from "../domain/order-number.js";

/** Pure owner fence over already captured transaction inputs; observedAt must come from the current server/database clock. */
export function validateOrderSubmissionWriteFence(input: {
  readonly record: Omit<OrderCreationRecord, "orderNumberAllocation">;
  readonly businessDateResolution: StoreBusinessDateResolution;
  readonly checkoutValidationEvidence: CheckoutValidationEvidence;
  readonly observedAt: string;
}) {
  try {
    const evidence = parseCheckoutValidationEvidence(input.checkoutValidationEvidence);
    // Sequence one is used only to validate the existing resolution contract; no number is allocated or returned.
    const parsed = parseOrderCreationRecord({
      ...input.record,
      orderNumberAllocation: createOrderNumberAllocation({
        orderReference: input.record.order.orderReference,
        allocatedAt: input.record.createdAt,
        sequence: 1n,
        businessDateResolution: input.businessDateResolution,
      }),
    });
    const observedAt = parseOrderingInstant(input.observedAt);
    const order = parsed.order,
      batch = order.batches[0];
    if (
      Date.parse(observedAt) < Date.parse(parsed.createdAt) ||
      Date.parse(parsed.createdAt) < Date.parse(evidence.validatedAt)
    )
      throw new Error("time mismatch");
    if (Date.parse(observedAt) >= Date.parse(evidence.validUntil))
      throw new OrderCreationError("ORDER_CREATE_VALIDATION_EXPIRED");
    const lines = new Map(evidence.catalogLines.map((line) => [line.cartItemReference, line]));
    if (
      evidence.brandReference !== order.brandReference ||
      evidence.storeReference !== order.storeReference ||
      evidence.guestSessionReference !== parsed.guestSessionReference ||
      evidence.orderType !== order.orderType ||
      evidence.sourceChannel !== order.sourceChannel ||
      evidence.cartReference !== batch.sourceCartReference ||
      evidence.cartVersion !== batch.sourceCartVersion ||
      evidence.quoteReference !== batch.quoteReference ||
      evidence.validationReference !== batch.checkoutValidationReference ||
      lines.size !== parsed.items.length ||
      parsed.items.some((item) => {
        const line = lines.get(item.cartItemReference);
        return (
          !line ||
          line.sellableReference !== item.catalog.sellableReference ||
          line.productVersionReference !== item.catalog.productVersionReference ||
          line.menuVersionReference !== item.catalog.menuVersionReference ||
          item.pricing.quoteInputDigest !== evidence.quoteInputDigest
        );
      })
    )
      throw new Error("link mismatch");
    return Object.freeze({
      observedAt,
      validUntil: evidence.validUntil,
      checkoutValidationEvidence: evidence,
    });
  } catch (error) {
    if (error instanceof OrderCreationError && error.code === "ORDER_CREATE_VALIDATION_EXPIRED")
      throw error;
    throw new OrderCreationError("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  }
}
