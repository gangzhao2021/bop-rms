import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createProductCommandClient } from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
import {
  CatalogError,
  contentRegistryFields,
  productVariantHistoryFields,
  parseProductAggregate,
} from "../../rms/catalog/src/index.ts";
import { remainingProductEditorVariantReferenceChecks } from "../../../apps/api/src/merchant-product-editor-variant-content-authority.ts";

// Owning canonical Variant history, current registry, native IAM/HTTP are actual local sources.
// Independent registry/history fields and remaining-five/phase/write authority are synthetic.
export async function exerciseCurrentVariantProductDraft({
  admin,
  id,
  editorSession,
  httpAt,
  runtimeOptions,
}) {
  const product = id(600),
    grant = id(97101);
  let permission = (
    await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='catalog.product.history.read'",
    )
  ).rows[0]?.permission_id;
  if (!permission) {
    permission = id(97100);
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.product.history.read','Active',1,$2,$2)",
      [permission, httpAt],
    );
  }
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
    [
      grant,
      id(96401),
      permission,
      id(2),
      httpAt,
      new Date(Date.parse(httpAt) + 3600000).toISOString(),
    ],
  );
  const recorded = parseProductAggregate(
    (
      await admin.query(
        "SELECT snapshot_json FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 AND product_id=$2 AND result_aggregate_version=8",
        [id(2), product],
      )
    ).rows[0].snapshot_json,
  );
  assert.equal(recorded.aggregateVersion, 8);
  const command = {
    productReference: product,
    operationReference: id(97102),
    expectedAggregateVersion: 8,
    draft: {
      ...recorded.draft,
      editorContent: {
        ...recorded.draft.editorContent,
        localizedDescriptions: {
          ...recorded.draft.editorContent.localizedDescriptions,
          "en-CA": "Synthetic native current Variant-history Draft",
        },
      },
    },
  };
  let clockOverride = null,
    mode = "normal",
    policyAllowed = true,
    tentative = false,
    historyHolds = 0;
  let originalDeadline;
  const historyRoots = new Set();
  const observedRoots = new Set();
  const now = () => clockOverride ?? new Date().toISOString();
  const options = {
    ...runtimeOptions,
    productCreation: undefined,
    persistence: { ...editorSession.persistence, now },
    productDraft: {
      auditReference: () => id(97103),
      writeAuthority: async () => "Allowed",
      categoryPolicy: async () => ({ allowedLifecycles: ["Draft"] }),
      registeredEditorContent: {
        registryAuthority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.tenantReference, id(1));
            assert.equal(input.brandReference, id(2));
            assert.equal(input.actorReference, id(3));
            assert.equal(input.action, "catalog.content-registry.read");
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_CONTENT_REGISTRY");
            assert.deepEqual(input.requiredFields, contentRegistryFields);
          },
        },
        variantHistory: {
          authority: {
            async holdUntilTransactionCompletes(tx, input) {
              historyHolds++;
              historyRoots.add(input.request.expectedAggregateVersion);
              assert.equal(input.tenantReference, id(1));
              assert.equal(input.brandReference, id(2));
              assert.equal(input.actorReference, id(3));
              assert.equal(input.permission, "catalog.product.history.read");
              assert.equal(input.purposeCode, "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY");
              assert.deepEqual(input.requiredFields, productVariantHistoryFields);
              assert.equal(input.request.productReference, product);
              if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              const root = (
                await tx.query(
                  "SELECT aggregate_version FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2",
                  [id(2), product],
                )
              ).rows[0].aggregate_version;
              observedRoots.add(root);
              assert.equal(input.request.expectedAggregateVersion, 8);
              assert.ok(root === 8 || root === 9);
              if (root === 9) {
                const own = await tx.query(
                  "SELECT result_aggregate_version FROM rms_catalog.product_operation_record WHERE brand_id=$1 AND product_id=$2 AND operation_id=$3",
                  [id(2), product, command.operationReference],
                );
                assert.equal(own.rows.length, 1);
                assert.equal(own.rows[0].result_aggregate_version, 9);
              }
              if (mode !== "normal" && !tentative && root === 9) {
                tentative = true;
                if (mode === "late-grant")
                  await tx.query(
                    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                    [grant],
                  );
                if (mode === "late-policy") policyAllowed = false;
                if (mode === "late-expiry") clockOverride = originalDeadline;
              }
            },
          },
          remainingAuthority: async (_tx, input) => {
            originalDeadline = input.validUntil;
            assert.equal(input.productReference, product);
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_DRAFT_REPLACE");
            assert.deepEqual(
              input.requiredReferenceChecks,
              input.mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks,
            );
          },
        },
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
    const body = {};
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
      body[schema + "." + table] = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    }
    return body;
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
        [product],
      )
    ).rows[0];
  const native = createMerchantRuntime(options),
    scope = { brandReference: id(2), storeReference: id(20) },
    path = "/merchant/catalog/products/draft";
  await withProductPublicationHttp(
    undefined,
    editorSession,
    scope,
    async (post) => {
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      let before = await state();
      assert.equal((await post(command, {}, path)).status, 403);
      assert.deepEqual(await state(), before);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      policyAllowed = false;
      before = await state();
      assert.equal((await post(command, {}, path)).status, 403);
      assert.deepEqual(await state(), before);
      policyAllowed = true;
      const dimensions = globalThis.structuredClone(command.draft.editorContent.variantDimensions);
      assert.ok(dimensions.length > 0);
      dimensions[0].code = "CHANGED_USED_DIMENSION";
      const bad = {
        ...command,
        draft: {
          ...command.draft,
          editorContent: { ...command.draft.editorContent, variantDimensions: dimensions },
        },
      };
      before = await state();
      assert.equal((await post(bad, {}, path)).status, 503);
      assert.deepEqual(await state(), before);
      for (const [failure, status] of [
        ["late-grant", 403],
        ["late-policy", 403],
        ["late-expiry", 503],
      ]) {
        mode = failure;
        clockOverride = null;
        tentative = false;
        policyAllowed = true;
        historyHolds = 0;
        before = await state();
        assert.equal((await post(command, {}, path)).status, status);
        assert.equal(tentative, true);
        assert.ok(historyHolds > 0);
        assert.deepEqual(await state(), before);
      }
      mode = "normal";
      clockOverride = null;
      policyAllowed = true;
      const initial = await counts();
      let lose = true;
      const bodies = [];
      const fetcher = async (url, request) => {
        assert.equal(url, path);
        bodies.push(request.body);
        const reply = await post(
          JSON.parse(request.body),
          { "x-bop-csrf": String(new globalThis.Headers(request.headers).get("x-bop-csrf")) },
          path,
        );
        if (lose) {
          assert.equal(reply.status, 200);
          lose = false;
          throw new TypeError("SYNTHETIC_NATIVE_VARIANT_SAVE_REPLY_LOST");
        }
        return new globalThis.Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": reply.contentType, "cache-control": reply.cacheControl },
        });
      };
      const pending = createProductCommandClient(fetcher).prepareDraft(command, scope);
      await assert.rejects(pending.execute(editorSession.csrf), { code: "OutcomeUnknown" });
      const after = await counts();
      assert.equal(after.root, 9);
      assert.deepEqual([...historyRoots], [8]);
      assert.ok(observedRoots.has(8) && observedRoots.has(9));
      for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
        assert.equal(after[key], initial[key] + 1);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      before = await state();
      await assert.rejects(pending.execute(editorSession.csrf), { code: "OutcomeUnknown" });
      assert.deepEqual(await state(), before);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
        [grant],
      );
      clockOverride = new Date(Date.parse(now()) + 60000).toISOString();
      before = await state();
      historyHolds = 0;
      const replay = await pending.execute(editorSession.csrf);
      assert.equal(replay.status, "AlreadyApplied");
      assert.equal(replay.aggregateVersion, 9);
      assert.deepEqual(replay.draft.editorContent, command.draft.editorContent);
      assert.equal(historyHolds, 0);
      assert.deepEqual(await state(), before);
      assert.ok(bodies.length === 3 && bodies.every((x) => x === bodies[0]));
    },
    { productDraft: native.productDraft },
  );
}
