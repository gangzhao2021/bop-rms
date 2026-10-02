import assert from "node:assert/strict";
import { canonicalizeRfc8785 } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  createPostgresProductCreationStore,
  createPostgresProductReferenceHistorySourceStore,
} from "../../rms/catalog/src/index.ts";
/** Actual immutable owner history SQL; synthetic authority never proves normal IAM or policy approval. */
export async function exerciseProductReferenceHistorySource({
  transactions,
  aggregate,
  tenantReference,
  request: originalRequest,
  expectedAggregates = [aggregate],
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
    reasonCode: "SYNTHETIC_HISTORY_REVIEW",
    activeSkuCount: aggregate.draft.skus.filter((s) => s.lifecycle === "Active").length,
  };
  let holds = 0,
    deniedAt = 0;
  const store = createPostgresProductReferenceHistorySourceStore({
    tenantReference,
    brandReference: aggregate.brandReference,
    actorReference: request.actorReference,
    transactions,
    clock: { now: () => new Date().toISOString() },
    authority: {
      async holdUntilTransactionCompletes(tx, input) {
        void tx;
        assert.equal(input.request.operationReference, request.operationReference);
        assert.equal(input.owningAction, "catalog.product.history.read");
        assert.equal(input.purposeCode, "CATALOG_LIFECYCLE_REFERENCE_HISTORY_READ");
        if (++holds === deniedAt) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
  });
  const snapshot = await store.loadSnapshot(request);
  assert.equal(holds, 2);
  assert.equal(snapshot.recordedAggregateVersion, aggregate.aggregateVersion);
  assert.equal(snapshot.profile, "RecordedDraftConfigurations");
  assert.equal(snapshot.publicationCoverage, "Unavailable");
  assert.equal(snapshot.futureScheduleCoverage, "Unavailable");
  const expected = expectedAggregates.map((a) => ({
    versionReference: a.draft.versionReference,
    skuReferences: a.draft.skus.map((s) => s.skuReference).sort(),
    categoryCoverage: a.draft.categoryClassification === undefined ? "Unavailable" : "Known",
    categoryReferences:
      a.draft.categoryClassification === undefined
        ? null
        : [...a.draft.categoryClassification.categoryReferences].sort(),
    primaryCategoryReference: a.draft.categoryClassification?.primaryCategoryReference ?? null,
    taxClassificationReference: a.draft.taxClassificationReference,
    bindings: a.draft.optionBindings
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
  }));
  assert.deepEqual(
    snapshot.configurations.map(canonicalizeRfc8785).sort(),
    [...new Set(expected.map(canonicalizeRfc8785))].sort(),
  );
  assert.equal(
    /localizedNames|createdByActorReference|unitQuantity|snapshot_json/.test(
      JSON.stringify(snapshot),
    ),
    false,
  );
  assert.equal((await store.loadSnapshot(request)).digest, snapshot.digest);
  deniedAt = holds + 1;
  await assert.rejects(store.loadSnapshot(request), { code: "CATALOG_PERMISSION_DENIED" });
  deniedAt = holds + 2;
  await assert.rejects(store.loadSnapshot(request), { code: "CATALOG_PERMISSION_DENIED" });
  deniedAt = 0;
  assert.equal((await store.loadSnapshot(request)).digest, snapshot.digest);
  const absent = "01902409-ffff-7000-8000-ffffffffffff";
  for (const changed of [
    { productReference: absent },
    { originalProductVersionReference: absent },
    { skuReference: absent },
  ])
    await assert.rejects(store.loadSnapshot({ ...request, ...changed }), {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
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
/** Rollback-only new synthetic root: missing snapshot and malformed nullable field must never become empty coverage. */
export async function exerciseProductReferenceHistoryGap({
  admin,
  role,
  aggregate,
  tenantReference,
  id,
}) {
  assert.match(role, /^wp2409_class_[a-f0-9]+$/u);
  const productReference = id(99001),
    operationReference = id(99002),
    occurredAt = aggregate.updatedAt;
  const broken = JSON.parse(JSON.stringify(aggregate));
  broken.productReference = productReference;
  broken.aggregateVersion = 1;
  for (const sku of broken.draft.skus) sku.productReference = productReference;
  delete broken.draft.taxClassificationReference;
  await admin.query("BEGIN");
  try {
    await admin.query(
      "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) SELECT $1,brand_id,'SYNTHETIC_HISTORY_GAP',product_type,lifecycle,1,created_at,created_by_actor_id,updated_at FROM rms_catalog.product WHERE product_id=$2",
      [productReference, aggregate.productReference],
    );
    await admin.query(
      "INSERT INTO rms_catalog.product_operation_record(operation_id,brand_id,product_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,'Create',$4,1,$5)",
      [
        operationReference,
        aggregate.brandReference,
        productReference,
        "sha256:" + "d".repeat(64),
        occurredAt,
      ],
    );
    const transactions = {
      async run(work) {
        await admin.query("SET LOCAL ROLE " + role);
        return work({ query: (sql, values) => admin.query(sql, [...values]) });
      },
    };
    await assert.rejects(
      exerciseProductReferenceHistorySource({ transactions, aggregate: broken, tenantReference }),
      { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
    );
    await admin.query("RESET ROLE");
    await admin.query(
      "INSERT INTO rms_catalog.product_operation_snapshot(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,1,$4,$5::jsonb)",
      [
        operationReference,
        aggregate.brandReference,
        productReference,
        occurredAt,
        JSON.stringify(broken),
      ],
    );
    await assert.rejects(
      exerciseProductReferenceHistorySource({ transactions, aggregate: broken, tenantReference }),
      { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
    );
  } finally {
    await admin.query("ROLLBACK");
  }
}
