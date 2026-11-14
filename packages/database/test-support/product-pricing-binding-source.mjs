import assert from "node:assert/strict";
import {
  createPostgresProductCreationStore,
  createPostgresProductPricingBindingSourceStore,
  CatalogError,
} from "../../rms/catalog/src/index.ts";
/** Actual owner SQL with explicit synthetic authority; no normal IAM/policy/held-writer proof. */
export async function exerciseProductPricingBindingSource({
  transactions,
  aggregate,
  tenantReference,
  request: originalRequest,
}) {
  const request = originalRequest ?? {
    purposeCode: "CATALOG_LIFECYCLE_REVIEW",
    brandReference: aggregate.brandReference,
    actorReference: aggregate.createdByActorReference,
    productReference: aggregate.productReference,
    skuReference: null,
    operationReference: aggregate.productReference,
    expectedAggregateVersion: aggregate.aggregateVersion,
    originalProductVersionReference: aggregate.draft.versionReference,
    beforeLifecycle: aggregate.lifecycle,
    targetLifecycle:
      aggregate.lifecycle === "Active"
        ? "Suspended"
        : aggregate.lifecycle === "Archived"
          ? "Draft"
          : aggregate.lifecycle === "Suspended"
            ? "Discontinued"
            : "Archived",
    reasonCode: "SYNTHETIC_REVIEW",
    activeSkuCount: aggregate.draft.skus.filter((s) => s.lifecycle === "Active").length,
  };
  let holds = 0,
    deniedAt = 0;
  const store = createPostgresProductPricingBindingSourceStore({
    tenantReference,
    brandReference: aggregate.brandReference,
    actorReference: request.actorReference,
    transactions,
    clock: { now: () => new Date().toISOString() },
    authority: {
      async holdUntilTransactionCompletes(tx, input) {
        void tx;
        assert.equal(input.request.brandReference, request.brandReference);
        assert.equal(input.request.actorReference, request.actorReference);
        assert.equal(input.purposeCode, "CATALOG_LIFECYCLE_PRICING_BINDING_SOURCE_READ");
        if (++holds === deniedAt) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
  });
  const snapshot = await store.loadSnapshot(request);
  assert.equal(holds, 2);
  assert.equal(snapshot.profile, "CurrentDraftBindings");
  assert.equal(snapshot.versionReference, aggregate.draft.versionReference);
  assert.deepEqual(snapshot.skuReferences, aggregate.draft.skus.map((s) => s.skuReference).sort());
  assert.equal(snapshot.taxClassificationReference, aggregate.draft.taxClassificationReference);
  const classification = aggregate.draft.categoryClassification;
  assert.equal(snapshot.categoryCoverage, classification === undefined ? "Unavailable" : "Known");
  assert.deepEqual(
    snapshot.categoryReferences,
    classification === undefined ? null : [...classification.categoryReferences].sort(),
  );
  assert.equal(snapshot.primaryCategoryReference, classification?.primaryCategoryReference ?? null);
  assert.deepEqual(
    snapshot.bindings,
    aggregate.draft.optionBindings
      .map((b) => ({
        bindingReference: b.bindingReference,
        optionSetReference: b.optionSetReference,
        optionSetVersionReference: b.optionSetVersionReference,
        enabledOptionReferences: [...b.enabledOptionReferences].sort(),
        includedSkuReferences: [...b.includedSkuReferences].sort(),
        excludedSkuReferences: [...b.excludedSkuReferences].sort(),
        channelCodes: [...b.channelCodes].sort(),
      }))
      .sort((a, b) => a.bindingReference.localeCompare(b.bindingReference)),
  );
  assert.equal(JSON.stringify(snapshot).includes("localizedNames"), false);
  assert.equal(JSON.stringify(snapshot).includes("createdByActorReference"), false);
  assert.equal(JSON.stringify(snapshot).includes("unitQuantity"), false);
  assert.equal((await store.loadSnapshot(request)).digest, snapshot.digest);
  deniedAt = holds + 1;
  await assert.rejects(store.loadSnapshot(request), { code: "CATALOG_PERMISSION_DENIED" });
  deniedAt = holds + 2;
  await assert.rejects(store.loadSnapshot(request), { code: "CATALOG_PERMISSION_DENIED" });
  deniedAt = 0;
  assert.equal((await store.loadSnapshot(request)).digest, snapshot.digest);
  const absent = "01902409-ffff-7000-8000-ffffffffffff";
  await assert.rejects(
    store.loadSnapshot({ ...request, originalProductVersionReference: absent }),
    { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
  );
  await assert.rejects(store.loadSnapshot({ ...request, productReference: absent }), {
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  await assert.rejects(store.loadSnapshot({ ...request, skuReference: absent }), {
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  if (snapshot.skuReferences.length)
    assert.deepEqual(
      (await store.loadSnapshot({ ...request, skuReference: snapshot.skuReferences[0] }))
        .skuReferences,
      snapshot.skuReferences,
    );
  // Callback holder pins the original Product intent through supported owner writer preparation.
  const competitor = createPostgresProductCreationStore({
    brandReference: request.brandReference,
    authorize: async () => true,
    transactions: {
      run: (work) =>
        transactions.run(async (tx) => {
          await tx.query("SET LOCAL lock_timeout='100ms'", []);
          return work(tx);
        }),
    },
  });
  const prepare = () =>
    competitor.codeAvailable({
      brandReference: request.brandReference,
      productCode: "SYNTHETIC_HELD_REFERENCE",
      skuCodes: [],
      excludingProductReference: null,
    });
  const beforeHeld = holds;
  const marker = Object.freeze({ held: true });
  assert.equal(
    await store.withCurrentSnapshot(request, async (held) => {
      assert.equal(held.digest, snapshot.digest);
      assert.equal(holds - beforeHeld, 2);
      await assert.rejects(prepare(), { code: "55P03" });
      return marker;
    }),
    marker,
  );
  assert.equal(holds - beforeHeld, 3);
  assert.equal(await prepare(), true); // Fence was released on COMMIT.
  // Version/state/count are source facts, not caller assertions accepted by a holder.
  for (const changed of [
    { expectedAggregateVersion: request.expectedAggregateVersion + 1 },
    { activeSkuCount: request.activeSkuCount + 1 },
    {
      beforeLifecycle: request.beforeLifecycle === "Draft" ? "Suspended" : "Draft",
      targetLifecycle: "Archived",
    },
  ]) {
    let called = false;
    await assert.rejects(
      store.withCurrentSnapshot({ ...request, ...changed }, async () => {
        called = true;
      }),
      { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
    );
    assert.equal(called, false);
  }
  const sku = aggregate.draft.skus[0];
  if (sku) {
    const skuRequest = {
      ...request,
      skuReference: sku.skuReference,
      beforeLifecycle: sku.lifecycle,
      targetLifecycle: sku.lifecycle === "Archived" ? "Draft" : "Archived",
    };
    const value = await store.withCurrentSnapshot(skuRequest, async (held) => {
      assert(held.request.skuReference === sku.skuReference);
      return marker;
    });
    assert.equal(value, marker);
  }
  deniedAt = holds + 3;
  await assert.rejects(
    store.withCurrentSnapshot(request, async () => marker),
    { code: "CATALOG_PERMISSION_DENIED" },
  );
  deniedAt = 0;
  return snapshot;
}
