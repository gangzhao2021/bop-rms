/** One online payment outcome as the guest's order page reports it. */
export interface ReportedOrderPayment {
  readonly status: "Succeeded" | "Failed";
  readonly occurredAt: string;
  readonly amount: { readonly amountMinor: bigint; readonly currencyCode: string } | null;
  readonly freshnessStatus: "Fresh" | "Stale" | "Rebuilding" | "Failed";
}

/**
 * WP-2423 Q10 / M118: the order's online payments, one per intent. The status projection is
 * updated asynchronously, so a final outcome Payment already recorded (what the payment result page
 * shows) is reported from that fact:
 * - an intent not projected yet is reported from its fact;
 * - another card after a decline is a later attempt of the same intent: the intent's newest fact
 *   replaces a projected decline when it is not older (the rule the projection itself applies when
 *   it supersedes). A projected success is never replaced, so nothing is ever downgraded.
 */
export function reportOrderPaymentOutcomes(
  projections: readonly (ReportedOrderPayment & { readonly paymentIntentReference: string })[],
  facts: readonly {
    readonly paymentIntentReference: string;
    readonly outcome: "Succeeded" | "Failed";
    readonly occurredAt: string;
    readonly amount: ReportedOrderPayment["amount"];
  }[],
): ReportedOrderPayment[] {
  const reported: ReportedOrderPayment[] = projections.map((projection) => ({
    status: projection.status,
    occurredAt: projection.occurredAt,
    amount: projection.amount,
    freshnessStatus: projection.freshnessStatus,
  }));
  const at = new Map(
    projections.map((projection, index) => [projection.paymentIntentReference, index]),
  );
  for (const fact of facts) {
    const fromFact: ReportedOrderPayment = {
      status: fact.outcome,
      occurredAt: fact.occurredAt,
      amount: fact.amount,
      freshnessStatus: "Fresh",
    };
    const index = at.get(fact.paymentIntentReference);
    if (index === undefined) {
      reported.push(fromFact);
      continue;
    }
    const prior = reported[index];
    if (
      prior !== undefined &&
      prior.status === "Failed" &&
      Date.parse(prior.occurredAt) <= Date.parse(fact.occurredAt)
    )
      reported[index] = fromFact;
  }
  return reported;
}
