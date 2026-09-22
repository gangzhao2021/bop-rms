import { createMerchantProductDraftCommand } from "../../../apps/api/src/merchant-product-draft-command.ts";
import { exerciseProductDraftReplacement } from "../test-support/product-draft-replacement.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { withProductCreationHttp } from "../../../apps/api/test-support/product-creation-http.mjs";
import { createMerchantProductCreationCommand } from "../../../apps/api/src/merchant-product-creation-command.ts";
import { createMerchantProductLifecycleCommand } from "../../../apps/api/src/merchant-product-lifecycle-command.ts";
const authority = vi.hoisted(() => ({ resolve: null }));
vi.mock("../../../apps/api/src/merchant-brand-scope.ts", () => ({
  createMerchantBrandScope:
    () =>
    (...args) =>
      authority.resolve(...args),
}));
// Session/policy authority is synthetic; HTTP, owner SQL, lifecycle and Audit are actual.
const { Client } = pg;
const id = (n) => "01902403-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("creates complete Product graphs through HTTP with exact replay, code concurrency and Audit rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_prod_create" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_prod_create_" + context.runId;
    assert.match(role, /^wp2402_prod_create_[a-f0-9]+$/);
    let auditFailures = 0;
    let failAudit = false,
      allowed = true,
      scopeKind = "Brand";
    const at = "2026-09-14T08:00:00.000Z";
    let now = at;
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_helpers TO " + role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,platform_audit.audit_record TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT UPDATE(lifecycle,aggregate_version,updated_at) ON rms_catalog.product TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({
              async query(sql, values) {
                const result = await client.query(sql, [...values]);
                if (failAudit && /INSERT INTO platform_audit\.audit_record/.test(sql)) {
                  auditFailures++;
                  throw new Error("synthetic failure after actual Audit insert");
                }
                return result;
              },
            });
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
      const brand = createBrand({
        brandReference: id(1),
        code: "CREATION_TEST",
        displayName: "Synthetic Creation",
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
          actorReference: id(2),
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
      authority.resolve = async (_tx, cookie, session) => {
        assert.equal(cookie, "synthetic-cookie");
        assert.equal(session, id(3));
        return {
          context: tenant,
          actorReference: id(2),
          authorizeAction: async (action) => ({
            action,
            scopeKind,
            effect: allowed ? "Allow" : "Deny",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            policySnapshotReference: id(4),
            policyVersion: 1,
            audit: {
              effect: allowed ? "Allow" : "Deny",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
            },
          }),
        };
      };
      const options = {
        merchant: { transactions, now: () => now },
        authentication: {
          authorize: async (input) => {
            assert.equal(input.sessionCookie, "synthetic-cookie");
            assert.equal(input.csrf, "synthetic-csrf");
            return { sessionReference: id(3) };
          },
        },
        auditReference: (operation) => id(10000 + Number.parseInt(operation.slice(-12), 16)),
      };
      const command = createMerchantProductCreationCommand(options);
      const lifecycle = createMerchantProductLifecycleCommand(options);
      const input = {
        internalCode: "HTTP_PRODUCT",
        productType: "NonAlcoholicBeverage",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic beverage" },
        taxClassificationReference: null,
        skus: [
          {
            skuCode: "HTTP_SKU_A",
            localizedNames: { "en-CA": "Synthetic A" },
            variantSelections: [],
            unitOfSale: "EACH",
            unitQuantity: "0.000001",
          },
          {
            skuCode: "HTTP_SKU_B",
            localizedNames: { "en-CA": "Synthetic B" },
            variantSelections: [{ dimensionReference: id(5), valueReference: id(6) }],
            unitOfSale: "EACH",
            unitQuantity: "99999999999999.999999",
          },
        ],
        operationReference: id(100),
      };
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.product) products,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,(SELECT count(*)::int FROM platform_audit.audit_record) audits",
          )
        ).rows[0];
      await withProductCreationHttp(command, async (post) => {
        const created = await post(input);
        assert.equal(created.status, 200);
        assert.equal(created.body.status, "Applied");
        assert.equal(created.body.lifecycle, "Draft");
        assert.equal(created.body.aggregateVersion, 1);
        assert.deepEqual(
          created.body.skus.map((sku) => sku.skuCode),
          ["HTTP_SKU_A", "HTTP_SKU_B"],
        );
        const stored = await admin.query(
          "SELECT sku_code,unit_quantity::text,lifecycle FROM rms_catalog.sku ORDER BY sku_code",
        );
        assert.deepEqual(stored.rows, [
          { sku_code: "HTTP_SKU_A", unit_quantity: "0.000001", lifecycle: "Draft" },
          { sku_code: "HTTP_SKU_B", unit_quantity: "99999999999999.999999", lifecycle: "Draft" },
        ]);
        assert.deepEqual(await counts(), { products: 1, snapshots: 1, audits: 1 });
        now = "2026-09-15T08:00:00.000Z";
        assert.deepEqual(await post(input), {
          status: 200,
          body: { ...created.body, status: "AlreadyApplied" },
        });
        assert.equal(
          (await post({ ...input, localizedNames: { "en-CA": "Different" } })).status,
          409,
        );
        for (const extra of [
          { brandReference: id(99) },
          { actorReference: id(99) },
          { requestedAt: at },
          { productReference: id(99) },
        ])
          assert.equal((await post({ ...input, ...extra })).status, 400);
        for (const quantity of [1, "100000000000000", "0.0000012", "0"]) {
          assert.equal(
            (await post({ ...input, skus: [{ ...input.skus[0], unitQuantity: quantity }] })).status,
            400,
          );
        }
        const variants = [
          { dimensionReference: id(8), valueReference: id(9) },
          { dimensionReference: id(5), valueReference: id(6) },
        ];
        assert.equal(
          (
            await post({
              ...input,
              operationReference: id(120),
              internalCode: "DUPLICATE_VARIANT",
              skus: [
                { ...input.skus[0], skuCode: "VARIANT_A", variantSelections: variants },
                {
                  ...input.skus[1],
                  skuCode: "VARIANT_B",
                  variantSelections: [...variants].reverse(),
                },
              ],
            })
          ).status,
          400,
        );
        assert.deepEqual(await counts(), { products: 1, snapshots: 1, audits: 1 });
        allowed = false;
        assert.equal((await post(input)).status, 403);
        allowed = true;
        scopeKind = "Store";
        assert.equal((await post(input)).status, 403);
        scopeKind = "Brand";
        now = "2026-09-14T08:01:00.000Z";
        const simple = (code, operation) => ({
          ...input,
          internalCode: code,
          operationReference: id(operation),
          skus: [{ ...input.skus[0], skuCode: code + "_SKU", unitQuantity: "1.500000" }],
        });
        const concurrent = await Promise.all([
          post(simple("SAME_CODE", 101)),
          post(simple("SAME_CODE", 102)),
        ]);
        assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
        const duplicateSku = await post({ ...simple("OTHER_PRODUCT", 103), skus: input.skus });
        assert.equal(duplicateSku.status, 409);
        const replays = await Promise.all([
          post(simple("SAME_OPERATION", 104)),
          post(simple("SAME_OPERATION", 104)),
        ]);
        assert.deepEqual(
          replays.map((result) => result.status),
          [200, 200],
        );
        assert.deepEqual(replays.map((result) => result.body.status).sort(), [
          "AlreadyApplied",
          "Applied",
        ]);
        assert.equal(replays[0].body.productReference, replays[1].body.productReference);
        assert.deepEqual(await counts(), { products: 3, snapshots: 3, audits: 3 });
        failAudit = true;
        assert.equal((await post(simple("ROLLBACK_PRODUCT", 105))).status, 503);
        assert.deepEqual(await counts(), { products: 3, snapshots: 3, audits: 3 });
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int count FROM rms_catalog.sku WHERE sku_code='ROLLBACK_PRODUCT_SKU'",
            )
          ).rows[0].count,
          0,
        );
        failAudit = false;
        assert.equal((await post(simple("ROLLBACK_PRODUCT", 105))).status, 200);
        assert.deepEqual(await counts(), { products: 4, snapshots: 4, audits: 4 });
        const active = await lifecycle({
          sessionCookie: "synthetic-cookie",
          csrf: "synthetic-csrf",
          command: {
            productReference: created.body.productReference,
            skuReference: null,
            targetLifecycle: "Active",
            expectedAggregateVersion: 1,
            operationReference: id(110),
          },
        });
        assert.equal(active.aggregateVersion, 2);
        assert.equal(active.productLifecycle, "Active");
        assert.deepEqual(await post(input), {
          status: 200,
          body: { ...created.body, status: "AlreadyApplied" },
        });
        assert.deepEqual(await counts(), { products: 4, snapshots: 5, audits: 5 });
        await exerciseProductDraftReplacement({
          admin,
          role,
          transactions,
          productReference: created.body.productReference,
          id,
          at,
          draftCommand: createMerchantProductDraftCommand(options),
          setNow: (value) => {
            now = value;
          },
          setPermission: (value) => {
            allowed = value;
          },
          auditFailureCount: () => auditFailures,
          setAuditFailure: (value) => {
            failAudit = value;
          },
        });
      });
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
