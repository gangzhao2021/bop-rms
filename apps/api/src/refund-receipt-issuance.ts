import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDigitalReceiptStore,
  createPostgresReceiptOrderSource,
  createRefundReceiptSnapshot,
  parseDigitalReceiptRecord,
  parseOrderingReference,
  parseOrderingInstant,
  DigitalReceiptError,
} from "@rms/ordering";
import { createPostgresPaymentReceiptCoverageSource } from "@rms/payment";
import type { createOriginalReceiptIssuance } from "./original-receipt-issuance.js";
type Original = Parameters<typeof createOriginalReceiptIssuance>[0];
type Request = Parameters<ReturnType<typeof createOriginalReceiptIssuance>>[1];
const encode = (value: unknown) =>
  canonicalizeRfc8785(
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ),
  );

/** Internal system issuance, not a customer write. The caller retains all owner
 * locks until commit. Reads actual coverage even on a visible-state no-op. */
export function createRefundReceiptIssuance(options: {
  scope: Parameters<typeof createPostgresPaymentReceiptCoverageSource>[0]["scope"];
  authorize: Original["authorize"];
  authorizeSources: Original["sources"]["authorize"];
  authorizeOrder: Parameters<typeof createPostgresReceiptOrderSource>[0]["authorize"];
  identities(): { recordReference: string; operationReference: string };
  audit: Original["audit"];
}) {
  const scope = {
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  };
  const orderSource = createPostgresReceiptOrderSource({
    ...scope,
    authorize: options.authorizeOrder,
  });
  return async (transaction: ConsumerTransaction, value: Request) => {
    if (
      !value ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 3 ||
      ["orderReference", "observedAt", "freshAfter"].some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor || !("value" in descriptor);
      })
    )
      throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
    const request = {
      orderReference: String(parseOrderingReference(value.orderReference)),
      observedAt: String(parseOrderingInstant(value.observedAt)),
      freshAfter: String(parseOrderingInstant(value.freshAfter)),
    };
    if (request.freshAfter > request.observedAt)
      throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
    let prepared: { encoded: string; sourceDigest: string } | undefined;
    const store = createPostgresDigitalReceiptStore({
      ...scope,
      authorize: (tx, access) => options.authorize(tx, { ...scope, ...request, ...access }),
      validateSources: async (_tx, record, digest) =>
        prepared !== undefined &&
        prepared.sourceDigest === digest &&
        prepared.encoded === encode(record) &&
        (await options.authorizeSources(_tx, {
          ...scope,
          ...request,
          receiptReference: record.snapshot.receiptReference,
        })) === true,
    });
    return store.issueRefund({
      transaction,
      orderReference: request.orderReference,
      create: async (chain) => {
        const previous = chain.records.at(-1);
        if (!previous) throw new DigitalReceiptError("DIGITAL_RECEIPT_CHAIN_CONFLICT");
        const sourceRequest = {
          ...scope,
          ...request,
          receiptReference: previous.snapshot.receiptReference,
        };
        const authorize = async () => {
          if ((await options.authorizeSources(transaction, sourceRequest)) !== true)
            throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
          return true;
        };
        await authorize();
        const order = await orderSource(transaction, request);
        const financial = await createPostgresPaymentReceiptCoverageSource({
          scope: options.scope,
          authorize,
        }).resolve(transaction, {
          ...request,
          expectedBatches: order.batches.map((batch) => ({
            orderBatchReference: batch.orderBatchReference,
            orderAllocationMinor: order.items
              .map((item) => item.snapshot)
              .filter((item) => item.orderBatchReference === batch.orderBatchReference)
              .reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n),
          })),
        });
        const snapshot = createRefundReceiptSnapshot(previous, financial);
        await authorize();
        if (snapshot === null) return null;
        const identities = options.identities();
        const record = parseDigitalReceiptRecord({
          recordReference: identities.recordReference,
          version: previous.version + 1,
          kind: "Refund",
          recordedAt: request.observedAt,
          previousRecordReference: previous.recordReference,
          reasonCode: "PAYMENT_REFUND_STATUS_CHANGED",
          snapshot,
        });
        const sourceDigest = "sha256:" + sha256Hex(encode({ previous, order, financial, record }));
        prepared = { encoded: encode(record), sourceDigest };
        return {
          record,
          sourceDigest,
          operationReference: identities.operationReference,
          audit: await options.audit(record, identities.operationReference),
        };
      },
    });
  };
}
