import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresReceiptIssuerSource } from "@bop/operating-entity";
import { createPostgresReceiptStoreIdentitySource, parseCanonicalInstant } from "@bop/tenant";
import {
  createOriginalReceiptSnapshotFromCurrentOrder,
  parseReceiptOrderSnapshot,
  parseOrderingReference,
  DigitalReceiptError,
  type OriginalReceiptSources,
} from "@rms/ordering";
import { createPostgresPaymentReceiptCoverageSource } from "@rms/payment";

type PaymentOptions = Parameters<typeof createPostgresPaymentReceiptCoverageSource>[0];
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
interface Request {
  readonly orderReference: string;
  readonly receiptReference: string;
  readonly observedAt: string;
  readonly freshAfter: string;
}
interface Evidence {
  readonly evidenceReference: string;
  readonly evidenceDigest: string;
}
const unavailable = (): never => {
  throw new DigitalReceiptError("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
};
const evidence = <T extends Evidence>(value: T): T => {
  parseOrderingReference(value.evidenceReference);
  if (!/^sha256:[0-9a-f]{64}$/u.test(value.evidenceDigest)) return unavailable();
  return value;
};

/** Internal issuance source composition. Caller retains every owner fence through
 * receipt append/commit. Payment composes actual refund owner evidence; template
 * publication remains required. No customer request accepts these ports.
 */
export function createReceiptIssuanceSources(options: {
  scope: PaymentOptions["scope"];
  authorize(tx: ConsumerTransaction, request: Scope & Request): Promise<boolean>;
  order(tx: ConsumerTransaction, request: Scope & Request): Promise<unknown>;
  template(
    tx: ConsumerTransaction,
    request: Scope & Request & { currencyCode: string },
  ): Promise<Evidence & { template: OriginalReceiptSources["template"] }>;
}) {
  const scope = {
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: Request) => {
    try {
      const request = {
        ...scope,
        orderReference: String(parseOrderingReference(value.orderReference)),
        receiptReference: String(parseOrderingReference(value.receiptReference)),
        observedAt: String(parseCanonicalInstant(value.observedAt)),
        freshAfter: String(parseCanonicalInstant(value.freshAfter)),
      };
      if (request.freshAfter > request.observedAt) return unavailable();
      const authorize = async () => {
        if ((await options.authorize(tx, request)) !== true)
          throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
        return true;
      };
      await authorize();
      const order = parseReceiptOrderSnapshot(await options.order(tx, request));
      if (
        order.orderReference !== request.orderReference ||
        order.brandReference !== scope.brandReference ||
        order.storeReference !== scope.storeReference
      )
        return unavailable();
      const store = await createPostgresReceiptStoreIdentitySource({
        ...scope,
        authorize,
      }).resolve({ transaction: tx, evaluatedAt: request.observedAt });
      const issuer = await createPostgresReceiptIssuerSource({
        ...scope,
        authorize,
      }).resolve({ transaction: tx, effectiveAt: request.observedAt });
      if (!store || !issuer) return unavailable();
      const financial = await createPostgresPaymentReceiptCoverageSource({
        scope: options.scope,
        authorize,
      }).resolve(tx, {
        orderReference: request.orderReference,
        observedAt: request.observedAt,
        freshAfter: request.freshAfter,
        expectedBatches: order.batches.map((batch) => ({
          orderBatchReference: batch.orderBatchReference,
          orderAllocationMinor: order.items
            .map((item) => item.snapshot)
            .filter((item) => item.orderBatchReference === batch.orderBatchReference)
            .reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n),
        })),
      });
      const template = evidence(
        await options.template(tx, { ...request, currencyCode: store.currencyCode }),
      );
      const snapshot = createOriginalReceiptSnapshotFromCurrentOrder({
        order,
        receiptReference: request.receiptReference,
        issuedAt: request.observedAt,
        issuer: {
          ...scope,
          operatingEntityReference: issuer.operatingEntityReference,
          displayName: issuer.legalName,
        },
        store: { ...scope, displayName: store.storeDisplayName, currencyCode: store.currencyCode },
        template: template.template,
        financial: {
          ...scope,
          orderReference: request.orderReference,
          orderBatchReferences: financial.batches.map((batch) => batch.orderBatchReference),
          captured: financial.captured,
          tip: financial.tip,
          refunded: financial.refunded,
          refundDisposition: financial.refundDisposition,
        },
      });
      await authorize();
      const content = JSON.parse(
        JSON.stringify({ snapshot, issuer, store, financial, template }, (_key, item) =>
          typeof item === "bigint" ? item.toString() : item,
        ),
      );
      return Object.freeze({
        snapshot,
        sourceDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(content)),
      });
    } catch (error) {
      if (error instanceof DigitalReceiptError) throw error;
      return unavailable();
    }
  };
}
