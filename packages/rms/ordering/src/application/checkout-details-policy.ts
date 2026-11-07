import { readClosedRecord } from "@bop/identity";
import { CartError, parseOrderingInstant } from "../domain/cart.js";
import {
  parseCheckoutDetailsSnapshot,
  type CheckoutDetailsSnapshot,
} from "../domain/checkout-details.js";

/** Validates current owner evidence; it does not publish or approve Store policy. */
export function validateCheckoutDetailsPolicy(
  detailsValue: CheckoutDetailsSnapshot,
  value: unknown,
  requestedAtValue: string,
  observedAtValue: string,
) {
  const details = parseCheckoutDetailsSnapshot(detailsValue);
  const requestedAt = parseOrderingInstant(requestedAtValue);
  const observedAt = parseOrderingInstant(observedAtValue);
  const policy = readClosedRecord(value, [
    "brandReference",
    "storeReference",
    "orderType",
    "checkedAt",
    "validUntil",
    "required",
  ]);
  const checkedAt = parseOrderingInstant(policy.checkedAt);
  const validUntil = parseOrderingInstant(policy.validUntil);
  if (
    policy.brandReference !== details.brandReference ||
    policy.storeReference !== details.storeReference ||
    policy.orderType !== details.orderType ||
    checkedAt !== requestedAt ||
    observedAt < checkedAt ||
    validUntil <= observedAt ||
    details.recordedAt > checkedAt
  )
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  const required = parseCheckoutDetailsSnapshot({ ...details, policies: policy.required }).policies;
  const key = (items: typeof required) =>
    JSON.stringify(
      [...items].sort((a, b) => a.documentReference.localeCompare(b.documentReference)),
    );
  if (key(required) !== key(details.policies)) throw new CartError("CART_SELECTION_INVALID");
  return Object.freeze({ checkedAt, validUntil });
}
