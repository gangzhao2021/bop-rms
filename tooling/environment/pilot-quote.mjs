import { createHash } from "node:crypto";
import { createPostgresCurrentQuoteService } from "../../packages/rms/pricing/src/index.ts";
import { createInternalReadTransactions } from "./pilot-read-transactions.mjs";
export async function createInternalTestQuote(
  resources,
  orderType = "Pickup",
  { loadPricingPolicy },
) {
  if (!["Pickup", "DineIn"].includes(orderType))
    throw new Error("INTERNAL_QUOTE_CHANNEL_UNAVAILABLE");
  const policy = await loadPricingPolicy(),
    scope = resources.scope,
    reference = resources.credentials.reference;
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const references = { hashIntent: hash, equals: (a, b) => a === b };
  const audit = (actionCode, targetType, targetId, occurredAt) => ({
    auditId: reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode,
    targetType,
    targetId,
    occurredAt,
    reasonCode:
      actionCode === "ORDERING_CART_QUOTE_EXPIRE"
        ? "QUOTE_VALIDITY_ENDED"
        : "AUTHORIZED_CART_QUOTE",
    correlationId: reference(),
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const policies = createPostgresCurrentQuoteService(createInternalReadTransactions(resources), {
    scope,
    priceBookReference: policy.priceBook.priceBookReference,
    taxConfigurationReference: policy.taxConfiguration.configurationReference,
    currencyMetadata: policy.currencyMetadata,
    clock: { now: resources.now },
    evidence: {
      load: async () => ({
        registrationEvidence: policy.taxConfiguration.registrationEvidence,
        professionalEvidence: policy.taxConfiguration.professionalEvidence,
      }),
    },
  });
  return {
    cartQuote: {
      references,
      attachmentTransactions: resources.transactions,
      pricingTransactions: resources.transactions,
      pricingReferences: { ...references, generateReference: reference },
      candidate: async (input) => {
        if (input.orderType !== orderType) throw new Error("INTERNAL_QUOTE_CHANNEL_UNAVAILABLE");
        const quote = await policies.create({
          ...scope,
          quoteReference: reference(),
          cartReference: input.cartReference,
          cartVersion: input.cartVersion,
          inputDigest: hash(JSON.stringify(input)),
          createdAt: input.requestedAt,
          expiresAt: new Date(
            Math.min(Date.parse(input.requestedAt) + 300000, Date.parse(policy.validUntil)),
          ).toISOString(),
          lines: input.lines.map((line) => ({
            lineReference: line.lineReference,
            sellableReference: line.sellableReference,
            productVersionReference: line.catalogSelectionEvidence.productVersionReference,
            menuVersionReference: line.catalogSelectionEvidence.menuVersionReference,
            quantity: line.quantity,
            priceContext: {
              ...scope,
              storeGroupReference: null,
              regionReference: null,
              sellableReference: line.sellableReference,
              channelCode: "CUSTOMER_WEB",
              orderType: input.orderType,
              currencyCode: "CAD",
              evaluatedAt: input.requestedAt,
            },
            taxContext: {
              ...scope,
              jurisdictionCode: "CA-ON",
              currencyCode: "CAD",
              taxClassificationReference: policy.taxClassificationReference,
              orderType: input.orderType,
              chargeType: "Sellable",
              evaluatedAt: input.requestedAt,
            },
          })),
        });
        return {
          quote,
          audit: audit(
            "PRICING_QUOTE_CREATE",
            "PricingPriceQuote",
            quote.quoteReference,
            quote.createdAt,
          ),
        };
      },
      audit: (input) =>
        audit("ORDERING_CART_ATTACH_QUOTE", "OrderingCart", input.cartReference, input.observedAt),
      expiryAudit: (record) =>
        audit("ORDERING_CART_QUOTE_EXPIRE", "OrderingCart", record.cartReference, record.expiredAt),
    },
  };
}
