import { canonicalizeRfc8785 } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDigitalReceiptStore,
  DigitalReceiptError,
  parseDigitalReceiptRecord,
  parseOrderingReference,
  parseOrderingInstant,
  type DigitalReceiptRecord,
} from "@rms/ordering";
import { createReceiptIssuanceSources } from "./receipt-issuance-sources.js";

type SourceOptions = Parameters<typeof createReceiptIssuanceSources>[0];
interface Request {
  readonly orderReference: string;
  readonly observedAt: string;
  readonly freshAfter: string;
}
const encode = (record: DigitalReceiptRecord) =>
  canonicalizeRfc8785(
    JSON.parse(
      JSON.stringify(record, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ),
  );

/** Internal composition, not a customer mutation. Caller owns transaction commit.
 * Identities and Audit are allocated only when the owning store finds no original.
 * No template/refund defaults or remote Provider side effects are introduced.
 */
export function createOriginalReceiptIssuance(options: {
  sources: SourceOptions;
  authorize(
    transaction: ConsumerTransaction,
    request: Request & {
      brandReference: string;
      storeReference: string;
      action: "IssueOriginal" | "IssueCorrection" | "IssueRefund" | "Read" | "Append";
    },
  ): Promise<boolean>;
  identities(): { recordReference: string; receiptReference: string; operationReference: string };
  audit(record: DigitalReceiptRecord, operationReference: string): Promise<unknown>;
}) {
  const resolveSources = createReceiptIssuanceSources(options.sources);
  const scope = {
    brandReference: String(parseOrderingReference(options.sources.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.sources.scope.storeReference)),
  };
  return async (transaction: ConsumerTransaction, value: Request) => {
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
        prepared.encoded === encode(record),
    });
    return store.issueOriginal({
      transaction,
      orderReference: request.orderReference,
      create: async () => {
        const identities = options.identities();
        const resolved = await resolveSources(transaction, {
          ...request,
          receiptReference: identities.receiptReference,
        });
        const record = parseDigitalReceiptRecord({
          recordReference: identities.recordReference,
          version: 1,
          kind: "Original",
          recordedAt: request.observedAt,
          previousRecordReference: null,
          reasonCode: null,
          snapshot: resolved.snapshot,
        });
        prepared = { encoded: encode(record), sourceDigest: resolved.sourceDigest };
        return {
          operationReference: identities.operationReference,
          sourceDigest: resolved.sourceDigest,
          record,
          audit: await options.audit(record, identities.operationReference),
        };
      },
    });
  };
}
