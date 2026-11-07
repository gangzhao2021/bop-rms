import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDigitalReceiptStore,
  createAdditionalReceiptSnapshot,
  parseDigitalReceiptRecord,
  parseOrderingReference,
  parseOrderingInstant,
  DigitalReceiptError,
} from "@rms/ordering";
import { createReceiptIssuanceSources } from "./receipt-issuance-sources.js";
import type { createOriginalReceiptIssuance } from "./original-receipt-issuance.js";
type Options = Parameters<typeof createOriginalReceiptIssuance>[0];
type Request = Parameters<ReturnType<typeof createOriginalReceiptIssuance>>[1];
const encode = (value: unknown) =>
  canonicalizeRfc8785(
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ),
  );
/** Internal whole-order receipt refresh after an Additional payment, under owner locks. */
export function createAdditionalReceiptIssuance(options: Options) {
  const resolveSources = createReceiptIssuanceSources(options.sources);
  const scope = {
    brandReference: String(parseOrderingReference(options.sources.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.sources.scope.storeReference)),
  };
  return async (transaction: ConsumerTransaction, value: Request) => {
    if (
      !value ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 3 ||
      ["orderReference", "observedAt", "freshAfter"].some((key) => {
        const d = Object.getOwnPropertyDescriptor(value, key);
        return !d || !("value" in d);
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
      validateSources: async (tx, record, digest) =>
        prepared !== undefined &&
        prepared.sourceDigest === digest &&
        prepared.encoded === encode(record) &&
        (await options.sources.authorize(tx, {
          ...scope,
          ...request,
          receiptReference: record.snapshot.receiptReference,
        })),
    });
    return store.issueCorrection({
      transaction,
      orderReference: request.orderReference,
      create: async (chain) => {
        const previous = chain.records.at(-1);
        if (!previous) throw new DigitalReceiptError("DIGITAL_RECEIPT_CHAIN_CONFLICT");
        const resolved = await resolveSources(transaction, {
          ...request,
          receiptReference: previous.snapshot.receiptReference,
        });
        const snapshot = createAdditionalReceiptSnapshot(previous, resolved.snapshot);
        if (snapshot === null) return null;
        const identities = options.identities();
        const record = parseDigitalReceiptRecord({
          recordReference: identities.recordReference,
          version: previous.version + 1,
          kind: "Correction",
          recordedAt: request.observedAt,
          previousRecordReference: previous.recordReference,
          reasonCode: "ORDER_ADDITIONAL_PAYMENT_CAPTURED",
          snapshot,
        });
        const sourceDigest =
          "sha256:" + sha256Hex(encode({ previous, sourceDigest: resolved.sourceDigest, record }));
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
