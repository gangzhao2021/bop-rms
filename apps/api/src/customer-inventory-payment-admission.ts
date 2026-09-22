import {
  createPostgresSubmissionFinalValidationStore,
  parseInventoryReference,
  parseInventoryInstant,
  parseInventoryDecimal,
  compareInventoryDecimals,
  type SubmissionExpiryCutoff,
  type CurrentSubmissionInventoryFacts,
  type InventoryItemTransaction,
} from "@rms/inventory";
import {
  parsePaymentIntentCreationRecord,
  type PaymentIntentClaimAdmission,
  type PaymentIntentCreationRecord,
} from "@rms/payment";

export interface CustomerInventoryPaymentAdmissionOptions {
  readonly scope: Readonly<{
    tenantReference: string;
    brandReference: string;
    storeReference: string;
  }>;
  readonly authorize: (
    transaction: InventoryItemTransaction,
    input: Readonly<{ submissionReference: string; actorReference: string }>,
  ) => Promise<boolean>;
  /** Required for remaining stock with an expiry date; no default calendar cutoff. */
  readonly resolveExpiryCutoff?: SubmissionExpiryCutoff;
  /** Actual current Workflow/Item/lot policy evaluation; no implicit permission for deferred/consumed stock. */
  readonly evaluate: (
    transaction: InventoryItemTransaction,
    input: Readonly<{
      payment: PaymentIntentCreationRecord;
      inventory: CurrentSubmissionInventoryFacts;
    }>,
  ) => Promise<boolean>;
}

/** Combines owner capabilities on Payment's existing transaction; never opens or commits one. */
export function createCustomerInventoryPaymentClaimAdmission(
  options: CustomerInventoryPaymentAdmissionOptions,
): PaymentIntentClaimAdmission {
  const scope = Object.freeze({
    tenantReference: parseInventoryReference(options.scope.tenantReference),
    brandReference: parseInventoryReference(options.scope.brandReference),
    storeReference: parseInventoryReference(options.scope.storeReference),
  });
  const { authorize, evaluate, resolveExpiryCutoff } = options;
  return Object.freeze({
    async admit(
      transaction: Parameters<PaymentIntentClaimAdmission["admit"]>[0],
      value: PaymentIntentCreationRecord,
      observedAt: string,
    ) {
      try {
        const payment = parsePaymentIntentCreationRecord(value);
        const preparation = payment.intent.preparation;
        if (
          String(preparation.brandReference) !== String(scope.brandReference) ||
          String(preparation.storeReference) !== String(scope.storeReference)
        )
          return false;
        const inventory = createPostgresSubmissionFinalValidationStore(
          {
            run: async (work) => work(transaction),
          },
          scope,
          {
            authorize,
            // This capability reads committed final records only; it cannot author a substitute.
            resolveCurrent: async () => {
              throw new Error("Inventory final record producer is unavailable");
            },
          },
        );
        const accepted = await inventory.withCurrent(
          {
            submissionReference: preparation.submissionReference,
            actorReference: preparation.guestSessionReference,
            observedAt,
          },
          async (tx, facts) => {
            const final = facts.record;
            if (
              String(final.orderReference) !== String(preparation.orderReference) ||
              String(final.cartReference) !== String(preparation.sourceCartReference) ||
              final.cartVersion !== preparation.sourceCartVersion ||
              String(final.quoteReference) !== String(preparation.quoteReference)
            )
              return false;
            let validUntil: string | null = null;
            const currentTime = parseInventoryInstant(facts.observedAt);
            for (const entry of facts.reservations) {
              if (
                compareInventoryDecimals(
                  parseInventoryDecimal(entry.reservation.remainingQuantity),
                  parseInventoryDecimal("0"),
                ) === 0
              )
                continue;
              const account = facts.accounts.find(
                (candidate) => candidate.accountReference === entry.accountReference,
              );
              if (!account || account.holdStatus !== "Available") return false;
              if (account.expiryDate !== null) {
                if (!resolveExpiryCutoff) return false;
                const cutoff = parseInventoryInstant(
                  await resolveExpiryCutoff(
                    tx,
                    Object.freeze({
                      storeReference: scope.storeReference,
                      accountReference: account.accountReference,
                      expiryDate: account.expiryDate,
                      observedAt: currentTime,
                    }),
                  ),
                );
                if (cutoff <= currentTime) return false;
                if (validUntil === null || cutoff < validUntil) validUntil = cutoff;
              }
            }
            if ((await evaluate(tx, Object.freeze({ payment, inventory: facts }))) !== true)
              return false;
            return validUntil === null ? true : Object.freeze({ validUntil });
          },
        );
        return accepted ?? false;
      } catch {
        return false;
      }
    },
  });
}
