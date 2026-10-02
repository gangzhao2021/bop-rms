import { exerciseProductReferenceHistorySource } from "./product-reference-history-source.mjs";
import { exerciseProductPricingReferenceMatches } from "./product-pricing-reference-matches.mjs";
import { exerciseProductPricingBindingSource } from "./product-pricing-binding-source.mjs";
import { createProductCommandClient } from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
import { withProductCreationHttp } from "../../../apps/api/test-support/product-creation-http.mjs";
import assert from "node:assert/strict";
import { sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createPostgresProductDraftStore,
  createPostgresProductDraftBaselineStore,
  CatalogError,
  productDraftBaselineFields,
  productDraftBaselineReferencedFields,
} from "../../rms/catalog/src/index.ts";

export async function exerciseProductDraftReplacement({
  admin,
  role,
  transactions,
  productReference,
  id,
  at,
  setAuditFailure,
  auditFailureCount,
  draftCommand,
  setNow,
  setPermission,
}) {
  for (const table of [
    "sku",
    "product_option_binding",
    "product_option_binding_option",
    "product_option_binding_sku_scope",
    "product_option_binding_channel",
  ])
    await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog." + table + " TO " + role);
  await admin.query("GRANT UPDATE ON rms_catalog.product_version TO " + role);
  const names = JSON.stringify({ "en-CA": "Synthetic draft option" });
  await admin.query(
    "INSERT INTO rms_catalog.option_set(option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'DRAFT_OPTIONS','Draft',1,$3,$4,$3)",
    [id(800), id(1), at, id(2)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,display_style,minimum_selection,maximum_selection,allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,'{}'::jsonb,'Quantity',0,3,true,3,3,$5,$5)",
    [id(801), id(800), id(1), names, at],
  );
  await admin.query(
    "INSERT INTO rms_catalog.option(option_id,option_set_version_id,option_set_id,brand_id,stable_code,lifecycle,localized_names_json,localized_descriptions_json,sort_order,default_eligible,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'DRAFT_OPTION','Active',$5::jsonb,'{}'::jsonb,0,true,$6,$7)",
    [id(802), id(801), id(800), id(1), names, at, id(2)],
  );
  let allowed = true;
  const store = createPostgresProductDraftStore({
    brandReference: id(1),
    transactions,
    authorize: async () => allowed,
  });
  const original = await store.load(productReference);
  assert.ok(original);
  const instant = (offset) =>
    new Date(Date.parse(original.updatedAt) + offset * 1000).toISOString();
  const prepare = (aggregate, n) => ({
    expectedAggregateVersion: aggregate.aggregateVersion - 1,
    record: {
      action: "ReplaceDraft",
      operationReference: id(n),
      operationIntentHash: sha256Hex(JSON.stringify(aggregate)),
      aggregate,
    },
    audit: {
      auditId: id(n + 10000),
      brandId: id(1),
      actor: { type: "User", reference: id(2) },
      actionCode: "CATALOG_PRODUCT_REPLACEDRAFT",
      targetType: "CatalogProduct",
      targetId: productReference,
      occurredAt: aggregate.updatedAt,
      correlationId: id(n),
      sourceChannel: "MERCHANT_WEB",
      reasonCode: "SYNTHETIC_DRAFT_UPDATE",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  const snapshotCounts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,(SELECT count(*)::int FROM platform_audit.audit_record) audits",
      )
    ).rows[0];
  const binding = {
    bindingReference: id(803),
    optionSetReference: id(800),
    optionSetVersionReference: id(801),
    purpose: "CHOICE",
    sortOrder: 0,
    enabledOptionReferences: [id(802)],
    defaultSelections: [{ optionReference: id(802), quantity: 2 }],
    minimumSelectionOverride: 0,
    maximumSelectionOverride: 3,
    includedSkuReferences: [original.draft.skus[0].skuReference],
    excludedSkuReferences: [original.draft.skus[1].skuReference],
    channelCodes: ["QR", "WEB"],
    storeOverrideAllowed: false,
  };
  const first = prepare(
    {
      ...original,
      aggregateVersion: original.aggregateVersion + 1,
      updatedAt: instant(1),
      draft: {
        ...original.draft,
        updatedAt: instant(1),
        localizedNames: { "en-CA": "Updated draft" },
        taxClassificationReference: id(804),
        skus: original.draft.skus.map((sku, index) => ({
          ...sku,
          localizedNames: { "en-CA": "Updated " + index },
          variantSelections: original.draft.skus[1 - index].variantSelections,
        })),
        optionBindings: [binding],
      },
    },
    700,
  );
  const before = await snapshotCounts();
  for (const lifecycle of ["Active", "Suspended", "Discontinued", "Archived"]) {
    const malformed = {
      ...first,
      record: {
        ...first.record,
        aggregate: {
          ...first.record.aggregate,
          draft: {
            ...first.record.aggregate.draft,
            skus: first.record.aggregate.draft.skus.map((sku) => ({ ...sku, lifecycle })),
          },
        },
      },
    };
    await assert.rejects(store.commit(malformed), { code: "CATALOG_INPUT_INVALID" });
    assert.deepEqual(await store.load(productReference), original);
    assert.deepEqual(await snapshotCounts(), before);
  }
  const failuresBefore = auditFailureCount();
  setAuditFailure(true);
  await assert.rejects(store.commit(first), /synthetic failure after actual Audit insert/);
  setAuditFailure(false);
  assert.equal(auditFailureCount(), failuresBefore + 1, "failure reached actual Audit insert");
  assert.deepEqual(await store.load(productReference), original);
  assert.deepEqual(await snapshotCounts(), before);
  const result = await store.commit(first);
  assert.deepEqual(result, first.record);
  const loaded = await store.load(productReference);
  assert.equal(loaded.draft.taxClassificationReference, id(804));
  assert.deepEqual(loaded.draft.optionBindings, [binding]);
  const catalogPricingBindings = await exerciseProductPricingBindingSource({
    transactions,
    aggregate: loaded,
    tenantReference: id(904),
  });
  const history = await exerciseProductReferenceHistorySource({
    transactions,
    aggregate: loaded,
    tenantReference: id(904),
    expectedAggregates: [original, loaded],
  });
  assert.equal(history.configurations.length, 2);
  assert.ok(
    history.recordedAggregateVersion > history.configurations.length,
    "lifecycle-only history is deduplicated",
  );
  const pricingSources = await exerciseProductPricingReferenceMatches({
    admin,
    role,
    transactions,
    catalog: catalogPricingBindings,
    tenantReference: id(904),
    id,
  });
  assert.equal(
    loaded.draft.skus.find((s) => s.skuReference === original.draft.skus[0].skuReference)
      .unitQuantity,
    original.draft.skus[0].unitQuantity,
  );
  // Actual current reader, restricted role/forced RLS and complete nonempty Draft.
  // Parent/field authority is a synthetic lease; no production entitlement evidence.
  let baselineAllowed = true,
    denyBaselineAtCommit = false,
    baselineChecks = 0;
  const baselineClock = { now: () => loaded.updatedAt };
  const baselineAuthority = {
    async holdUntilTransactionCompletes(_tx, input) {
      baselineChecks++;
      assert.equal(input.tenantReference, id(9000));
      assert.equal(input.brandReference, id(1));
      assert.equal(input.actorReference, id(2));
      assert.equal(input.purposeCode, "CATALOG_PRODUCT_DRAFT_BASELINE_READ");
      assert.equal(input.permission, "catalog.manage");
      assert.equal(input.action, "catalog.product.manage");
      assert.equal(input.capability, "catalog.cat_product_edit");
      assert.deepEqual(input.requiredFields, productDraftBaselineFields);
      assert.deepEqual(input.referencedFields, productDraftBaselineReferencedFields);
      if (!baselineAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
  };
  const baselineOptions = {
    tenantReference: id(9000),
    brandReference: id(1),
    actorReference: id(2),
    transactions: {
      run: (work) =>
        transactions.run(async (tx) => {
          const value = await work(tx);
          if (denyBaselineAtCommit) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          return value;
        }),
    },
    authority: baselineAuthority,
    clock: baselineClock,
    maximumSkus: 100,
    maximumOptionBindings: 100,
  };
  const baselineStore = createPostgresProductDraftBaselineStore(baselineOptions);
  const currentBaseline = await baselineStore.loadBaseline(productReference);
  assert.equal(baselineChecks, 3);
  assert.equal(currentBaseline.aggregateVersion, loaded.aggregateVersion);
  assert.equal(currentBaseline.classificationCoverage, "Unavailable");
  assert.deepEqual(currentBaseline.draft, loaded.draft);
  assert.equal(currentBaseline.draft.skus.length, 2);
  assert.deepEqual(currentBaseline.draft.optionBindings, [binding]);
  assert.ok(Object.isFrozen(currentBaseline.draft.optionBindings[0].defaultSelections));
  assert.equal(await baselineStore.loadBaseline(id(9999)), null);
  await assert.rejects(
    createPostgresProductDraftBaselineStore({ ...baselineOptions, maximumSkus: 1 }).loadBaseline(
      productReference,
    ),
    { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
  );
  baselineAllowed = false;
  await assert.rejects(baselineStore.loadBaseline(productReference), {
    code: "CATALOG_PERMISSION_DENIED",
  });
  baselineAllowed = true;
  denyBaselineAtCommit = true;
  await assert.rejects(baselineStore.loadBaseline(productReference), {
    code: "CATALOG_PERMISSION_DENIED",
  });
  denyBaselineAtCommit = false;
  assert.deepEqual(await store.commit(first), result);
  assert.deepEqual(await snapshotCounts(), {
    snapshots: before.snapshots + 1,
    audits: before.audits + 1,
  });
  const second = prepare(
    {
      ...loaded,
      aggregateVersion: loaded.aggregateVersion + 1,
      updatedAt: instant(2),
      draft: {
        ...loaded.draft,
        updatedAt: instant(2),
        optionBindings: [],
        skus: [
          loaded.draft.skus[0],
          {
            ...loaded.draft.skus[1],
            skuReference: id(810),
            skuCode: "DRAFT_NEW_SKU",
            unitQuantity: "2",
            createdAt: instant(2),
            createdByActorReference: id(2),
          },
        ],
      },
    },
    701,
  );
  await store.commit(second);
  await pricingSources.recheckRecordedHistory(3);
  await pricingSources.recheckHeldCurrentReferences(await store.load(productReference));
  assert.equal(
    (await store.load(productReference)).draft.skus.some((s) => s.skuReference === id(810)),
    true,
  );
  assert.deepEqual(await store.resolveOperation(id(700)), result);
  assert.deepEqual(await store.commit(first), result);
  const beforeHistoryRead = await snapshotCounts();
  assert.deepEqual(
    await store.loadAggregateVersion(productReference, original.aggregateVersion),
    original,
  );
  assert.deepEqual(
    await store.loadAggregateVersion(productReference, loaded.aggregateVersion),
    loaded,
  );
  const nowStored = await store.load(productReference);
  assert.deepEqual(
    await store.loadAggregateVersion(productReference, nowStored.aggregateVersion),
    second.record.aggregate,
  );
  assert.equal(await store.loadAggregateVersion(productReference, 999), null);
  assert.equal(await store.loadAggregateVersion(id(9999), 1), null);
  allowed = false;
  await assert.rejects(store.loadAggregateVersion(productReference, 1), {
    code: "CATALOG_PERMISSION_DENIED",
  });
  allowed = true;
  let historyChecks = 0;
  const lateDeniedReader = createPostgresProductDraftStore({
    brandReference: id(1),
    transactions,
    authorize: async () => ++historyChecks !== 3,
  });
  await assert.rejects(lateDeniedReader.loadAggregateVersion(productReference, 1), {
    code: "CATALOG_PERMISSION_DENIED",
  });
  assert.equal(historyChecks, 3);
  assert.deepEqual(await snapshotCounts(), beforeHistoryRead);
  assert.deepEqual(await store.load(productReference), nowStored);
  const latest = await store.load(productReference);
  baselineClock.now = () => latest.updatedAt;
  const newerBaseline = await baselineStore.loadBaseline(productReference);
  assert.equal(newerBaseline.aggregateVersion, latest.aggregateVersion);
  assert.deepEqual(newerBaseline.draft, latest.draft);
  assert.notEqual(newerBaseline.aggregateVersion, currentBaseline.aggregateVersion);
  assert.deepEqual(currentBaseline.draft.optionBindings, [binding]);
  const change = (n, name) =>
    prepare(
      {
        ...latest,
        aggregateVersion: latest.aggregateVersion + 1,
        updatedAt: instant(3),
        draft: { ...latest.draft, updatedAt: instant(3), localizedNames: { "en-CA": name } },
      },
      n,
    );
  const raced = await Promise.allSettled([
    store.commit(change(702, "First")),
    store.commit(change(703, "Second")),
  ]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(raced.find((r) => r.status === "rejected").reason.code, "CATALOG_VERSION_CONFLICT");
  await assert.rejects(
    store.commit({ ...first, record: { ...first.record, operationIntentHash: "a".repeat(64) } }),
    { code: "CATALOG_IDEMPOTENCY_CONFLICT" },
  );

  for (const table of ["option_set", "option_set_version", "option", "option_conflict"])
    await admin.query("GRANT SELECT,UPDATE ON rms_catalog." + table + " TO " + role);
  const httpBase = await store.load(productReference);
  setNow(instant(10));
  await withProductCreationHttp(
    undefined,
    async (post, fetcher, csrf) => {
      const command = {
        productReference,
        expectedAggregateVersion: httpBase.aggregateVersion,
        operationReference: id(720),
        draft: {
          ...httpBase.draft,
          localizedNames: { "en-CA": "HTTP saved draft" },
          optionBindings: first.record.aggregate.draft.optionBindings.map((binding) => ({
            ...binding,
            includedSkuReferences: [],
            excludedSkuReferences: [],
          })),
        },
      };
      const route = "/merchant/catalog/products/draft";
      const client = createProductCommandClient(fetcher);
      const prepared = client.prepareDraft(command, {
        brandReference: id(1),
        storeReference: id(5),
      });
      const saved = { status: 200, body: await prepared.execute(csrf) };
      assert.deepEqual(
        saved.body.draft.skus.map((sku) => sku.variantSelections),
        command.draft.skus.map((sku) => sku.variantSelections),
      );
      assert.deepEqual(saved.body.draft.optionBindings, command.draft.optionBindings);
      assert.ok(Object.isFrozen(saved.body.draft.optionBindings[0].defaultSelections));
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.status, "Applied");
      assert.equal(saved.body.draft.optionBindings[0].defaultSelections[0].quantity, 2);
      assert.equal(
        (await store.load(productReference)).draft.localizedNames["en-CA"],
        "HTTP saved draft",
      );
      const counts = await snapshotCounts();
      assert.deepEqual(await prepared.execute(csrf), { ...saved.body, status: "AlreadyApplied" });
      assert.deepEqual(await snapshotCounts(), counts);
      setNow(instant(20));
      assert.deepEqual(await post(command, route), {
        status: 200,
        body: { ...saved.body, status: "AlreadyApplied" },
      });
      assert.deepEqual(await snapshotCounts(), counts);
      assert.equal((await post({ ...command, brandReference: id(99) }, route)).status, 400);
      assert.equal(
        (
          await post(
            {
              ...command,
              draft: { ...command.draft, localizedNames: { "en-CA": "changed intent" } },
            },
            route,
          )
        ).status,
        409,
      );
      const badBinding = {
        ...command,
        operationReference: id(721),
        expectedAggregateVersion: saved.body.aggregateVersion,
        draft: {
          ...saved.body.draft,
          optionBindings: saved.body.draft.optionBindings.map((b) => ({
            ...b,
            optionSetVersionReference: id(999),
          })),
        },
      };
      assert.equal((await post(badBinding, route)).status, 403);
      assert.deepEqual(await snapshotCounts(), counts);
      const nextCommand = {
        ...command,
        operationReference: id(722),
        expectedAggregateVersion: saved.body.aggregateVersion,
        draft: {
          ...saved.body.draft,
          skus: [
            ...saved.body.draft.skus,
            {
              ...saved.body.draft.skus[0],
              skuReference: id(822),
              skuCode: "HTTP_DRAFT_NEW",
              lifecycle: "Draft",
              variantSelections: [{ dimensionReference: id(850), valueReference: id(851) }],
              createdAt: at,
              createdByActorReference: id(999),
            },
          ],
        },
      };
      const nextPrepared = client.prepareDraft(nextCommand, {
        brandReference: id(1),
        storeReference: id(5),
      });
      const nextSaved = { status: 200, body: await nextPrepared.execute(csrf) };
      assert.equal(nextSaved.status, 200, JSON.stringify(nextSaved.body));
      const newSku = nextSaved.body.draft.skus.find((sku) => sku.skuReference === id(822));
      assert.equal(newSku.createdAt, instant(20));
      assert.equal(newSku.createdByActorReference, id(2));
      const nextCounts = await snapshotCounts();
      setNow(instant(30));
      assert.deepEqual(await post(nextCommand, route), {
        status: 200,
        body: { ...nextSaved.body, status: "AlreadyApplied" },
      });
      assert.deepEqual(await post(command, route), {
        status: 200,
        body: { ...saved.body, status: "AlreadyApplied" },
      });
      assert.deepEqual(await snapshotCounts(), nextCounts);
      setPermission(false);
      assert.equal((await post(command, route)).status, 403);
      setPermission(true);
    },
    draftCommand,
    { brandReference: id(1), storeReference: id(5) },
  );
  allowed = false;
  await assert.rejects(store.commit(first), { code: "CATALOG_PERMISSION_DENIED" });
  await assert.rejects(store.resolveOperation(id(700)), { code: "CATALOG_PERMISSION_DENIED" });
}
