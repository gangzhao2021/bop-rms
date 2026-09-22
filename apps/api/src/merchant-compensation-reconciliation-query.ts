import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import {
  createPostgresPaymentCompensationReconciliationSource,
  createPostgresPaymentCompensationOperationsStore,
} from "@rms/payment";
import { createMerchantRefundTransactions } from "./merchant-refund-transactions.js";
import type { createMerchantCompensationReconciliationCommand } from "./merchant-compensation-reconciliation-command.js";
type Options = Pick<
  Parameters<typeof createMerchantCompensationReconciliationCommand>[0],
  "persistence" | "authentication"
>;
/** Current confirmed refund and Case version for the selected operator; no client financial facts. */
export function createMerchantCompensationReconciliationQuery(options: Options) {
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const session = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["orderReference", "caseReference"]);
    const orderReference = String(parseOpaqueUuidV7(raw.orderReference, "ACTOR_REFERENCE_INVALID"));
    const caseReference = String(parseOpaqueUuidV7(raw.caseReference, "ACTOR_REFERENCE_INVALID"));
    const context = await createMerchantRefundTransactions({
      persistence: options.persistence,
      sessionCookie: input.sessionCookie,
      sessionReference: session.sessionReference,
      orderReference,
      permission: "operations.order-exception.manage",
    });
    return context.transactions.run(async (tx) => {
      const authorize = async () => context.authorize(tx, { ...context.scope, orderReference });
      const source = await createPostgresPaymentCompensationReconciliationSource({
        scope: context.scope,
        authorize,
      })(tx, caseReference);
      if (!source || source.caseRecord.orderReference !== orderReference)
        throw new Error("COMPENSATION_RECONCILIATION_UNAVAILABLE");
      const operations = createPostgresPaymentCompensationOperationsStore({
        transactions: { run: (work) => work(tx) },
        scope: context.scope,
        authorize: async (t, access) =>
          t === tx &&
          access.action === "Read" &&
          access.actorReference === null &&
          access.brandReference === context.scope.brandReference &&
          access.storeReference === context.scope.storeReference &&
          access.caseReference === caseReference &&
          access.purpose === "ReconcilePaidWithoutFulfillableOrder" &&
          (await authorize()),
        validateEvidence: async () => false,
      });
      const receipt = await operations.resolve({ compensationCaseReference: caseReference });
      if (
        receipt &&
        (receipt.refundReference !== source.refund.refundReference ||
          receipt.refundEvidenceDigest !== source.refund.evidenceDigest)
      )
        throw new Error("COMPENSATION_RECONCILIATION_UNAVAILABLE");
      return Object.freeze({
        caseVersion: source.caseRecord.version,
        caseState: source.caseRecord.state,
        refund: Object.freeze({
          amountMinor: source.refund.amount.amountMinor.toString(),
          currencyCode: source.refund.amount.currencyCode,
          confirmedAt: source.refund.providerConfirmedAt,
        }),
        acknowledgmentRecorded: receipt !== null,
      });
    });
  };
}
