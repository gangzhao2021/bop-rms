import { CheckoutSessionServiceError, parseOrderingReference } from "@rms/ordering";
import { createCustomerAdditionalDiningSessionSubmission } from "./customer-additional-dining-session-submission.js";
import { createCustomerAdditionalDiningSessionClock } from "./customer-additional-dining-session-clock.js";
import { createCustomerAdditionalDiningSessionTipSelection } from "./customer-session-tip-selection.js";
import {
  createCustomerSessionPaymentIntent,
  type CustomerSessionPaymentIntentOptions,
} from "./customer-session-payment-intent.js";

type SubmissionOptions = Parameters<typeof createCustomerAdditionalDiningSessionSubmission>[0];
type TipOptions = Parameters<typeof createCustomerAdditionalDiningSessionTipSelection>[1];
/** One internal Additional Payment assembly; provider/admission/Inventory remain explicit owner ports. */
export function createCustomerAdditionalDiningPaymentComposition(options: {
  submission: SubmissionOptions;
  tip: Omit<TipOptions, "transactions">;
  payment: Pick<
    CustomerSessionPaymentIntentOptions,
    "inventory" | "history" | "nextPreparationReference" | "payment"
  >;
}) {
  const s = options.submission;
  const scope = s.runtime.inventory.scope;
  if (
    String(parseOrderingReference(options.tip.preparation.scope.brandReference)) !==
      String(parseOrderingReference(scope.brandReference)) ||
    String(parseOrderingReference(options.tip.preparation.scope.storeReference)) !==
      String(parseOrderingReference(scope.storeReference))
  )
    throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  const submission = createCustomerAdditionalDiningSessionSubmission(s);
  const clock = createCustomerAdditionalDiningSessionClock({
    access: s.access,
    scope,
    transactions: s.runtime.transactions,
    authorizeHistory: s.historyAuthorization,
    now: () => s.source.clock.now(),
  });
  const tips = createCustomerAdditionalDiningSessionTipSelection(
    s.access,
    {
      ...options.tip,
      transactions: s.runtime.transactions,
      preparation: { ...options.tip.preparation, now: () => s.source.clock.now() },
    },
    s.parent,
  );
  return createCustomerSessionPaymentIntent({
    ...options.payment,
    submissionKind: "Additional",
    access: s.access,
    tenantReference: String(scope.tenantReference),
    tips,
    orders: { create: submission.create, preparePaymentClock: clock.preparePaymentClock },
  });
}
