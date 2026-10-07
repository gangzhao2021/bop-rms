import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { CatalogError, parseProductAggregate } from "../../rms/catalog/src/contracts/product.ts";
import { deriveCatalogProductPublicationContentIdentity } from "../../rms/catalog/src/contracts/product-publication-content.ts";
import { parseProductPublicationCommandV2 } from "../../rms/catalog/src/contracts/product-publication-v2.ts";
import {
  productPublicationCheckCodes,
  productPublicationScopeLevels,
} from "../../rms/catalog/src/contracts/product-publication.ts";
import { catalogProductPublicationAuditAction } from "../../rms/catalog/src/contracts/product-publication-event.ts";
import { bindCatalogProductPublicationValidationContextV2 } from "../../rms/catalog/src/contracts/product-publication-validation-context-v2.ts";
import { buildCatalogProductPublicationReferenceRequestV2 } from "../../rms/catalog/src/contracts/product-publication-reference-request-v2.ts";
import {
  createPostgresProductCreationStore,
  createPostgresProductDraftStore,
} from "../../rms/catalog/src/infrastructure/persistence/product-lifecycle-store.ts";
import { createPostgresProductPublicationStoreV2 } from "../../rms/catalog/src/infrastructure/persistence/product-publication-store.ts";
import { createPostgresProductPublicationReferenceHistorySourceV2 } from "../../rms/catalog/src/infrastructure/persistence/product-reference-history-source-store.ts";
import { createPostgresProductPublicationMenuReferenceSourceV2 } from "../../rms/catalog/src/infrastructure/persistence/menu-reference-source-store.ts";
import { createPostgresProductPublicationBundleReferenceSourceV2 } from "../../rms/catalog/src/infrastructure/persistence/bundle-reference-source-store.ts";
import { createPostgresProductPublicationAvailabilityReferenceSourceV2 } from "../../rms/catalog/src/infrastructure/persistence/availability-reference-source-store.ts";
import {
  createMenuReviewContent,
  createPostgresMenuReviewContentStore,
} from "../../rms/catalog/src/infrastructure/persistence/menu-review-content-store.ts";
import { withIsolatedDatabase } from "./isolated-database.mjs";

const id = (n) => "01902461-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const sourceFactories = {
  Product: createPostgresProductPublicationReferenceHistorySourceV2,
  Availability: createPostgresProductPublicationAvailabilityReferenceSourceV2,
  Bundle: createPostgresProductPublicationBundleReferenceSourceV2,
  Menu: createPostgresProductPublicationMenuReferenceSourceV2,
};
const countsSql = `SELECT
 (SELECT count(*)::int FROM rms_catalog.product) products,
 (SELECT count(*)::int FROM rms_catalog.product_version) versions,
 (SELECT count(*)::int FROM rms_catalog.product_operation_record) operations,
 (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,
 (SELECT count(*)::int FROM rms_catalog.product_source_commit) commits,
 (SELECT count(*)::int FROM platform_audit.audit_record) audit,
 (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,
 (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id),'[]'::jsonb) FROM rms_catalog.product_source_head h) heads,
 (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains`;

/** Synthetic identities, field authority and configured reference content only.
 * Product Create/ReplaceDraft and Menu review saves use actual owning stores.
 * Bundle/Availability have no production mutation repositories: their explicitly
 * synthetic SQL fixtures exercise actual immutable schema/generation triggers.
 * All four publication readers, barriers, RLS, consumer writes and rollback are
 * actual. Complete stored references do not assert applicability or validation. */
