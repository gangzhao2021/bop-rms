import { createHash } from "node:crypto";
import { createCustomerConfiguredOrderSourceComposition } from "../../apps/api/dist/customer-order-source-composition.js";
import {
  createPostgresStoreBusinessDateSource,
  createPostgresCurrentStorePublicationProof,
} from "../../packages/rms/store/src/index.ts";
import { createInternalReadTransactions } from "./pilot-read-transactions.mjs";
export function createInternalOrderSourceOptions(resources, catalogOptions, orderType = "Pickup") {
  if (!["Pickup", "DineIn"].includes(orderType)) throw new Error("INTERNAL_ORDER_TYPE_UNAVAILABLE");
  const { scope, transactions, now, credentials } = resources,
    reads = createInternalReadTransactions(resources);
  return {
    scope,
    cartTransactions: transactions,
    catalogTransactions: reads,
    pricingTransactions: reads,
    catalogScope: {
      ...catalogOptions.catalogScope,
      orderType,
      orderTypeCode: orderType === "DineIn" ? "DINE_IN" : catalogOptions.catalogScope.orderTypeCode,
    },
    catalogSafety: catalogOptions.catalogSafety,
    catalogReferences: {
      generate: credentials.reference,
      hash: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    },
    clock: { now },
  };
}
export function createInternalOrderSources(resources, catalogOptions, orderType = "Pickup") {
  const { scope, transactions, operating } = resources;
  const source = createCustomerConfiguredOrderSourceComposition(
    createInternalOrderSourceOptions(resources, catalogOptions, orderType),
  );
  const dateSource = createPostgresStoreBusinessDateSource({
    ...scope,
    timeZone: operating.timeZone,
    authorize: operating.authorize,
    publicationProof: async (tx, candidate, observedAt) => {
      const proof = await createPostgresCurrentStorePublicationProof({
        ...operating,
        configurationReference: candidate.configurationReference,
      })(tx, observedAt);
      return {
        contentDigest: proof.contentDigest,
        businessDayStartSource: proof.businessDayStartSource,
      };
    },
  });
  return {
    source,
    businessDate: {
      resolve: (input) => {
        if (
          input.brandReference !== scope.brandReference ||
          input.storeReference !== scope.storeReference
        )
          throw new Error("INTERNAL_ORDER_SCOPE_MISMATCH");
        return transactions.run((tx) => dateSource(tx, input.occurredAt));
      },
    },
  };
}
