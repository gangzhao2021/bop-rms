import type { Money } from "@rms/pricing";
import {
  parsePaymentInstant,
  parsePaymentIntentCreationRecord,
  type PaymentIntentCreationRecord,
} from "./payment-intent-creation.js";
import {
  createRetrieveIntentRequest,
  parsePaymentReference,
  parsePaymentProviderOutcome,
} from "./payment-provider-adapter.js";
import type { RetrieveIntentRequest } from "../contracts/payment-provider-adapter.js";

export class CustomerPaymentHandoffError extends Error {
  constructor(readonly code: "NOT_READY" | "UNAVAILABLE") {
    super("customer payment handoff unavailable");
    this.name = "CustomerPaymentHandoffError";
  }
}
export interface CustomerPaymentHandoffPorts {
  readonly now: () => string;
  /** Current request-local Guest/Store/Order authorization, payable state and Provider
   * admission gate. Return null if denied. Never return only a historical snapshot. */
  readonly loadCurrent: (
    operationReference: string,
    observedAt: string,
  ) => Promise<PaymentIntentCreationRecord | null>;
  readonly provider: {
    retrieve(
      request: RetrieveIntentRequest,
      expectedAmount: Money,
    ): Promise<{
      snapshot: unknown;
      clientSecret: string;
    }>;
  };
}
/** No repository write or audit payload accepts the ephemeral credential. */
export function createCustomerPaymentHandoff(ports: CustomerPaymentHandoffPorts) {
  return Object.freeze({
    async retrieve(operationReference: string): Promise<{ clientSecret: string }> {
      try {
        const operation = parsePaymentReference(operationReference);
        let previousTime = -Infinity;
        const currentTime = () => {
          const instant = parsePaymentInstant(ports.now());
          const time = Date.parse(instant);
          if (time < previousTime) throw new CustomerPaymentHandoffError("UNAVAILABLE");
          previousTime = time;
          return instant;
        };
        async function load() {
          const record = await ports.loadCurrent(operation, currentTime());
          if (record === null) throw new CustomerPaymentHandoffError("NOT_READY");
          const parsed = parsePaymentIntentCreationRecord(record);
          const now = Date.parse(currentTime());
          if (
            parsed.intent.paymentOperationReference !== operation ||
            now < Date.parse(parsed.intent.createdAt) ||
            now >= Date.parse(parsed.intent.preparation.capacityExpiresAt) ||
            parsed.providerOutcome?.kind !== "Snapshot" ||
            parsed.providerOutcome.status !== "RequiresCustomerAction"
          )
            throw new CustomerPaymentHandoffError("NOT_READY");
          return parsed;
        }
        const record = await load();
        const outcome = record.providerOutcome;
        if (outcome?.kind !== "Snapshot") throw new CustomerPaymentHandoffError("NOT_READY");
        const request = createRetrieveIntentRequest({
          operation: "RetrieveIntent",
          purpose: "RetrievePaymentIntent",
          context: outcome.context,
          providerIntentReference: outcome.providerIntentReference,
        });
        const result = await ports.provider.retrieve(request, record.intent.preparation.total);
        const fresh = parsePaymentProviderOutcome(result.snapshot);
        if (
          fresh.kind !== "Snapshot" ||
          fresh.status !== "RequiresCustomerAction" ||
          fresh.providerIntentReference !== outcome.providerIntentReference ||
          JSON.stringify(fresh.context) !== JSON.stringify(outcome.context) ||
          fresh.requestedAmount.amountMinor !== record.intent.preparation.total.amountMinor ||
          fresh.requestedAmount.currencyCode !== record.intent.preparation.total.currencyCode
        )
          throw new CustomerPaymentHandoffError("NOT_READY");
        const prefix = outcome.providerIntentReference + "_secret_";
        if (
          typeof result.clientSecret !== "string" ||
          result.clientSecret.length > 512 ||
          !result.clientSecret.startsWith(prefix) ||
          !/^[A-Za-z0-9]+$/u.test(result.clientSecret.slice(prefix.length))
        )
          throw new CustomerPaymentHandoffError("UNAVAILABLE");
        const latest = await load();
        const serialized = (value: unknown) =>
          JSON.stringify(value, (_key, item: unknown) =>
            typeof item === "bigint" ? item.toString() : item,
          );
        if (serialized(latest) !== serialized(record))
          throw new CustomerPaymentHandoffError("NOT_READY");
        return Object.freeze({ clientSecret: result.clientSecret });
      } catch (error) {
        if (error instanceof CustomerPaymentHandoffError) throw error;
        throw new CustomerPaymentHandoffError("UNAVAILABLE");
      }
    },
  });
}
