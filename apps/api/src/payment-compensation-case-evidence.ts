import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresPaymentCompensationSource,
  parsePaidWithoutFulfillableOrderDisposition,
  type PaymentCompensationCase,
  type PaymentCompensationSource,
  type PaymentCompensationRuntimeOptions,
} from "@rms/payment";
type SourceOptions = Omit<
  Parameters<typeof createPostgresPaymentCompensationSource>[0],
  "transactions"
>;
export interface PaymentCompensationCaseEvidence {
  readonly validateOpen: PaymentCompensationRuntimeOptions["cases"]["validateOpen"];
  readonly validateCurrentSource: PaymentCompensationRuntimeOptions["cases"]["validateCurrentSource"];
  readonly validateClaim: PaymentCompensationRuntimeOptions["actions"]["validateClaim"];
}
/** Call under the owner's existing fences. New observations may advance source versions;
 * they must never change the original disposition, terminal or payment identity. */
export function createPaymentCompensationCaseEvidence(options: {
  disposition: unknown;
  source: SourceOptions;
  validateDisposition(tx: ConsumerTransaction, value: unknown): Promise<boolean>;
}): PaymentCompensationCaseEvidence {
  const disposition = parsePaidWithoutFulfillableOrderDisposition(options.disposition);
  async function load(tx: ConsumerTransaction) {
    if (!(await options.validateDisposition(tx, disposition))) return null;
    const source = createPostgresPaymentCompensationSource({
      ...options.source,
      transactions: { run: (work) => work(tx) },
    });
    const input = {
      brandReference: disposition.brandReference,
      storeReference: disposition.storeReference,
      orderReference: disposition.orderReference,
      paymentTransactionReference: disposition.paymentTransactionReference,
      paymentIntentReference: disposition.paymentIntentReference,
      paymentAttemptReference: disposition.paymentAttemptReference,
    };
    const identity = await source.resolveIdentity(input);
    if (!identity) return null;
    const current = await source.resolve({
      ...input,
      environment: identity.environment,
      identityVersion: identity.identityVersion,
      identityDigest: identity.identityDigest,
    });
    return current && (await options.validateDisposition(tx, disposition)) ? current : null;
  }
  function matches(record: PaymentCompensationCase, source: PaymentCompensationSource) {
    return (
      record.dispositionReference === String(disposition.dispositionReference) &&
      record.dispositionDigest === String(disposition.sourceDigest) &&
      record.brandReference === String(disposition.brandReference) &&
      record.storeReference === String(disposition.storeReference) &&
      record.orderReference === String(disposition.orderReference) &&
      record.paymentTransactionReference === String(disposition.paymentTransactionReference) &&
      record.paymentIntentReference === String(disposition.paymentIntentReference) &&
      record.paymentAttemptReference === String(disposition.paymentAttemptReference) &&
      record.environment === source.environment &&
      record.originalPaymentMethod === source.originalPaymentMethod &&
      record.terminalEvidenceDigest === source.terminalEvidenceDigest &&
      record.sourceVersion <= source.sourceVersion &&
      (record.sourceVersion !== source.sourceVersion ||
        record.sourceSnapshotDigest === source.sourceSnapshotDigest)
    );
  }
  const validateOpen: PaymentCompensationRuntimeOptions["cases"]["validateOpen"] = async (
    tx,
    record,
  ) => {
    const source = await load(tx);
    return (
      source !== null &&
      matches(record, source) &&
      record.sourceVersion === source.sourceVersion &&
      record.sourceSnapshotDigest === source.sourceSnapshotDigest
    );
  };
  const validateCurrentSource: PaymentCompensationRuntimeOptions["cases"]["validateCurrentSource"] =
    async (tx, { current, next }) => {
      const source = await load(tx);
      return source !== null && matches(current, source) && matches(next, source);
    };
  const validateClaim: PaymentCompensationRuntimeOptions["actions"]["validateClaim"] = async (
    tx,
    { caseRecord, receipt, interacEvidence },
  ) => {
    const source = await load(tx);
    return (
      source !== null &&
      matches(caseRecord, source) &&
      source.originalPaymentMethod === "OnlineCard" &&
      interacEvidence === null &&
      receipt.compensationCaseReference === caseRecord.caseReference &&
      receipt.brandReference === caseRecord.brandReference &&
      receipt.storeReference === caseRecord.storeReference &&
      receipt.paymentTransactionReference === caseRecord.paymentTransactionReference &&
      receipt.paymentAttemptReference === caseRecord.paymentAttemptReference &&
      receipt.originalPaymentMethod === source.originalPaymentMethod &&
      receipt.dispositionDigest === String(disposition.sourceDigest) &&
      receipt.terminalEvidenceDigest === source.terminalEvidenceDigest &&
      receipt.sourceVersion <= source.sourceVersion &&
      (receipt.sourceVersion !== source.sourceVersion ||
        receipt.sourceSnapshotDigest === source.sourceSnapshotDigest) &&
      receipt.amount.currencyCode === source.capturedAmount.currencyCode &&
      receipt.amount.amountMinor > 0n &&
      source.confirmedRefundedAmount.amountMinor +
        source.pendingRefundClaimedAmount.amountMinor +
        receipt.amount.amountMinor <=
        source.capturedAmount.amountMinor
    );
  };
  return Object.freeze({ validateOpen, validateCurrentSource, validateClaim });
}
