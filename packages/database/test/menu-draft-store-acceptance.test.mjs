import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import {
  createCategoryMenuService,
  createPostgresMenuDraftStore,
  parseCatalogHash,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { productApiGrants } from "../test-support/merchant-api-grants.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";

const { Client } = pg;
const id = (n) => "01909a1d-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The pilot API role's grants for Menu drafts (docs/spec/pilot-acl-additions.json). */
export const menuDraftApiGrants = [
  "GRANT SELECT,INSERT,UPDATE ON rms_catalog.menu,rms_catalog.menu_version TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.menu_section,rms_catalog.sellable_placement,rms_catalog.menu_section_category,rms_catalog.menu_version_store,rms_catalog.menu_version_channel,rms_catalog.menu_version_order_type TO ROLE_",
  "GRANT SELECT,INSERT ON rms_catalog.menu_operation_record,rms_catalog.menu_operation_snapshot TO ROLE_",
  "GRANT SELECT ON rms_catalog.menu_review_content,rms_catalog.menu_publication_revision TO ROLE_",
  "GRANT EXECUTE ON FUNCTION rms_catalog.menu_version_submitted(uuid) TO ROLE_",
];

/** WP-2423 / DEC-MENU-REVISION: Menu drafts, their freeze once submitted, and revisions, under RLS. */
it("creates and edits a Menu draft, freezes it once submitted and revises it", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_menu_draft" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_menu_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      taxClass = id(100),
      at = "2026-09-20T00:00:00.000Z";
    let second = 0;
    const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, ++second)).toISOString();
    let operation = 0x7000;
    const op = () => "019a0000-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      // TEST-ONLY Store tax configuration (products need a tax class the Store covers).
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'TEST_STORE_TAX',1,$4,$5,$4)",
        [id(200), brandReference, storeReference, at, owner],
      );
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
         VALUES($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$5,$7,NULL,'America/Toronto',$8,$9,$10,'2027-01-01T00:00:00Z',$11,$12,$13,$5,'2027-01-01T00:00:00Z',$7)`,
        [
          id(201),
          id(200),
          brandReference,
          storeReference,
          "sha256:" + "a".repeat(64),
          id(202),
          at,
          id(203),
          id(204),
          id(205),
          id(206),
          id(207),
          id(208),
        ],
      );
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code) VALUES($1,$2,$3,$4,$5,$6,'Pickup','Sellable','TEST_TAX','Taxable',0.13,'Exclusive','HalfUp',1,false,NULL,'TEST_TAX_LINE')",
        [id(210), id(201), id(200), brandReference, storeReference, taxClass],
      );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
        [id(201), id(200)],
      );
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of [...productApiGrants, ...menuDraftApiGrants])
        await admin.query(sql.replaceAll("ROLE_", role));
      const persistence = {
        now,
        transactions: {
          async run(work) {
            await admin.query("BEGIN");
            try {
              await admin.query("SET LOCAL ROLE " + role);
              const value = await work(admin);
              await admin.query("COMMIT");
              return value;
            } catch (error) {
              await admin.query("ROLLBACK");
              throw error;
            }
          },
        },
      };
      const scope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: {
          [owner]: [
            "catalog.product.read",
            "catalog.product.create",
            "catalog.product.update",
            "catalog.product.manage",
            "catalog.product.publish",
            "catalog.sku.create",
            "catalog.sku.activate",
          ],
        },
      });
      const products = createMerchantProducts({
        persistence,
        authentication: { authorize: async () => ({ sessionReference: id(7) }) },
        references: { next: op },
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      });
      const latte = await products.command({
        sessionCookie: "c",
        csrf: "c",
        body: {
          action: "Create",
          operationReference: op(),
          internalCode: "LATTE",
          productType: "NonAlcoholicBeverage",
          name: "Latte",
          taxClassificationReference: taxClass,
          sizes: [
            { skuReference: null, skuCode: "LATTE-S", name: "Small" },
            { skuReference: null, skuCode: "LATTE-L", name: "Large" },
          ],
        },
      });
      const [small, large] = latte.product.sizes.map((size) => size.skuReference);

      // The Catalog Menu service over the new repository, in one restricted transaction each.
      const brand = createBrand({
        brandReference,
        code: "MENU_TEST",
        displayName: "Synthetic Menus",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const tenantContext = createTenantContext(
        {
          actorType: "User",
          actorReference: owner,
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
      let sequence = 0x8000;
      const service = (tx) =>
        createCategoryMenuService({
          menus: createPostgresMenuDraftStore({
            brandReference,
            transactions: { run: (work) => work(tx) },
            now,
            authorize: async () => true,
          }),
          categories: {},
          facts: {
            validateStores: async (input) =>
              input.storeReferences.every((store) => store === storeReference),
            validateCategories: async (input) => input.categoryReferences.length === 0,
            validateSellables: async () => true,
          },
          references: {
            generate: () =>
              "019a0001-0000-7000-8000-" + (++sequence).toString(16).padStart(12, "0"),
            hashIntent: (value) =>
              parseCatalogHash(createHash("sha256").update(value).digest("hex")),
            equals: (a, b) => a === b,
          },
          authorization: {
            authorize: async (input) => ({
              tenantContext,
              permission: {
                action: "catalog.menu.manage",
                scopeKind: "Brand",
                effect: "Allow",
                reason: "ROLE_PERMISSION",
                source: "RolePermission",
                policySnapshotReference: id(300),
                policyVersion: 1,
                audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
              },
              audit: {
                auditId: "019a0002-0000-7000-8000-" + (++sequence).toString(16).padStart(12, "0"),
                brandId: brandReference,
                actor: { type: "User", reference: owner },
                actionCode: "CATALOG_MENU_" + input.action.toUpperCase(),
                targetType: "CatalogMenu",
                targetId: input.aggregateReference,
                correlationId: input.operationReference,
                occurredAt: input.observedAt,
                reasonCode: "AUTHORIZED_OPERATION",
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "CONFIGURATION_AUDIT",
                retentionPolicyVersion: 1,
              },
            }),
          },
        });
      const run = (work) => persistence.transactions.run((tx) => work(service(tx)));
      const placement = (sku, sortOrder, presentationRole = "Standard") => ({
        sellableReference: sku,
        sellableType: "Sku",
        presentationRole,
        sortOrder,
        pinned: false,
        localizedNameOverrides: {},
      });
      const createCommand = {
        internalCode: "ALL_DAY",
        draft: {
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "All day" },
          baseMenuReference: null,
          storeReferences: [storeReference],
          channelCodes: ["CUSTOMER_PWA"],
          orderTypeCodes: ["PICKUP", "DINE_IN"],
          sections: [
            {
              internalCode: "COFFEE",
              localizedNames: { "en-CA": "Coffee" },
              sortOrder: 0,
              categoryReferences: [],
              placements: [placement(small, 0)],
            },
          ],
        },
        operationReference: op(),
        requestedAt: now(),
      };
      const created = await run((s) => s.createMenu(createCommand));
      assert.equal(created.status, "Applied");
      const menu = created.aggregate;
      assert.equal(menu.aggregateVersion, 1);
      assert.equal((await run((s) => s.createMenu(createCommand))).status, "AlreadyApplied");

      // Edit the draft in place: add the large size, featured.
      const at2 = now();
      const editCommand = {
        menuReference: menu.menuReference,
        expectedAggregateVersion: 1,
        operationReference: op(),
        requestedAt: at2,
        draft: {
          ...menu.draft,
          updatedAt: at2,
          sections: menu.draft.sections.map((section) => ({
            ...section,
            placements: [
              ...section.placements,
              {
                ...placement(large, 1, "Featured"),
                placementReference: "019a0003-0000-7000-8000-000000000001",
                menuReference: menu.menuReference,
                sectionReference: section.sectionReference,
                brandReference,
                createdAt: at2,
                createdByActorReference: owner,
              },
            ],
          })),
        },
      };
      const edited = await run((s) => s.replaceMenuDraft(editCommand));
      assert.equal(edited.aggregate.aggregateVersion, 2);
      assert.equal(edited.aggregate.draft.sections[0].placements.length, 2);
      assert.equal(edited.aggregate.draft.versionReference, menu.draft.versionReference);
      assert.equal((await run((s) => s.replaceMenuDraft(editCommand))).status, "AlreadyApplied");

      // Revising an unsubmitted draft is refused: keep editing it instead.
      await assert.rejects(
        run((s) =>
          s.reviseMenu({
            menuReference: menu.menuReference,
            expectedAggregateVersion: 2,
            operationReference: op(),
            requestedAt: now(),
          }),
        ),
        (error) =>
          error.code === "CATALOG_DEPENDENCY_UNAVAILABLE" ||
          error.code === "CATALOG_LIFECYCLE_CONFLICT",
      );

      // Submitted (a publication revision exists): its content is frozen, then it is revised.
      await admin.query("SET session_replication_role = replica");
      await admin.query(
        "INSERT INTO rms_catalog.menu_publication_revision(lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES($1,1,$2,$3,$4,$5,'Draft',NULL,NULL,$6)",
        [
          id(500),
          menu.menuReference,
          menu.draft.versionReference,
          brandReference,
          "sha256:" + "c".repeat(64),
          now(),
        ],
      );
      await admin.query("SET session_replication_role = DEFAULT");
      await assert.rejects(
        persistence.transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [brandReference],
          );
          await tx.query("DELETE FROM rms_catalog.sellable_placement WHERE sku_id=$1", [large]);
        }),
        /submitted Menu version cannot change/u,
      );
      const at3 = now();
      await assert.rejects(
        run((s) =>
          s.replaceMenuDraft({
            ...editCommand,
            expectedAggregateVersion: 2,
            operationReference: op(),
            requestedAt: at3,
            draft: { ...edited.aggregate.draft, updatedAt: at3 },
          }),
        ),
      );
      const revised = await run((s) =>
        s.reviseMenu({
          menuReference: menu.menuReference,
          expectedAggregateVersion: 2,
          operationReference: op(),
          requestedAt: now(),
        }),
      );
      assert.equal(revised.aggregate.aggregateVersion, 3);
      assert.notEqual(revised.aggregate.draft.versionReference, menu.draft.versionReference);
      assert.deepEqual(
        revised.aggregate.draft.sections[0].placements.map((p) => [
          p.sellableReference,
          p.presentationRole,
        ]),
        [
          [small, "Standard"],
          [large, "Featured"],
        ],
      );
      // The submitted version keeps its rows; the Menu points at the new version.
      const versions = (
        await admin.query(
          "SELECT v.menu_version_id::text id,v.revision_of_version_id::text of,(m.current_version_id=v.menu_version_id) current,(SELECT count(*) FROM rms_catalog.sellable_placement p JOIN rms_catalog.menu_section s ON s.menu_section_id=p.menu_section_id WHERE s.menu_version_id=v.menu_version_id)::int placements FROM rms_catalog.menu_version v JOIN rms_catalog.menu m ON m.menu_id=v.menu_id ORDER BY v.created_at",
        )
      ).rows;
      assert.deepEqual(versions, [
        { id: menu.draft.versionReference, of: null, current: false, placements: 2 },
        {
          id: revised.aggregate.draft.versionReference,
          of: menu.draft.versionReference,
          current: true,
          placements: 2,
        },
      ]);
      // The new version is editable.
      const at4 = now();
      const trimmed = await run((s) =>
        s.replaceMenuDraft({
          menuReference: menu.menuReference,
          expectedAggregateVersion: 3,
          operationReference: op(),
          requestedAt: at4,
          draft: {
            ...revised.aggregate.draft,
            updatedAt: at4,
            sections: revised.aggregate.draft.sections.map((section) => ({
              ...section,
              placements: section.placements.filter((p) => p.sellableReference === small),
            })),
          },
        }),
      );
      assert.equal(trimmed.aggregate.draft.sections[0].placements.length, 1);
      const audits = (
        await admin.query(
          "SELECT action_code FROM platform_audit.audit_record WHERE target_type='CatalogMenu' ORDER BY occurred_at",
        )
      ).rows.map((row) => row.action_code);
      assert.deepEqual(audits, [
        "CATALOG_MENU_CREATE",
        "CATALOG_MENU_REPLACEDRAFT",
        "CATALOG_MENU_REVISE",
        "CATALOG_MENU_REPLACEDRAFT",
      ]);
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
