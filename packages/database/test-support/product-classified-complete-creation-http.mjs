import { exerciseCurrentPolicyProductDraft } from "./product-current-policy-draft-http.mjs";
import { exerciseCurrentVariantProductDraft } from "./product-current-variant-draft-http.mjs";
import { exerciseCurrentRegistryProductDraft } from "./product-current-registry-draft-http.mjs";
import assert from "node:assert/strict";
import { exerciseClassifiedCompleteProductDraft } from "./product-classified-complete-draft-http.mjs";
import { createHash } from "node:crypto";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createProductCommandClient } from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
import {
  CatalogError,
  createPostgresCategoryRepository,
  productCategoryAssignmentFields,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "../../rms/catalog/src/index.ts";

// Actual isolated owning Category/Product SQL, native IAM and encrypted-session
// HTTP. Independent Category fields/phase policy and full-content/screen holders
// are synthetic. These tests do not establish publication or real Store facts.
export async function exerciseClassifiedCompleteProductCreation({
  admin,
  role,
  id,
  editorSession,
  httpAt,
  unusedFullEditorConfiguration,
}) {
  assert.match(role, /^wp2421_full_[a-f0-9]+$/);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_catalog.category,rms_catalog.category_source_head TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_catalog.category_operation_record,rms_catalog.category_operation_snapshot,rms_catalog.category_source_commit TO " +
      role,
  );
  let clock = httpAt,
    event = 96820,
    mode = "normal",
    policyAllowed = true,
    observedTentative = false,
    productReference;
  const category = {
    categoryReference: id(96810),
    brandReference: id(2),
    internalCode: "SYNTH_CAT103",
    lifecycle: "Draft",
    aggregateVersion: 1,
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic initial Category" },
    localizedDescriptions: {},
    parentCategoryReference: null,
    level: 1,
    sortOrder: 96810,
    storeReferences: [],
    createdAt: httpAt,
    createdByActorReference: id(3),
    updatedAt: httpAt,
  };
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const categoryOptions = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    transactions: editorSession.persistence.transactions,
    authority: {
      async holdUntilTransactionCompletes(_tx, input) {
        assert.equal(input.tenantReference, id(1));
        assert.equal(input.brandReference, id(2));
        assert.equal(input.actorReference, id(3));
        assert.equal(input.purposeCode, "CATALOG_CATEGORY_PERSISTENCE");
        assert.equal(input.permission, "catalog.manage");
        assert.equal(input.domainPermission, "catalog.category.manage");
      },
    },
    clock: { now: () => clock },
    eventReference: () => id(event++),
    maximumCategoryNodes: 100,
  };
  const categoryWrite = (aggregate, action, operation, auditId) => {
    const record = {
      action,
      operationReference: id(operation),
      operationIntentHash: digest({ action, aggregate }),
      aggregate,
    };
    return {
      record,
      ...(action === "Create" ? {} : { expectedAggregateVersion: aggregate.aggregateVersion - 1 }),
      audit: {
        auditId: id(auditId),
        brandId: id(2),
        actor: { type: "User", reference: id(3) },
        actionCode: "CATALOG_CATEGORY_" + action.toUpperCase(),
        targetType: "CatalogCategory",
        targetId: aggregate.categoryReference,
        reasonCode: "SYNTHETIC_TEST",
        correlationId: record.operationReference,
        occurredAt: aggregate.updatedAt,
        sourceChannel: "API",
        dataClassification: "Internal",
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      },
    };
  };
  await createPostgresCategoryRepository(categoryOptions).create(
    categoryWrite(category, "Create", 96811, 96812),
  );
  const tableNames = (
    await admin.query(
      "SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema=ANY($1::text[]) ORDER BY table_schema,table_name",
      [["rms_catalog", "platform_audit", "platform_eventing", "bop_permission"]],
    )
  ).rows;
  // Digests only: no credentials, sessions, raw payloads or unrestricted IDs in outputs.
  const state = async () => {
    const result = {};
    for (const { table_schema: schema, table_name: table } of tableNames) {
      assert.match(schema, /^[a-z_]+$/);
      assert.match(table, /^[a-z_]+$/);
      const rows = (
        await admin.query(
          'SELECT to_jsonb(t) value FROM "' +
            schema +
            '"."' +
            table +
            '" t ORDER BY to_jsonb(t)::text',
        )
      ).rows;
      result[schema + "." + table] = digest(rows);
    }
    return result;
  };
  const command = {
    operationReference: id(96801),
    internalCode: "SYNTH_CLASSIFIED_CREATE103",
    productType: "PreparedFood",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic classified complete Product" },
    taxClassificationReference: null,
    skus: [],
    categoryClassification: {
      categoryReferences: [category.categoryReference],
      primaryCategoryReference: category.categoryReference,
    },
    editorContent: {
      profile: "CatalogProductEditorContentV1",
      localizedShortDescriptions: { "en-CA": "Synthetic initial short" },
      localizedDescriptions: { "en-CA": "Explicit classified complete content" },
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
  };
  const holder = async (tx, input) => {
    assert.equal(input.tenantReference, id(1));
    assert.equal(input.brandReference, id(2));
    assert.equal(input.storeReference, id(20));
    assert.equal(input.actorReference, id(3));
    assert.equal(input.productReference, productReference);
    assert.equal(input.purposeCode, "CATALOG_PRODUCT_CREATE");
    assert.deepEqual(input.requiredFields, productEditorContentFields);
    assert.deepEqual(
      input.requiredReferenceChecks,
      input.mode === "Read" ? [] : productEditorContentReferenceChecks,
    );
    if (
      !observedTentative &&
      mode !== "normal" &&
      (
        await tx.query("SELECT count(*)::int n FROM rms_catalog.product WHERE product_id=$1", [
          productReference,
        ])
      ).rows[0].n === 1
    ) {
      observedTentative = true;
      if (mode === "late-ref-permission")
        await tx.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [id(96420)],
        );
      if (mode === "late-policy") policyAllowed = false;
      if (mode === "late-expiry") clock = input.validUntil;
      if (mode === "late-category")
        await createPostgresCategoryRepository({
          ...categoryOptions,
          transactions: { run: (work) => work(tx) },
        }).commit(
          categoryWrite(
            { ...category, lifecycle: "Active", aggregateVersion: 2 },
            "ChangeLifecycle",
            96813,
            96814,
          ),
        );
    }
  };
  const policy = async (_tx, input) => {
    assert.equal(input.tenantReference, id(1));
    assert.equal(input.brandReference, id(2));
    assert.equal(input.actorReference, id(3));
    assert.equal(input.productReference, productReference);
    assert.equal(input.permission, "catalog.product.manage");
    assert.equal(input.referencedPermission, "catalog.manage");
    assert.deepEqual(input.requiredFields, productCategoryAssignmentFields);
    assert.deepEqual(input.referencedFields, ["categoryReference", "brandReference", "lifecycle"]);
    if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    // Explicit independent synthetic fixture rule; production has no default policy.
    return { allowedLifecycles: ["Draft"] };
  };
  const runtimeOptions = {
    persistence: { ...editorSession.persistence, now: () => clock },
    exactOrigin: "https://merchant.invalid",
    acceptedHost: "merchant.invalid",
    serviceAudit: {
      reasonCode: "SYNTHETIC_CLASSIFIED_CREATE",
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
    productCreation: {
      auditReference: (operation) =>
        operation === command.operationReference ? id(96802) : id(96805),
      writeAuthority: async (_tx, input) => {
        assert.equal(input.action, "Create");
        assert.equal(input.screenId, "CAT-PRODUCT-CREATE");
        assert.equal(input.brandReference, id(2));
        assert.equal(input.storeReference, id(20));
        assert.equal(input.skuCreationPermission, null);
        productReference = input.productReference;
        return "Allowed";
      },
      editorContentAuthority: holder,
      categoryPolicy: policy,
    },
  };
  const scope = { brandReference: id(2), storeReference: id(20) },
    path = "/merchant/catalog/products";
  const missing = createMerchantRuntime({
    ...runtimeOptions,
    productCreation: { ...runtimeOptions.productCreation, categoryPolicy: undefined },
  });
  await withProductPublicationHttp(
    undefined,
    editorSession,
    scope,
    async (post) => {
      const before = await state();
      assert.equal((await post(command, {}, path)).status, 503);
      assert.equal(
        (
          await post(
            {
              ...command,
              categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
            },
            {},
            path,
          )
        ).status,
        503,
      );
      assert.deepEqual(await state(), before);
    },
    { productCreation: missing.productCreation },
  );
  const native = createMerchantRuntime(runtimeOptions);
  await withProductPublicationHttp(
    undefined,
    editorSession,
    scope,
    async (post) => {
      let before = await state();
      assert.equal(
        (
          await post(
            {
              ...command,
              categoryClassification: {
                categoryReferences: [id(96899)],
                primaryCategoryReference: id(96899),
              },
            },
            {},
            path,
          )
        ).status,
        503,
      );
      assert.deepEqual(await state(), before);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(96420)],
      );
      before = await state();
      assert.equal((await post(command, {}, path)).status, 403);
      assert.deepEqual(await state(), before);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [id(96420)],
      );
      for (const [failure, status] of [
        ["late-ref-permission", 403],
        ["late-category", 409],
        ["late-policy", 403],
        ["late-expiry", 503],
      ]) {
        mode = failure;
        clock = httpAt;
        policyAllowed = true;
        observedTentative = false;
        before = await state();
        assert.equal((await post(command, {}, path)).status, status);
        assert.equal(observedTentative, true);
        assert.deepEqual(await state(), before);
      }
      mode = "normal";
      clock = httpAt;
      policyAllowed = true;
      const bodies = [];
      let loseReply = true;
      const fetcher = async (url, options) => {
        assert.equal(url, path);
        bodies.push(options.body);
        const headers = new globalThis.Headers(options.headers);
        const response = await post(
          JSON.parse(options.body),
          {
            "x-bop-csrf": headers.get("x-bop-csrf"),
            "x-bop-catalog-scope": headers.get("x-bop-catalog-scope"),
          },
          url,
        );
        if (loseReply) {
          assert.equal(response.status, 200);
          loseReply = false;
          throw new TypeError("SYNTHETIC_REPLY_LOST_AFTER_NATIVE_COMMIT");
        }
        return new globalThis.Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { "content-type": response.contentType, "cache-control": response.cacheControl },
        });
      };
      const pending = createProductCommandClient(fetcher).prepareCreate(command, scope);
      await assert.rejects(pending.execute(editorSession.csrf), { code: "OutcomeUnknown" });
      const original = (
        await admin.query(
          "SELECT snapshot_json FROM rms_catalog.product_operation_snapshot WHERE operation_id=$1",
          [command.operationReference],
        )
      ).rows[0].snapshot_json;
      assert.equal(original.aggregateVersion, 1);
      assert.deepEqual(original.draft.skus, []);
      assert.deepEqual(original.draft.categoryClassification, command.categoryClassification);
      assert.deepEqual(original.draft.editorContent, command.editorContent);
      const assignments = await admin.query(
        "SELECT count(*)::int n FROM rms_catalog.product_version_category_assignment WHERE product_id=$1",
        [productReference],
      );
      assert.equal(assignments.rows[0].n, 1);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(96420)],
      );
      before = await state();
      await assert.rejects(pending.execute(editorSession.csrf), { code: "OutcomeUnknown" });
      assert.deepEqual(await state(), before);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [id(96420)],
      );
      clock = new Date(Date.parse(httpAt) + 60000).toISOString();
      before = await state();
      const replay = await pending.execute(editorSession.csrf);
      assert.equal(replay.status, "AlreadyApplied");
      assert.equal(replay.aggregateVersion, 1);
      assert.deepEqual(replay.categoryClassification, command.categoryClassification);
      assert.equal(replay.productReference, productReference);
      assert.ok(bodies.length >= 3 && bodies.every((body) => body === bodies[0]));
      assert.deepEqual(await state(), before);
      const empty = {
        ...command,
        operationReference: id(96804),
        internalCode: "SYNTH_EMPTY_CLASS103",
        categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      };
      const createdEmpty = await createProductCommandClient(fetcher)
        .prepareCreate(empty, scope)
        .execute(editorSession.csrf);
      assert.equal(createdEmpty.status, "Applied");
      assert.equal(createdEmpty.aggregateVersion, 1);
      assert.deepEqual(createdEmpty.categoryClassification, empty.categoryClassification);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_catalog.product_version_category_assignment WHERE product_id=$1",
            [createdEmpty.productReference],
          )
        ).rows[0].n,
        0,
      );
      await exerciseClassifiedCompleteProductDraft({
        admin,
        id,
        editorSession,
        httpAt,
        original,
        runtimeOptions,
      });
      await exerciseCurrentRegistryProductDraft({
        admin,
        id,
        editorSession,
        httpAt,
        original,
        runtimeOptions,
      });
      await exerciseCurrentVariantProductDraft({
        admin,
        id,
        editorSession,
        httpAt,
        runtimeOptions,
      });
      await exerciseCurrentPolicyProductDraft({ admin, role, id, editorSession, runtimeOptions });
    },
    { productCreation: native.productCreation },
  );
}
