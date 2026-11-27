import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderPaymentDispositionReader,
  createPostgresStaffOrderCancellationReader,
  parseOrderPaymentOutcomeDisposition,
  parseOrderingInstant,
} from "@rms/ordering";
import {
  createPostgresPaymentCompensationIdentityReader,
  parsePaidWithoutFulfillableOrderDisposition,
  type PaidWithoutFulfillableOrderDisposition,
} from "@rms/payment";
/** Original disposition and successful payment identity are mandatory evidence,
 * not substitutes for current balance, lease, Provider or operations verification.
 * WP-2423 Q6: a CancelledByStaff source is never an Ordering payment disposition row (the payment
 * was already Confirmed); it is verified against Ordering's append-only staff cancellation record. */
export function createPaymentCompensationDispositionEvidence(options: {
  scope: {
    brandReference: string;
    storeReference: string;
    providerAccountReference: string;
    environment: "Test" | "Live";
  };
  now(): string;
  authorize(
    tx: ConsumerTransaction,
    disposition: PaidWithoutFulfillableOrderDisposition,
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({ ...options.scope });
  const ordering = createPostgresOrderPaymentDispositionReader(scope);
  const staff = createPostgresStaffOrderCancellationReader(scope);
  return async (tx: ConsumerTransaction, value: unknown): Promise<boolean> => {
    const disposition = parsePaidWithoutFulfillableOrderDisposition(value);
    if (
      disposition.brandReference !== scope.brandReference ||
      disposition.storeReference !== scope.storeReference ||
      disposition.evaluatedAt > parseOrderingInstant(options.now())
    )
      return false;
    if ((await options.authorize(tx, disposition)) !== true) return false;
    const input = { transaction: tx, paymentEventReference: disposition.paymentEventReference };
    const stored =
      disposition.reason === "CancelledByStaff"
        ? await staff.loadCompensationByPaymentEvent(input)
        : ((await ordering.loadByPaymentEvent(input))?.record ?? null);
    if (
      !stored ||
      JSON.stringify(parseOrderPaymentOutcomeDisposition(stored)) !== JSON.stringify(disposition)
    )
      return false;
    const identity = createPostgresPaymentCompensationIdentityReader({
      scope,
      transactions: { run: (work) => work(tx) },
      authorize: async (t) => t === tx && (await options.authorize(tx, disposition)) === true,
    });
    const current = await identity({
      brandReference: disposition.brandReference,
      storeReference: disposition.storeReference,
      orderReference: disposition.orderReference,
      paymentTransactionReference: disposition.paymentTransactionReference,
      paymentIntentReference: disposition.paymentIntentReference,
      paymentAttemptReference: disposition.paymentAttemptReference,
    });
    return current !== null && (await options.authorize(tx, disposition)) === true;
  };
}
