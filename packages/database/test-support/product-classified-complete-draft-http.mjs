import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createProductCommandClient } from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
import {
  CatalogError,
  productCategoryAssignmentFields,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "../../rms/catalog/src/index.ts";

// Uses milestone103's actual initial native Create history; no fabricated Product
// identity or source facts. Independent field/phase/screen policies are synthetic.
export async function exerciseClassifiedCompleteProductDraft({
  admin,
  id,
  editorSession,
  httpAt,
  original,
  runtimeOptions,
}) {
  const productReference = original.productReference,
    operationReference = id(96901),
    path = "/merchant/catalog/products/draft";
  let clock = new Date(Date.parse(httpAt) + 120000).toISOString(),
    mode = "normal",
    policyAllowed = true,
    observedTentative = false;
  const at = clock;
  const command = {
    productReference,
    operationReference,
    expectedAggregateVersion: 1,
    draft: {
      ...original.draft,
      localizedNames: { "en-CA": "Synthetic classified complete Draft saved" },
      editorContent: {
        ...original.draft.editorContent,
        localizedDescriptions: { "en-CA": "Synthetic classified full Draft change" },
      },
    },
  };
  const options = {
    ...runtimeOptions,
    productCreation: undefined,
    persistence: { ...editorSession.persistence, now: () => clock },
    productDraft: {
      auditReference: (operation) => (operation === operationReference ? id(96902) : id(96904)),
      writeAuthority: async (_tx, input) => {
        assert.equal(input.productReference, productReference);
        assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
        assert.equal(input.action, "ReplaceDraft");
        assert.equal(input.actionPermission, "catalog.product.update");
        assert.equal(input.brandReference, id(2));
        assert.equal(input.storeReference, id(20));
        return "Allowed";
      },
      editorContentAuthority: async (tx, input) => {
        assert.equal(input.tenantReference, id(1));
        assert.equal(input.brandReference, id(2));
        assert.equal(input.storeReference, id(20));
        assert.equal(input.actorReference, id(3));
        assert.equal(input.productReference, productReference);
        assert.equal(input.purposeCode, "CATALOG_PRODUCT_DRAFT_REPLACE");
        assert.deepEqual(input.requiredFields, productEditorContentFields);
        assert.deepEqual(
          input.requiredReferenceChecks,
          input.mode === "Read" ? [] : productEditorContentReferenceChecks,
        );
        assert.equal(Date.parse(input.validUntil) - Date.parse(input.observedAt), 5000);
        const root = (
          await tx.query("SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1", [
            productReference,
          ])
        ).rows[0].aggregate_version;
        if (mode !== "normal" && !observedTentative && root === 2) {
          observedTentative = true;
          if (mode === "late-ref-permission")
            await tx.query(
              "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
              [id(96420)],
            );
          if (mode === "late-policy") policyAllowed = false;
          if (mode === "late-expiry") clock = input.validUntil;
        }
      },
      categoryPolicy: async (_tx, input) => {
        assert.equal(input.tenantReference, id(1));
        assert.equal(input.brandReference, id(2));
        assert.equal(input.actorReference, id(3));
        assert.equal(input.productReference, productReference);
        assert.equal(input.permission, "catalog.product.manage");
        assert.equal(input.referencedPermission, "catalog.manage");
        assert.deepEqual(input.requiredFields, productCategoryAssignmentFields);
        if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return { allowedLifecycles: ["Draft"] };
      },
    },
  };
  const tables = (
    await admin.query(
      "SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema=ANY($1::text[]) ORDER BY table_schema,table_name",
      [["rms_catalog", "platform_audit", "platform_eventing", "bop_permission"]],
    )
  ).rows;
  const state = async () => {
    const result = {};
    for (const { table_schema: schema, table_name: table } of tables) {
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
      result[schema + "." + table] = createHash("sha256")
        .update(JSON.stringify(rows))
        .digest("hex");
    }
    return result;
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.sku WHERE product_id=$1) skus,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
        [productReference],
      )
    ).rows[0];
  const initial = await counts();
  assert.equal(initial.root, 1);
  assert.equal(initial.skus, 0);
  const scope = { brandReference: id(2), storeReference: id(20) };
  const missing = createMerchantRuntime({
    ...options,
    productDraft: { ...options.productDraft, categoryPolicy: undefined },
  });
  await withProductPublicationHttp(
    undefined,
    editorSession,
    scope,
    async (post) => {
      const before = await state();
      assert.equal((await post(command, {}, path)).status, 503);
      assert.deepEqual(await state(), before);
    },
    { productDraft: missing.productDraft },
  );
  const native = createMerchantRuntime(options);
  await withProductPublicationHttp(
    undefined,
    editorSession,
    scope,
    async (post) => {
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [id(96420)],
      );
      let before = await state();
      assert.equal((await post(command, {}, path)).status, 403);
      assert.deepEqual(await state(), before);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [id(96420)],
      );
      for (const [failure, status] of [
        ["late-ref-permission", 403],
        ["late-policy", 403],
        ["late-expiry", 503],
      ]) {
        mode = failure;
        policyAllowed = true;
        clock = at;
        observedTentative = false;
        before = await state();
        assert.equal((await post(command, {}, path)).status, status);
        assert.equal(observedTentative, true);
        assert.deepEqual(await state(), before);
      }
      mode = "normal";
      policyAllowed = true;
      clock = at;
      let loseReply = true;
      const bodies = [];
      const fetcher = async (url, request) => {
        assert.equal(url, path);
        bodies.push(request.body);
        const headers = new globalThis.Headers(request.headers);
        const reply = await post(
          JSON.parse(request.body),
          {
            "x-bop-csrf": headers.get("x-bop-csrf"),
            "x-bop-catalog-scope": headers.get("x-bop-catalog-scope"),
          },
          url,
        );
        if (loseReply) {
          assert.equal(reply.status, 200);
          loseReply = false;
          throw new TypeError("SYNTHETIC_REPLY_LOST_AFTER_NATIVE_SAVE_COMMIT");
        }
        return new globalThis.Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": reply.contentType, "cache-control": reply.cacheControl },
        });
      };
      const client = createProductCommandClient(fetcher),
        pending = client.prepareDraft(command, scope);
      await assert.rejects(pending.execute(editorSession.csrf), { code: "OutcomeUnknown" });
      const after = await counts();
      assert.equal(after.root, 2);
      assert.equal(after.skus, 0);
      for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
        assert.equal(after[key], initial[key] + 1);
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
      clock = new Date(Date.parse(at) + 60000).toISOString();
      before = await state();
      const replay = await pending.execute(editorSession.csrf);
      assert.equal(replay.status, "AlreadyApplied");
      assert.equal(replay.aggregateVersion, 2);
      assert.deepEqual(replay.draft.categoryClassification, original.draft.categoryClassification);
      assert.deepEqual(replay.draft.editorContent, command.draft.editorContent);
      assert.ok(bodies.length >= 3 && bodies.every((body) => body === bodies[0]));
      assert.deepEqual(await state(), before);
      const emptyCommand = {
        ...command,
        operationReference: id(96903),
        expectedAggregateVersion: 2,
        draft: {
          ...replay.draft,
          categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
        },
      };
      const empty = await client.prepareDraft(emptyCommand, scope).execute(editorSession.csrf);
      assert.equal(empty.status, "Applied");
      assert.equal(empty.aggregateVersion, 3);
      assert.deepEqual(
        empty.draft.categoryClassification,
        emptyCommand.draft.categoryClassification,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_catalog.product_version_category_assignment WHERE product_id=$1",
            [productReference],
          )
        ).rows[0].n,
        0,
      );
      before = await state();
      const originalSave = await pending.execute(editorSession.csrf);
      assert.deepEqual(originalSave, replay);
      assert.equal(originalSave.aggregateVersion, 2);
      assert.equal(bodies.at(-1), bodies[0]);
      assert.deepEqual(await state(), before);
      const final = await counts();
      assert.equal(final.root, 3);
      for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
        assert.equal(final[key], after[key] + 1);
    },
    { productDraft: native.productDraft },
  );
}
