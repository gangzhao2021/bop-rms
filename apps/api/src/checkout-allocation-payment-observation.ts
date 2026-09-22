import type { ConsumerTransaction } from "@bop/eventing";
import { parseCheckoutSessionAllocation, parseOrderingReference } from "@rms/ordering";
import {
  createPostgresPaymentIntentCreationStore,
  createPostgresPaymentTerminalStore,
  parsePaymentInstant,
  parsePaymentIntentCreationRecord,
} from "@rms/payment";
const unavailable = (): never => {
  throw new Error("CHECKOUT_PAYMENT_OBSERVATION_UNAVAILABLE");
};
/** Internal observation through owner ports, not replacement authorization.
 * Missing creation/terminal facts are unresolved even after the original deadline.
 * Caller must retain its own write fences and reconcile Order/Inventory separately.
 */
export function createCheckoutAllocationPaymentObservation(options: {
  readonly scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  now(): string;
  authorize(transaction: ConsumerTransaction): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
    providerAccountReference: String(
      parseOrderingReference(options.scope.providerAccountReference),
    ),
    environment: options.scope.environment,
  });
  if (scope.environment !== "Test" && scope.environment !== "Live") return unavailable();
  return Object.freeze({
    async resolve(transaction: ConsumerTransaction, value: unknown) {
      try {
        const allocation = parseCheckoutSessionAllocation(value),
          started = parsePaymentInstant(options.now());
        if (
          allocation.brandReference !== scope.brandReference ||
          allocation.storeReference !== scope.storeReference ||
          allocation.allocatedAt > started ||
          (await options.authorize(transaction)) !== true
        )
          return unavailable();
        const runner = {
          run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
        };
        const stored = await createPostgresPaymentIntentCreationStore(
          runner,
          { brandReference: scope.brandReference, storeReference: scope.storeReference },
          { now: options.now, generateObservationReference: unavailable },
        ).resolveOperation(allocation.paymentOperationReference);
        const finish = async () => {
          const at = parsePaymentInstant(options.now());
          if (at < started || (await options.authorize(transaction)) !== true) return unavailable();
          return at;
        };
        if (stored === null) {
          await finish();
          return Object.freeze({
            status: "Unresolved" as const,
            reason: "IntentUnavailable" as const,
          });
        }
        const payment = parsePaymentIntentCreationRecord(stored),
          p = payment.intent.preparation;
        if (
          payment.intent.paymentOperationReference !== allocation.paymentOperationReference ||
          p.brandReference !== allocation.brandReference ||
          p.storeReference !== allocation.storeReference ||
          p.guestSessionReference !== allocation.guestSessionReference ||
          p.submissionReference !== allocation.submissionReference ||
          p.sourceCartReference !== allocation.cartReference ||
          p.sourceCartVersion !== allocation.cartVersion ||
          p.quoteReference !== allocation.quoteReference ||
          payment.attempt.providerEnvironment !== scope.environment ||
          payment.intent.createdAt < allocation.allocatedAt ||
          payment.intent.createdAt > started
        )
          return unavailable();
        const terminal = await createPostgresPaymentTerminalStore(runner, scope).read(
          payment.intent.paymentIntentReference,
        );
        if (terminal === null) {
          await finish();
          return Object.freeze({
            status: "Unresolved" as const,
            reason: "TerminalUnavailable" as const,
          });
        }
        const at = await finish();
        if (
          terminal.brandReference !== scope.brandReference ||
          terminal.storeReference !== scope.storeReference ||
          terminal.providerAccountReference !== scope.providerAccountReference ||
          terminal.environment !== scope.environment ||
          terminal.paymentIntentReference !== payment.intent.paymentIntentReference ||
          terminal.paymentAttemptReference !== payment.attempt.paymentAttemptReference ||
          String(terminal.orderReference) !== String(p.orderReference) ||
          terminal.recordedAt > at ||
          terminal.occurredAt < allocation.allocatedAt ||
          (terminal.outcome === "Succeeded" &&
            (terminal.amount?.amountMinor !== p.total.amountMinor ||
              terminal.amount.currencyCode !== p.total.currencyCode))
        )
          return unavailable();
        return Object.freeze({
          status: "Terminal" as const,
          outcome: terminal.outcome,
          payment,
          terminal,
        });
      } catch {
        return unavailable();
      }
    },
  });
}
