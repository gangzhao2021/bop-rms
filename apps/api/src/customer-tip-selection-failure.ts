import { GuestSessionError } from "@bop/identity";
import {
  CartError,
  CheckoutSessionServiceError,
  CheckoutValidationError,
  OrderCreationError,
} from "@rms/ordering";
import { PaymentTipSelectionError } from "@rms/payment";
import { CustomerStoreClosedError } from "./customer-store-open-gate.js";

/**
 * WP-2423 Q10: a tip selection that fails for an internal reason (a lock wait, a database or owner
 * dependency) is retryable, not "this checkout no longer exists". Only owner refusals keep their
 * meaning (a Guest/binding refusal stays a concealed 404); anything else becomes a 503 the customer
 * can retry without leaving the payment page.
 */
export function rethrowTipSelectionFailure(error: unknown): never {
  if (
    error instanceof GuestSessionError ||
    error instanceof PaymentTipSelectionError ||
    error instanceof CheckoutSessionServiceError ||
    error instanceof OrderCreationError ||
    error instanceof CheckoutValidationError ||
    error instanceof CartError ||
    error instanceof CustomerStoreClosedError
  )
    throw error;
  throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
}
