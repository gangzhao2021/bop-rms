import { createHash } from "node:crypto";
import { createMoney, parseCurrencyCode } from "@rms/pricing";
import {
  createPaymentProviderSnapshot,
  parseProviderReference,
} from "../../application/payment-provider-adapter.js";
import {
  PaymentProviderContractError,
  type CreateIntentRequest,
  type RetrieveIntentRequest,
  type PaymentProviderSnapshot,
} from "../../contracts/payment-provider-adapter.js";
import { encodeStripeOnlineIntentRequest } from "./stripe-online-intent-request.js";

function invalid(): never {
  throw new PaymentProviderContractError("PAYMENT_PROVIDER_STATE_INVALID");
}
function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  return value as Record<string, unknown>;
}
function amount(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 99_999_999)
    return invalid();
  return BigInt(value);
}
const money = (value: bigint) =>
  createMoney({ amountMinor: value, currencyCode: parseCurrencyCode("CAD") });

/** Project only required payment facts. Raw Stripe payload and client_secret never enter history. */
export function normalizeStripeOnlineIntentResponse(
  request: CreateIntentRequest | RetrieveIntentRequest,
  payload: unknown,
  observedAt: string,
): PaymentProviderSnapshot {
  encodeStripeOnlineIntentRequest(request);
  const raw = object(payload);
  if (
    raw.object !== "payment_intent" ||
    raw.currency !== "cad" ||
    raw.livemode !== (request.context.environment === "Live") ||
    raw.capture_method !== "automatic" ||
    !Array.isArray(raw.payment_method_types) ||
    raw.payment_method_types.length !== 1 ||
    raw.payment_method_types[0] !== "card" ||
    typeof raw.id !== "string" ||
    !/^pi_[A-Za-z0-9]+$/u.test(raw.id)
  )
    return invalid();
  const reference = parseProviderReference(raw.id);
  if (request.operation === "RetrieveIntent" && reference !== request.providerIntentReference)
    return invalid();
  const requested = amount(raw.amount);
  const received = amount(raw.amount_received);
  if (
    requested === 0n ||
    amount(raw.amount_capturable) !== 0n ||
    (request.operation === "CreateIntent" && requested !== request.amount.amountMinor)
  )
    return invalid();
  const states: Record<string, PaymentProviderSnapshot["status"]> = {
    requires_payment_method: "RequiresCustomerAction",
    requires_confirmation: "RequiresCustomerAction",
    requires_action: "RequiresCustomerAction",
    processing: "Pending",
    canceled: "Cancelled",
    succeeded: "Captured",
  };
  if (typeof raw.status !== "string" || !Object.hasOwn(states, raw.status)) return invalid();
  const status = states[raw.status];
  if (status === undefined) return invalid();
  let transaction = null;
  let refunded = 0n;
  if (raw.latest_charge !== null) {
    const charge = object(raw.latest_charge);
    if (
      charge.object !== "charge" ||
      charge.payment_intent !== reference ||
      charge.currency !== "cad" ||
      charge.livemode !== raw.livemode ||
      typeof charge.id !== "string" ||
      !/^ch_[A-Za-z0-9]+$/u.test(charge.id) ||
      amount(charge.amount) !== requested ||
      amount(charge.amount_captured) !== received
    )
      return invalid();
    refunded = amount(charge.amount_refunded);
    if (
      status === "Captured" &&
      (charge.paid !== true ||
        charge.captured !== true ||
        charge.status !== "succeeded" ||
        object(charge.payment_method_details).type !== "card")
    )
      return invalid();
    transaction = parseProviderReference(charge.id);
  }
  if (
    (status === "Captured" && (transaction === null || received !== requested)) ||
    (status !== "Captured" && (received !== 0n || refunded !== 0n))
  )
    return invalid();
  const projected = {
    kind: "Snapshot" as const,
    context: request.context,
    providerIntentReference: reference,
    providerTransactionReference: transaction,
    paymentMethod: "OnlineCard" as const,
    captureMode: "Automatic" as const,
    status,
    requestedAmount: money(requested),
    authorizedAmount: money(received),
    capturedAmount: money(received),
    refundedAmount: money(refunded),
    observedAt,
  };
  const digest =
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify(projected, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      )
      .digest("hex");
  return createPaymentProviderSnapshot({
    ...projected,
    evidenceDigest: digest as PaymentProviderSnapshot["evidenceDigest"],
  });
}
