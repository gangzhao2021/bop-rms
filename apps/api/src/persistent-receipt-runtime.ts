import { createAdditionalReceiptIssuance } from "./additional-receipt-issuance.js";
import { createRefundReceiptIssuance } from "./refund-receipt-issuance.js";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresReceiptOrderSource,
  DigitalReceiptError,
  parseOrderingReference,
} from "@rms/ordering";
import { createOriginalReceiptIssuance } from "./original-receipt-issuance.js";
import { createPublishedReceiptTemplateSource } from "./published-receipt-template-source.js";
type IssuanceOptions = Parameters<typeof createOriginalReceiptIssuance>[0];
type TemplateOptions = Parameters<typeof createPublishedReceiptTemplateSource>[0];
type OrderOptions = Parameters<typeof createPostgresReceiptOrderSource>[0];
type Request = Parameters<ReturnType<typeof createOriginalReceiptIssuance>>[1];
/** Explicit local runtime assembly. Caller supplies a real transaction runner and
 * current authority; actual Payment refund coverage and published template are required.
 * No Provider call, credentials, HTTP route or Worker subscription is created here.
 */
export function createPersistentReceiptRuntime(options: {
  transactions: { run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> };
  sources: Omit<IssuanceOptions["sources"], "order" | "template">;
  template: TemplateOptions;
  authorize: IssuanceOptions["authorize"];
  authorizeOrder: OrderOptions["authorize"];
  identities: IssuanceOptions["identities"];
  audit: IssuanceOptions["audit"];
}) {
  const scope = {
    brandReference: String(parseOrderingReference(options.sources.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.sources.scope.storeReference)),
  };
  if (
    scope.brandReference !==
      String(parseOrderingReference(options.template.store.brandReference)) ||
    scope.storeReference !==
      String(parseOrderingReference(options.template.store.storeReference)) ||
    String(parseOrderingReference(options.sources.scope.tenantReference)) !==
      String(parseOrderingReference(options.template.store.tenantReference)) ||
    typeof options.transactions.run !== "function"
  )
    throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
  const issue = createOriginalReceiptIssuance({
    authorize: options.authorize,
    identities: options.identities,
    audit: options.audit,
    sources: {
      ...options.sources,
      order: createPostgresReceiptOrderSource({ ...scope, authorize: options.authorizeOrder }),
      template: createPublishedReceiptTemplateSource(options.template),
    },
  });
  const issueAdditional = createAdditionalReceiptIssuance({
    authorize: options.authorize,
    identities: options.identities,
    audit: options.audit,
    sources: {
      ...options.sources,
      order: createPostgresReceiptOrderSource({ ...scope, authorize: options.authorizeOrder }),
      template: createPublishedReceiptTemplateSource(options.template),
    },
  });
  const issueRefund = createRefundReceiptIssuance({
    scope: options.sources.scope,
    authorize: options.authorize,
    authorizeSources: options.sources.authorize,
    authorizeOrder: options.authorizeOrder,
    identities: options.identities,
    audit: options.audit,
  });
  return Object.freeze({
    issueAdditional: (request: Request) =>
      options.transactions.run((transaction) => issueAdditional(transaction, request)),
    issueRefund: (request: Request) =>
      options.transactions.run((transaction) => issueRefund(transaction, request)),
    issueOriginal: (request: Request) =>
      options.transactions.run((transaction) => issue(transaction, request)),
  });
}
