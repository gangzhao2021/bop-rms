import { syntheticLifecycleReview } from "../test-support/product-lifecycle-review.mjs";
import { assertProductSourceCommits } from "../test-support/product-source-commit.mjs";
import { withProductLifecycleHttp } from "../../../apps/api/test-support/product-lifecycle-http.mjs";
import { createMerchantProductLifecycleCommand } from "../../../apps/api/src/merchant-product-lifecycle-command.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { sha256Hex } from "../../bop/audit/src/index.ts";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import {
  createCatalogProductService,
  createPostgresProductLifecycleStore,
  resolveSkuSellable,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
// Only session/policy authority is synthetic; HTTP, Catalog and all writes are real.
const authority = vi.hoisted(() => ({ resolve: null }));
vi.mock("../../../apps/api/src/merchant-brand-scope.ts", () => ({
  createMerchantBrandScope:
    () =>
    (...args) =>
      authority.resolve(...args),
}));
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("persists Product and SKU lifecycle with exact immutable replay and atomic Audit", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_prod_life" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_prod_life_" + context.runId;
    assert.match(role, /^wp2402_prod_life_[a-f0-9]+$/);
    const at = "2026-09-14T08:00:00.000Z";
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_version_category_assignment,rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query("GRANT USAGE ON SCHEMA platform_eventing TO " + role);
      await admin.query("GRANT INSERT ON platform_eventing.outbox_event TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_catalog.product_source_head TO " + role);
      await admin.query("GRANT SELECT,INSERT ON rms_catalog.product_source_commit TO " + role);
      await admin.query(
        "GRANT UPDATE(lifecycle,aggregate_version,updated_at) ON rms_catalog.product TO " + role,
      );
      await admin.query("GRANT UPDATE(lifecycle) ON rms_catalog.sku TO " + role);
      await admin.query("GRANT UPDATE(updated_at) ON rms_catalog.product_version TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query(
        "INSERT INTO rms_catalog.product VALUES($1,$2,'LIFE_PRODUCT','NonAlcoholicBeverage','Draft',1,$3,$4,$3)",
        [id(1), id(2), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
        [id(4), id(1), id(2), JSON.stringify({ "en-CA": "Synthetic product" }), at],
      );
      await admin.query(
        "INSERT INTO rms_catalog.sku VALUES($1,$2,$3,$4,'LIFE_SKU','Draft',$5,'[]',$6,'EACH',1.5,$7,$8)",
        [
          id(5),
          id(1),
          id(2),
          id(4),
          JSON.stringify({ "en-CA": "Synthetic SKU" }),
          "sha256:" + sha256Hex("[]"),
          at,
          id(3),
        ],
      );
      await admin.query(
        "INSERT INTO rms_catalog.option_set VALUES($1,$2,'LIFE_OPTIONS','Draft',1,$3,$4,$3)",
        [id(10), id(2), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.option_set_version VALUES($1,$2,$3,'Draft','en-CA',$4,'{}','SingleChoice',0,1,false,1,1,$5,$5)",
        [id(11), id(10), id(2), JSON.stringify({ "en-CA": "Synthetic options" }), at],
      );
      await admin.query(
        "INSERT INTO rms_catalog.option VALUES($1,$2,$3,$4,'OPTION_A','Active',$5,'{}',0,true,NULL,$6,$7)",
        [id(12), id(11), id(10), id(2), JSON.stringify({ "en-CA": "Synthetic option" }), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_option_binding VALUES($1,$2,$3,$4,$5,$6,'CUSTOMIZE',0,0,1,false)",
        [id(13), id(4), id(1), id(2), id(10), id(11)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_option_binding_option VALUES($1,$2,$3,$4,$5,1)",
        [id(13), id(1), id(2), id(12), id(10)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_option_binding_sku_scope VALUES($1,$2,$3,$4,'Include')",
        [id(13), id(1), id(2), id(5)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_option_binding_channel VALUES($1,$2,$3,'WEB')",
        [id(13), id(1), id(2)],
      );
      const runner = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      let authorized = true,
        writeChecks = 0,
        rejectWriteAt = Infinity;
      const store = createPostgresProductLifecycleStore({
        brandReference: id(2),
        transactions: runner,
        authorize: async (_tx, request) =>
          authorized && (!request.record || ++writeChecks < rejectWriteAt),
      });
      const brand = createBrand({
        brandReference: id(2),
        code: "LIFE_BRAND",
        displayName: "Synthetic",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const tenant = createTenantContext(
        {
          actorType: "User",
          actorReference: id(3),
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt: at,
          recentMfaAt: null,
        },
        brand,
        null,
        at,
      );
      const audit = (operation, time) => ({
        auditId: id(1000 + Number.parseInt(operation.slice(-12), 16)),
        brandId: id(2),
        actor: { type: "User", reference: id(3) },
        actionCode: "CATALOG_PRODUCT_CHANGELIFECYCLE",
        targetType: "CatalogProduct",
        targetId: id(1),
        correlationId: operation,
        occurredAt: time,
        reasonCode: "SYNTHETIC_TEST",
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      });
      const unused = async () => {
        throw new Error("not a lifecycle port");
      };
      const service = createCatalogProductService({
        lifecycleReview: {
          withCurrentReview: async (request, mutate) => mutate(syntheticLifecycleReview(request)),
        },
        authorization: {
          authorize: async (request) => ({
            tenantContext: tenant,
            permission: {
              effect: "Allow",
              scopeKind: "Brand",
              action: "catalog.product.manage",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
              policySnapshotReference: id(20),
              policyVersion: 1,
              audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
            },
            audit: audit(request.operationReference, request.observedAt),
          }),
        },
        references: {
          hashIntent: sha256Hex,
          equals: (a, b) => a === b,
          generate: () => {
            throw new Error("unused");
          },
        },
        repository: { ...store, create: unused, codeAvailable: unused },
        optionSets: { resolveVersion: unused },
      });
      const original = await store.load(id(1));
      assert.equal(original.draft.skus[0].unitQuantity, "1.5");
      assert.equal(original.draft.optionBindings.length, 1);
      assert.deepEqual(original.draft.optionBindings[0].defaultSelections, [
        { optionReference: id(12), quantity: 1 },
      ]);
      const activate = {
        productReference: id(1),
        skuReference: null,
        targetLifecycle: "Active",
        expectedAggregateVersion: 1,
        operationReference: id(30),
        requestedAt: "2026-09-14T08:01:00.000Z",
      };
      const product = await service.changeLifecycle(activate);
      assert.equal(product.status, "Applied");
      assert.equal(product.aggregate.lifecycle, "Active");
      assert.equal(resolveSkuSellable(product.aggregate, id(5)).catalogEligible, false);
      const sku = await service.changeLifecycle({
        ...activate,
        skuReference: id(5),
        expectedAggregateVersion: 2,
        operationReference: id(31),
        requestedAt: "2026-09-14T08:02:00.000Z",
      });
      assert.equal(resolveSkuSellable(sku.aggregate, id(5)).catalogEligible, true);
      assert.deepEqual(sku.aggregate.draft.optionBindings, original.draft.optionBindings);
      assert.deepEqual(await service.changeLifecycle(activate), {
        status: "AlreadyApplied",
        aggregate: product.aggregate,
      });
      await assert.rejects(service.changeLifecycle({ ...activate, operationReference: id(32) }), {
        code: "CATALOG_VERSION_CONFLICT",
      });
      await assert.rejects(
        service.changeLifecycle({
          ...activate,
          expectedAggregateVersion: 3,
          targetLifecycle: "Archived",
          reasonCode: "SYNTHETIC_TEST",
          operationReference: id(32),
        }),
        { code: "CATALOG_LIFECYCLE_CONFLICT" },
      );
      const counts = async () => {
        await assertProductSourceCommits(admin);
        return (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM rms_catalog.product_operation_record) operations",
          )
        ).rows[0];
      };
      assert.deepEqual(await counts(), { snapshots: 2, audits: 2, operations: 2 });
      await assert.rejects(
        service.changeLifecycle({
          ...activate,
          targetLifecycle: "Suspended",
          expectedAggregateVersion: 3,
          operationReference: id(32),
          reasonCode: "SYNTHETIC_MISMATCH",
        }),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      assert.deepEqual(await counts(), { snapshots: 2, audits: 2, operations: 2 });
      writeChecks = 0;
      rejectWriteAt = 2;
      await assert.rejects(
        service.changeLifecycle({
          ...activate,
          skuReference: id(5),
          targetLifecycle: "Suspended",
          reasonCode: "SYNTHETIC_TEST",
          expectedAggregateVersion: 3,
          operationReference: id(32),
          requestedAt: "2026-09-14T08:03:00.000Z",
        }),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      assert.deepEqual(await counts(), { snapshots: 2, audits: 2, operations: 2 });
      assert.equal((await store.load(id(1))).aggregateVersion, 3);
      rejectWriteAt = Infinity;
      authorized = false;
      await assert.rejects(store.resolveOperation(id(30)), { code: "CATALOG_PERMISSION_DENIED" });
      authorized = true;
      assert.equal(
        await createPostgresProductLifecycleStore({
          brandReference: id(99),
          transactions: runner,
          authorize: async () => true,
        }).load(id(1)),
        null,
      );
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_catalog.product_operation_snapshot SET snapshot_json='{}' WHERE operation_id=$1",
            [id(30)],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin.query(
            "DELETE FROM rms_catalog.product_operation_snapshot WHERE operation_id=$1",
            [id(30)],
          )
        ).rowCount,
        0,
      );
      await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [id(99)],
        );
        assert.equal(
          (await tx.query("SELECT * FROM rms_catalog.product_operation_snapshot", [])).rows.length,
          0,
        );
        for (const table of ["product_source_head", "product_source_commit"])
          assert.equal((await tx.query("SELECT * FROM rms_catalog." + table, [])).rows.length, 0);
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(99)],
        );
        assert.equal(
          (await tx.query("SELECT * FROM rms_catalog.product_operation_snapshot", [])).rows.length,
          0,
        );
      });

      let httpAllowed = true,
        httpScopeKind = "Brand";
      let httpTime = "2026-09-14T08:04:00.000Z";
      authority.resolve = async (_tx, cookie, sessionReference) => {
        assert.equal(cookie, "synthetic-cookie");
        assert.equal(sessionReference, id(700));
        return {
          actorReference: id(3),
          tenantReference: id(900),
          selectedStoreReference: id(901),
          context: tenant,
          authorizeAction: async (action) => ({
            effect: httpAllowed ? "Allow" : "Deny",
            scopeKind: httpScopeKind,
            action,
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            policySnapshotReference: id(20),
            policyVersion: 1,
            audit: {
              effect: httpAllowed ? "Allow" : "Deny",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
            },
          }),
        };
      };
      let reviewCalls = 0,
        reviewDecision = "Allowed",
        reviewMissing = false,
        reviewStaleCommit = false;
      const httpOptions = {
        merchant: { transactions: runner, now: () => httpTime },
        authentication: {
          authorize: async (input) => {
            assert.equal(input.sessionCookie, "synthetic-cookie");
            assert.equal(input.csrf, "synthetic-csrf");
            return { sessionReference: id(700) };
          },
        },
        auditReference: (operation) => audit(operation, httpTime).auditId,
        lifecycleReview: async (_tx, input) => {
          assert.equal(input.tenantReference, id(900));
          assert.equal(input.storeReference, id(901));
          assert.equal(input.sessionReference, id(700));
          assert.equal(input.actionPermission, "catalog.sku.suspend");
          reviewCalls++;
          const evidence = syntheticLifecycleReview(input.request);
          evidence.decision = reviewDecision;
          if (reviewMissing) evidence.sources.pop();
          if (reviewStaleCommit && reviewCalls === 3) evidence.policyVersion = 2;
          return evidence;
        },
        writeAuthority: async (_tx, input) => {
          assert.equal(input.tenantReference, id(900));
          assert.equal(input.storeReference, id(901));
          assert.equal(input.brandReference, tenant.brand.brandReference);
          assert.equal(input.actorReference, id(3));
          assert.equal(input.sessionReference, id(700));
          assert.equal(input.phase, "phase_1");
          assert.equal(input.screenId, "CAT-SKU-DETAIL");
          return "Allowed";
        },
      };
      const httpCommand = createMerchantProductLifecycleCommand(httpOptions);
      await withProductLifecycleHttp(
        httpCommand,
        async (post) => {
          const change = {
            productReference: id(1),
            skuReference: id(5),
            targetLifecycle: "Suspended",
            expectedAggregateVersion: 3,
            operationReference: id(40),
            reasonCode: "SYNTHETIC_LIFECYCLE_CHANGE",
          };
          const missingReason = { ...change };
          delete missingReason.reasonCode;
          assert.equal((await post(missingReason)).status, 400);
          const beforeReason = await counts();
          for (const scope of [
            { brandReference: id(99), storeReference: id(901) },
            { brandReference: tenant.brand.brandReference, storeReference: id(902) },
          ]) {
            assert.equal((await post(change, scope)).status, 403);
            assert.deepEqual(await counts(), beforeReason);
          }
          await assert.rejects(
            createMerchantProductLifecycleCommand({ ...httpOptions, lifecycleReview: undefined })({
              sessionCookie: "synthetic-cookie",
              csrf: "synthetic-csrf",
              command: change,
              expectedScope: {
                brandReference: tenant.brand.brandReference,
                storeReference: id(901),
              },
            }),
            { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
          );
          assert.deepEqual(await counts(), beforeReason);
          for (const decision of [
            "Blocked",
            "ApprovalRequired",
            "WarningAcknowledgementRequired",
          ]) {
            reviewDecision = decision;
            assert.equal((await post(change)).status, 409);
            assert.deepEqual(await counts(), beforeReason);
          }
          reviewDecision = "Allowed";
          reviewMissing = true;
          assert.equal((await post(change)).status, 503);
          assert.deepEqual(await counts(), beforeReason);
          reviewMissing = false;
          reviewCalls = 0;
          reviewStaleCommit = true;
          assert.equal((await post(change)).status, 409);
          assert.equal(reviewCalls, 3);
          assert.deepEqual(await counts(), beforeReason);
          reviewStaleCommit = false;
          reviewCalls = 0;
          const changed = await post(change);
          assert.equal(changed.status, 200);
          assert.deepEqual(changed.body, {
            status: "Applied",
            productReference: id(1),
            skuReference: id(5),
            aggregateVersion: 4,
            productLifecycle: "Active",
            skuLifecycle: "Suspended",
          });
          assert.equal(
            (
              await admin.query(
                "SELECT reason_code FROM platform_audit.audit_record WHERE audit_id=$1",
                [audit(change.operationReference, httpTime).auditId],
              )
            ).rows[0].reason_code,
            change.reasonCode,
          );
          const impactAudit = (
            await admin.query(
              "SELECT after_summary_json FROM platform_audit.audit_record WHERE audit_id=$1",
              [audit(change.operationReference, httpTime).auditId],
            )
          ).rows[0].after_summary_json;
          assert.equal(
            impactAudit.lifecycleReviewReference,
            syntheticLifecycleReview({ activeSkuCount: 1 }).reviewReference,
          );
          assert.equal(impactAudit.lifecycleReviewPolicyVersion, 1);
          const reasonCounts = await counts();
          assert.equal(reasonCounts.audits, beforeReason.audits + 1);
          assert.equal((await post({ ...change, reasonCode: "SYNTHETIC_DIFFERENT" })).status, 409);
          assert.deepEqual(await counts(), reasonCounts);
          httpTime = "2026-09-15T08:04:00.000Z";
          reviewDecision = "Blocked";
          assert.equal((await post(change)).status, 409);
          assert.deepEqual(await counts(), reasonCounts);
          reviewDecision = "Allowed";
          const replay = await post(change);
          assert.equal(replay.status, 200);
          assert.deepEqual(replay.body, { ...changed.body, status: "AlreadyApplied" });
          assert.equal((await post({ ...change, targetLifecycle: "Active" })).status, 409);
          assert.equal((await post({ ...change, operationReference: id(41) })).status, 409);
          for (const injected of [
            { brandReference: id(99) },
            { actorReference: id(99) },
            { requestedAt: at },
            { draft: {} },
            { expectedAggregateVersion: "4" },
            { targetLifecycle: "Unknown" },
            { reasonCode: "" },
            { reasonCode: "REASON\n" },
            { reasonCode: "A".repeat(129) },
            { skuReference: id(999), expectedAggregateVersion: 4, operationReference: id(41) },
          ]) {
            const response = await post({ ...change, ...injected });
            assert.equal(response.status, Object.hasOwn(injected, "skuReference") ? 403 : 400);
          }
          httpAllowed = false;
          assert.equal((await post(change)).status, 403);
          httpAllowed = true;
          httpScopeKind = "Store";
          assert.equal((await post(change)).status, 403);
          httpScopeKind = "Brand";
          httpTime = "2026-09-14T08:05:00.000Z";
          assert.equal(
            (
              await post({
                ...change,
                operationReference: id(41),
                expectedAggregateVersion: 4,
                targetLifecycle: "Active",
              })
            ).status,
            200,
          );
          assert.deepEqual(await counts(), { snapshots: 4, audits: 4, operations: 4 });
          const current = await store.load(id(1));
          assert.equal(current.aggregateVersion, 5);
          assert.equal(current.draft.skus[0].lifecycle, "Active");
          assert.deepEqual(current.draft.optionBindings, original.draft.optionBindings);
        },
        { brandReference: tenant.brand.brandReference, storeReference: id(901) },
      );

      const rootTransitions = [
        "Suspended",
        "Active",
        "Discontinued",
        "Archived",
        "Draft",
        "Active",
        "Discontinued",
        "Archived",
        "Discontinued",
      ];
      const rootEvents = [
        "ProductSuspended",
        "ProductResumed",
        "ProductDiscontinued",
        "ProductArchived",
        "ProductRestored",
        "ProductActivated",
        "ProductDiscontinued",
        "ProductArchived",
        "ProductRestored",
      ];
      for (let index = 0; index < rootTransitions.length; index++) {
        const result = await service.changeLifecycle({
          ...activate,
          skuReference: null,
          targetLifecycle: rootTransitions[index],
          reasonCode: "SYNTHETIC_TEST",
          expectedAggregateVersion: 5 + index,
          operationReference: id(50 + index),
          requestedAt: new Date(Date.parse(at) + (6 + index) * 60000).toISOString(),
        });
        assert.equal(result.status, "Applied");
        const receipts = await assertProductSourceCommits(admin);
        const receipt = receipts.find((row) => row.operation_id === id(50 + index));
        assert.equal(receipt.event_type, rootEvents[index]);
        assert.equal(receipt.payload_json.changedSkuReference, null);
      }
      await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(99)],
        );
        for (const table of ["product_source_head", "product_source_commit"])
          assert.equal((await tx.query("SELECT * FROM rms_catalog." + table, [])).rows.length, 0);
      });
      await assert.rejects(
        runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [id(99)],
          );
          await tx.query(
            "INSERT INTO rms_catalog.product_source_head(brand_id,source_revision) VALUES($1,1)",
            [id(2)],
          );
        }),
        { code: "42501" },
      );

      // Legacy metadata alone is not reconstructable history.
      await admin.query(
        "INSERT INTO rms_catalog.product_operation_record VALUES($1,$2,$3,'ChangeLifecycle',$4,3,$5)",
        [id(99), id(2), id(1), "sha256:" + "f".repeat(64), "2026-09-14T08:02:00.000Z"],
      );
      await assert.rejects(store.resolveOperation(id(99)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
