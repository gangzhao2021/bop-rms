import type { ConsumerTransaction } from "@bop/eventing";
import {
  cardMachinePaymentIntentView,
  cardMachineTerminalView,
  createPostgresCardMachinePaymentStore,
  createPostgresPaymentIntentCreationStore,
  createPostgresPaymentTerminalStore,
  parsePaymentIntentCreationRecord,
  parsePaymentInstant,
} from "@rms/payment";
import {
  parseOrderingReference,
  parsePaymentSucceededEnvelope,
  createPaymentOutcomeEventBinding,
  OrderPaymentOutcomeError,
} from "@rms/ordering";

const unavailable = (): never => {
  throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
};

/** Internal Payment facts for fulfillment evaluation, never a confirmation or client response. */
export function createOrderCapturedPaymentSource(options: {
  scope: Readonly<{
    brandReference: string;
    storeReference: string;
    providerAccountReference: string;
    environment: "Test" | "Live";
  }>;
  now(): string;
  authorize(
    transaction: ConsumerTransaction,
    event: ReturnType<typeof parsePaymentSucceededEnvelope>,
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
    providerAccountReference: String(
      parseOrderingReference(options.scope.providerAccountReference),
    ),
    environment: options.scope.environment,
  });
  return Object.freeze({
    async resolve(transaction: ConsumerTransaction, value: unknown) {
      try {
        const event = parsePaymentSucceededEnvelope(value);
        if (event.tenantId !== scope.brandReference || event.storeId !== scope.storeReference)
          return unavailable();
        const startedAt = parsePaymentInstant(options.now());
        if ((await options.authorize(transaction, event)) !== true) return unavailable();
        const runner = {
          run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
        };
        const history = createPostgresPaymentIntentCreationStore(
          runner,
          { brandReference: scope.brandReference, storeReference: scope.storeReference },
          { now: options.now, generateObservationReference: unavailable },
        );
        const stored = await history.resolveOperation(event.correlationId);
        if (stored === null) {
          // WP-2423 Q7: a payment staff recorded from the Store's card machine.
          const card = await createPostgresCardMachinePaymentStore({
            scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
            authorize: async () => true,
          }).loadByPaymentOperation(transaction, event.correlationId);
          if (card === null) return unavailable();
          const payment = cardMachinePaymentIntentView(card);
          const terminal = cardMachineTerminalView(card);
          const p = payment.intent.preparation;
          if (
            card.environment !== scope.environment ||
            payment.intent.paymentIntentReference !== event.payload.paymentIntentReference ||
            payment.attempt.paymentAttemptReference !== event.payload.paymentAttemptReference ||
            terminal.paymentTransactionReference !== event.payload.paymentTransactionReference ||
            p.brandReference !== event.tenantId ||
            p.storeReference !== event.storeId ||
            p.orderReference !== event.payload.orderReference ||
            p.total.amountMinor.toString() !== event.payload.amountMinor ||
            createPaymentOutcomeEventBinding(parsePaymentSucceededEnvelope(terminal.event)) !==
              createPaymentOutcomeEventBinding(event) ||
            parsePaymentInstant(terminal.recordedAt) > parsePaymentInstant(options.now())
          )
            return unavailable();
          return Object.freeze({ payment, terminal });
        }
        const payment = parsePaymentIntentCreationRecord(stored);
        const preparation = payment.intent.preparation;
        if (
          payment.intent.paymentOperationReference !== event.correlationId ||
          payment.intent.paymentIntentReference !== event.payload.paymentIntentReference ||
          payment.attempt.paymentAttemptReference !== event.payload.paymentAttemptReference ||
          preparation.brandReference !== event.tenantId ||
          preparation.storeReference !== event.storeId ||
          preparation.orderReference !== event.payload.orderReference ||
          preparation.total.amountMinor.toString() !== event.payload.amountMinor ||
          preparation.total.currencyCode !== event.payload.currencyCode ||
          payment.attempt.providerEnvironment !== scope.environment
        )
          return unavailable();
        const terminal = await createPostgresPaymentTerminalStore(runner, scope).read(
          event.payload.paymentIntentReference,
        );
        if (
          terminal === null ||
          terminal.outcome !== "Succeeded" ||
          terminal.paymentIntentReference !== event.payload.paymentIntentReference ||
          terminal.paymentAttemptReference !== event.payload.paymentAttemptReference ||
          terminal.paymentTransactionReference !== event.payload.paymentTransactionReference ||
          String(terminal.orderReference) !== event.payload.orderReference ||
          terminal.amount?.amountMinor !== preparation.total.amountMinor ||
          terminal.amount.currencyCode !== preparation.total.currencyCode ||
          createPaymentOutcomeEventBinding(parsePaymentSucceededEnvelope(terminal.event)) !==
            createPaymentOutcomeEventBinding(event)
        )
          return unavailable();
        const completedAt = parsePaymentInstant(options.now());
        if (
          completedAt < startedAt ||
          parsePaymentInstant(terminal.recordedAt) > completedAt ||
          parsePaymentInstant(terminal.occurredAt) > parsePaymentInstant(terminal.recordedAt)
        )
          return unavailable();
        return Object.freeze({ payment, terminal });
      } catch {
        return unavailable();
      }
    },
  });
}
