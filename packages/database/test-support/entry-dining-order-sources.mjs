import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCustomerOrderSourceComposition } from "../../../apps/api/src/customer-order-source-composition.ts";
import {
  createPostgresStoreBusinessDateSource,
  createPostgresCurrentStorePublicationProof,
} from "../../rms/store/src/index.ts";

/** Actual owner snapshots and Store business date for the Entry-created checkout. */
export async function prepareEntryDiningOrderSources({
  run,
  scope,
  sources,
  operating,
  checkout,
  details,
  commitment,
  reference,
  mode = "DineIn",
  clock,
}) {
  const now = clock ?? commitment.allocated.options.now;
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const source = createCustomerOrderSourceComposition({
    scope,
    cartTransactions: { run },
    catalogTransactions: sources.reads,
    pricingTransactions: sources.reads,
    catalogScope: { ...sources.catalogOptions.catalogScope, orderType: mode },
    catalogSafety: sources.catalogOptions.catalogSafety,
    catalogReferences: { generate: reference, hash },
    clock: { now },
  });
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
  const businessDate = {
    resolve: async (input) => {
      assert.equal(input.brandReference, scope.brandReference);
      assert.equal(input.storeReference, scope.storeReference);
      return run((tx) => dateSource(tx, input.occurredAt));
    },
  };
  const evidence = checkout.session.validation;
  const snapshot = await source.load({ evidence });
  assert.equal(snapshot.cart.cartReference, evidence.cartReference);
  assert.equal(snapshot.cart.aggregateVersion, evidence.cartVersion);
  assert.equal(snapshot.lines.length, mode === "Pickup" ? 1 : 2);
  assert.deepEqual(
    snapshot.lines.map((line) => line.cartItemReference).sort(),
    snapshot.cart.items.map((item) => item.cartItemReference).sort(),
  );
  assert(snapshot.lines.every((line) => line.pricing.quoteReference === evidence.quoteReference));
  assert.equal(details.saved.snapshot.quoteReference, evidence.quoteReference);
  const resolution = await businessDate.resolve({
    ...scope,
    occurredAt: checkout.session.createdAt,
  });
  assert.equal(resolution.brandReference, scope.brandReference);
  assert.equal(resolution.storeReference, scope.storeReference);
  assert.equal(resolution.timeZone, operating.timeZone);
  return { source, businessDate, snapshot, resolution };
}
