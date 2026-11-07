import assert from "node:assert/strict";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createProductCommandClient } from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
import {
  CatalogError,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "../../rms/catalog/src/index.ts";

// Real isolated HTTP/encrypted session/IAM/owning writes. Complete-field/reference
// and screen holders explicitly synthetic; this does not qualify publication.
export async function exerciseCompleteProductCreation({
  admin,
  id,
  editorSession,
  httpAt,
  httpFrom,
  httpUntil,
  unusedFullEditorConfiguration,
}) {
  let permission = (
    await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='catalog.product.create'",
    )
  ).rows[0]?.permission_id;
  if (!permission) {
    permission = id(96700);
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.product.create','Active',1,$2,$2)",
      [permission, httpFrom],
    );
  }
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
    [id(96701), id(96401), permission, id(2), httpFrom, httpUntil],
  );
  const operationReference = id(96702),
    command = {
      operationReference,
      internalCode: "SYNTHETIC_COMPLETE_CREATE99",
      productType: "PreparedFood",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic initial complete Product" },
      taxClassificationReference: null,
      skus: [],
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: { "en-CA": "Synthetic initial short" },
        localizedDescriptions: { "en-CA": "Explicit initial complete content" },
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
  let clock = httpAt,
    mode = "normal",
    observedTentative = false,
    productReference;
  const holder = async (tx, input) => {
    assert.equal(input.tenantReference, id(1));
    assert.equal(input.brandReference, id(2));
    assert.equal(input.storeReference, id(20));
    assert.equal(input.actorReference, id(3));
    assert.equal(input.productReference, productReference);
    assert.deepEqual(input.requiredFields, productEditorContentFields);
    assert.deepEqual(
      input.requiredReferenceChecks,
      input.mode === "Read" ? [] : productEditorContentReferenceChecks,
    );
    assert.equal(Date.parse(input.validUntil) - Date.parse(input.observedAt), 5000);
    const creating = input.operationReference === operationReference;
    assert.equal(
      input.purposeCode,
      creating ? "CATALOG_PRODUCT_CREATE" : "CATALOG_PRODUCT_DRAFT_REPLACE",
    );
    const tentative = (
      await tx.query("SELECT count(*)::int n FROM rms_catalog.product WHERE product_id=$1", [
        productReference,
      ])
    ).rows[0].n;
    if (creating && tentative === 1 && mode !== "normal") {
      observedTentative = true;
      if (mode === "late-fields") throw new CatalogError("CATALOG_PERMISSION_DENIED");
      if (mode === "late-expiry") clock = input.validUntil;
      if (mode === "late-action")
        await tx.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [id(96701)],
        );
    }
  };
  const writeAuthority = async (_tx, input) => {
    assert.equal(input.brandReference, id(2));
    assert.equal(input.storeReference, id(20));
    if (input.action === "Create") {
      assert.equal(input.screenId, "CAT-PRODUCT-CREATE");
      assert.equal(input.skuCreationPermission, null);
      productReference = input.productReference;
    } else {
      assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
      assert.equal(input.productReference, productReference);
    }
    return "Allowed";
  };
  const runtimeOptions = {
    persistence: { ...editorSession.persistence, now: () => clock },
    exactOrigin: "https://merchant.invalid",
    acceptedHost: "merchant.invalid",
    serviceAudit: {
      reasonCode: "SYNTHETIC_FULL_CREATE",
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
      auditReference: () => id(96703),
      writeAuthority,
      editorContentAuthority: holder,
    },
    productDraft: {
      auditReference: () => id(96705),
      writeAuthority,
      editorContentAuthority: holder,
    },
  };
  const native = createMerchantRuntime(runtimeOptions);
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_catalog.product WHERE product_id=$1) products,(SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.sku WHERE product_id=$1) skus,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
        [productReference ?? id(96799)],
      )
    ).rows[0];
  await withProductPublicationHttp(
    undefined,
    editorSession,
    { brandReference: id(2), storeReference: id(20) },
    async (post) => {
      const path = "/merchant/catalog/products";
      const before = await counts();
      for (const failure of ["late-fields", "late-expiry", "late-action"]) {
        mode = failure;
        clock = httpAt;
        observedTentative = false;
        const refused = await post(command, {}, path);
        assert.equal(refused.status, failure === "late-expiry" ? 503 : 403);
        assert.equal(observedTentative, true);
        assert.deepEqual(await counts(), before);
      }
      mode = "normal";
      clock = httpAt;
      const bodies = [];
      let loseReply = true;
      const fetcher = async (url, options) => {
        assert.equal(url, path);
        const body = options.body;
        bodies.push(body);
        const headers = new globalThis.Headers(options.headers);
        const result = await post(
          JSON.parse(body),
          {
            "x-bop-csrf": headers.get("x-bop-csrf"),
            "x-bop-catalog-scope": headers.get("x-bop-catalog-scope"),
          },
          url,
        );
        assert.equal(result.status, 200);
        if (loseReply) {
          loseReply = false;
          throw new TypeError("SYNTHETIC_REPLY_LOST_AFTER_NATIVE_COMMIT");
        }
        return new globalThis.Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": result.contentType, "cache-control": result.cacheControl },
        });
      };
      const pending = createProductCommandClient(fetcher).prepareCreate(command, {
        brandReference: id(2),
        storeReference: id(20),
      });
      await assert.rejects(pending.execute(editorSession.csrf), { code: "OutcomeUnknown" });
      const after = await counts();
      assert.deepEqual(after, {
        products: 1,
        root: 1,
        skus: 0,
        operations: 1,
        snapshots: 1,
        commits: 1,
        audit: 1,
        outbox: 1,
      });
      clock = new Date(Date.parse(httpAt) + 60000).toISOString();
      const replay = await pending.execute(editorSession.csrf);
      assert.equal(replay.status, "AlreadyApplied");
      assert.equal(replay.productReference, productReference);
      assert.deepEqual(replay.skus, []);
      assert.equal(bodies[0], bodies[1]);
      assert.deepEqual(await counts(), after);
      const original = (
        await admin.query(
          "SELECT snapshot_json FROM rms_catalog.product_operation_snapshot WHERE operation_id=$1",
          [operationReference],
        )
      ).rows[0].snapshot_json;
      assert.equal(original.createdAt, httpAt);
      assert.equal(original.draft.createdAt, httpAt);
      assert.deepEqual(original.draft.editorContent, command.editorContent);
      const save = {
        productReference,
        expectedAggregateVersion: 1,
        operationReference: id(96704),
        draft: {
          ...original.draft,
          localizedNames: { "en-CA": "Synthetic complete Product edited after native creation" },
        },
      };
      const saved = await post(save, {}, "/merchant/catalog/products/draft");
      assert.equal(saved.status, 200);
      assert.equal(saved.body.aggregateVersion, 2);
      assert.deepEqual(saved.body.draft.editorContent, command.editorContent);
      assert.deepEqual(saved.body.draft.skus, []);
      const final = await counts();
      assert.equal(final.root, 2);
      for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
        assert.equal(final[key], 2);
      assert.deepEqual((await pending.execute(editorSession.csrf)).skus, []);
      assert.deepEqual(await counts(), final);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(96701)],
      );
      assert.equal((await post(command, {}, path)).status, 403);
      assert.deepEqual(await counts(), final);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [id(96701)],
      );
      assert.deepEqual(await pending.execute(editorSession.csrf), replay);
      assert.deepEqual(await counts(), final);
    },
    { productCreation: native.productCreation, productDraft: native.productDraft },
  );
  const missing = createMerchantRuntime({
    ...runtimeOptions,
    productCreation: { ...runtimeOptions.productCreation, editorContentAuthority: undefined },
  });
  await withProductPublicationHttp(
    undefined,
    editorSession,
    { brandReference: id(2), storeReference: id(20) },
    async (post) => {
      assert.equal((await post(command, {}, "/merchant/catalog/products")).status, 400);
    },
    { productCreation: missing.productCreation },
  );
}