export async function exerciseProductPublicationReferenceSourcesV2() {
  await withIsolatedDatabase({ caseId: "wp2421_pub_refs" }, async (context) => {
    const admin = new pg.Client(context.clientConfig),
      competitor = new pg.Client(context.clientConfig),
      role = "wp2421_pubrefs_" + context.runId,
      tenant = id(1),
      brand = id(2),
      actor = id(3),
      past = new Date(Date.now() - 3600000).toISOString(),
      guardStates = new WeakMap();
    assert.match(role, /^wp2421_pubrefs_[a-f0-9]+$/u);
    await Promise.all([admin.connect(), competitor.connect()]);
    let createdRole = false,
      forcedClock = null,
      deniedOwner = null,
      sequence = 10000,
      publicationHead = null;
    const now = () => forcedClock ?? new Date().toISOString(),
      counts = async (tx = admin) => (await tx.query(countsSql, [])).rows[0];
    const registerBeforeCommit = async (tx, guard, finalAssert) => {
      const state = guardStates.get(tx);
      assert(state, "Registration belongs to the actual caller transaction");
      assert.equal(state.phase, "work");
      assert.equal(typeof guard, "function");
      assert.equal(typeof finalAssert, "function");
      const evidence = {
        asyncEntered: 0,
        asyncReturned: 0,
        finalEntered: 0,
        finalReturned: 0,
        finalError: null,
      };
      state.guards.push({
        evidence,
        async guard() {
          evidence.asyncEntered++;
          const result = await guard();
          evidence.asyncReturned++;
          return result;
        },
        finalAssert() {
          evidence.finalEntered++;
          try {
            const result = finalAssert();
            evidence.finalReturned++;
            return result;
          } catch (error) {
            evidence.finalError = error;
            throw error;
          }
        },
      });
    };
    const transactions = {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        const tx = { query: (sql, values = []) => client.query(sql, [...values]) },
          state = { phase: "work", guards: [], constraintsCompleted: false };
        guardStates.set(tx, state);
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          const result = await work(tx);
          state.phase = "async";
          for (const entry of state.guards) assert.equal(await entry.guard(), undefined);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          state.constraintsCompleted = true;
          state.phase = "final";
          for (const entry of state.guards) assert.equal(entry.finalAssert(), undefined);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          guardStates.delete(tx);
          await client.end();
        }
      },
    };
    const audit = (operation, actionCode, targetType, targetId, occurredAt) => ({
      auditId: id(operation + 500000),
      brandId: brand,
      actor: { type: "User", reference: actor },
      actionCode,
      targetType,
      targetId,
      reasonCode: "SYNTHETIC_PUBLICATION_REFERENCES",
      correlationId: id(operation),
      occurredAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "CATALOG_CONFIGURATION",
      retentionPolicyVersion: 1,
    });
    const productOptions = (runner = transactions) => ({
      brandReference: brand,
      transactions: runner,
      authorize: async () => true,
      editorContentAuthority: {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.equal(input.aggregate.brandReference, brand);
        },
      },
    });
    const aggregate = (base, sku = true) =>
      parseProductAggregate({
        productReference: id(base),
        brandReference: brand,
        internalCode: "SYNTH_REFS_" + base,
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: past,
        createdByActorReference: actor,
        updatedAt: past,
        draft: {
          versionReference: id(base + 1),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic stored reference content" },
          taxClassificationReference: null,
          createdAt: past,
          updatedAt: past,
          skus: sku
            ? [
                {
                  skuReference: id(base + 2),
                  productReference: id(base),
                  brandReference: brand,
                  skuCode: "SYNTH_REFS_SKU_" + base,
                  lifecycle: "Draft",
                  localizedNames: { "en-CA": "Synthetic SKU" },
                  variantSelections: [],
                  unitOfSale: "EA",
                  unitQuantity: "1",
                  createdAt: past,
                  createdByActorReference: actor,
                },
              ]
            : [],
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
    const createProduct = async (value, operation, runner = transactions) =>
      createPostgresProductCreationStore(productOptions(runner)).create({
        record: {
          action: "Create",
          operationReference: id(operation),
          operationIntentHash: sha256Hex(canonicalizeRfc8785(value)),
          aggregate: value,
        },
        audit: audit(
          operation,
          "CATALOG_PRODUCT_CREATE",
          "CatalogProduct",
          value.productReference,
          value.createdAt,
        ),
      });
    const makeRequest = (value, duration = 5000) => {
      const observedAt = now(),
        identity = deriveCatalogProductPublicationContentIdentity(value),
        intentBody = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
        replacementIntent = { ...intentBody, digest: hash(intentBody) },
        command = parseProductPublicationCommandV2({
          profile: "CatalogProductPublicationCommandV2",
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "User",
          operationReference: id(++sequence),
          productReference: value.productReference,
          versionReference: value.draft.versionReference,
          expectedProductAggregateVersion: value.aggregateVersion,
          expectedPublicationVersion: publicationHead?.publicationVersion ?? 0,
          action: "Validate",
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
          scopeSet: [
            {
              level: "Store",
              reference: id(40),
              channelCodes: ["WEB"],
              orderTypeCodes: ["PICKUP"],
            },
          ],
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: past, localDateTime: past.slice(0, -1), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
          scheduleReference: null,
          replacementVersionReference: null,
          successorDraftVersionReference: null,
          occurredAt: observedAt,
          reasonCode: "SYNTHETIC_REFERENCE_READ",
          replacementIntent,
          replacementIntentDigest: replacementIntent.digest,
        });
      return buildCatalogProductPublicationReferenceRequestV2(
        bindCatalogProductPublicationValidationContextV2({
          command,
          aggregate: value,
          current: publicationHead,
          content: null,
          observedAt,
        }),
        new Date(Date.parse(observedAt) + duration).toISOString(),
      );
    };
    const source = (owner, tx, request) =>
      sourceFactories[owner]({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        clock: { now },
        transactions: { run: (work) => work(tx) },
        registerBeforeCommit,
        authority: {
          async holdUntilTransactionCompletes(actual, input) {
            assert.equal(actual, tx);
            assert.deepEqual(input.request, request);
            assert.equal(input.permission, "catalog.manage");
            assert.equal(input.requiredScope, "FullBrandScope");
            assert.equal(input.actorKind, "User");
            assert.equal(input.request.originalIntentDigest, hash(request.command));
            assert.equal(input.request.aggregateSnapshotDigest, request.aggregateSnapshotDigest);
            assert(
              input.requiredFields.includes(
                owner === "Product" ? "aggregateSnapshotDigest" : "originalIntentDigest",
              ),
            );
            if (deniedOwner === owner) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
    const readOne = (owner, request, work = async (snapshot) => snapshot) =>
      transactions.run((tx) =>
        source(owner, tx, request).withCurrentSnapshot(request, async (snapshot, actual) => {
          assert.equal(actual, tx);
          assert.deepEqual(snapshot.request, request);
          return work(snapshot, tx);
        }),
      );
    const readAll = (request, work) =>
      transactions.run(async (tx) => {
        const snapshots = {},
          owners = Object.keys(sourceFactories);
        const next = (index) =>
          index === owners.length
            ? work(snapshots, tx)
            : source(owners[index], tx, request).withCurrentSnapshot(
                request,
                async (snapshot, actual) => {
                  assert.equal(actual, tx);
                  assert.deepEqual(snapshot.request, request);
                  snapshots[owners[index]] = snapshot;
                  return next(index + 1);
                },
              );
        return next(0);
      });
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      createdRole = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_publication_operation_abandonment TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_catalog.product,rms_catalog.product_source_head,platform_audit.audit_chain_head TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.product_version_category_assignment TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.menu_review_content,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_publication_revision,rms_catalog.menu_reference_generation,rms_catalog.menu_publication_revision,rms_catalog.menu_publication_release,rms_catalog.menu_release_effective_period,rms_catalog.bundle_reference_generation,rms_catalog.bundle,rms_catalog.bundle_version,rms_catalog.bundle_component_group,rms_catalog.bundle_component_sellable,rms_catalog.availability_rule,rms_catalog.availability_reference_generation TO " +
          role,
      );
      await admin.query("GRANT INSERT ON rms_catalog.product_publication_revision TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_publication_validation_report,rms_catalog.product_scope_retirement_header TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_scope_retirement,rms_catalog.product_scope_journal,rms_catalog.product_publication_content,rms_catalog.product_approval_receipt TO " +
          role,
      );

      const first = aggregate(100),
        other = aggregate(200);
      await createProduct(first, 110);
      await createProduct(other, 210);
      const changedAt = new Date(Date.parse(past) + 1000).toISOString();
      let current = parseProductAggregate({
        ...first,
        aggregateVersion: 2,
        updatedAt: changedAt,
        draft: {
          ...first.draft,
          updatedAt: changedAt,
          editorContent: {
            ...first.draft.editorContent,
            variantDimensions: [
              {
                dimensionReference: id(180),
                code: "SYNTH_OPTIONAL",
                localizedNames: { "en-CA": "Synthetic optional dimension" },
                sortOrder: 0,
                selectionRequirement: "Optional",
                values: [
                  {
                    valueReference: id(181),
                    code: "SYNTH_VALUE",
                    localizedNames: { "en-CA": "Synthetic value" },
                    sortOrder: 0,
                    attributeReference: null,
                    mediaReference: null,
                  },
                ],
              },
            ],
            variantCombinations: [
              { selections: [], disposition: "Valid", skuReference: id(102) },
              {
                selections: [{ dimensionReference: id(180), valueReference: id(181) }],
                disposition: "Valid",
                skuReference: id(103),
              },
            ],
          },
          skus: [
            ...first.draft.skus,
            {
              ...first.draft.skus[0],
              skuReference: id(103),
              skuCode: "SYNTH_REFS_SKU_103",
              createdAt: changedAt,
              variantSelections: [{ dimensionReference: id(180), valueReference: id(181) }],
            },
          ],
        },
      });
      await createPostgresProductDraftStore(productOptions()).commit({
        record: {
          action: "ReplaceDraft",
          operationReference: id(111),
          operationIntentHash: sha256Hex(canonicalizeRfc8785(current)),
          aggregate: current,
        },
        expectedAggregateVersion: 1,
        audit: audit(
          111,
          "CATALOG_PRODUCT_REPLACEDRAFT",
          "CatalogProduct",
          current.productReference,
          changedAt,
        ),
      });
      const emptyRequest = makeRequest(current),
        empty = await readAll(emptyRequest, async (snapshots) => snapshots);
      assert.equal(empty.Product.profile, "RecordedDraftConfigurationsForPublicationV2");
      assert.equal(empty.Product.recordedAggregateVersion, 2);
      assert.equal(empty.Product.publicationCoverage, "Unavailable");
      assert.equal(empty.Product.futureScheduleCoverage, "Unavailable");
      assert.deepEqual(
        empty.Product.configurations
          .map((entry) => [...entry.skuReferences])
          .sort((a, b) => a.length - b.length),
        [[id(102)], [id(102), id(103)]],
      );
      for (const [owner, field] of [
        ["Availability", "rules"],
        ["Bundle", "bundles"],
        ["Menu", "reviews"],
      ]) {
        assert.equal(empty[owner].generation, "0");
        assert.equal(empty[owner].coverage, "CompleteStoredReferences");
        assert.equal(empty[owner].applicability, "Unavailable");
        assert.deepEqual(empty[owner][field], []);
      }

      // Menu parent identity is a synthetic schema fixture; review persistence
      // and Audit use the production owning save. No review approval is claimed.
      await admin.query(
        "INSERT INTO rms_catalog.menu(menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTH_REFS_MENU',1,$3,$4,$3)",
        [id(300), brand, past, actor],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_version(menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)",
        [id(301), id(300), brand, JSON.stringify({ "en-CA": "Synthetic menu" }), past],
      );
      const menu = createPostgresMenuReviewContentStore({
        brandReference: brand,
        menuReference: id(300),
        authorize: async () => true,
      });
      for (const [offset, targets] of [
        [0, [[id(102), id(101)]]],
        [
          1,
          [
            [id(103), id(101)],
            [id(202), id(201)],
          ],
        ],
      ]) {
        const record = createMenuReviewContent({
          lifecycleReference: id(310 + offset),
          configurationDigest: hash({ fixture: offset }),
          createdByActorReference: actor,
          createdAt: past,
          content: {
            brandReference: brand,
            menuReference: id(300),
            menuVersionReference: id(301),
            defaultLocale: "en-CA",
            localizedNames: { "en-CA": "Synthetic menu" },
            storeReferences: [],
            channelCodes: ["WEB"],
            orderTypeCodes: ["PICKUP"],
            sections: [
              {
                sectionReference: id(320),
                internalCode: "SYNTH_SECTION",
                localizedNames: { "en-CA": "Synthetic section" },
                sortOrder: 0,
                sellables: targets.map(([sku, version], index) => ({
                  placementReference: id(330 + offset * 10 + index),
                  sellableReference: sku,
                  productVersionReference: version,
                  localizedNames: { "en-CA": "Synthetic configured reference" },
                  presentationRole: "Standard",
                  sortOrder: index,
                  pinned: false,
                  configuredAvailability: "Unavailable",
                  optionRules: [],
                  allergenDisclosure: {
                    registryVersionReference: id(350),
                    items: [],
                    allergenFreeClaim: false,
                    assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                  },
                })),
              },
            ],
          },
        });
        await transactions.run((tx) =>
          menu.save(
            tx,
            record,
            audit(
              360 + offset,
              "CATALOG_MENU_SNAPSHOT_CREATED",
              "CatalogMenuVersion",
              id(301),
              past,
            ),
          ),
        );
      }
      // Explicit synthetic Bundle and Availability rows, as in their existing
      // native owner fixtures. Generation increments are real trigger results.
      await admin.query("BEGIN");
      try {
        await admin.query(
          "INSERT INTO rms_catalog.bundle(bundle_id,brand_id,internal_code,lifecycle,aggregate_version,current_version_id,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTH_REFS_BUNDLE','Draft',1,$3,$4,$5,$4)",
          [id(400), brand, id(401), past, actor],
        );
        for (const offset of [1, 2]) {
          await admin.query(
            "INSERT INTO rms_catalog.bundle_version(bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,price_mode,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,'{}'::jsonb,'Computed',$5,$5)",
            [
              id(400 + offset),
              id(400),
              brand,
              JSON.stringify({ "en-CA": "Synthetic bundle" }),
              past,
            ],
          );
          await admin.query(
            "INSERT INTO rms_catalog.bundle_component_group(group_id,bundle_version_id,bundle_id,brand_id,stable_code,localized_names_json,minimum_selection,maximum_selection,sort_order) VALUES($1,$2,$3,$4,'SYNTH_GROUP',$5::jsonb,0,2,0)",
            [
              id(410 + offset),
              id(400 + offset),
              id(400),
              brand,
              JSON.stringify({ "en-CA": "Synthetic group" }),
            ],
          );
          for (const [type, reference] of [
            ["Product", current.productReference],
            ["Sku", offset === 1 ? id(103) : id(202)],
          ])
            await admin.query(
              "INSERT INTO rms_catalog.bundle_component_sellable(group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type) VALUES($1,$2,$3,$4,$5,$6)",
              [id(410 + offset), id(400 + offset), id(400), brand, reference, type],
            );
        }
        for (const [offset, sku] of [
          [0, id(103)],
          [1, id(202)],
        ])
          await admin.query(
            "INSERT INTO rms_catalog.availability_rule(availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,sellable_type,store_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,'Draft',$4,'Sku',NULL,'[\"WEB\"]'::jsonb,'[\"PICKUP\"]'::jsonb,$5,NULL,'Unavailable',1,'SYNTHETIC',$5,$6,$5)",
            [id(500 + offset), brand, "SYNTH_REFS_AVAIL_" + offset, sku, past, actor],
          );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }

      const request = makeRequest(current);
      const populated = await readAll(request, async (snapshots, tx) => {
        assert.equal(guardStates.get(tx).guards.length, 4);
        await competitor.query("BEGIN");
        try {
          for (const key of [
            "CatalogProductSource:",
            "CatalogAvailabilityReferenceV1:",
            "CatalogBundleReferenceV1:",
            "CatalogMenuReferenceV1:",
          ])
            assert.equal(
              (
                await competitor.query(
                  "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) allowed",
                  [key + brand],
                )
              ).rows[0].allowed,
              false,
              key + " must remain held",
            );
        } finally {
          await competitor.query("ROLLBACK");
        }
        return snapshots;
      });
      assert.equal(populated.Menu.reviews.length, 2);
      assert.equal(populated.Menu.placements.length, 3);
      assert(
        populated.Menu.placements.some(
          (entry) => entry.skuReference === id(103) && entry.productVersionReference === id(101),
        ),
      );
      assert(
        populated.Menu.placements.some(
          (entry) => entry.skuReference === id(202) && entry.productVersionReference === id(201),
        ),
      );
      assert.equal(populated.Bundle.versions.length, 2);
      assert.equal(populated.Bundle.members.length, 4);
      assert(populated.Bundle.members.some((entry) => entry.sellableReference === id(202)));
      assert.equal(populated.Availability.rules.length, 2);
      assert(populated.Availability.rules.some((entry) => entry.sellableReference === id(202)));
      for (const owner of ["Menu", "Bundle", "Availability"]) {
        const generation = (
          await admin.query(
            "SELECT generation::text FROM rms_catalog." +
              owner.toLowerCase() +
              "_reference_generation WHERE brand_id=$1",
            [brand],
          )
        ).rows[0].generation;
        assert.equal(populated[owner].generation, generation);
        assert(BigInt(generation) > 0n);
        assert.equal(populated[owner].applicability, "Unavailable");
        assert.equal(populated[owner].validUntil, request.validUntil);
      }
      assert.equal(request.originalIntentDigest, hash(request.command));
      assert.equal(request.aggregateSnapshotDigest, hash(current));
      assert.equal(request.currentPublicationDigest, null);

      // Exercise the non-null current-publication SQL branch using a real V2
      // Validate write. Policy and technical facts below are controlled doubles;
      // all technical checks deliberately fail, so this records no eligibility.
      const validationCommand = makeRequest(current).command;
      const validated = await createPostgresProductPublicationStoreV2({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        transactions,
        registerBeforeCommit,
        clock: { now },
        maximumApprovalValiditySeconds: 3600,
        authority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.command.productReference, current.productReference);
            assert(input.requiredPermissions.includes("catalog.product.history.read"));
          },
        },
        editorContentAuthority: productOptions().editorContentAuthority,
        audit: {
          create(publication, action) {
            const operation = Number.parseInt(publication.operationReference.slice(-12), 16);
            return {
              ...audit(
                operation,
                catalogProductPublicationAuditAction(action),
                "Product",
                publication.productReference,
                publication.occurredAt,
              ),
              reasonCode: publication.reasonCode,
            };
          },
        },
        sources: {
          async withCurrentPolicy(_tx, input, work) {
            return work({
              content: {
                profile: "PublishingProductPublicationPolicyV1",
                tenantReference: tenant,
                brandReference: brand,
                familyReference: id(650),
                policyReference: id(651),
                policyVersion: 1,
                scopeOrder: productPublicationScopeLevels,
                approvalPolicy: "Required",
                warningOverrideAllowed: false,
                requiredLocales: ["en-CA"],
                mediaRequirement: "Optional",
                effectiveFrom: past,
                effectiveUntil: null,
              },
              currentPublicationReference: id(652),
              observedAt: input.observedAt,
              validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
            });
          },
          async withHeldCurrentFacts(_tx, input, work) {
            const command = input.command,
              bindings = {
                productAggregateVersion: command.expectedProductAggregateVersion,
                contentDigest: command.contentDigest,
                configurationDigest: command.configurationDigest,
                scopeDigest: hash(command.scopeSet),
                periodDigest: hash(command.effectivePeriod),
              };
            return work({
              now: input.observedAt,
              ...bindings,
              validation: {
                profile: "CatalogProductPublicationValidationV2",
                replacementIntentDigest: command.replacementIntentDigest,
                evidenceReference: id(653),
                ...bindings,
                policyReference: id(651),
                policyVersion: 1,
                approvalPolicy: "Required",
                checks: productPublicationCheckCodes.map((code) => ({
                  code,
                  outcome: code === "ApprovalPolicy" ? "Pending" : "HardError",
                })),
                warningAcknowledgement: null,
                checkedAt: input.observedAt,
                validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
              },
              approval: null,
              reviewReference: null,
              replacement: null,
            });
          },
        },
      }).execute(validationCommand);
      assert.equal(validated.status, "Applied");
      assert.equal(validated.publication.state, "Draft");
      assert.equal(validated.publication.validationDecision, "HardError");
      assert.equal(validated.aggregate.aggregateVersion, current.aggregateVersion + 1);
      assert.equal(validated.scopeRetirementHeader.retirements.length, 0);
      current = validated.aggregate;
      publicationHead = validated.publication;
      const nextRequest = makeRequest(current);
      assert.equal(nextRequest.currentPublicationDigest, hash(publicationHead));
      assert.equal(nextRequest.aggregateSnapshotDigest, hash(current));
      assert.equal(
        nextRequest.command.expectedPublicationVersion,
        publicationHead.publicationVersion,
      );
      const withHead = await readOne("Product", nextRequest);
      assert.equal(withHead.recordedAggregateVersion, current.aggregateVersion);
      assert.deepEqual(withHead.request, nextRequest);
      assert.equal(withHead.configurations.length, 2);
      let tamperedHeadConsumer = false;
      await assert.rejects(
        readOne(
          "Product",
          { ...makeRequest(current), currentPublicationDigest: hash("wrong existing head") },
          async () => {
            tamperedHeadConsumer = true;
          },
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(tamperedHeadConsumer, false);

      // Rehashing a wrong root/current tuple does not make it an owning fact.
      for (const changed of [
        { aggregateSnapshotDigest: hash(first) },
        { originalIntentDigest: hash("different complete command") },
        {
          command: { ...request.command, expectedPublicationVersion: 1 },
          currentPublicationDigest: hash("absent publication"),
        },
      ]) {
        const wrong = { ...makeRequest(current), ...changed };
        if (changed.command) wrong.originalIntentDigest = hash(wrong.command);
        let called = false;
        await assert.rejects(
          readOne("Product", wrong, async () => {
            called = true;
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.equal(called, false);
      }
      for (const owner of Object.keys(sourceFactories)) {
        deniedOwner = owner;
        let called = false;
        await assert.rejects(
          readOne(owner, makeRequest(current), async () => {
            called = true;
          }),
          { code: "CATALOG_PERMISSION_DENIED" },
        );
        assert.equal(called, false);
        deniedOwner = null;

        const before = await counts(),
          original = makeRequest(current);
        let consumer = null,
          tentative = null,
          actualState = null,
          actualGuard = null,
          laterCalls = 0;
        await assert.rejects(
          readOne(owner, original, async (_snapshot, tx) => {
            actualState = guardStates.get(tx);
            actualGuard = actualState.guards[0].evidence;
            const base = ++sequence * 10;
            consumer = await createProduct(aggregate(base, false), base + 5, {
              run: (work) => work(tx),
            });
            await registerBeforeCommit(
              tx,
              async () => {
                laterCalls++;
                tentative = await counts(tx);
                forcedClock = original.validUntil;
              },
              () => undefined,
            );
            return consumer;
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert(consumer, "Actual Product consumer must return before the later guard");
        assert.equal(consumer.action, "Create");
        assert.equal(Date.parse(original.validUntil) - Date.parse(original.observedAt), 5000);
        assert.equal(forcedClock, original.validUntil);
        assert.equal(laterCalls, 1);
        assert.equal(actualState.constraintsCompleted, true);
        assert.equal(actualGuard.asyncEntered, 1);
        assert.equal(actualGuard.asyncReturned, 1);
        assert.equal(actualGuard.finalEntered, 1);
        assert.equal(actualGuard.finalReturned, 0);
        assert(actualGuard.finalError instanceof CatalogError);
        assert.equal(actualGuard.finalError.code, "CATALOG_DEPENDENCY_UNAVAILABLE");
        for (const key of [
          "products",
          "versions",
          "operations",
          "snapshots",
          "commits",
          "audit",
          "outbox",
        ])
          assert.equal(tentative[key], before[key] + 1, owner + " tentative " + key);
        assert.notDeepEqual(tentative.heads, before.heads);
        assert.notDeepEqual(tentative.chains, before.chains);
        assert.deepEqual(await counts(), before);
        forcedClock = null;
      }
    } finally {
      if (createdRole) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await Promise.all([admin.end(), competitor.end()]);
    }
  });
}
