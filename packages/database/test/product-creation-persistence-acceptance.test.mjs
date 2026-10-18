import {
  createCatalogProductService,
  createPostgresProductLifecycleStore,
} from "../../rms/catalog/src/index.ts";
import { sha256Hex } from "../../bop/audit/src/index.ts";
import { setTimeout as delay } from "node:timers/promises";
import { assertProductSourceCommits } from "../test-support/product-source-commit.mjs";
import { createMerchantProductDraftCommand } from "../../../apps/api/src/merchant-product-draft-command.ts";
import { exerciseProductDraftReplacement } from "../test-support/product-draft-replacement.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  withProductCreationHttp,
  productCreationFixtureCsrf,
} from "../../../apps/api/test-support/product-creation-http.mjs";
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
    let loseCommitReply = false;
    let commitGate = null;
    let failOutbox = false;
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
        "GRANT SELECT ON rms_catalog.product_version_category_assignment,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query("GRANT USAGE ON SCHEMA platform_eventing TO " + role);
      await admin.query("GRANT INSERT ON platform_eventing.outbox_event TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_catalog.product_source_head TO " + role);
      await admin.query("GRANT SELECT,INSERT ON rms_catalog.product_source_commit TO " + role);
      await admin.query("GRANT SELECT ON rms_catalog.product_publication_revision TO " + role);
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
                if (
                  commitGate?.firstPid &&
                  client.processID !== commitGate.firstPid &&
                  /SELECT pg_advisory_xact_lock/.test(sql) &&
                  values[0] === "CatalogProductSource:" + id(1)
                ) {
                  commitGate.secondPid = client.processID;
                  commitGate.blocked();
                }
                const result = await client.query(sql, [...values]);
                if (failAudit && /INSERT INTO platform_audit\.audit_record/.test(sql)) {
                  auditFailures++;
                  throw new Error("synthetic failure after actual Audit insert");
                }
                if (
                  commitGate &&
                  commitGate.firstPid === null &&
                  /INSERT INTO platform_eventing\.outbox_event/.test(sql)
                ) {
                  commitGate.firstPid = client.processID;
                  commitGate.reached();
                  await commitGate.wait;
                }
                if (failOutbox && /INSERT INTO platform_eventing\.outbox_event/.test(sql))
                  throw new Error("synthetic failure after actual Outbox insert");
                return result;
              },
            });
            await client.query("COMMIT");
            if (loseCommitReply) {
              loseCommitReply = false;
              throw new Error("synthetic lost reply after actual COMMIT");
            }
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
          tenantReference: id(9000),
          selectedStoreReference: id(5),
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
            assert.equal(input.csrf, productCreationFixtureCsrf);
            return { sessionReference: id(3) };
          },
        },
        auditReference: (operation) => id(10000 + Number.parseInt(operation.slice(-12), 16)),
        writeAuthority: async (_tx, input) => {
          assert.equal(input.tenantReference, id(9000));
          assert.equal(input.brandReference, id(1));
          assert.equal(input.storeReference, id(5));
          assert.equal(input.actorReference, id(2));
          assert.equal(input.sessionReference, id(3));
          assert.equal(input.permission, "catalog.manage");
          assert.equal(input.owningAction, "catalog.product.manage");
          assert.equal(input.phase, "phase_1");
          assert.equal(
            input.screenId,
            input.action === "Create" ? "CAT-PRODUCT-CREATE" : "CAT-PRODUCT-EDIT",
          );
          return "Allowed";
        },
      };
      const command = createMerchantProductCreationCommand(options);
      const lifecycle = createMerchantProductLifecycleCommand({
        ...options,
        writeAuthority: async (_tx, input) => {
          assert.equal(input.screenId, "CAT-PRODUCT-DETAIL");
          assert.equal(input.phase, "phase_1");
          return "Allowed";
        },
      });
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
      const counts = async () => {
        await assertProductSourceCommits(admin);
        return (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.product) products,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,(SELECT count(*)::int FROM platform_audit.audit_record) audits",
          )
        ).rows[0];
      };
      await withProductCreationHttp(
        command,
        async (post) => {
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
              (await post({ ...input, skus: [{ ...input.skus[0], unitQuantity: quantity }] }))
                .status,
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
          const activation = {
            productReference: created.body.productReference,
            skuReference: null,
            targetLifecycle: "Active",
            expectedAggregateVersion: 1,
            operationReference: id(110),
          };
          await assert.rejects(
            lifecycle({
              sessionCookie: "synthetic-cookie",
              csrf: productCreationFixtureCsrf,
              command: activation,
              expectedScope: { brandReference: id(1), storeReference: id(5) },
            }),
            { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
          );
          assert.deepEqual(await counts(), { products: 4, snapshots: 4, audits: 4 });
          // Existing owning minimum prepares an explicit legacy Active fixture for Draft
          // consumers. This is not canonical publishing or a successful normal action.
          const unused = () => {
            throw new Error("Unused legacy fixture operation");
          };
          const legacyStore = createPostgresProductLifecycleStore({
            brandReference: id(1),
            transactions,
            authorize: async () => allowed,
          });
          const legacyFixture = createCatalogProductService({
            repository: { ...legacyStore, create: unused, codeAvailable: unused },
            optionSets: { resolveVersion: unused },
            references: { generate: unused, hashIntent: sha256Hex, equals: (a, b) => a === b },
            authorization: {
              authorize: async (request) => ({
                tenantContext: tenant,
                permission: await (
                  await authority.resolve(null, "synthetic-cookie", id(3))
                ).authorizeAction("catalog.product.manage"),
                audit: {
                  auditId: options.auditReference(request.operationReference),
                  brandId: id(1),
                  actor: { type: "User", reference: id(2) },
                  actionCode: "CATALOG_PRODUCT_CHANGELIFECYCLE",
                  targetType: "CatalogProduct",
                  targetId: activation.productReference,
                  occurredAt: request.observedAt,
                  correlationId: request.operationReference,
                  reasonCode: "SYNTHETIC_LEGACY_FIXTURE",
                  sourceChannel: "SYNTHETIC_FIXTURE",
                  dataClassification: "Internal",
                  retentionPolicyCode: "CONFIGURATION_AUDIT",
                  retentionPolicyVersion: 1,
                },
              }),
            },
          });
          const active = await legacyFixture.changeLifecycle({
            ...activation,
            requestedAt: now,
            reasonCode: "SYNTHETIC_LEGACY_FIXTURE",
          });
          assert.equal(active.aggregate.aggregateVersion, 2);
          assert.equal(active.aggregate.lifecycle, "Active");
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
          const beforeOutboxFailure = await counts();
          failOutbox = true;
          assert.equal((await post(simple("OUTBOX_FAILURE", 120))).status, 503);
          assert.deepEqual(await counts(), beforeOutboxFailure);
          failOutbox = false;
          assert.equal((await post(simple("OUTBOX_FAILURE", 120))).status, 200);
          const sourceRecords = await assertProductSourceCommits(admin);
          assert.ok(sourceRecords.some((row) => row.event_type === "ProductCreated"));
          assert.ok(sourceRecords.some((row) => row.event_type === "ProductActivated"));
          assert.ok(sourceRecords.some((row) => row.event_type === "ProductDraftUpdated"));
          // Receipts cannot be silently rewritten; head cannot regress, jump or reset.
          assert.equal(
            (
              await admin.query(
                "UPDATE rms_catalog.product_source_commit SET event_type='ProductArchived'",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (await admin.query("DELETE FROM rms_catalog.product_source_commit")).rowCount,
            0,
          );
          await assert.rejects(
            admin.query(
              "UPDATE rms_catalog.product_source_head SET source_revision=source_revision+2",
            ),
            { code: "23514" },
          );
          await assert.rejects(admin.query("DELETE FROM rms_catalog.product_source_head"), {
            code: "55000",
          });
          await assertProductSourceCommits(admin);
          const beforeHeldCommit = await counts();
          let release, reached, blocked;
          const wait = new Promise((resolve) => {
            release = resolve;
          });
          const atOutbox = new Promise((resolve) => {
            reached = resolve;
          });
          const atBarrier = new Promise((resolve) => {
            blocked = resolve;
          });
          commitGate = { firstPid: null, secondPid: null, wait, reached, blocked };
          const first = post(simple("SERIAL_FIRST", 121));
          let second;
          try {
            await Promise.race([
              atOutbox,
              first.then(() => {
                throw new Error("first completed before commit gate");
              }),
            ]);
            second = post(simple("SERIAL_SECOND", 122));
            await Promise.race([
              atBarrier,
              second.then(() => {
                throw new Error("second bypassed source barrier");
              }),
            ]);
            let waiting = false;
            for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
              waiting = (
                await admin.query(
                  "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) waiting",
                  [commitGate.secondPid],
                )
              ).rows[0].waiting;
              if (!waiting) await delay(10);
            }
            assert.equal(waiting, true, "second actual backend waits until first COMMIT");
            assert.deepEqual(
              await counts(),
              beforeHeldCommit,
              "uncommitted revision/Event/result are invisible",
            );
            release();
            const results = await Promise.all([first, second]);
            assert.deepEqual(
              results.map((result) => result.status),
              [200, 200],
            );
            const receipts = await assertProductSourceCommits(admin);
            const firstReceipt = receipts.find((row) => row.operation_id === id(121));
            const secondReceipt = receipts.find((row) => row.operation_id === id(122));
            assert.equal(
              BigInt(secondReceipt.source_revision),
              BigInt(firstReceipt.source_revision) + 1n,
            );
          } finally {
            release();
            await Promise.allSettled([first, ...(second ? [second] : [])]);
            commitGate = null;
          }
          const beforeLostReply = await counts();
          loseCommitReply = true;
          assert.equal((await post(simple("COMMIT_REPLY_LOSS", 123))).status, 503);
          const committedCounts = await counts();
          assert.deepEqual(committedCounts, {
            products: beforeLostReply.products + 1,
            snapshots: beforeLostReply.snapshots + 1,
            audits: beforeLostReply.audits + 1,
          });
          now = new Date(Date.parse(now) + 60000).toISOString();
          const recovered = await post(simple("COMMIT_REPLY_LOSS", 123));
          assert.equal(recovered.status, 200);
          assert.equal(recovered.body.status, "AlreadyApplied");
          assert.deepEqual(await counts(), committedCounts);
        },
        undefined,
        { brandReference: id(1), storeReference: id(5) },
      );
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
