import assert from "node:assert/strict";
import {
  createPostgresProductCreationStore,
  parseProductAggregate,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "../../rms/catalog/src/index.ts";
import { sha256Hex } from "../../bop/audit/src/index.ts";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createCompleteDraftNativeHttpClient } from "./product-complete-draft-client-http.mjs";

// Actual owning creation, native frontend bytes/HTTP, encrypted synthetic session,
// current native IAM and isolated SQL. Field/reference/screen policies are synthetic;
// an empty Draft is not evidence of publication or selling eligibility.
export async function exerciseEmptyProductDraft({
  admin,
  id,
  options,
  original,
  audit,
  editorSession,
  httpAt,
  unusedFullEditorConfiguration,
}) {
  const productReference = id(96600),
    operationReference = id(96603),
    empty = parseProductAggregate({
      ...original,
      productReference,
      internalCode: "SYNTHETIC_EMPTY_DRAFT98",
      draft: {
        ...original.draft,
        versionReference: id(96601),
        skus: [],
        optionBindings: [],
        editorContent: {
          profile: "CatalogProductEditorContentV1",
          localizedShortDescriptions: {},
          localizedDescriptions: {},
          preparationNotes: {},
          tagReferences: [],
          attributeValues: [],
          media: [],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
          allergenReferences: [],
          nutritionProfile: null,
        },
      },
    });
  await createPostgresProductCreationStore({
    ...options,
    editorContentAuthority: {
      async holdUntilTransactionCompletes(_tx, input) {
        assert.deepEqual(input.aggregate, empty);
        assert.deepEqual(input.requiredFields, productEditorContentFields);
        assert.deepEqual(
          input.requiredReferenceChecks,
          input.mode === "Read" ? [] : productEditorContentReferenceChecks,
        );
      },
    },
  }).create({
    record: {
      action: "Create",
      operationReference: id(96602),
      operationIntentHash: sha256Hex("synthetic empty Product initial Draft98"),
      aggregate: empty,
    },
    audit: { ...audit(96602, "CATALOG_PRODUCT_CREATE"), targetId: productReference },
  });
  const native = createMerchantRuntime({
    persistence: { ...editorSession.persistence, now: () => httpAt },
    exactOrigin: "https://merchant.invalid",
    acceptedHost: "merchant.invalid",
    serviceAudit: {
      reasonCode: "SYNTHETIC_EMPTY_DRAFT",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
    configuration: {
      actionPermissions: {
        saveDraft: "store.service.save-draft",
        validate: "store.service.validate",
        submit: "store.service.submit",
        approve: "store.service.approve",
        publish: "store.service.publish",
      },
      configure: unusedFullEditorConfiguration,
      review: {
        validate: unusedFullEditorConfiguration,
        snapshotAudit: unusedFullEditorConfiguration,
      },
    },
    productDraft: {
      auditReference: () => id(96604),
      async writeAuthority(_tx, input) {
        assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
        assert.equal(input.actionPermission, "catalog.product.update");
        assert.equal(input.productReference, productReference);
        assert.equal(input.storeReference, id(20));
        return "Allowed";
      },
      async editorContentAuthority(_tx, input) {
        assert.equal(input.tenantReference, id(1));
        assert.equal(input.brandReference, id(2));
        assert.equal(input.actorReference, id(3));
        assert.equal(input.storeReference, id(20));
        assert.equal(input.productReference, productReference);
        assert.equal(input.operationReference, operationReference);
        assert.equal(input.purposeCode, "CATALOG_PRODUCT_DRAFT_REPLACE");
        assert.deepEqual(input.aggregate.draft.skus, []);
        assert.deepEqual(input.requiredFields, productEditorContentFields);
        assert.deepEqual(
          input.requiredReferenceChecks,
          input.mode === "Read" ? [] : productEditorContentReferenceChecks,
        );
        assert.equal(Date.parse(input.validUntil) - Date.parse(input.observedAt), 5000);
      },
    },
  });
  const command = {
    productReference,
    expectedAggregateVersion: 1,
    operationReference,
    draft: {
      ...empty.draft,
      localizedNames: { "en-CA": "Synthetic empty Draft edited" },
      editorContent: {
        ...empty.draft.editorContent,
        localizedDescriptions: { "fr-CA": "b".repeat(4096), "zh-CN": "茶".repeat(3000) },
      },
    },
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.sku WHERE product_id=$1) skus,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
        [productReference],
      )
    ).rows[0];
  const before = await counts();
  assert.equal(before.root, 1);
  assert.equal(before.skus, 0);
  await withProductPublicationHttp(
    undefined,
    editorSession,
    { brandReference: id(2), storeReference: id(20) },
    async (post) => {
      const scope = { brandReference: id(2), storeReference: id(20) },
        execute = createCompleteDraftNativeHttpClient({
          post,
          command,
          scope,
          csrf: editorSession.csrf,
        }),
        applied = await execute();
      assert.equal(applied.status, 200);
      assert.equal(applied.body.status, "Applied");
      assert.equal(applied.body.aggregateVersion, 2);
      assert.deepEqual(applied.body.draft.skus, []);
      const after = await counts();
      assert.equal(after.root, 2);
      assert.equal(after.skus, 0);
      for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
        assert.equal(after[key], before[key] + 1);
      const replay = await execute();
      assert.equal(replay.body.status, "AlreadyApplied");
      assert.deepEqual({ ...replay.body, status: "Applied" }, applied.body);
      assert.deepEqual(await counts(), after);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(96423)],
      );
      assert.equal((await post(command, {}, "/merchant/catalog/products/draft")).status, 403);
      assert.deepEqual(await counts(), after);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [id(96423)],
      );
      assert.deepEqual((await execute()).body, replay.body);
      assert.deepEqual(await counts(), after);
    },
    { productDraft: native.productDraft },
  );
}
