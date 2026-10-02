import { createMerchantProductListQuery } from "../../../apps/api/src/merchant-product-list-query.ts";
import { createProductListClient } from "../../../apps/merchant-web/src/catalog-product-list-client.ts";
import { createProductDraftEditor } from "../../../apps/merchant-web/src/catalog-product-draft-editor.ts";
import {
  productCreateWriteFields,
  productDraftWriteFields,
  productCreateResultFields,
  productDraftResultFields,
} from "../../../apps/api/src/merchant-product-write-authority.ts";
import { createProductDraftEditingSession } from "../../../apps/merchant-web/src/catalog-product-draft-baseline.ts";
import { replaceProductDraftCategorySelection } from "../../../apps/merchant-web/src/catalog-product-category-selection.ts";
import { createProductDraftBaselineTransportClient } from "../../../apps/merchant-web/src/catalog-product-draft-baseline-client.ts";
import { createMerchantProductDraftBaselineQuery } from "../../../apps/api/src/merchant-product-draft-baseline-query.ts";
import { createProductCategoryLookupClient } from "../../../apps/merchant-web/src/catalog-product-category-lookup-client.ts";
import { createProductCommandClient } from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import pg from "pg";
import { request as httpRequest } from "node:http";
import { it } from "vitest";
import { createMerchantCategoryTransactions } from "../../../apps/api/src/merchant-category-transactions.ts";
import { createMerchantCategoryAuthority } from "../../../apps/api/src/merchant-category-authority.ts";
import {
  CatalogError,
  createPostgresCategoryRepository,
  createPostgresCategorySourceStore,
  productCategoryLookupFields,
  productDraftBaselineFields,
  productDraftBaselineReferencedFields,
  categoryPersistenceFields,
  categoryTreeViewFields,
  categoryProductViewFields,
  categoryTreeMenuViewFields,
  menuCategorySourceFields,
  categoryMenuReviewStates,
  createPostgresProductSearchGenerationStore,
} from "../../rms/catalog/src/index.ts";
import { URL } from "node:url";
import { createRequire } from "node:module";
const apiRequire = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = apiRequire("express");
import { createCategoryTreeClient } from "../../../apps/merchant-web/src/catalog-category-tree-client.ts";
import { createMerchantProductCreationCommand } from "../../../apps/api/src/merchant-product-creation-command.ts";
import { createMerchantProductLifecycleCommand } from "../../../apps/api/src/merchant-product-lifecycle-command.ts";
import { createMerchantProductDraftCommand } from "../../../apps/api/src/merchant-product-draft-command.ts";
import { createMerchantProductCategoryLookupQuery } from "../../../apps/api/src/merchant-product-category-lookup-query.ts";
import { createMerchantCategoryTreeQuery } from "../../../apps/api/src/merchant-category-tree-query.ts";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
import { createIdentityActor, parseSelectorHash } from "../../bop/identity/src/index.ts";
import * as fixture from "../../bop/permission/src/tests/current-policy.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
// Identity Actor, Tenant association, normal Screen and Phase/field providers are synthetic;
// session/selection/organization/membership/policy/Category/Audit/Event SQL is real.
it.each(["authority", "normal-tree"])(
  "composes actual current Category %s with owning SQL and permission revocation",
  async (mode) => {
    const live = mode === "normal-tree";
    const f = {
      ...fixture,
      ...(live
        ? {
            FROM: new Date(Date.now() - 60000).toISOString(),
            AT: new Date().toISOString(),
            UNTIL: new Date(Date.now() + 3600000).toISOString(),
          }
        : {}),
    };
    await withIsolatedDatabase({ caseId: "wp2409_cat_auth" }, async (context) => {
      const admin = new Client(context.clientConfig);
      await admin.connect();
      const role = "wp2409_cat_auth_" + context.runId;
      assert.match(role, /^wp2409_cat_auth_[a-f0-9]+$/);
      const tenant = f.uuid("90"),
        session = f.uuid("91"),
        targetStore = f.uuid("92"),
        foreignStore = f.uuid("93"),
        foreignBrand = f.uuid("94");
      const permissions = [
          f.uuid("100"),
          f.uuid("101"),
          f.uuid("102"),
          f.uuid("106"),
          f.uuid("107"),
          f.uuid("108"),
        ],
        grants = [
          f.uuid("110"),
          f.uuid("111"),
          f.uuid("112"),
          f.uuid("116"),
          f.uuid("117"),
          f.uuid("118"),
        ];
      const csrfToken = Buffer.alloc(32, 37).toString("base64url");
      const cookie = Buffer.alloc(32, 7).toString("base64url"),
        key = Buffer.alloc(32, 92),
        hasher = {
          hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
          equals: (a, b) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
        };
      let now = f.AT,
        association = true,
        fields = true,
        expireAfterWork = false,
        failFieldsBeforeCommit = false,
        denyTreeFieldsBeforeCommit = false,
        phaseChecks = 0,
        catalogQueries = 0,
        productWriteStatements = 0,
        productReadStatements = 0,
        categoryReadStatements = 0,
        event = 10000,
        loseCommitReply = false,
        revokeLifecycleAfterWrite = null;
      const databaseRunner = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const tx = {
              async query(sql, values) {
                if (/(?:FROM|INTO|UPDATE)\s+rms_catalog\./u.test(sql)) catalogQueries++;
                if (/(?:FROM|JOIN)\s+rms_catalog\.(?:product|sku)(?:\s|_)/u.test(sql))
                  productReadStatements++;
                if (/(?:FROM|JOIN)\s+rms_catalog\.category(?:\s|_)/u.test(sql))
                  categoryReadStatements++;
                if (/(?:INSERT INTO|UPDATE)\s+rms_catalog\.product(?:\s|_)/u.test(sql))
                  productWriteStatements++;
                const result = await client.query(sql, [...values]);
                if (revokeLifecycleAfterWrite && /^UPDATE rms_catalog\.product SET/u.test(sql)) {
                  await client.query(
                    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                    [revokeLifecycleAfterWrite],
                  );
                  revokeLifecycleAfterWrite = null;
                }
                return result;
              },
            };
            const result = await work(tx);
            await client.query("COMMIT");
            if (loseCommitReply) {
              loseCommitReply = false;
              throw new Error("SYNTHETIC_COMMIT_REPLY_LOSS");
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
      const host = createMerchantCategoryTransactions(databaseRunner);
      const runner = {
        run: (work) =>
          host.transactions.run(async (tx) => {
            const result = await work(tx);
            // Simulate elapsed time/provider failure between business work and host checks.
            if (expireAfterWork) {
              expireAfterWork = false;
              now = "2026-07-28T12:45:00.000Z";
            }
            if (denyTreeFieldsBeforeCommit) {
              denyTreeFieldsBeforeCommit = false;
              fields = false;
            }
            if (failFieldsBeforeCommit) {
              failFieldsBeforeCommit = false;
              fields = "error";
            }
            return result;
          }),
      };
      const source = {
        identity: { hasher },
        now: () => (live ? new Date().toISOString() : now),
        currentActor: async () =>
          live ? createIdentityActor({ ...f.actor, authenticatedAt: f.FROM }) : f.actor,
        validateAssociation: async (_tx, sessionValue, selection) =>
          association &&
          sessionValue.actor.actorReference === f.ACTOR &&
          selection.tenantReference === tenant &&
          selection.brandReference === f.BRAND &&
          selection.storeReference === f.STORE,
      };
      const authority = createMerchantCategoryAuthority({
        source,
        sessionCookie: cookie,
        sessionReference: session,
        tenantReference: tenant,
        brandReference: f.BRAND,
        storeReference: f.STORE,
        actorReference: f.ACTOR,
        registerBeforeCommit: host.registerBeforeCommit,
        async holdFieldsAndPhaseUntilCommit(tx, input) {
          phaseChecks++;
          assert.equal(input.storeContext.store.storeReference, f.STORE);
          assert.equal(input.brandContext.store, null);
          if (!live) assert.equal(input.observedAt, now);
          else assert.ok(Math.abs(Date.now() - Date.parse(input.observedAt)) < 5000);
          if (input.purposeCode === "CATALOG_CATEGORY_TREE_VIEW_READ") {
            assert.deepEqual(input.requiredFields, categoryTreeViewFields);
            assert.deepEqual(input.referencedCapabilities, ["catalog.cat_product_list"]);
          } else {
            assert.equal(input.requiredFields.length, 15);
            assert.deepEqual(input.referencedCapabilities, []);
          }
          assert.deepEqual(input.activeRoleCodes, ["synthetic_catalog"]);
          if (fields === "error") throw new Error("SYNTHETIC_PRIVATE_DRIVER_DETAIL");
          if (!fields) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
            "SyntheticCategoryFieldsPhase:" + f.BRAND,
          ]);
        },
      });
      const options = {
        tenantReference: tenant,
        brandReference: f.BRAND,
        actorReference: f.ACTOR,
        transactions: runner,
        authority,
        clock: { now: () => now },
        eventReference: () => f.uuid(String(event++)),
        maximumCategoryNodes: 100,
      };
      const repository = createPostgresCategoryRepository(options),
        categorySource = createPostgresCategorySourceStore({
          ...options,
          maximumSourceCommits: 100,
        });
      const category = (n, stores = [targetStore]) => ({
        categoryReference: f.uuid(String(1000 + n)),
        brandReference: f.BRAND,
        internalCode: "AUTH_CATEGORY_" + n,
        lifecycle: "Draft",
        aggregateVersion: 1,
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic authorized category" },
        localizedDescriptions: {},
        parentCategoryReference: null,
        level: 1,
        sortOrder: n,
        storeReferences: stores,
        createdAt: f.AT,
        createdByActorReference: f.ACTOR,
        updatedAt: f.AT,
      });
      const command = (n, stores) => {
        const aggregate = category(n, stores),
          op = f.uuid(String(2000 + n));
        return {
          record: {
            action: "Create",
            operationReference: op,
            operationIntentHash: n.toString(16).padStart(64, "0"),
            aggregate,
          },
          audit: {
            auditId: f.uuid(String(3000 + n)),
            brandId: f.BRAND,
            actor: { type: "User", reference: f.ACTOR },
            actionCode: "CATALOG_CATEGORY_CREATE",
            targetType: "CatalogCategory",
            targetId: aggregate.categoryReference,
            reasonCode: "SYNTHETIC_TEST",
            correlationId: op,
            occurredAt: f.AT,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          },
        };
      };
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*) FROM rms_catalog.category)::int roots,(SELECT count(*) FROM rms_catalog.category_source_commit)::int commits,(SELECT count(*) FROM platform_audit.audit_record)::int audits,(SELECT count(*) FROM platform_eventing.outbox_event)::int events,(SELECT count(*) FROM rms_catalog.product)::int products,(SELECT count(*) FROM rms_catalog.product_operation_snapshot)::int product_snapshots,(SELECT count(*) FROM rms_catalog.product_source_commit)::int product_commits,(SELECT COALESCE(max(source_revision),0)::text FROM rms_catalog.product_source_head) product_revision",
          )
        ).rows[0];
      try {
        await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
        await admin.query(
          "GRANT USAGE ON SCHEMA bop_identity,bop_tenant,bop_membership,bop_permission,rms_catalog,platform_audit,platform_eventing,platform_helpers TO " +
            role,
        );
        await admin.query(
          "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
            role,
        );
        await admin.query(
          "GRANT SELECT,UPDATE ON bop_identity.authentication_session,bop_identity.browser_session_selection,bop_tenant.brand,bop_tenant.store,bop_membership.membership,bop_membership.store_assignment,bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override TO " +
            role,
        );
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON rms_catalog.category,rms_catalog.category_source_head,platform_audit.audit_chain_head TO " +
            role,
        );
        await admin.query(
          "GRANT SELECT,INSERT ON rms_catalog.category_operation_record,rms_catalog.category_operation_snapshot,rms_catalog.category_source_commit,platform_audit.audit_record,platform_eventing.outbox_event TO " +
            role,
        );
        for (const [brand, code] of [
          [f.BRAND, "SYNTHETIC"],
          [foreignBrand, "SYNTHETIC_FOREIGN"],
        ])
          await admin.query(
            "INSERT INTO bop_tenant.brand VALUES($1,$2,'Synthetic Brand','en-CA','CAD','Active',1,$3,$3)",
            [brand, code, f.FROM],
          );
        for (const [store, brand, code] of [
          [f.STORE, f.BRAND, "SELECTED"],
          [targetStore, f.BRAND, "TARGET"],
          [foreignStore, foreignBrand, "FOREIGN"],
        ])
          await admin.query(
            "INSERT INTO bop_tenant.store VALUES($1,$2,$3,'Synthetic Store','America/Toronto','en-CA','CAD','Active',1,$4,$4)",
            [store, brand, code, f.FROM],
          );
        await admin.query(
          "INSERT INTO bop_membership.membership VALUES($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
          [f.MEMBERSHIP, f.ACTOR, f.BRAND, f.WORKFORCE, f.FROM, f.UNTIL],
        );
        await admin.query(
          "INSERT INTO bop_membership.store_assignment VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [f.STORE_ASSIGNMENT, f.MEMBERSHIP, f.ACTOR, f.BRAND, f.STORE, f.FROM, f.UNTIL],
        );
        await admin.query(
          "INSERT INTO bop_identity.authentication_session(session_id,actor_id,session_selector_hash,csrf_selector_hash,policy_code,status,encrypted_secret,cipher_algorithm,key_reference,encryption_context,authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version) VALUES($1,$2,decode($3,'hex'),decode($4,'hex'),'WorkforceStandard','Active',$5,'SYNTHETIC_AES_256_GCM','synthetic-test-key','synthetic-test-context',$6,$6,$7,$8,$9,1)",
          [
            session,
            f.ACTOR,
            hasher.hash(cookie),
            "b".repeat(64),
            Buffer.alloc(29, 1),
            f.FROM,
            f.AT,
            live ? new Date(Date.parse(f.AT) + 30 * 60000).toISOString() : f.UNTIL,
            live
              ? new Date(Date.parse(f.FROM) + 720 * 60000).toISOString()
              : "2026-07-29T00:00:00.000Z",
          ],
        );
        await admin.query(
          "INSERT INTO bop_identity.browser_session_selection VALUES($1,$2,$3,$4,$5,$6)",
          [session, f.ACTOR, tenant, f.BRAND, f.STORE, f.AT],
        );
        await admin.query("INSERT INTO bop_permission.policy_state VALUES($1,$2,1,$3)", [
          f.BRAND,
          f.SNAPSHOT,
          f.FROM,
        ]);
        for (const [index, action] of [
          "merchant.access",
          "catalog.manage",
          "catalog.category.manage",
          "catalog.category.read",
          "catalog.product.read",
          "catalog.sku.read",
        ].entries())
          await admin.query(
            "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
            [permissions[index], action, f.FROM],
          );
        for (const [roleRef, store, code] of [
          [f.STORE_ROLE, f.STORE, "synthetic_navigation"],
          [f.BRAND_ROLE, null, "synthetic_catalog"],
        ])
          await admin.query(
            "INSERT INTO bop_permission.role VALUES($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
            [roleRef, f.BRAND, store, code, f.FROM, f.UNTIL],
          );
        for (const [assignment, roleRef, storeAssignment, store] of [
          [f.STORE_ROLE_ASSIGNMENT, f.STORE_ROLE, f.STORE_ASSIGNMENT, f.STORE],
          [f.BRAND_ASSIGNMENT, f.BRAND_ROLE, null, null],
        ])
          await admin.query(
            "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
            [
              assignment,
              roleRef,
              f.MEMBERSHIP,
              storeAssignment,
              f.ACTOR,
              f.BRAND,
              store,
              f.FROM,
              f.UNTIL,
            ],
          );
        for (let index = 0; index < permissions.length; index++)
          await admin.query(
            "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
            [
              grants[index],
              index === 0 ? f.STORE_ROLE : f.BRAND_ROLE,
              permissions[index],
              f.BRAND,
              index === 0 ? f.STORE : null,
              f.FROM,
              f.UNTIL,
            ],
          );
        const initial = command(1);
        assert.deepEqual(await repository.create(initial), initial.record);
        const complete = await categorySource.loadSnapshot();
        assert.equal(complete.sourceRevision, "1");
        assert.equal(complete.categories.length, 1);
        assert.deepEqual(complete.categories[0], initial.record.aggregate);
        const original = await counts();
        if (live) {
          // Fixture role grants only: no production ACL or current provider is fabricated.
          await admin.query(
            "GRANT SELECT ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_version_category_assignment,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.product_source_commit,rms_catalog.product_operation_record,rms_catalog.product_search_generation,rms_catalog.product_search_row,rms_catalog.product_search_activation,rms_catalog.product_source_head TO " +
              role,
          );
          await admin.query(
            "GRANT INSERT ON rms_catalog.product_search_generation,rms_catalog.product_search_row TO " +
              role,
          );
          await admin.query(
            "GRANT INSERT,UPDATE ON rms_catalog.product_source_head,rms_catalog.product_search_activation TO " +
              role,
          );
          await admin.query(
            "GRANT SELECT ON rms_catalog.menu,rms_catalog.menu_version,rms_catalog.menu_section,rms_catalog.menu_section_category,rms_catalog.menu_review_content,rms_catalog.menu_publication_revision TO " +
              role,
          );
          const menu = f.uuid("18000"),
            version = f.uuid("18001");
          await admin.query("INSERT INTO rms_catalog.menu VALUES($1,$2,'COUNT_MENU',1,$3,$4,$3)", [
            menu,
            f.BRAND,
            f.FROM,
            f.ACTOR,
          ]);
          await admin.query(
            "INSERT INTO rms_catalog.menu_version VALUES($1,$2,$3,'Draft',NULL,'en-CA',$4,$5,$5)",
            [version, menu, f.BRAND, JSON.stringify({ "en-CA": "Synthetic count Menu" }), f.FROM],
          );
          for (let section = 0; section < 2; section++) {
            const sectionReference = f.uuid(String(18002 + section));
            await admin.query("INSERT INTO rms_catalog.menu_section VALUES($1,$2,$3,$4,$5,$6,$7)", [
              sectionReference,
              version,
              menu,
              f.BRAND,
              "SECTION_" + section,
              JSON.stringify({ "en-CA": "Synthetic section" }),
              section,
            ]);
            await admin.query("INSERT INTO rms_catalog.menu_section_category VALUES($1,$2,$3,$4)", [
              sectionReference,
              menu,
              f.BRAND,
              initial.record.aggregate.categoryReference,
            ]);
          }
          const expectedMenuUse = {
            status: "Known",
            draftMenuCount: 1,
            reviewed: {
              total: { status: "Known", menuCount: 0 },
              byLifecycle: Object.fromEntries(
                categoryMenuReviewStates.map((state) => [state, { status: "Known", menuCount: 0 }]),
              ),
            },
          };
          let menuAllowed = true,
            menuChecks = 0,
            menuDenyAt = null;
          let productAllowed = true,
            normalHeld = false,
            listHeld = false,
            productChecks = 0,
            revokeTreeReadAfterProduct = null;
          const productAuthority = {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(input.tenantReference, tenant);
              assert.equal(input.brandReference, f.BRAND);
              assert.equal(input.actorReference, f.ACTOR);
              assert.equal(input.permission, "catalog.manage");
              assert.equal(input.capability, "catalog.cat_product_list");
              assert.ok(
                ["CATALOG_PRODUCT_SEARCH_BUILD", "CATALOG_PRODUCT_CATEGORY_SOURCE_READ"].includes(
                  input.purposeCode,
                ),
              );
              if (input.purposeCode === "CATALOG_PRODUCT_CATEGORY_SOURCE_READ") {
                assert.ok(normalHeld || listHeld);
                assert.deepEqual(input.requiredClassificationFields, [
                  "categoryClassification",
                  "categoryReferences",
                  "primaryCategoryReference",
                ]);
                productChecks++;
                if (revokeTreeReadAfterProduct && productChecks === 2)
                  await tx.query(
                    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                    [revokeTreeReadAfterProduct],
                  );
              }
              if (!productAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
                "SyntheticProductFieldsPhase:" + f.BRAND,
              ]);
            },
          };
          const generation = createPostgresProductSearchGenerationStore({
            tenantReference: tenant,
            brandReference: f.BRAND,
            actorReference: f.ACTOR,
            transactions: databaseRunner,
            authorization: productAuthority,
            clock: { now: source.now },
            maximumProducts: 100,
          });
          await generation.rebuild({
            operationReference: f.uuid("15000"),
            actorReference: f.ACTOR,
            observedAt: source.now(),
          });
          const normalAuthority = {
            async withCurrentCategoryTree(input, work) {
              assert.equal(input.sessionCookie, cookie);
              assert.equal(input.screenId, "CAT-CATEGORY-TREE");
              assert.equal(input.purposeCode, "CATALOG_CATEGORY_TREE");
              assert.equal(input.referencedCapability, "catalog.cat_product_list");
              assert.deepEqual(input.requiredFields, categoryTreeMenuViewFields);
              normalHeld = true;
              try {
                return await work({
                  tenantReference: tenant,
                  brandReference: f.BRAND,
                  storeReference: f.STORE,
                  actorReference: f.ACTOR,
                  sessionReference: session,
                  locale: "en-CA",
                });
              } finally {
                normalHeld = false;
              }
            },
          };
          const normal = createMerchantCategoryTreeQuery({
            includeMenuUse: true,
            merchant: { ...source, transactions: databaseRunner },
            authority: normalAuthority,
            createProductSourceAuthority: () => productAuthority,
            holdCategoryFieldsAndPhaseUntilCommit: async (tx, input) => {
              assert.ok(normalHeld || listHeld);
              assert.equal(input.brandContext.brand.brandReference, f.BRAND);
              if (input.purposeCode === "CATALOG_CATEGORY_TREE_VIEW_READ") {
                assert.deepEqual(input.requiredFields, categoryTreeMenuViewFields);
                assert.deepEqual(input.referencedCapabilities, ["catalog.cat_product_list"]);
              }
              if (input.purposeCode === "CATALOG_MENU_CATEGORY_SOURCE_READ") {
                assert.deepEqual(input.requiredFields, menuCategorySourceFields);
                assert.deepEqual(input.referencedCapabilities, []);
                menuChecks++;
                if (!menuAllowed || menuChecks === menuDenyAt)
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
              }
              if (!fields) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
                "SyntheticCategoryFieldsPhase:" + f.BRAND,
              ]);
            },
            maximumProducts: 100,
            maximumCategoryNodes: 100,
            maximumSourceCommits: 100,
          });
          // Parent Screen/Phase/field/lifecycle lease is an explicit synthetic provider;
          // normal current IAM/Brand scope, owner Category history and outer COMMIT are real.
          let lookupHeld = false,
            lookupChecks = 0,
            lookupMode = "allow",
            revokeLookupReadAfterSource = false;
          const categoryLookup = createMerchantProductCategoryLookupQuery({
            merchant: { ...source, transactions: databaseRunner },
            authority: {
              async withCurrentProductCategoryLookup(input, work) {
                assert.equal(input.sessionCookie, cookie);
                assert.equal(input.permission, "catalog.manage");
                assert.equal(input.purposeCode, "CATALOG_PRODUCT_CATEGORY_LOOKUP");
                assert.ok(["CAT-PRODUCT-CREATE", "CAT-PRODUCT-EDIT"].includes(input.screenId));
                assert.equal(
                  input.capability,
                  input.screenId === "CAT-PRODUCT-CREATE"
                    ? "catalog.cat_product_create"
                    : "catalog.cat_product_edit",
                );
                assert.deepEqual(input.requiredFields, productCategoryLookupFields);
                lookupHeld = true;
                try {
                  return await work({
                    tenantReference: tenant,
                    brandReference: f.BRAND,
                    storeReference: f.STORE,
                    actorReference: f.ACTOR,
                    sessionReference: session,
                    locale: "en-CA",
                  });
                } finally {
                  lookupHeld = false;
                }
              },
            },
            holdFieldsPolicyAndPhaseUntilCommit: async (tx, input) => {
              assert.ok(lookupHeld);
              assert.equal(input.tenantReference, tenant);
              assert.equal(input.brandReference, f.BRAND);
              assert.equal(input.storeReference, f.STORE);
              assert.equal(input.actorReference, f.ACTOR);
              assert.equal(input.sessionReference, session);
              assert.deepEqual(input.requiredFields, productCategoryLookupFields);
              assert.deepEqual(input.referencedFields, categoryPersistenceFields);
              lookupChecks++;
              if (revokeLookupReadAfterSource && lookupChecks === 3)
                await tx.query(
                  "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                  [grants[3]],
                );
              if (lookupMode === "deny-commit" && lookupChecks === 4)
                throw new CatalogError("CATALOG_PERMISSION_DENIED");
              await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
                "SyntheticProductLookupFieldsPhase:" + f.BRAND,
              ]);
              return {
                allowedLifecycles:
                  lookupMode === "active-only" ||
                  (lookupMode === "change-commit" && lookupChecks === 4)
                    ? ["Active"]
                    : ["Draft", "Active"],
              };
            },
            maximumCategoryNodes: 100,
            maximumSourceCommits: 100,
          });
          const lookupRequest = (parentScreenId = "CAT-PRODUCT-CREATE") =>
            categoryLookup({ sessionCookie: cookie, query: { parentScreenId } });
          const beforeLookup = await counts();
          for (const parent of ["CAT-PRODUCT-CREATE", "CAT-PRODUCT-EDIT"]) {
            lookupChecks = 0;
            const view = await lookupRequest(parent);
            assert.equal(lookupChecks, 4);
            assert.equal(view.lookup.parentScreenId, parent);
            assert.deepEqual(view.scope, { brandReference: f.BRAND, storeReference: f.STORE });
            assert.deepEqual(
              view.lookup.items.map((item) => item.categoryReference),
              [initial.record.aggregate.categoryReference],
            );
            assert.equal(view.lookup.items[0].lifecycle, "Draft");
            assert.ok(!JSON.stringify(view).includes(f.ACTOR));
            assert.ok(!JSON.stringify(view).includes("productCount"));
          }
          lookupMode = "active-only";
          lookupChecks = 0;
          assert.deepEqual((await lookupRequest()).lookup.items, []);
          for (const mode of ["deny-commit", "change-commit"]) {
            lookupMode = mode;
            lookupChecks = 0;
            await assert.rejects(lookupRequest(), {
              code: mode === "deny-commit" ? "Denied" : "Unavailable",
            });
            assert.equal(lookupChecks, 4);
          }
          lookupMode = "allow";
          lookupChecks = 0;
          assert.deepEqual(
            await counts(),
            beforeLookup,
            "related lookup and discarded COMMIT responses never write business facts",
          );
          await admin.query(
            "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_version_category_assignment,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO " +
              role,
          );
          await admin.query(
            "GRANT SELECT,INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit TO " +
              role,
          );
          await admin.query(
            "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.product.manage','Active',1,$2,$2)",
            [f.uuid("103"), f.FROM],
          );
          await admin.query(
            "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
            [f.uuid("113"), f.BRAND_ROLE, f.uuid("103"), f.BRAND, f.FROM, f.UNTIL],
          );
          for (const [permissionId, grantId, action] of [
            [f.uuid("104"), f.uuid("114"), "catalog.product.create"],
            [f.uuid("105"), f.uuid("115"), "catalog.product.update"],
            [f.uuid("109"), f.uuid("119"), "catalog.sku.create"],
          ]) {
            await admin.query(
              "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
              [permissionId, action, f.FROM],
            );
            await admin.query(
              "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
              [grantId, f.BRAND_ROLE, permissionId, f.BRAND, f.FROM, f.UNTIL],
            );
          }
          let assignmentAllowed = true,
            denyWriteCommit = false,
            writeCalls = 0,
            revokeSkuAtMutation = null;
          let parentAllowed = true,
            parentFeature = true,
            parentDenyAtCommit = false,
            parentDisableAtCommit = false,
            revokeIntentAtHolder = null,
            parentCalls = 0;
          const writeOptions = {
            merchant: { ...source, transactions: databaseRunner },
            authentication: {
              authorize: async (input) => {
                assert.equal(input.sessionCookie, cookie);
                assert.equal(input.csrf, csrfToken);
                return { sessionReference: session };
              },
            },
            auditReference: (operation) =>
              f.uuid(String(200000 + Number.parseInt(operation.slice(-12), 16))),
            writeAuthority: async (tx, input) => {
              assert.equal(input.tenantReference, tenant);
              assert.equal(input.brandReference, f.BRAND);
              assert.equal(input.storeReference, f.STORE);
              assert.equal(input.actorReference, f.ACTOR);
              assert.equal(input.sessionReference, session);
              assert.equal(input.permission, "catalog.manage");
              assert.equal(input.owningAction, "catalog.product.manage");
              assert.equal(
                input.actionPermission,
                input.action === "Create" ? "catalog.product.create" : "catalog.product.update",
              );
              if (input.action === "Create")
                assert.equal(input.skuCreationPermission, "catalog.sku.create");
              assert.equal(input.phase, "phase_1");
              assert.equal(
                input.screenId,
                input.action === "Create" ? "CAT-PRODUCT-CREATE" : "CAT-PRODUCT-EDIT",
              );
              assert.equal(
                input.capability,
                input.action === "Create"
                  ? "catalog.cat_product_create"
                  : "catalog.cat_product_edit",
              );
              assert.equal(
                input.purposeCode,
                input.action === "Create"
                  ? "CATALOG_PRODUCT_CREATE"
                  : "CATALOG_PRODUCT_DRAFT_REPLACE",
              );
              assert.deepEqual(
                input.requiredWriteFields,
                input.action === "Create" ? productCreateWriteFields : productDraftWriteFields,
              );
              assert.deepEqual(
                input.requiredReadFields,
                input.action === "Create" ? productCreateResultFields : productDraftResultFields,
              );
              parentCalls++;
              if (revokeIntentAtHolder && parentCalls === 1) {
                await tx.query(
                  "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                  [revokeIntentAtHolder],
                );
              }
              if (!parentAllowed || (parentDenyAtCommit && parentCalls === 2))
                throw new CatalogError("CATALOG_PERMISSION_DENIED");
              if (!parentFeature || (parentDisableAtCommit && parentCalls === 2))
                return "FeatureDisabled";
              await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
                "SyntheticProductWriteParentFieldsPhase:" + f.BRAND,
              ]);
              return "Allowed";
            },
            categoryPolicy: async (tx, input) => {
              assert.equal(input.tenantReference, tenant);
              assert.equal(input.brandReference, f.BRAND);
              assert.equal(input.actorReference, f.ACTOR);
              assert.equal(input.permission, "catalog.product.manage");
              assert.equal(input.referencedPermission, "catalog.manage");
              assert.deepEqual(input.requiredFields, [
                "categoryClassification",
                "categoryReferences",
                "primaryCategoryReference",
              ]);
              assert.deepEqual(input.referencedFields, [
                "categoryReference",
                "brandReference",
                "lifecycle",
              ]);
              if (input.purposeCode === "CATALOG_PRODUCT_CATEGORY_MUTATION") {
                writeCalls++;
                if (revokeSkuAtMutation) {
                  await tx.query(
                    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                    [revokeSkuAtMutation],
                  );
                  revokeSkuAtMutation = null;
                }
                if (denyWriteCommit && writeCalls === 2)
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
              } else assert.equal(input.purposeCode, "CATALOG_PRODUCT_CATEGORY_ACCESS");
              if (!assignmentAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
                "SyntheticProductClassificationPolicy:" + f.BRAND,
              ]);
              return { allowedLifecycles: ["Draft", "Active"] };
            },
          };
          let lifecycleFields = true,
            lifecyclePhase = true,
            lifecycleParentCalls = 0,
            lifecycleDenyCommit = false,
            lifecycleDisableCommit = false;
          const createProduct = createMerchantProductCreationCommand(writeOptions),
            replaceProduct = createMerchantProductDraftCommand(writeOptions),
            lifecycleProduct = createMerchantProductLifecycleCommand({
              ...writeOptions,
              writeAuthority: async (tx, input) => {
                assert.equal(input.tenantReference, tenant);
                assert.equal(input.brandReference, f.BRAND);
                assert.equal(input.storeReference, f.STORE);
                assert.equal(input.actorReference, f.ACTOR);
                assert.equal(input.sessionReference, session);
                assert.equal(input.screenId, "CAT-SKU-DETAIL");
                assert.equal(input.capability, "catalog.cat_sku_detail");
                assert.equal(input.phase, "phase_1");
                assert.deepEqual(input.requiredWriteFields, ["draft.skus.lifecycle", "reasonCode"]);
                assert.equal(typeof input.reasonCode, "string");
                assert.deepEqual(input.requiredReadFields, [
                  "productReference",
                  "aggregateVersion",
                  "lifecycle",
                  "draft.versionReference",
                  "draft.skus.skuReference",
                  "draft.skus.lifecycle",
                ]);
                if (input.intent !== null) {
                  assert.equal(input.intent.action, "activate");
                  assert.equal(input.intent.beforeLifecycle, "Draft");
                  assert.equal(input.intent.actionPermission, "catalog.sku.activate");
                }
                lifecycleParentCalls++;
                if (!lifecycleFields || (lifecycleDenyCommit && lifecycleParentCalls === 4))
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
                if (!lifecyclePhase || (lifecycleDisableCommit && lifecycleParentCalls === 4))
                  return "FeatureDisabled";
                await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
                  "SyntheticLifecycleFieldsPhase:" + f.BRAND,
                ]);
                return "Allowed";
              },
            });
          let baselineHeld = false,
            baselineChecks = 0,
            baselineDenyAtCommit = false,
            revokeBaselineReadAfterSource = null;
          const baselineQuery = createMerchantProductDraftBaselineQuery({
            merchant: { ...source, transactions: databaseRunner },
            authority: {
              async withCurrentProductDraftBaseline(input, work) {
                assert.equal(input.sessionCookie, cookie);
                assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
                assert.equal(input.capability, "catalog.cat_product_edit");
                assert.equal(input.permission, "catalog.manage");
                assert.equal(input.action, "catalog.product.manage");
                assert.equal(input.purposeCode, "CATALOG_PRODUCT_DRAFT_BASELINE_READ");
                assert.deepEqual(input.requiredFields, productDraftBaselineFields);
                baselineHeld = true;
                try {
                  return await work({
                    tenantReference: tenant,
                    brandReference: f.BRAND,
                    storeReference: f.STORE,
                    actorReference: f.ACTOR,
                    sessionReference: session,
                  });
                } finally {
                  baselineHeld = false;
                }
              },
            },
            holdFieldsAndPhaseUntilCommit: async (tx, input) => {
              assert.ok(baselineHeld);
              assert.equal(input.brandReference, f.BRAND);
              assert.equal(input.storeReference, f.STORE);
              assert.equal(input.actorReference, f.ACTOR);
              assert.equal(input.sessionReference, session);
              assert.deepEqual(input.requiredFields, productDraftBaselineFields);
              assert.deepEqual(input.referencedFields, productDraftBaselineReferencedFields);
              baselineChecks++;
              if (revokeBaselineReadAfterSource && baselineChecks === 4)
                await tx.query(
                  "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                  [revokeBaselineReadAfterSource],
                );
              if (baselineDenyAtCommit && baselineChecks === 5)
                throw new CatalogError("CATALOG_PERMISSION_DENIED");
              await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
                "SyntheticDraftBaselineFieldsPhase:" + f.BRAND,
              ]);
            },
            categoryPolicy: writeOptions.categoryPolicy,
            maximumSkus: 100,
            maximumOptionBindings: 100,
          });
          const listQuery = createMerchantProductListQuery({
            merchant: { ...source, transactions: runner },
            cursorKey: Buffer.alloc(32, 23),
            authority: {
              async withCurrentProductList(input, work) {
                assert.equal(input.sessionCookie, cookie);
                assert.equal(input.screenId, "CAT-PRODUCT-LIST");
                assert.equal(input.purposeCode, "CATALOG_PRODUCT_LIST");
                assert.ok(input.requiredFields.includes("category"));
                listHeld = true;
                try {
                  return await work({
                    tenantReference: tenant,
                    brandReference: f.BRAND,
                    storeReference: f.STORE,
                    actorReference: f.ACTOR,
                    sessionReference: session,
                    locale: "en-CA",
                  });
                } finally {
                  listHeld = false;
                }
              },
            },
            categorySource: {
              authorization: productAuthority,
              maximumProducts: 100,
              categorySource: {
                authority,
                maximumCategoryNodes: 100,
                maximumSourceCommits: 100,
                viewAuthority: {
                  async holdUntilTransactionCompletes(_tx, input) {
                    assert.ok(listHeld);
                    assert.equal(input.tenantReference, tenant);
                    assert.equal(input.brandReference, f.BRAND);
                    assert.equal(input.actorReference, f.ACTOR);
                    assert.equal(input.purposeCode, "CATALOG_CATEGORY_PRODUCT_VIEW_READ");
                    assert.deepEqual(input.requiredFields, categoryProductViewFields);
                  },
                },
              },
            },
          });
          const app = express();
          app.use(
            "/merchant",
            createMerchantBffRouter({
              service: {},
              acceptedHost: "merchant.invalid",
              exactOrigin: "https://merchant.invalid",
              categoryTree: normal,
              productCategoryLookup: categoryLookup,
              productDraftBaseline: baselineQuery,
              productCreation: createProduct,
              productDraft: replaceProduct,
              productLifecycle: lifecycleProduct,
              productList: listQuery,
            }),
          );
          const server = app.listen(0, "127.0.0.1");
          await new Promise((resolve) => server.once("listening", resolve));
          try {
            const address = server.address();
            const request = async (filters, encoded = null) =>
              new Promise((resolve, reject) => {
                const req = httpRequest(
                  "http://127.0.0.1:" + address.port + "/merchant/catalog/categories",
                  {
                    method: "GET",
                    headers: {
                      Host: "merchant.invalid",
                      Origin: "https://merchant.invalid",
                      "Sec-Fetch-Site": "same-origin",
                      Cookie: "__Host-bop-merchant=" + cookie,
                      "x-bop-category-tree":
                        encoded ?? Buffer.from(JSON.stringify(filters)).toString("base64url"),
                    },
                  },
                  (response) => {
                    const chunks = [];
                    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    response.on("end", () =>
                      resolve(
                        new globalThis.Response(Buffer.concat(chunks).toString("utf8"), {
                          status: response.statusCode,
                          headers: response.headers,
                        }),
                      ),
                    );
                  },
                );
                req.on("error", reject);
                req.end();
              });
            const lookupFetcher = async (path, options) => {
              assert.ok(
                [
                  "/merchant/catalog/products",
                  "/merchant/catalog/products/category-lookup",
                  "/merchant/catalog/products/draft-baseline",
                ].includes(path),
              );
              assert.equal(options.method, "GET");
              assert.equal(options.credentials, "same-origin");
              assert.equal(options.cache, "no-store");
              assert.equal(options.redirect, "error");
              assert.equal(options.body, undefined);
              return new Promise((resolve, reject) => {
                const req = httpRequest(
                  "http://127.0.0.1:" + address.port + path,
                  {
                    method: options.method,
                    signal: options.signal,
                    headers: {
                      Host: "merchant.invalid",
                      Origin: "https://merchant.invalid",
                      "Sec-Fetch-Site": "same-origin",
                      Cookie: "__Host-bop-merchant=" + cookie,
                      ...Object.fromEntries(new globalThis.Headers(options.headers)),
                    },
                  },
                  (response) => {
                    const chunks = [];
                    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    response.on("end", () =>
                      resolve(
                        new globalThis.Response(Buffer.concat(chunks), {
                          status: response.statusCode,
                          headers: response.headers,
                        }),
                      ),
                    );
                    response.on("error", reject);
                  },
                );
                req.on("error", reject);
                req.end();
              });
            };
            const lookupClient = createProductCategoryLookupClient(lookupFetcher);
            const lookupExpected = {
              brandReference: f.BRAND,
              storeReference: f.STORE,
              locale: "en-CA",
            };
            const loadLookup = (parent = "CAT-PRODUCT-CREATE", expected = lookupExpected) =>
              lookupClient.load(parent, expected, new globalThis.AbortController().signal);
            const requestLookup = async (parentScreenId = "CAT-PRODUCT-CREATE") =>
              lookupFetcher("/merchant/catalog/products/category-lookup", {
                method: "GET",
                credentials: "same-origin",
                cache: "no-store",
                redirect: "error",
                headers: {
                  "x-bop-product-category-lookup": Buffer.from(
                    JSON.stringify({ parentScreenId }),
                  ).toString("base64url"),
                },
              });
            for (const parent of ["CAT-PRODUCT-CREATE", "CAT-PRODUCT-EDIT"]) {
              lookupChecks = 0;
              const view = await loadLookup(parent);
              assert.equal(view.lookup.parentScreenId, parent);
              assert.deepEqual(
                view.lookup.items.map((item) => item.categoryReference),
                [initial.record.aggregate.categoryReference],
              );
              assert.equal(lookupChecks, 4);
            }
            lookupMode = "deny-commit";
            lookupChecks = 0;
            await assert.rejects(loadLookup(), { code: "Denied" });
            lookupChecks = 0;
            const deniedLookup = await requestLookup();
            assert.equal(deniedLookup.status, 403);
            assert.deepEqual(await deniedLookup.json(), {
              error: "product_category_lookup_denied",
            });
            lookupMode = "allow";
            lookupChecks = 0;
            await assert.rejects(
              loadLookup("CAT-PRODUCT-EDIT", { ...lookupExpected, brandReference: foreignBrand }),
              { code: "Unavailable" },
            );
            await assert.rejects(
              loadLookup("CAT-PRODUCT-CREATE", { ...lookupExpected, storeReference: foreignStore }),
              { code: "Unavailable" },
            );
            const agedClient = createProductCategoryLookupClient(
              lookupFetcher,
              () => Date.now() + 5001,
            );
            await assert.rejects(
              agedClient.load(
                "CAT-PRODUCT-CREATE",
                lookupExpected,
                new globalThis.AbortController().signal,
              ),
              { code: "Stale" },
            );
            assert.deepEqual(await counts(), beforeLookup);
            const post = async (
              path,
              command,
              expectedScope = { brandReference: f.BRAND, storeReference: f.STORE },
            ) =>
              new Promise((resolve, reject) => {
                const body = JSON.stringify(command);
                const req = httpRequest(
                  "http://127.0.0.1:" + address.port + path,
                  {
                    method: "POST",
                    headers: {
                      Host: "merchant.invalid",
                      Origin: "https://merchant.invalid",
                      "Sec-Fetch-Site": "same-origin",
                      Cookie: "__Host-bop-merchant=" + cookie,
                      "x-bop-csrf": csrfToken,
                      "x-bop-catalog-scope": Buffer.from(JSON.stringify(expectedScope)).toString(
                        "base64url",
                      ),
                      "Content-Type": "application/json",
                      "Content-Length": Buffer.byteLength(body),
                    },
                  },
                  (response) => {
                    const chunks = [];
                    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    response.on("end", () =>
                      resolve({
                        status: response.statusCode,
                        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                      }),
                    );
                  },
                );
                req.on("error", reject);
                req.end(body);
              });
            const commandFetcher = async (path, options) => {
              assert.ok(
                ["/merchant/catalog/products", "/merchant/catalog/products/draft"].includes(path),
              );
              assert.equal(options.method, "POST");
              assert.equal(options.credentials, "same-origin");
              assert.equal(options.cache, "no-store");
              assert.equal(options.redirect, "error");
              assert.equal(typeof options.body, "string");
              return new Promise((resolve, reject) => {
                const req = httpRequest(
                  "http://127.0.0.1:" + address.port + path,
                  {
                    method: options.method,
                    signal: options.signal,
                    headers: {
                      Host: "merchant.invalid",
                      Origin: "https://merchant.invalid",
                      "Sec-Fetch-Site": "same-origin",
                      Cookie: "__Host-bop-merchant=" + cookie,
                      ...Object.fromEntries(new globalThis.Headers(options.headers)),
                      "Content-Length": Buffer.byteLength(options.body),
                    },
                  },
                  (response) => {
                    const chunks = [];
                    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    response.on("end", () =>
                      resolve(
                        new globalThis.Response(Buffer.concat(chunks), {
                          status: response.statusCode,
                          headers: response.headers,
                        }),
                      ),
                    );
                    response.on("error", reject);
                  },
                );
                req.on("error", reject);
                req.end(options.body);
              });
            };
            const productClient = createProductCommandClient(commandFetcher);
            const filters = {
              search: null,
              lifecycle: null,
              productUsage: null,
              includeArchivedProducts: false,
            };
            const before = await counts();
            const response = await request(filters);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("cache-control"), "no-store");
            const result = await response.json();
            assert.deepEqual(result.scope, { brandReference: f.BRAND, storeReference: f.STORE });
            assert.equal(result.query.tree.classificationCoverage, "Known");
            assert.equal(result.query.tree.items.length, 1);
            assert.equal(
              result.query.tree.items[0].categoryReference,
              initial.record.aggregate.categoryReference,
            );
            assert.deepEqual(result.query.tree.items[0].productCount, {
              status: "Known",
              includingArchived: 0,
              excludingArchived: 0,
            });
            assert.deepEqual(result.query.tree.items[0].menuUse, expectedMenuUse);
            assert.equal(result.query.tree.source.menu.consistency, "StatementSnapshot");
            assert.equal(result.query.tree.source.menu.reviewCategoryCoverage, "Known");
            assert.equal(menuChecks, 3, "Menu source fields remain held through outer COMMIT");
            assert.ok(!JSON.stringify(result).includes(menu));
            assert.ok(!JSON.stringify(result).includes(version));
            assert.equal(productChecks, 3, "Product source checks include outer COMMIT");
            const expected = { brandReference: f.BRAND, storeReference: f.STORE };
            const client = createCategoryTreeClient(async (url, options) => {
              assert.equal(url, "/merchant/catalog/categories");
              assert.equal(options.method, "GET");
              assert.equal(options.credentials, "same-origin");
              assert.equal(options.cache, "no-store");
              assert.equal(options.redirect, "error");
              const encoded = new globalThis.Headers(options.headers).get("x-bop-category-tree");
              assert.equal(typeof encoded, "string");
              return request(null, encoded);
            });
            const clientView = await client.load(
              filters,
              expected,
              new globalThis.AbortController().signal,
            );
            assert.equal(
              clientView.query.tree.items[0].categoryReference,
              initial.record.aggregate.categoryReference,
            );
            assert.deepEqual(
              clientView.query.tree.items[0].productCount,
              result.query.tree.items[0].productCount,
            );
            assert.deepEqual(clientView.query.tree.items[0].menuUse, expectedMenuUse);
            assert.equal(menuChecks, 6);
            assert.ok(Object.isFrozen(clientView.query.tree.items[0].menuUse.reviewed.byLifecycle));
            assert.ok(Object.isFrozen(clientView.query.tree.items[0]));
            assert.equal(
              productChecks,
              6,
              "actual client repeats held source checks through COMMIT",
            );

            assert.deepEqual(await counts(), before);
            const empty = await request({ ...filters, productUsage: "Empty" });
            assert.equal(empty.status, 200);
            assert.deepEqual((await empty.json()).query.matchedCategoryReferences, [
              initial.record.aggregate.categoryReference,
            ]);
            const used = await request({ ...filters, productUsage: "Used" });
            assert.equal(used.status, 200);
            assert.deepEqual((await used.json()).query.matchedCategoryReferences, []);
            const menuChecksBeforeLateDenial = menuChecks;
            menuDenyAt = menuChecks + 3;
            assert.equal((await request(filters)).status, 403);
            assert.equal(
              menuChecks,
              menuChecksBeforeLateDenial + 3,
              "Menu authority can be withdrawn at outer COMMIT after its SQL read",
            );
            assert.deepEqual(await counts(), before);
            menuDenyAt = null;
            menuAllowed = false;
            assert.equal((await request(filters)).status, 403);
            menuAllowed = true;
            productAllowed = false;
            assert.equal((await request(filters)).status, 403);
            productAllowed = true;
            fields = false;
            assert.equal((await request(filters)).status, 403);
            fields = true;
            // Actual normal classified Create/Draft and current read counts; no projection DTO is canned.
            const createInput = {
              internalCode: "NORMAL_CLASSIFIED",
              productType: "PreparedFood",
              defaultLocale: "en-CA",
              localizedNames: { "en-CA": "Synthetic normal classified Product" },
              taxClassificationReference: null,
              skus: [
                {
                  skuCode: "NORMAL_CLASSIFIED_SKU",
                  localizedNames: { "en-CA": "Synthetic normal SKU" },
                  variantSelections: [],
                  unitOfSale: "EACH",
                  unitQuantity: "1",
                },
              ],
              operationReference: f.uuid("16000"),
              categoryClassification: {
                categoryReferences: [initial.record.aggregate.categoryReference],
                primaryCategoryReference: initial.record.aggregate.categoryReference,
              },
            };
            for (const expectedScope of [
              { brandReference: foreignBrand, storeReference: f.STORE },
              { brandReference: f.BRAND, storeReference: targetStore },
            ]) {
              assert.equal(
                (await post("/merchant/catalog/products", createInput, expectedScope)).status,
                403,
              );
              assert.deepEqual(await counts(), before);
            }
            const preparedCreate = productClient.prepareCreate(createInput, expected);
            loseCommitReply = true;
            await assert.rejects(preparedCreate.execute(csrfToken), { code: "OutcomeUnknown" });
            const committedAfterLostReply = await counts();
            assert.equal(committedAfterLostReply.audits, before.audits + 1);
            assert.equal(committedAfterLostReply.events, before.events + 1);
            assignmentAllowed = false;
            await assert.rejects(preparedCreate.execute(csrfToken), {
              code: "OutcomeUnknown",
              attemptCode: "Denied",
            });
            assert.deepEqual(await counts(), committedAfterLostReply);
            assignmentAllowed = true;
            const creation = { status: 200, body: await preparedCreate.execute(csrfToken) };
            assert.equal(creation.body.status, "AlreadyApplied");
            assert.deepEqual(await counts(), committedAfterLostReply);
            assert.ok(Object.isFrozen(creation.body.categoryClassification.categoryReferences));
            assert.equal(creation.status, 200);
            assert.deepEqual(creation.body.scope, {
              brandReference: f.BRAND,
              storeReference: f.STORE,
            });
            assert.equal(creation.body.operationReference, createInput.operationReference);
            assert.deepEqual(
              creation.body.categoryClassification,
              createInput.categoryClassification,
            );
            const afterCreate = await counts();
            assert.equal(afterCreate.audits, before.audits + 1);
            assert.equal(afterCreate.events, before.events + 1);
            for (const classification of [
              {
                categoryReferences: [],
                primaryCategoryReference: initial.record.aggregate.categoryReference,
              },
              {
                categoryReferences: [
                  initial.record.aggregate.categoryReference,
                  initial.record.aggregate.categoryReference,
                ],
                primaryCategoryReference: null,
              },
              { ...createInput.categoryClassification, permission: "Allow" },
            ]) {
              assert.equal(
                (
                  await post("/merchant/catalog/products", {
                    ...createInput,
                    categoryClassification: classification,
                  })
                ).status,
                400,
              );
              assert.deepEqual(await counts(), afterCreate);
            }
            assert.equal(
              (
                await post("/merchant/catalog/products", {
                  ...createInput,
                  actorReference: f.ACTOR,
                })
              ).status,
              400,
            );
            assert.deepEqual(await counts(), afterCreate);
            const replay = await post("/merchant/catalog/products", createInput);
            assert.equal(replay.status, 200);
            assert.deepEqual(replay.body, { ...creation.body, status: "AlreadyApplied" });
            assert.deepEqual(await counts(), afterCreate);
            await generation.rebuild({
              operationReference: f.uuid("16001"),
              actorReference: f.ACTOR,
              observedAt: source.now(),
            });
            const positive = await client.load(
              filters,
              expected,
              new globalThis.AbortController().signal,
            );
            assert.deepEqual(positive.query.tree.items[0].productCount, {
              status: "Known",
              includingArchived: 1,
              excludingArchived: 1,
            });
            const lifecycleInput = {
              productReference: creation.body.productReference,
              skuReference: creation.body.skus[0].skuReference,
              targetLifecycle: "Active",
              reasonCode: "SYNTHETIC_ACTIVATION",
              expectedAggregateVersion: 1,
              operationReference: f.uuid("16005"),
            };
            await assert.rejects(
              createMerchantProductLifecycleCommand({ ...writeOptions, writeAuthority: undefined })(
                {
                  sessionCookie: cookie,
                  csrf: csrfToken,
                  command: lifecycleInput,
                  expectedScope: { brandReference: f.BRAND, storeReference: f.STORE },
                },
              ),
              { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
            );
            assert.deepEqual(await counts(), afterCreate);
            const skuActivatePermission = f.uuid("123"),
              skuActivateGrant = f.uuid("124");
            assert.equal(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).status,
              403,
              "Product manage does not imply SKU Activate",
            );
            assert.deepEqual(await counts(), afterCreate);
            await admin.query(
              "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.sku.activate','Active',1,$2,$2)",
              [skuActivatePermission, f.FROM],
            );
            await admin.query(
              "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
              [
                skuActivateGrant,
                f.STORE_ROLE,
                skuActivatePermission,
                f.BRAND,
                f.STORE,
                f.FROM,
                f.UNTIL,
              ],
            );
            assert.equal(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).status,
              403,
            );
            await admin.query(
              "UPDATE bop_permission.permission_grant SET role_id=$2,store_id=NULL,version=version+1 WHERE grant_id=$1",
              [skuActivateGrant, f.BRAND_ROLE],
            );
            lifecycleFields = false;
            assert.equal(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).status,
              403,
            );
            assert.deepEqual(await counts(), afterCreate);
            lifecycleFields = true;
            lifecyclePhase = false;
            assert.deepEqual(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).body,
              { error: "product_lifecycle_feature_disabled" },
            );
            assert.deepEqual(await counts(), afterCreate);
            lifecyclePhase = true;
            for (const gate of ["Fields", "Phase"]) {
              lifecycleParentCalls = 0;
              lifecycleDenyCommit = gate === "Fields";
              lifecycleDisableCommit = gate === "Phase";
              const writes = productWriteStatements;
              assert.equal(
                (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).status,
                gate === "Fields" ? 403 : 409,
              );
              assert.equal(lifecycleParentCalls, 4);
              assert.ok(productWriteStatements > writes);
              assert.deepEqual(await counts(), afterCreate);
            }
            lifecycleDenyCommit = false;
            lifecycleDisableCommit = false;
            revokeLifecycleAfterWrite = skuActivateGrant;
            const beforeActivateWrites = productWriteStatements;
            assert.equal(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).status,
              403,
            );
            assert.ok(productWriteStatements > beforeActivateWrites);
            assert.deepEqual(await counts(), afterCreate);
            assert.equal(
              (
                await admin.query(
                  "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
                  [skuActivateGrant],
                )
              ).rows[0].lifecycle,
              "Active",
            );
            for (const expectedScope of [
              { brandReference: foreignBrand, storeReference: f.STORE },
              { brandReference: f.BRAND, storeReference: targetStore },
            ]) {
              const reads = productReadStatements,
                writes = productWriteStatements;
              assert.equal(
                (await post("/merchant/catalog/products/lifecycle", lifecycleInput, expectedScope))
                  .status,
                403,
              );
              assert.equal(productReadStatements, reads);
              assert.equal(productWriteStatements, writes);
              assert.deepEqual(await counts(), afterCreate);
            }
            const changedSku = await post("/merchant/catalog/products/lifecycle", lifecycleInput);
            assert.equal(changedSku.status, 200);
            assert.equal(changedSku.body.skuLifecycle, "Active");
            const afterLifecycle = await counts();
            assert.equal(
              (
                await admin.query(
                  "SELECT reason_code FROM platform_audit.audit_record WHERE audit_id=$1",
                  [writeOptions.auditReference(lifecycleInput.operationReference)],
                )
              ).rows[0].reason_code,
              lifecycleInput.reasonCode,
            );
            assert.equal(
              (
                await post("/merchant/catalog/products/lifecycle", {
                  ...lifecycleInput,
                  reasonCode: "SYNTHETIC_OTHER",
                })
              ).status,
              409,
            );
            assert.deepEqual(await counts(), afterLifecycle);
            assert.equal(afterLifecycle.audits, afterCreate.audits + 1);
            assert.deepEqual(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).body,
              { ...changedSku.body, status: "AlreadyApplied" },
            );
            assert.deepEqual(await counts(), afterLifecycle);
            const draft = (
              await admin.query(
                "SELECT snapshot_json->'draft' draft FROM rms_catalog.product_operation_snapshot WHERE operation_id=$1",
                [lifecycleInput.operationReference],
              )
            ).rows[0].draft;
            baselineChecks = 0;
            const baselineRequest = {
              sessionCookie: cookie,
              query: { productReference: creation.body.productReference },
            };
            await generation.rebuild({
              operationReference: f.uuid("16012"),
              actorReference: f.ACTOR,
              observedAt: source.now(),
            });
            const listFilters = {
              search: null,
              lifecycle: null,
              productType: null,
              limit: 50,
              cursor: null,
              includeArchived: false,
              hasActiveSku: null,
              missingTranslationLocale: null,
              updatedFrom: null,
              updatedUntil: null,
              createdFrom: null,
              createdUntil: null,
              sort: "updatedAt",
              direction: "DESC",
              categoryReference: null,
            };
            const listClient = createProductListClient(lookupFetcher, () =>
              Date.parse(source.now()),
            );
            const loadList = () =>
              listClient.load(listFilters, f.STORE, new globalThis.AbortController().signal);
            const beforeList = await counts();
            assert.equal(
              (await loadList()).items[0].productReference,
              creation.body.productReference,
            );
            for (const grant of [grants[3], grants[4], grants[5]]) {
              await admin.query(
                "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                [grant],
              );
              await assert.rejects(loadList(), { code: "Denied" });
              await admin.query(
                "UPDATE bop_permission.permission_grant SET lifecycle='Active',role_id=$2,store_id=$3,version=version+1 WHERE grant_id=$1",
                [grant, f.STORE_ROLE, f.STORE],
              );
              await assert.rejects(loadList(), { code: "Denied" });
              assert.deepEqual(await counts(), beforeList);
              await admin.query(
                "UPDATE bop_permission.permission_grant SET role_id=$2,store_id=NULL,version=version+1 WHERE grant_id=$1",
                [grant, f.BRAND_ROLE],
              );
              assert.equal((await loadList()).items.length, 1);
            }
            const baselineBefore = await counts();
            const baselineClient = createProductDraftBaselineTransportClient(lookupFetcher, () =>
              Date.parse(source.now()),
            );
            const baselineExpected = {
              ...expected,
              productReference: creation.body.productReference,
            };
            const loadBaseline = (selected = baselineExpected) =>
              baselineClient.load(selected, new globalThis.AbortController().signal);
            let currentBaseline = await loadBaseline();
            for (const grant of [grants[3], grants[4], grants[5]]) {
              await admin.query(
                "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                [grant],
              );
              if (grant === grants[3]) {
                lookupChecks = 0;
                await assert.rejects(loadLookup(), { code: "Denied" });
                assert.equal(
                  lookupChecks,
                  0,
                  "Category read denied before lookup field/source holder",
                );
                const deniedRead = await requestLookup();
                assert.equal(deniedRead.status, 403);
                assert.deepEqual(await deniedRead.json(), {
                  error: "product_category_lookup_denied",
                });
              } else {
                baselineChecks = 0;
                await assert.rejects(loadBaseline(), { code: "Denied" });
                assert.equal(
                  baselineChecks,
                  0,
                  "fine Product/SKU read denied before baseline source",
                );
              }
              if (grant !== grants[5]) {
                productChecks = 0;
                await assert.rejects(
                  client.load(filters, expected, new globalThis.AbortController().signal),
                  { code: "Denied" },
                );
                assert.equal(
                  productChecks,
                  0,
                  "fine Category/Product read denied before tree Product source",
                );
              }
              if (grant === grants[4])
                assert.ok(
                  (await loadLookup()).lookup.items.length > 0,
                  "Category lookup read does not require Product read or mutation",
                );
              if (grant === grants[5])
                assert.ok(
                  (await client.load(filters, expected, new globalThis.AbortController().signal))
                    .query.tree.items.length > 0,
                  "count-only tree does not require SKU content read",
                );
              assert.deepEqual(await counts(), baselineBefore);
              await admin.query(
                "UPDATE bop_permission.permission_grant SET lifecycle='Active',role_id=$2,store_id=$3,version=version+1 WHERE grant_id=$1",
                [grant, f.STORE_ROLE, f.STORE],
              );
              if (grant === grants[3]) await assert.rejects(loadLookup(), { code: "Denied" });
              else await assert.rejects(loadBaseline(), { code: "Denied" });
              if (grant !== grants[5])
                await assert.rejects(
                  client.load(filters, expected, new globalThis.AbortController().signal),
                  { code: "Denied" },
                );
              assert.deepEqual(await counts(), baselineBefore);
              await admin.query(
                "UPDATE bop_permission.permission_grant SET role_id=$2,store_id=NULL,version=version+1 WHERE grant_id=$1",
                [grant, f.BRAND_ROLE],
              );
            }
            for (const grant of [grants[4], grants[5]]) {
              baselineChecks = 0;
              const beforeRead = productReadStatements;
              revokeBaselineReadAfterSource = grant;
              await assert.rejects(loadBaseline(), { code: "Denied" });
              revokeBaselineReadAfterSource = null;
              assert.equal(baselineChecks, 4, "final fine read denial before fifth holder");
              assert.ok(
                productReadStatements > beforeRead,
                "baseline owner SQL actually read before final fine denial",
              );
              assert.deepEqual(await counts(), baselineBefore);
              assert.equal(
                (
                  await admin.query(
                    "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
                    [grant],
                  )
                ).rows[0].lifecycle,
                "Active",
              );
            }
            lookupChecks = 0;
            const beforeCategoryRead = categoryReadStatements;
            revokeLookupReadAfterSource = true;
            await assert.rejects(loadLookup(), { code: "Denied" });
            revokeLookupReadAfterSource = false;
            assert.equal(lookupChecks, 3, "fine read denial before final lookup holder");
            assert.ok(
              categoryReadStatements > beforeCategoryRead,
              "Category source actually read before fine denial",
            );
            assert.deepEqual(await counts(), baselineBefore);
            for (const grant of [grants[3], grants[4]]) {
              productChecks = 0;
              const beforeRead = productReadStatements;
              revokeTreeReadAfterProduct = grant;
              await assert.rejects(
                client.load(filters, expected, new globalThis.AbortController().signal),
                { code: "Denied" },
              );
              revokeTreeReadAfterProduct = null;
              assert.ok(
                productReadStatements > beforeRead,
                "Product count source actually read before final fine denial",
              );
              assert.deepEqual(await counts(), baselineBefore);
              assert.equal(
                (
                  await admin.query(
                    "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
                    [grant],
                  )
                ).rows[0].lifecycle,
                "Active",
              );
            }
            baselineChecks = 0;
            const freshBaseline = await loadBaseline();
            assert.deepEqual(freshBaseline.baseline.draft, currentBaseline.baseline.draft);
            currentBaseline = freshBaseline;
            const editingSession = createProductDraftEditingSession(
              currentBaseline,
              baselineExpected,
              Date.parse(source.now()),
            );
            assert.equal(baselineChecks, 5);
            assert.equal(
              currentBaseline.baseline.aggregateVersion,
              changedSku.body.aggregateVersion,
            );
            assert.equal(currentBaseline.baseline.classificationCoverage, "Known");
            assert.deepEqual(currentBaseline.baseline.draft, draft);
            baselineChecks = 0;
            baselineDenyAtCommit = true;
            await assert.rejects(loadBaseline(), { code: "Denied" });
            assert.equal(baselineChecks, 5);
            baselineDenyAtCommit = false;
            assignmentAllowed = false;
            baselineChecks = 0;
            await assert.rejects(loadBaseline(), { code: "Denied" });
            assignmentAllowed = true;
            assert.deepEqual(await counts(), baselineBefore);
            await assert.rejects(
              loadBaseline({ ...baselineExpected, brandReference: foreignBrand }),
              { code: "Unavailable" },
            );
            await assert.rejects(
              loadBaseline({ ...baselineExpected, storeReference: foreignStore }),
              { code: "Unavailable" },
            );
            const agedBaseline = createProductDraftBaselineTransportClient(
              lookupFetcher,
              () => Date.parse(source.now()) + 5001,
            );
            await assert.rejects(
              agedBaseline.load(baselineExpected, new globalThis.AbortController().signal),
              { code: "Stale" },
            );
            const directlyRead = await baselineQuery(baselineRequest);
            assert.deepEqual(
              {
                ...directlyRead,
                baseline: {
                  ...directlyRead.baseline,
                  projection: {
                    ...directlyRead.baseline.projection,
                    asOfUtc: currentBaseline.baseline.projection.asOfUtc,
                  },
                },
              },
              currentBaseline,
            );
            assert.ok(
              Date.parse(directlyRead.baseline.projection.asOfUtc) >=
                Date.parse(currentBaseline.baseline.projection.asOfUtc),
            );
            assert.ok(
              Date.parse(source.now()) - Date.parse(directlyRead.baseline.projection.asOfUtc) <=
                5000,
            );
            assert.deepEqual(await counts(), baselineBefore);
            // Immutable operation snapshot stores the actual Aggregate, including its complete Draft.
            assert.ok(draft);
            const editChoices = await loadLookup("CAT-PRODUCT-EDIT");
            const editedDraft = replaceProductDraftCategorySelection(
              editingSession,
              editingSession.view.baseline.draft,
              { categoryReferences: [], primaryCategoryReference: null },
              editChoices,
              { scope: baselineExpected, locale: "en-CA", observedAt: Date.parse(source.now()) },
            );
            const draftInput = {
              productReference: creation.body.productReference,
              expectedAggregateVersion: editingSession.view.baseline.aggregateVersion,
              operationReference: f.uuid("16002"),
              draft: editedDraft,
            };
            for (const expectedScope of [
              { brandReference: foreignBrand, storeReference: f.STORE },
              { brandReference: f.BRAND, storeReference: targetStore },
            ]) {
              assert.equal(
                (await post("/merchant/catalog/products/draft", draftInput, expectedScope)).status,
                403,
              );
              assert.deepEqual(await counts(), afterLifecycle);
            }
            for (const lifecycle of ["Suspended", "Discontinued", "Archived"]) {
              const invalidLifecycleDraft = {
                ...draftInput,
                draft: {
                  ...draftInput.draft,
                  skus: draftInput.draft.skus.map((sku) => ({ ...sku, lifecycle })),
                },
              };
              assert.equal(
                (await post("/merchant/catalog/products/draft", invalidLifecycleDraft)).status,
                400,
              );
              assert.deepEqual(await counts(), afterLifecycle);
            }
            const preparedDraft = editingSession.prepareSave(
              productClient,
              { operationReference: draftInput.operationReference, draft: editedDraft },
              baselineExpected,
            );
            assert.equal(
              preparedDraft.command.expectedAggregateVersion,
              currentBaseline.baseline.aggregateVersion,
            );
            const replacement = { status: 200, body: await preparedDraft.execute(csrfToken) };
            assert.equal(replacement.body.status, "Applied");
            assert.ok(Object.isFrozen(replacement.body.draft.skus));
            assert.equal(replacement.status, 200);
            assert.deepEqual(replacement.body.scope, {
              brandReference: f.BRAND,
              storeReference: f.STORE,
            });
            assert.equal(replacement.body.operationReference, draftInput.operationReference);
            assert.deepEqual(replacement.body.draft.categoryClassification, {
              categoryReferences: [],
              primaryCategoryReference: null,
            });
            const afterReplace = await counts();
            assert.deepEqual(await preparedDraft.execute(csrfToken), {
              ...replacement.body,
              status: "AlreadyApplied",
            });
            assert.deepEqual(await counts(), afterReplace);
            assert.equal(afterReplace.audits, afterLifecycle.audits + 1);
            assert.equal(afterReplace.events, afterLifecycle.events + 1);
            assert.deepEqual((await post("/merchant/catalog/products/draft", draftInput)).body, {
              ...replacement.body,
              status: "AlreadyApplied",
            });
            assert.deepEqual(await counts(), afterReplace);
            const withoutClassification = { ...replacement.body.draft };
            delete withoutClassification.categoryClassification;
            assert.equal(
              (
                await post("/merchant/catalog/products/draft", {
                  ...draftInput,
                  draft: withoutClassification,
                  expectedAggregateVersion: replacement.body.aggregateVersion,
                  operationReference: f.uuid("16006"),
                })
              ).status,
              400,
            );
            assert.deepEqual(await counts(), afterReplace);
            await generation.rebuild({
              operationReference: f.uuid("16003"),
              actorReference: f.ACTOR,
              observedAt: source.now(),
            });
            const explicitEmpty = await client.load(
              filters,
              expected,
              new globalThis.AbortController().signal,
            );
            assert.deepEqual(explicitEmpty.query.tree.items[0].productCount, {
              status: "Known",
              includingArchived: 0,
              excludingArchived: 0,
            });
            writeCalls = 0;
            denyWriteCommit = true;
            const failedInput = {
              ...createInput,
              internalCode: "NORMAL_REVOKED",
              skus: [{ ...createInput.skus[0], skuCode: "NORMAL_REVOKED_SKU" }],
              operationReference: f.uuid("16004"),
            };
            const deniedWrite = await post("/merchant/catalog/products", failedInput);
            assert.equal(deniedWrite.status, 403);
            assert.equal(writeCalls, 2, "fields revoked at beforeCOMMIT Write recheck");
            assert.deepEqual(await counts(), afterReplace);
            assert.equal(
              (
                await admin.query(
                  "SELECT count(*)::int count FROM rms_catalog.product WHERE internal_code='NORMAL_REVOKED'",
                )
              ).rows[0].count,
              0,
            );
            denyWriteCommit = false;
            parentCalls = 0;
            parentDenyAtCommit = true;
            assert.equal((await post("/merchant/catalog/products", failedInput)).status, 403);
            assert.equal(parentCalls, 2);
            assert.deepEqual(await counts(), afterReplace);
            parentDenyAtCommit = false;
            parentAllowed = false;
            assert.equal((await post("/merchant/catalog/products", failedInput)).status, 403);
            assert.deepEqual(await counts(), afterReplace);
            parentAllowed = true;
            parentFeature = false;
            const disabled = await post("/merchant/catalog/products", failedInput);
            assert.equal(disabled.status, 409);
            assert.deepEqual(disabled.body, { error: "product_creation_feature_disabled" });
            assert.deepEqual(await counts(), afterReplace);
            parentFeature = true;
            parentCalls = 0;
            parentDisableAtCommit = true;
            await assert.rejects(
              productClient.prepareCreate(failedInput, expected).execute(csrfToken),
              { code: "FeatureDisabled" },
            );
            assert.equal(parentCalls, 2);
            assert.deepEqual(await counts(), afterReplace);
            parentDisableAtCommit = false;
            const failedDraft = {
              productReference: replacement.body.productReference,
              expectedAggregateVersion: replacement.body.aggregateVersion,
              operationReference: f.uuid("16009"),
              draft: {
                ...replacement.body.draft,
                localizedNames: { "en-CA": "Synthetic denied Draft" },
              },
            };
            for (const [path, value, priorValue, grant] of [
              ["/merchant/catalog/products", failedInput, createInput, f.uuid("114")],
              ["/merchant/catalog/products", failedInput, createInput, f.uuid("119")],
              ["/merchant/catalog/products/draft", failedDraft, draftInput, f.uuid("115")],
            ]) {
              await admin.query(
                "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                [grant],
              );
              parentCalls = 0;
              assert.equal(
                (await post(path, value)).status,
                403,
                "generic manage and other action grant do not imply exact intent",
              );
              assert.equal(
                (await post(path, priorValue)).status,
                403,
                "original operation replay also needs current intent permission",
              );
              assert.equal(parentCalls, 0, "denied intent never reaches field/Phase holder");
              assert.deepEqual(await counts(), afterReplace);
              await admin.query(
                "UPDATE bop_permission.permission_grant SET lifecycle='Active',role_id=$2,store_id=$3,version=version+1 WHERE grant_id=$1",
                [grant, f.STORE_ROLE, f.STORE],
              );
              assert.equal(
                (await post(path, value)).status,
                403,
                "Store-only intent grant does not replace Brand authority",
              );
              assert.equal(parentCalls, 0);
              assert.deepEqual(await counts(), afterReplace);
              await admin.query(
                "UPDATE bop_permission.permission_grant SET role_id=$2,store_id=NULL,version=version+1 WHERE grant_id=$1",
                [grant, f.BRAND_ROLE],
              );
              parentCalls = 0;
              revokeIntentAtHolder = grant;
              const beforeStatements = productWriteStatements;
              assert.equal(
                (await post(path, value)).status,
                403,
                "exact intent revoked after initial holder is denied at COMMIT",
              );
              revokeIntentAtHolder = null;
              assert.equal(
                parentCalls,
                1,
                "final intent denial occurs before second field/Phase holder",
              );
              assert.ok(
                productWriteStatements > beforeStatements,
                "owning Product writes actually reached transaction before late denial",
              );
              assert.deepEqual(
                await counts(),
                afterReplace,
                "Product/Audit/Event/source rolled back together",
              );
              assert.equal(
                (
                  await admin.query(
                    "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
                    [grant],
                  )
                ).rows[0].lifecycle,
                "Active",
                "in-transaction revocation also rolled back",
              );
            }
            parentCalls = 0;
            for (const expectedAggregateVersion of [2147483647, 2147483648]) {
              const invalidVersion = await post("/merchant/catalog/products/draft", {
                ...failedDraft,
                expectedAggregateVersion,
              });
              assert.equal(invalidVersion.status, 400);
              assert.deepEqual(invalidVersion.body, { error: "product_draft_invalid" });
            }
            assert.equal(
              parentCalls,
              0,
              "invalid caller version never reaches the current write holder",
            );
            assert.deepEqual(await counts(), afterReplace);
            parentAllowed = false;
            assert.equal((await post("/merchant/catalog/products/draft", failedDraft)).status, 403);
            assert.deepEqual(await counts(), afterReplace);
            parentAllowed = true;
            parentCalls = 0;
            parentDenyAtCommit = true;
            assert.equal((await post("/merchant/catalog/products/draft", failedDraft)).status, 403);
            assert.equal(parentCalls, 2);
            assert.deepEqual(await counts(), afterReplace);
            parentDenyAtCommit = false;
            parentCalls = 0;
            parentDisableAtCommit = true;
            await assert.rejects(
              productClient.prepareDraft(failedDraft, expected).execute(csrfToken),
              { code: "FeatureDisabled" },
            );
            assert.equal(parentCalls, 2);
            assert.deepEqual(await counts(), afterReplace);
            parentDisableAtCommit = false;
            const missingDraftParent = createMerchantProductDraftCommand({
              ...writeOptions,
              writeAuthority: undefined,
            });
            await assert.rejects(
              missingDraftParent({
                sessionCookie: cookie,
                csrf: csrfToken,
                command: failedDraft,
                expectedScope: expected,
              }),
              { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
            );
            assert.deepEqual(await counts(), afterReplace);
            const missingParent = createMerchantProductCreationCommand({
              ...writeOptions,
              writeAuthority: undefined,
            });
            await assert.rejects(
              missingParent({
                sessionCookie: cookie,
                csrf: csrfToken,
                command: failedInput,
                expectedScope: expected,
              }),
              { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
            );
            assert.deepEqual(await counts(), afterReplace);
            assignmentAllowed = false;
            assert.equal((await post("/merchant/catalog/products", failedInput)).status, 403);
            assert.deepEqual(await counts(), afterReplace);
            assignmentAllowed = true;
            const noProvider = createMerchantProductCreationCommand({
              ...writeOptions,
              categoryPolicy: undefined,
            });
            await assert.rejects(
              noProvider({
                sessionCookie: cookie,
                csrf: csrfToken,
                command: failedInput,
                expectedScope: { brandReference: f.BRAND, storeReference: f.STORE },
              }),
              { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
            );
            assert.deepEqual(await counts(), afterReplace);
            let editorScope = { ...baselineExpected };
            const editor = createProductDraftEditor({
              expectedScope: baselineExpected,
              currentScope: () => editorScope,
              currentContext: () => 1,
              baseline: baselineClient,
              commands: productClient,
              now: () => Date.parse(source.now()),
            });
            await editor.load(new globalThis.AbortController().signal);
            const beforeEdit = editor.view();
            assert.equal(beforeEdit.status, "Ready");
            assert.equal(beforeEdit.baseline.aggregateVersion, replacement.body.aggregateVersion);
            editor.edit({
              ...beforeEdit.draft,
              localizedNames: {
                ...beforeEdit.draft.localizedNames,
                "en-CA": "Synthetic coordinated edit",
              },
            });
            loseCommitReply = true;
            await assert.rejects(editor.save(f.uuid("16010"), csrfToken), {
              code: "OutcomeUnknown",
            });
            assert.equal(editor.view().pendingSave, true);
            const afterCoordinated = await counts();
            assert.equal(afterCoordinated.audits, afterReplace.audits + 1);
            assert.equal(afterCoordinated.events, afterReplace.events + 1);
            assert.equal(afterCoordinated.product_snapshots, afterReplace.product_snapshots + 1);
            assert.equal(afterCoordinated.product_commits, afterReplace.product_commits + 1);
            assert.throws(() => editor.edit(beforeEdit.draft), { code: "PendingSave" });
            await assert.rejects(editor.save(f.uuid("16011"), csrfToken), { code: "PendingSave" });
            await assert.rejects(editor.discardAndReload(new globalThis.AbortController().signal), {
              code: "PendingSave",
            });
            assert.deepEqual(await counts(), afterCoordinated);
            await editor.retrySave(csrfToken);
            const recovered = editor.view();
            assert.equal(recovered.status, "Ready");
            assert.equal(recovered.pendingSave, false);
            assert.equal(recovered.dirty, false);
            assert.equal(
              recovered.baseline.aggregateVersion,
              beforeEdit.baseline.aggregateVersion + 1,
            );
            assert.equal(recovered.draft.localizedNames["en-CA"], "Synthetic coordinated edit");
            assert.deepEqual(recovered.draft.skus, beforeEdit.draft.skus);
            assert.deepEqual(recovered.draft.optionBindings, beforeEdit.draft.optionBindings);
            assert.deepEqual(
              recovered.draft.categoryClassification,
              beforeEdit.draft.categoryClassification,
            );
            assert.deepEqual(
              await counts(),
              afterCoordinated,
              "exact replay and current baseline read do not duplicate writes",
            );
            editorScope = { ...baselineExpected, storeReference: targetStore };
            assert.equal(editor.view().status, "ScopeChanged");
            assert.equal(editor.view().draft, null);
            await assert.rejects(editor.load(new globalThis.AbortController().signal), {
              code: "ScopeChanged",
            });
            editorScope = { ...baselineExpected };
            await editor.load(new globalThis.AbortController().signal);
            assert.equal(
              editor.view().baseline.aggregateVersion,
              recovered.baseline.aggregateVersion,
            );
            assert.deepEqual(await counts(), afterCoordinated);
            await admin.query(
              "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
              [grants[1]],
            );
            parentCalls = 0;
            assert.equal((await post("/merchant/catalog/products", failedInput)).status, 403);
            assert.equal((await post("/merchant/catalog/products/draft", failedDraft)).status, 403);
            assert.equal(
              parentCalls,
              0,
              "actual revoked Brand parent grant denies before synthetic field/Phase holder",
            );
            assert.deepEqual(await counts(), afterCoordinated);
            lookupChecks = 0;
            await assert.rejects(lookupRequest("CAT-PRODUCT-EDIT"), { code: "Denied" });
            assert.equal(
              lookupChecks,
              0,
              "revoked real Brand catalog.manage denies before synthetic field/Phase policy or owner Category read",
            );
            await assert.rejects(loadLookup("CAT-PRODUCT-EDIT"), { code: "Denied" });
            const revokedLookup = await requestLookup("CAT-PRODUCT-EDIT");
            assert.equal(revokedLookup.status, 403);
            assert.deepEqual(await revokedLookup.json(), {
              error: "product_category_lookup_denied",
            });
            const revoked = await request(filters);
            assert.equal(revoked.status, 403);
            assert.deepEqual(await revoked.json(), { error: "category_tree_denied" });
            await assert.rejects(
              client.load(filters, expected, new globalThis.AbortController().signal),
              { code: "Denied" },
            );
            assert.deepEqual(await counts(), afterCoordinated);
            // Independent SKU intents retain their original meaning after later edits.
            const setSkuGrant = (grant, lifecycle, role = f.BRAND_ROLE, store = null) =>
              admin.query(
                "UPDATE bop_permission.permission_grant SET lifecycle=$2,role_id=$3,store_id=$4,version=version+1 WHERE grant_id=$1",
                [grant, lifecycle, role, store],
              );
            await setSkuGrant(grants[1], "Active");
            const skuUpdatePermission = f.uuid("121"),
              skuUpdateGrant = f.uuid("122"),
              skuCreateGrant = f.uuid("119");
            const currentForSku = await loadBaseline();
            const editSku = {
              productReference: creation.body.productReference,
              expectedAggregateVersion: currentForSku.baseline.aggregateVersion,
              operationReference: f.uuid("16100"),
              draft: {
                ...currentForSku.baseline.draft,
                skus: currentForSku.baseline.draft.skus.map((sku) => ({
                  ...sku,
                  localizedNames: { "en-CA": "Synthetic independent SKU edit" },
                })),
              },
            };
            const beforeSkuEdit = await counts();
            assert.equal(
              (await post("/merchant/catalog/products/draft", editSku)).status,
              403,
              "Product update does not imply SKU update",
            );
            assert.deepEqual(await counts(), beforeSkuEdit);
            await admin.query(
              "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.sku.update','Active',1,$2,$2)",
              [skuUpdatePermission, f.FROM],
            );
            await admin.query(
              "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
              [
                skuUpdateGrant,
                f.STORE_ROLE,
                skuUpdatePermission,
                f.BRAND,
                f.STORE,
                f.FROM,
                f.UNTIL,
              ],
            );
            assert.equal((await post("/merchant/catalog/products/draft", editSku)).status, 403);
            assert.deepEqual(await counts(), beforeSkuEdit);
            await setSkuGrant(skuUpdateGrant, "Active");
            revokeSkuAtMutation = skuUpdateGrant;
            const beforeSkuStatements = productWriteStatements;
            assert.equal((await post("/merchant/catalog/products/draft", editSku)).status, 403);
            assert.ok(
              productWriteStatements > beforeSkuStatements,
              "SKU allowed initially and owning writes executed before late denial",
            );
            assert.deepEqual(await counts(), beforeSkuEdit);
            assert.equal(
              (
                await admin.query(
                  "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
                  [skuUpdateGrant],
                )
              ).rows[0].lifecycle,
              "Active",
            );
            const skuEditReceipt = await post("/merchant/catalog/products/draft", editSku);
            assert.equal(skuEditReceipt.status, 200);
            await setSkuGrant(skuUpdateGrant, "Revoked");
            await setSkuGrant(skuCreateGrant, "Revoked");
            const packet = (receipt, operation, name) => ({
              productReference: creation.body.productReference,
              expectedAggregateVersion: receipt.body.aggregateVersion,
              operationReference: f.uuid(operation),
              draft: { ...receipt.body.draft, localizedNames: { "en-CA": name } },
            });
            const productOnlyReceipt = await post(
              "/merchant/catalog/products/draft",
              packet(skuEditReceipt, "16101", "Synthetic Product after SKU edit"),
            );
            assert.equal(
              productOnlyReceipt.status,
              200,
              "unchanged SKU requires no fabricated mutation permission",
            );
            const afterProductOnly = await counts();
            assert.equal(
              (await post("/merchant/catalog/products/draft", editSku)).status,
              403,
              "old SKU edit keeps original update permission after subsequent Product save",
            );
            assert.deepEqual(await counts(), afterProductOnly);
            await setSkuGrant(skuUpdateGrant, "Active");
            const oldEditReplay = await post("/merchant/catalog/products/draft", editSku);
            assert.equal(oldEditReplay.status, 200);
            assert.deepEqual(oldEditReplay.body, {
              ...skuEditReceipt.body,
              status: "AlreadyApplied",
            });
            assert.deepEqual(await counts(), afterProductOnly);
            const oldSku = productOnlyReceipt.body.draft.skus[0];
            assert.ok(oldSku);
            const addSku = {
              ...packet(productOnlyReceipt, "16102", "Synthetic Product after SKU edit"),
              draft: {
                ...productOnlyReceipt.body.draft,
                skus: [
                  ...productOnlyReceipt.body.draft.skus,
                  {
                    ...oldSku,
                    skuReference: f.uuid("17001"),
                    skuCode: "NORMAL_ADDED_SKU",
                    lifecycle: "Draft",
                    variantSelections: [
                      { dimensionReference: f.uuid("17002"), valueReference: f.uuid("17003") },
                    ],
                  },
                ],
              },
            };
            assert.equal(
              (await post("/merchant/catalog/products/draft", addSku)).status,
              403,
              "SKU update does not imply creation",
            );
            await setSkuGrant(skuCreateGrant, "Active", f.STORE_ROLE, f.STORE);
            assert.equal((await post("/merchant/catalog/products/draft", addSku)).status, 403);
            assert.deepEqual(await counts(), afterProductOnly);
            await setSkuGrant(skuCreateGrant, "Active");
            const addSkuReceipt = await post("/merchant/catalog/products/draft", addSku);
            assert.equal(addSkuReceipt.status, 200);
            await setSkuGrant(skuCreateGrant, "Revoked");
            assert.equal(
              (
                await post(
                  "/merchant/catalog/products/draft",
                  packet(addSkuReceipt, "16103", "Synthetic Product after new SKU"),
                )
              ).status,
              200,
            );
            const afterLaterProduct = await counts();
            assert.equal(
              (await post("/merchant/catalog/products/draft", addSku)).status,
              403,
              "original creation stays creation when target SKU now exists",
            );
            assert.deepEqual(await counts(), afterLaterProduct);
            await setSkuGrant(skuCreateGrant, "Active");
            const oldCreateReplay = await post("/merchant/catalog/products/draft", addSku);
            assert.equal(oldCreateReplay.status, 200);
            assert.deepEqual(oldCreateReplay.body, {
              ...addSkuReceipt.body,
              status: "AlreadyApplied",
            });
            assert.deepEqual(await counts(), afterLaterProduct);
            await setSkuGrant(skuActivateGrant, "Revoked");
            assert.equal(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).status,
              403,
              "original activation remains activation after later state/content",
            );
            assert.deepEqual(await counts(), afterLaterProduct);
            await setSkuGrant(skuActivateGrant, "Active");
            const oldReads = productReadStatements,
              oldWrites = productWriteStatements;
            assert.equal(
              (
                await post("/merchant/catalog/products/lifecycle", lifecycleInput, {
                  brandReference: f.BRAND,
                  storeReference: targetStore,
                })
              ).status,
              403,
            );
            assert.equal(productReadStatements, oldReads);
            assert.equal(productWriteStatements, oldWrites);
            assert.deepEqual(await counts(), afterLaterProduct);
            lifecycleFields = false;
            assert.equal(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).status,
              403,
            );
            assert.deepEqual(await counts(), afterLaterProduct);
            lifecycleFields = true;
            lifecyclePhase = false;
            assert.deepEqual(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).body,
              { error: "product_lifecycle_feature_disabled" },
            );
            assert.deepEqual(await counts(), afterLaterProduct);
            lifecyclePhase = true;
            assert.deepEqual(
              (await post("/merchant/catalog/products/lifecycle", lifecycleInput)).body,
              { ...changedSku.body, status: "AlreadyApplied" },
            );
            assert.deepEqual(await counts(), afterLaterProduct);
          } finally {
            server.closeAllConnections();
            await new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
          return;
        }
        const treePacket = {
          tenantReference: tenant,
          brandReference: f.BRAND,
          actorReference: f.ACTOR,
          purposeCode: "CATALOG_CATEGORY_TREE_VIEW_READ",
          permission: "catalog.manage",
          capability: "catalog.cat_category_tree",
          referencedCapability: "catalog.cat_product_list",
          requiredFields: categoryTreeViewFields,
          observedAt: now,
        };
        const beforeTreeChecks = phaseChecks;
        await runner.run((tx) => authority.holdUntilTransactionCompletes(tx, treePacket));
        assert.equal(
          phaseChecks,
          beforeTreeChecks + 2,
          "tree lease is evaluated again at host COMMIT",
        );
        assert.deepEqual(await counts(), original);
        denyTreeFieldsBeforeCommit = true;
        await assert.rejects(
          runner.run((tx) => authority.holdUntilTransactionCompletes(tx, treePacket)),
          { code: "CATALOG_PERMISSION_DENIED" },
        );
        assert.deepEqual(await counts(), original);
        fields = true;

        const denied = async (n) => {
          catalogQueries = 0;
          await assert.rejects(repository.create(command(n)));
          assert.equal(catalogQueries, 0);
          assert.deepEqual(await counts(), original);
        };
        fields = false;
        await denied(2);
        fields = true;
        association = false;
        await denied(2);
        association = true;
        await admin.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [grants[1]],
        );
        // Even equivalent Store-scoped catalog.manage cannot replace Brand grant.
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [f.uuid("120"), f.STORE_ROLE, permissions[1], f.BRAND, f.STORE, f.FROM, f.UNTIL],
        );
        await denied(2);
        await admin.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
          [grants[1]],
        );
        await admin.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [grants[2]],
        );
        await denied(2);
        await admin.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
          [grants[2]],
        );
        await assert.rejects(repository.create(command(2, [foreignStore])));
        assert.deepEqual(await counts(), original);
        await admin.query(
          "UPDATE bop_tenant.store SET lifecycle='Suspended',version=version+1,updated_at=$2 WHERE store_id=$1",
          [targetStore, f.AT],
        );
        await assert.rejects(repository.create(command(2)));
        assert.deepEqual(await counts(), original);
        await admin.query(
          "UPDATE bop_tenant.store SET lifecycle='Active',version=version+1,updated_at=$2 WHERE store_id=$1",
          [targetStore, f.AT],
        );
        await admin.query(
          "UPDATE bop_membership.store_assignment SET lifecycle='Suspended',version=version+1 WHERE assignment_id=$1",
          [f.STORE_ASSIGNMENT],
        );
        await denied(2);
        await admin.query(
          "UPDATE bop_membership.store_assignment SET lifecycle='Active',version=version+1 WHERE assignment_id=$1",
          [f.STORE_ASSIGNMENT],
        );
        // Real owner row/table locks survive repository return, including target Store.
        await runner.run(async (tx) => {
          const bounded = createPostgresCategoryRepository({
            ...options,
            transactions: { run: (work) => work(tx) },
          });
          await bounded.create(command(2));
          for (const [sql, values] of [
            [
              "SELECT session_id FROM bop_identity.authentication_session WHERE session_id=$1 FOR UPDATE NOWAIT",
              [session],
            ],
            [
              "SELECT store_id FROM bop_tenant.store WHERE store_id=$1 FOR UPDATE NOWAIT",
              [targetStore],
            ],
            ["LOCK TABLE bop_membership.membership IN ROW EXCLUSIVE MODE NOWAIT", []],
            ["LOCK TABLE bop_permission.permission_grant IN ROW EXCLUSIVE MODE NOWAIT", []],
          ]) {
            await admin.query("BEGIN");
            try {
              await assert.rejects(admin.query(sql, values), { code: "55P03" });
            } finally {
              await admin.query("ROLLBACK");
            }
          }
        });
        const beforeExpiry = await counts();
        assert.equal(beforeExpiry.roots, 2);
        await admin.query(
          "UPDATE bop_permission.permission_grant SET effective_until='2026-07-28T12:40:00.000Z',version=version+1 WHERE grant_id=$1",
          [grants[2]],
        );
        // A later read cannot replace pending write authority in the registered COMMIT check.
        expireAfterWork = true;
        await assert.rejects(
          runner.run(async (tx) => {
            const borrowed = { run: (work) => work(tx) };
            await createPostgresCategoryRepository({ ...options, transactions: borrowed }).create(
              command(3),
            );
            const snapshot = await createPostgresCategorySourceStore({
              ...options,
              maximumSourceCommits: 100,
              transactions: borrowed,
            }).loadSnapshot();
            assert.equal(snapshot.categories.length, 3);
          }),
        );
        now = f.AT;
        assert.deepEqual(await counts(), beforeExpiry);
        assert.equal(await repository.load(category(3).categoryReference), null);
        await admin.query(
          "UPDATE bop_permission.permission_grant SET effective_until=$2,version=version+1 WHERE grant_id=$1",
          [grants[2], f.UNTIL],
        );
        assert.deepEqual(await repository.create(initial), initial.record);
        failFieldsBeforeCommit = true;
        await assert.rejects(repository.create(command(4)), {
          code: "CATALOG_DEPENDENCY_UNAVAILABLE",
          message: "catalog is unavailable",
        });
        fields = true;
        assert.deepEqual(await counts(), beforeExpiry);
        // A misconfigured holder cannot bypass the host's mandatory check registration.
        await assert.rejects(
          host.transactions.run(async (tx) => {
            await createPostgresCategoryRepository({
              ...options,
              authority: { holdUntilTransactionCompletes: async () => undefined },
              transactions: { run: (work) => work(tx) },
            }).create(command(5));
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.deepEqual(await counts(), beforeExpiry);
        // Driver failure caught by application code still cannot produce success/COMMIT.
        await assert.rejects(
          runner.run(async (tx) => {
            await createPostgresCategoryRepository({
              ...options,
              transactions: { run: (work) => work(tx) },
            }).create(command(5));
            await tx.query("SELECT 1 / 0", []).catch(() => undefined);
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.deepEqual(await counts(), beforeExpiry);
        assert.ok(phaseChecks > 0);
      } finally {
        await admin.query("DROP OWNED BY " + role).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
        await admin.end();
      }
    });
  },
);
