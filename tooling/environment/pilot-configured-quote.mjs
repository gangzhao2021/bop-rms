import { createHash } from "node:crypto";
import { currentStorePriceBook } from "../../packages/rms/pricing/src/index.ts";
import {
  createPostgresCurrentOptionBindingsStore,
  listProductVersionTaxClassifications,
} from "../../packages/rms/catalog/src/index.ts";
import { createInternalReadTransactions } from "./pilot-read-transactions.mjs";

/**
 * WP-2423 slice 4: the configured Quote (v2) every new cart uses — the Store's assigned price book,
 * its tax configuration and, for each selected option, the binding it belongs to (from current
 * Catalog bindings, limited to the selection's rule evidence). Options are taxed with their item.
 */
export async function createInternalConfiguredQuote(resources, orderType, { loadPricingPolicy }) {
  if (!["Pickup", "DineIn"].includes(orderType))
    throw new Error("INTERNAL_QUOTE_CHANNEL_UNAVAILABLE");
  const policy = await loadPricingPolicy(),
    scope = resources.scope,
    reference = resources.credentials.reference;
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
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
  const reads = createInternalReadTransactions(resources);
  const pricingChannelCode = "CUSTOMER_WEB";
  const catalogChannelCode = "CUSTOMER_PWA";
  return {
    pricingChannelCode,
    references: { hashIntent: hash, equals: (a, b) => a === b },
    pricingReferences: {
      generateReference: reference,
      hashIntent: hash,
      equals: (a, b) => a === b,
    },
    catalogReferences: { generate: reference, hash },
    policyTransactions: reads,
    // The Store's assigned price book, read for each quote (DEC-PRICE-STORE-ASSIGNMENT).
    policies: async () => {
      const assignment = await reads.run((tx) => currentStorePriceBook(tx, scope));
      if (assignment === null) throw new Error("INTERNAL_QUOTE_PRICE_BOOK_UNASSIGNED");
      return {
        priceBookReference: assignment.priceBookReference,
        taxConfigurationReference: policy.taxConfiguration.configurationReference,
        currencyMetadata: policy.currencyMetadata,
        evidence: {
          load: async () => ({
            registrationEvidence: policy.taxConfiguration.registrationEvidence,
            professionalEvidence: policy.taxConfiguration.professionalEvidence,
          }),
        },
      };
    },
    quoteRequest: async (input) => {
      if (input.orderType !== orderType) throw new Error("INTERNAL_QUOTE_CHANNEL_UNAVAILABLE");
      // Each line's Product version tax class (DEC-CAT-PRODUCT-ADMIN).
      const taxClasses = await reads.run((tx) =>
        listProductVersionTaxClassifications(
          tx,
          scope,
          input.lines.map((line) => line.catalogSelectionEvidence.productVersionReference),
        ),
      );
      const taxClassOf = (line) => {
        const value = taxClasses.get(line.catalogSelectionEvidence.productVersionReference);
        if (typeof value !== "string") throw new Error("INTERNAL_QUOTE_TAX_CLASS_UNAVAILABLE");
        return value;
      };
      const options = [];
      for (const line of input.lines) {
        if (line.optionSelections.length === 0) continue;
        const evidence = new Set(
          line.catalogSelectionEvidence.ruleEvidence.map((rule) => rule.bindingReference),
        );
        const source = await createPostgresCurrentOptionBindingsStore(reads, {
          brandReference: scope.brandReference,
        }).load({
          sellableReference: line.sellableReference,
          productVersionReference: line.catalogSelectionEvidence.productVersionReference,
          channelCode: catalogChannelCode,
          observedAt: input.requestedAt,
        });
        for (const selection of line.optionSelections) {
          const owners = (source?.bindings ?? []).filter(
            ({ binding }) =>
              evidence.has(binding.bindingReference) &&
              binding.enabledOptionReferences.includes(selection.optionReference),
          );
          if (owners.length !== 1) throw new Error("INTERNAL_QUOTE_OPTION_BINDING_UNAVAILABLE");
          options.push({
            lineReference: line.lineReference,
            bindingReference: owners[0].binding.bindingReference,
            optionReference: selection.optionReference,
            selectedQuantity: selection.quantity,
            taxBasis: "ParentSellable",
            taxClassificationReference: taxClassOf(line),
          });
        }
      }
      return {
        base: {
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
              channelCode: pricingChannelCode,
              orderType: input.orderType,
              currencyCode: "CAD",
              evaluatedAt: input.requestedAt,
            },
            taxContext: {
              ...scope,
              jurisdictionCode: "CA-ON",
              currencyCode: "CAD",
              taxClassificationReference: taxClassOf(line),
              orderType: input.orderType,
              chargeType: "Sellable",
              evaluatedAt: input.requestedAt,
            },
          })),
        },
        options,
      };
    },
    quoteAudit: async (quote) =>
      audit("PRICING_QUOTE_CREATE", "PricingPriceQuote", quote.quoteReference, quote.createdAt),
    audit: (input) =>
      audit("ORDERING_CART_ATTACH_QUOTE", "OrderingCart", input.cartReference, input.observedAt),
    expiryAudit: (record) =>
      audit("ORDERING_CART_QUOTE_EXPIRE", "OrderingCart", record.cartReference, record.expiredAt),
  };
}
