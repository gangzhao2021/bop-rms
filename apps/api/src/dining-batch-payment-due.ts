/**
 * WP-2423: what staff and the customer are told about an unpaid dine-in round before and after the
 * System cancels it. Composes Ordering's payment deadlines and unpaid cancellations with Payment's
 * latest terminal outcome per batch; no business rule is decided here beyond that composition.
 */
export type BatchPaymentOutcome = "Succeeded" | "Failed";

/** A dine-in round still waiting for its payment, as staff see it on the order screen. */
export type MerchantBatchPaymentDue = null | {
  readonly status: "Failed" | "Awaiting";
  /**
   * When the round is cancelled automatically: when its payment failed, or (WP-2423 item 5) when
   * no payment was ever started for it (a staff-entered round not yet paid on the card machine).
   * Null while a started payment is still open.
   */
  readonly cancelsAt: string | null;
};

export function resolveMerchantBatchPaymentDue(input: {
  readonly orderType: "DineIn" | "Pickup";
  /** The Order can still take or serve rounds (not cancelled, rejected or fulfilled). */
  readonly open: boolean;
  readonly batch: { readonly orderBatchReference: string; readonly acceptanceStatus: string };
  /** Batches whose payment Ordering recorded. */
  readonly paidBatches: ReadonlySet<string>;
  /** Dining-owned batches and when their payment window ends. */
  readonly deadlines: ReadonlyMap<string, string>;
  readonly outcomes: ReadonlyMap<string, BatchPaymentOutcome>;
  /**
   * WP-2423 item 5: batches for which a payment was started (an online payment, or one recorded on
   * the card machine). Absent: unknown, so only a failed payment has a cancellation time.
   */
  readonly paymentStarted?: ReadonlySet<string>;
}): MerchantBatchPaymentDue {
  const reference = input.batch.orderBatchReference;
  const deadline = input.deadlines.get(reference);
  if (
    input.orderType !== "DineIn" ||
    !input.open ||
    input.batch.acceptanceStatus !== "NotAccepted" ||
    input.paidBatches.has(reference) ||
    deadline === undefined
  )
    return null;
  const outcome = input.outcomes.get(reference);
  // Paid at the Provider, not yet recorded by Ordering: nothing is due.
  if (outcome === "Succeeded") return null;
  return outcome === "Failed"
    ? Object.freeze({ status: "Failed" as const, cancelsAt: deadline })
    : Object.freeze({
        status: "Awaiting" as const,
        cancelsAt:
          input.paymentStarted !== undefined && !input.paymentStarted.has(reference)
            ? deadline
            : null,
      });
}

export interface CustomerBatchPayment {
  readonly orderBatchReference: string;
  readonly status: BatchPaymentOutcome | "Awaiting";
  /**
   * When the round is cancelled automatically; only for a failed, or (WP-2423 item 5) never-started,
   * not yet cancelled round.
   */
  readonly cancelsAt: string | null;
}

/** Every Dining-owned round of a dine-in Order with its payment state, in the Order's batch order. */
export function resolveCustomerBatchPayments(input: {
  readonly batchReferences: readonly string[];
  readonly deadlines: ReadonlyMap<string, string>;
  readonly outcomes: ReadonlyMap<string, BatchPaymentOutcome>;
  readonly cancelled: ReadonlySet<string>;
  /** WP-2423 item 5: batches whose payment was started (see the merchant resolver). */
  readonly paymentStarted?: ReadonlySet<string>;
}): readonly CustomerBatchPayment[] {
  return Object.freeze(
    input.batchReferences.flatMap((orderBatchReference) => {
      const deadline = input.deadlines.get(orderBatchReference);
      if (deadline === undefined) return [];
      const status = input.outcomes.get(orderBatchReference) ?? "Awaiting";
      return [
        Object.freeze({
          orderBatchReference,
          status,
          cancelsAt:
            !input.cancelled.has(orderBatchReference) &&
            (status === "Failed" ||
              (status === "Awaiting" &&
                input.paymentStarted !== undefined &&
                !input.paymentStarted.has(orderBatchReference)))
              ? deadline
              : null,
        }),
      ];
    }),
  );
}
