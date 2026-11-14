import { canonicalizeRfc8785 } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderPaymentDispositionReader,
  parseOrderPaymentOutcomeDisposition,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";
import {
  createSubmissionInventoryRelease,
  type SubmissionInventoryReleaseResult,
} from "./submission-inventory-release.js";

type Disposition = Extract<
  ReturnType<typeof parseOrderPaymentOutcomeDisposition>,
  { disposition: "PaidWithoutFulfillableOrder" }
>;
const fail = (): never => {
  throw new Error("PAID_WITHOUT_FULFILLABLE_INVENTORY_UNAVAILABLE");
};
/**
 * WP-2423 Q12: a paid submission that Ordering durably decided cannot be fulfilled
 * (CapacityExpired, SubmissionCancelled or OrderNoLongerFulfillable; kitchen release Blocked)
 * returns its reserved stock. The disposition is re-read through Ordering's public reader in the
 * caller's transaction; the proposal is never trusted. Replay and a set already released by
 * another source (for example a dining checkout cancellation) are verified no-ops. Started or
 * consumed stock is never released here (NotReleasable, left for staff).
 * The caller must roll back the transaction on any thrown failure.
 */
export function createPaidWithoutFulfillableInventoryRelease(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  systemActorReference: string;
  now(): string;
  authorize(tx: ConsumerTransaction, disposition: Disposition): Promise<boolean>;
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.scope.tenantReference),
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  };
  const reader = createPostgresOrderPaymentDispositionReader({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  const release = createSubmissionInventoryRelease({
    scope,
    systemActorReference: options.systemActorReference,
    reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
    now: options.now,
  });
  return async (
    transaction: ConsumerTransaction,
    value: unknown,
  ): Promise<SubmissionInventoryReleaseResult> => {
    const proposal = parseOrderPaymentOutcomeDisposition(value);
    if (
      proposal.disposition !== "PaidWithoutFulfillableOrder" ||
      proposal.kitchenReleaseDisposition !== "Blocked" ||
      proposal.brandReference !== scope.brandReference ||
      proposal.storeReference !== scope.storeReference
    )
      return fail();
    const releasedAt = parseOrderingInstant(options.now());
    if (proposal.evaluatedAt > releasedAt) return fail();
    const allowed = async () => (await options.authorize(transaction, proposal)) === true;
    if (!(await allowed())) return fail();
    const stored = await reader.loadByPaymentEvent({
      transaction,
      paymentEventReference: proposal.paymentEventReference,
    });
    if (
      stored === null ||
      !("disposition" in stored.record) ||
      stored.record.disposition !== "PaidWithoutFulfillableOrder" ||
      canonicalizeRfc8785(stored.record) !== canonicalizeRfc8785(proposal)
    )
      return fail();
    return release.release(transaction, {
      source: {
        kind: "PaidWithoutFulfillableInventory/v1",
        reference: proposal.dispositionReference,
        submissionReference: proposal.submissionReference,
        orderReference: proposal.orderReference,
        occurredAt: proposal.evaluatedAt,
      },
      // The worker releases after the disposition commits; the ledger needs the actual time.
      releasedAt,
      authorize: allowed,
    });
  };
}
