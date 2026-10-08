import { exerciseMenuProjectionPublication } from "../test-support/menu-projection-publication.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import {
  createPublishingLifecycleRecord,
  createPublishingScope,
  createPostgresPublishingMutationStore,
} from "../../bop/publishing/src/index.ts";
import {
  createPostgresMenuDraftSource,
  createPostgresMenuCategorySourceStore,
  createPostgresProductMenuSourceStore,
  productMenuSourceFields,
  CatalogError,
  createPostgresMenuReviewProductSource,
  createPostgresAllergenReviewFactsStore,
  validateMenuAllergenProvenance,
  createPostgresMenuReviewContentStore,
  createMenuReviewContent,
  buildReviewedMenuContent,
  createPostgresMenuPublicationRepository,
  createPostgresMenuPublicationEvidenceSource,
} from "../../rms/catalog/src/index.ts";
import { createPostgresCurrentMenuReleaseStore } from "../../rms/catalog/src/infrastructure/persistence/current-menu-release-store.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedPriceMenuOwnerFacts } from "../test-support/price-menu-owner-facts.mjs";
import { createMerchantMenuPublicationCommand } from "../../../apps/api/src/merchant-menu-publication-command.ts";
import { withMenuPublicationHttp } from "../../../apps/api/test-support/menu-publication-http.mjs";
const authority = vi.hoisted(() => ({ resolve: null }));
vi.mock("../../../apps/api/src/merchant-brand-scope.ts", () => ({
  createMerchantBrandScope:
    () =>
    (...args) =>
      authority.resolve(...args),
}));
// Authentication and policy decisions remain synthetic; the HTTP and both owners are actual.
const { Client } = pg;
const id = (n) => "01902405-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("persists Menu review approval publication and archive with exact replay and atomic Audit Outbox", async () => {
  await withIsolatedDatabase({ caseId: "wp2409_menu_source" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2409_menu_source_" + context.runId;
    assert.match(role, /^wp2409_menu_source_[a-f0-9]+$/);
    const at = "2026-09-14T08:00:00.000Z";
    let allowed = true,
      fault = null,
      sequence = 2000;
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA platform_helpers,platform_audit,platform_eventing,bop_publishing TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      const scope = await seedPriceMenuOwnerFacts(
        admin,
        role,
        { brandReference: id(1), entries: [{ sellableReference: id(20) }] },
        id,
        at,
      );
      await admin.query("GRANT SELECT ON rms_catalog.menu_section_category TO " + role);
      await admin.query(
        "INSERT INTO rms_catalog.category VALUES($1,$2,'REVIEW_CATEGORY','Draft',1,'en-CA',$3,'{}',NULL,1,0,'[]',$4,$5,$4)",
        [id(850), id(1), JSON.stringify({ "en-CA": "Synthetic review category" }), at, id(701)],
      );
      await admin.query("INSERT INTO rms_catalog.menu_section_category VALUES($1,$2,$3,$4)", [
        id(804),
        scope.menuReference,
        id(1),
        id(850),
      ]);
      await admin.query("GRANT SELECT,INSERT ON rms_catalog.menu_review_content TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.menu_publication_revision,rms_catalog.menu_publication_release,rms_catalog.menu_release_effective_period,rms_catalog.menu_publication_operation_record,rms_catalog.menu_publication_operation_snapshot,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
      );
      const runner = {
        async acquire() {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("SET ROLE " + role);
            return {
              query: (sql, values) => client.query(sql, [...values]),
              release: () => client.end(),
            };
          } catch (error) {
            await client.end();
            throw error;
          }
        },
        async run(work, readOnly = false) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query(
              readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
            );
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({
              async query(sql, values) {
                const result = await client.query(sql, [...values]);
                if (fault === "audit" && /INSERT INTO platform_audit\.audit_record/.test(sql))
                  throw new Error("synthetic Audit failure");
                if (fault === "event" && /INSERT INTO platform_eventing\.outbox_event/.test(sql))
                  throw new Error("synthetic Outbox failure");
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
      const categorySource = createPostgresMenuCategorySourceStore({
        tenantReference: id(1),
        brandReference: id(1),
        actorReference: id(701),
        transactions: runner,
        clock: { now: () => new Date().toISOString() },
        authority: {
          async holdUntilTransactionCompletes() {
            // Synthetic source-field/Phase lease only; no production authorization claim.
            if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const menuImpactRequest = {
        purposeCode: "CATALOG_LIFECYCLE_REVIEW",
        brandReference: id(1),
        actorReference: id(701),
        productReference: id(802),
        skuReference: null,
        operationReference: id(12500),
        expectedAggregateVersion: 1,
        originalProductVersionReference: id(803),
        beforeLifecycle: "Active",
        targetLifecycle: "Suspended",
        reasonCode: "SYNTHETIC_TEST",
        activeSkuCount: 1,
      };
      let impactCalls = 0,
        impactDeniedAt = 0,
        impactReads = 0;
      const impactOptions = {
        tenantReference: id(900),
        brandReference: id(1),
        actorReference: id(701),
        transactions: {
          run(work) {
            return runner.run((tx) =>
              work({
                async query(sql, values) {
                  if (sql.includes("targetExists")) impactReads++;
                  return tx.query(sql, values);
                },
              }),
            );
          },
        },
        clock: { now: () => new Date().toISOString() },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            void tx;
            impactCalls++;
            assert.equal(input.tenantReference, id(900));
            assert.equal(input.actorReference, id(701));
            assert.equal(input.request.brandReference, id(1));
            assert.equal(input.request.productReference, id(802));
            assert.equal(input.permission, "catalog.manage");
            assert.equal(input.purposeCode, "CATALOG_LIFECYCLE_MENU_SOURCE_READ");
            assert.deepEqual(input.requiredFields, productMenuSourceFields);
            // Synthetic authority only; all source reads and publication rows are actual.
            if (!allowed || impactCalls === impactDeniedAt)
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      };
      const impactSource = createPostgresProductMenuSourceStore(impactOptions);
      assert.deepEqual((await impactSource.loadSnapshot(menuImpactRequest)).reviews, []);
      const initialCategorySource = await categorySource.loadSnapshot();
      assert.equal(initialCategorySource.consistency, "StatementSnapshot");
      assert.equal(initialCategorySource.menus.length, 1);
      assert.deepEqual(initialCategorySource.menus[0].draftCategoryBindings, [
        { sectionReference: id(804), categoryReferences: [id(850)] },
      ]);
      assert.deepEqual(initialCategorySource.menus[0].reviewedSnapshots, []);
      assert.equal(initialCategorySource.reviewCategoryCoverage, "Known");
      await admin.query(
        "UPDATE rms_catalog.product_version SET localized_names_json=$2 WHERE product_version_id=$1",
        [id(803), JSON.stringify({ "en-CA": "Product fallback", "fr-CA": "Produit" })],
      );
      await admin.query("UPDATE rms_catalog.sku SET localized_names_json=$2 WHERE sku_id=$1", [
        id(20),
        JSON.stringify({ "en-CA": "Reviewed item" }),
      ]);
      const readProducts = createPostgresMenuReviewProductSource({
        brandReference: id(1),
        authorize: async () => allowed,
      });
      const productRequest = { sellableReferences: [id(20)], observedAt: at };
      const products = await runner.run((tx) => readProducts(tx, productRequest));
      const product = products[0];
      assert.equal(product.productReference, id(802));
      assert.equal(product.productVersionReference, id(803));
      assert.equal(product.localizedNames["en-CA"], "Reviewed item");
      assert.equal(product.localizedNames["fr-CA"], "Produit");
      assert.equal(product.productLifecycle, "Active");
      assert.equal(product.skuLifecycle, "Active");
      for (const sellableReferences of [[id(999)], [id(20), id(999)], [id(20), id(20)]])
        await assert.rejects(
          runner.run((tx) => readProducts(tx, { ...productRequest, sellableReferences })),
        );
      await assert.rejects(
        runner.run((tx) =>
          createPostgresMenuReviewProductSource({
            brandReference: id(999),
            authorize: async () => true,
          })(tx, productRequest),
        ),
      );
      let productAuthorizations = 0;
      await assert.rejects(
        runner.run((tx) =>
          createPostgresMenuReviewProductSource({
            brandReference: id(1),
            authorize: async () => ++productAuthorizations === 1,
          })(tx, productRequest),
        ),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      for (const changedAt of ["2026-09-14T09:00:00.000Z", "2026-09-14T08:00:00.000001Z"]) {
        await admin.query(
          "UPDATE rms_catalog.product_version SET updated_at=$2 WHERE product_version_id=$1",
          [id(803), changedAt],
        );
        await assert.rejects(
          runner.run((tx) =>
            readProducts(tx, {
              ...productRequest,
              observedAt: "2026-09-14T08:10:00.000Z",
            }),
          ),
        );
      }
      await admin.query(
        "UPDATE rms_catalog.product_version SET updated_at=$2 WHERE product_version_id=$1",
        [id(803), at],
      );
      const owner = await createPostgresMenuDraftSource({
        brandReference: id(1),
        transactions: runner,
        authorize: async () => true,
      }).load(scope.menuReference, at);
      await admin.query(
        "GRANT SELECT,UPDATE ON rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry,rms_catalog.allergen_source_evidence,rms_catalog.allergen_source_assertion TO " +
          role,
      );
      for (const registry of [id(954), id(956)]) {
        await admin.query(
          "INSERT INTO rms_catalog.allergen_registry_version VALUES($1,$2,'CA',$3,$4,$5,'Approved')",
          [registry, id(1), "sha256:" + "a".repeat(64), at, id(701)],
        );
        await admin.query(
          "INSERT INTO rms_catalog.allergen_registry_entry VALUES($1,$2,$3,'MILK',$4)",
          [registry, id(1), id(955), JSON.stringify({ "en-CA": "Milk" })],
        );
      }
      await admin.query(
        "INSERT INTO rms_catalog.allergen_source_evidence VALUES($1,$2,$3,'Product',$4,NULL,$5,$6,$7,'Approved')",
        [
          id(961),
          id(1),
          id(802),
          id(803),
          "sha256:" + "b".repeat(64),
          at,
          "2026-09-15T08:00:00.000Z",
        ],
      );
      await admin.query(
        "INSERT INTO rms_catalog.allergen_source_assertion VALUES($1,$2,$3,$4,'Contains')",
        [id(961), id(1), id(954), id(955)],
      );
      const readAllergens = createPostgresAllergenReviewFactsStore({
        brandReference: id(1),
        authorize: async () => allowed,
      });
      const allergenRequest = {
        registryVersionReference: id(954),
        evidenceReferences: [id(961)],
        defaultLocale: "en-CA",
        observedAt: at,
      };
      const allergenFacts = await runner.run((tx) => readAllergens(tx, allergenRequest));
      assert.equal(allergenFacts.evidence[0].sourceVersionReference, id(803));
      assert.equal(allergenFacts.evidence[0].subjectReference, id(802));
      for (const invalid of [
        { evidenceReferences: [] },
        { evidenceReferences: [id(961), id(999)] },
        { evidenceReferences: [id(961), id(961)] },
        { registryVersionReference: id(956) },
        { observedAt: "2026-09-15T08:00:00.000Z" },
      ])
        await assert.rejects(
          runner.run((tx) => readAllergens(tx, { ...allergenRequest, ...invalid })),
        );
      await assert.rejects(
        runner.run((tx) =>
          createPostgresAllergenReviewFactsStore({
            brandReference: id(999),
            authorize: async () => true,
          })(tx, allergenRequest),
        ),
      );
      let allergenAuthorizations = 0;
      await assert.rejects(
        runner.run((tx) =>
          createPostgresAllergenReviewFactsStore({
            brandReference: id(1),
            authorize: async () => ++allergenAuthorizations === 1,
          })(tx, allergenRequest),
        ),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      const contentStore = createPostgresMenuReviewContentStore({
        brandReference: id(1),
        menuReference: scope.menuReference,
        authorize: async () => allowed,
      });
      // The paths are synthetic owner linkage; Menu/Product and evidence rows are actual.
      const provenance = {
        brandReference: id(1),
        menuVersionReference: id(801),
        defaultLocale: "en-CA",
        ...allergenFacts,
        paths: [
          {
            sellableReference: id(20),
            productVersionReference: product.productVersionReference,
            evidenceReferences: [id(961)],
            optionEvidenceReferences: {},
          },
        ],
      };
      const assembly = {
        menu: owner.aggregate,
        sellables: [{ ...product, optionRules: [] }],
        provenance,
        checkedAt: at,
        validationEvidenceReference: id(951),
      };
      const content = buildReviewedMenuContent(assembly);
      assert.deepEqual(content.categoryBindings, [
        { sectionReference: id(804), categoryReferences: [id(850)] },
      ]);
      const emptyMenu = globalThis.structuredClone(owner.aggregate);
      emptyMenu.draft.sections[0].categoryReferences = [];
      assert.deepEqual(
        buildReviewedMenuContent({ ...assembly, menu: emptyMenu }).categoryBindings,
        [{ sectionReference: id(804), categoryReferences: [] }],
      );
      assert.deepEqual(content.categoryBindings[0].categoryReferences, [id(850)]);
      assert.equal(content.sections[0].sellables[0].localizedNames["fr-CA"], "Produit");
      assert.deepEqual(content.storeReferences, owner.aggregate.draft.storeReferences);
      for (const sellables of [
        [],
        [...assembly.sellables, ...assembly.sellables],
        [{ ...assembly.sellables[0], brandReference: id(999) }],
        [{ ...assembly.sellables[0], productVersionReference: id(999) }],
        [{ ...assembly.sellables[0], optionRules: [{ enabledOptionReferences: [id(998)] }] }],
      ])
        assert.throws(() => buildReviewedMenuContent({ ...assembly, sellables }), {
          code: "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
      for (const patch of [
        { brandReference: id(999) },
        { menuVersionReference: id(999) },
        { defaultLocale: "fr-CA" },
        { paths: [] },
        { paths: [...provenance.paths, ...provenance.paths] },
      ])
        assert.throws(
          () =>
            buildReviewedMenuContent({
              ...assembly,
              provenance: { ...provenance, ...patch },
            }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
      const unavailable = buildReviewedMenuContent({
        ...assembly,
        sellables: [{ ...assembly.sellables[0], skuLifecycle: "Suspended" }],
      });
      assert.equal(unavailable.sections[0].sellables[0].configuredAvailability, "Unavailable");
      const override = globalThis.structuredClone(owner.aggregate);
      override.draft.sections[0].placements[0].localizedNameOverrides = {
        "en-CA": "Menu override",
      };
      const overridden = buildReviewedMenuContent({ ...assembly, menu: override });
      assert.equal(overridden.sections[0].sellables[0].localizedNames["en-CA"], "Menu override");
      assert.equal(overridden.sections[0].sellables[0].localizedNames["fr-CA"], "Produit");
      const contentRecord = createMenuReviewContent({
        lifecycleReference: id(950),
        configurationDigest: owner.configurationDigest,
        createdByActorReference: id(701),
        createdAt: at,
        content,
      });
      const digest = contentRecord.snapshotDigest;
      assert.notEqual(digest, owner.configurationDigest);
      const contentAudit = {
        auditId: id(12000),
        brandId: id(1),
        actor: { type: "User", reference: id(701) },
        actionCode: "CATALOG_MENU_SNAPSHOT_CREATED",
        targetType: "CatalogMenuVersion",
        targetId: id(801),
        correlationId: id(12001),
        occurredAt: at,
        reasonCode: "SYNTHETIC_TEST",
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      };
      fault = "audit";
      await assert.rejects(runner.run((tx) => contentStore.save(tx, contentRecord, contentAudit)));
      fault = null;
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM rms_catalog.menu_review_content")).rows[0]
          .n,
        0,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM platform_audit.audit_record")).rows[0].n,
        0,
      );
      await runner.run((tx) => contentStore.save(tx, contentRecord, contentAudit));
      await runner.run((tx) =>
        contentStore.save(tx, contentRecord, { ...contentAudit, auditId: id(12002) }),
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM platform_audit.audit_record")).rows[0].n,
        1,
      );
      const pendingImpact = await impactSource.loadSnapshot(menuImpactRequest);
      assert.equal(pendingImpact.reviews.length, 1);
      assert.equal(pendingImpact.reviews[0].lifecycle, null);
      assert.deepEqual(pendingImpact.reviews[0].placements, [
        {
          sectionReference: id(804),
          placementReference: owner.aggregate.draft.sections[0].placements[0].placementReference,
          skuReference: id(20),
          productVersionReference: id(803),
        },
      ]);
      assert.deepEqual(
        await runner.run((tx) => contentStore.read(tx, id(801), digest, at)),
        contentRecord,
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT snapshot_json#>'{content,categoryBindings}' bindings FROM rms_catalog.menu_review_content WHERE lifecycle_id=$1",
            [id(950)],
          )
        ).rows[0].bindings,
        content.categoryBindings,
      );
      await assert.rejects(
        runner.run((tx) =>
          contentStore.save(
            tx,
            {
              ...contentRecord,
              snapshotDigest: "sha256:" + "f".repeat(64),
            },
            contentAudit,
          ),
        ),
      );
      await assert.rejects(
        runner.run((tx) =>
          contentStore.save(
            tx,
            createMenuReviewContent({
              ...contentRecord,
              configurationDigest: "sha256:" + "f".repeat(64),
            }),
            contentAudit,
          ),
        ),
        { code: "CATALOG_IDEMPOTENCY_CONFLICT" },
      );
      allowed = false;
      await assert.rejects(
        runner.run((tx) => contentStore.read(tx, id(801), digest, at)),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      allowed = true;
      assert.equal(
        await runner.run((tx) => contentStore.read(tx, id(801), "sha256:" + "f".repeat(64), at)),
        null,
      );
      for (const statement of [
        "UPDATE rms_catalog.menu_review_content SET snapshot_json='{}'",
        "DELETE FROM rms_catalog.menu_review_content",
      ])
        assert.equal((await admin.query(statement)).rowCount, 0);
      await runner.run(async (tx) => {
        for (const [brand, store] of [
          [id(999), ""],
          [id(1), scope.storeReference],
        ]) {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          assert.equal(
            (await tx.query("SELECT * FROM rms_catalog.menu_review_content", [])).rows.length,
            0,
          );
        }
      });
      const publishingScope = createPublishingScope({
        kind: "Brand",
        brandReference: id(1),
        storeReference: null,
      });
      const draft = createPublishingLifecycleRecord({
        lifecycleId: id(950),
        familyReference: scope.menuReference,
        configurationType: "MENU",
        purposeCode: "CUSTOMER_ORDERING",
        snapshotReference: id(801),
        snapshotDigest: digest,
        scope: publishingScope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: at,
        changedAt: at,
      });
      // Synthetic validation/approval decisions; Publishing history, Menu, Audit and event rows are actual.
      const allergenValidation = validateMenuAllergenProvenance({
        snapshot: { ...provenance, snapshotDigest: digest },
        evidenceReference: id(951),
        checkedAt: at,
      });
      assert.deepEqual(
        allergenValidation.disclosures[id(20)],
        contentRecord.content.sections[0].sellables[0].allergenDisclosure,
      );
      const validation = () => allergenValidation.validation;
      const approval = () => ({
        evidenceReference: id(952),
        reviewLifecycleId: id(950),
        reviewVersion: 2,
        snapshotReference: id(801),
        snapshotDigest: digest,
        scope: publishingScope,
        decision: "Accepted",
        approvedActorReference: id(702),
        approvedAt: "2026-09-14T08:01:00.000Z",
        validUntil: "2026-09-15T08:00:00.000Z",
      });
      const binding = {
        tenantReference: id(900),
        brandReference: id(1),
        menuReference: scope.menuReference,
        menuVersionReference: id(801),
        lifecycleReference: id(950),
        snapshotDigest: digest,
        authorize: async () => allowed,
      };
      const source = createPostgresMenuPublicationEvidenceSource(binding);
      const evidence = async (tx, command) => {
        const current = await createPostgresMenuDraftSource({
          brandReference: id(1),
          transactions: { run: (work) => work(tx) },
          authorize: async () => allowed,
        }).load(scope.menuReference, command.requestedAt);
        assert.equal(current.configurationDigest, owner.configurationDigest);
        return source(tx, command);
      };
      const publishing = createPostgresPublishingMutationStore(runner, id(900), publishingScope);
      const persistEvidence = async (operation, current, next, n, extra = {}) => {
        await publishing.commit({
          operation,
          current,
          next,
          expectedVersion: current?.version ?? 1,
          idempotencyKey: id(n),
          release: null,
          supersededReleaseId: null,
          rollbackTargetReleaseId: null,
          validationEvidence: null,
          approvalEvidence: null,
          audit: {
            auditId: id(n + 1),
            brandId: id(1),
            actor: { type: "User", reference: operation === "Approve" ? id(702) : id(701) },
            actionCode: {
              CreateDraft: "PUBLISHING_DRAFT_CREATED",
              SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
              Approve: "PUBLISHING_REVIEW_APPROVED",
            }[operation],
            targetType: "PublishingLifecycle",
            targetId: draft.lifecycleId,
            reasonCode: "SYNTHETIC_TEST",
            correlationId: id(n),
            occurredAt: next.changedAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Confidential",
            retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
            retentionPolicyVersion: 1,
          },
          ...extra,
        });
      };
      await persistEvidence("CreateDraft", null, draft, 10000);
      const inReview = {
        ...draft,
        version: 2,
        state: "InReview",
        validationEvidenceReference: validation().evidenceReference,
      };
      await persistEvidence("SubmitReview", draft, inReview, 10010, {
        validationEvidence: validation(),
      });
      const repository = (transactions) =>
        createPostgresMenuPublicationRepository({
          brandReference: id(1),
          menuReference: scope.menuReference,
          transactions,
          authorize: async () => allowed,
          evidence,
          timingReference: (operation) => id(5000 + Number.parseInt(operation.slice(-12), 16)),
        });
      const brand = createBrand({
        brandReference: id(1),
        code: "MENU_TEST",
        displayName: "Synthetic Menu",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      let now = at,
        actor = id(701),
        scopeKind = "Brand",
        bindingAvailable = true;
      authority.resolve = async (_tx, cookie, session) => {
        assert.equal(cookie, "synthetic-cookie");
        assert.equal(session, id(990));
        return {
          tenantReference: id(900),
          actorReference: actor,
          context: createTenantContext(
            {
              actorType: "User",
              actorReference: actor,
              accountKind: "Workforce",
              status: "Active",
              authenticationMethod: "Oidc",
              verificationLevel: "SingleFactor",
              authenticatedAt: at,
              recentMfaAt: null,
            },
            brand,
            null,
            now,
          ),
          authorizeAction: async (action) => ({
            effect: allowed ? "Allow" : "Deny",
            scopeKind,
            action,
          }),
        };
      };
      const httpCommand = createMerchantMenuPublicationCommand({
        merchant: { transactions: runner, now: () => now },
        authentication: {
          authorize: async (input) => {
            assert.deepEqual(input, { sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" });
            return { sessionReference: id(990) };
          },
        },
        binding: async (tx, input) => {
          assert.deepEqual(input, {
            tenantReference: id(900),
            brandReference: id(1),
            menuReference: scope.menuReference,
            menuVersionReference: id(801),
          });
          return bindingAvailable
            ? contentStore.read(tx, input.menuVersionReference, digest, now)
            : null;
        },
        reference: (purpose, operation) => {
          const n = Number.parseInt(operation.slice(-12), 16);
          return purpose === "Audit"
            ? id(6000 + n)
            : purpose === "Timing"
              ? id(5000 + n)
              : id(sequence++);
        },
      });
      const send = async (command, extra = {}, actorOverride = null) => {
        now = command.requestedAt;
        actor = actorOverride ?? (command.action === "Approve" ? id(702) : id(701));
        const body = { ...command };
        delete body.requestedAt;
        let result;
        await withMenuPublicationHttp(httpCommand, async (post) => {
          result = await post({ ...body, ...extra });
        });
        return result;
      };
      const execute = async (command) => {
        const response = await send(command);
        if (response.status !== 200)
          throw Object.assign(new Error("synthetic HTTP command failed"), {
            status: response.status,
          });
        const saved = await repository(runner).resolveOperation(command.operationReference);
        assert.deepEqual(response.body, {
          status: response.body.status,
          menuReference: command.menuReference,
          menuVersionReference: command.menuVersionReference,
          snapshotDigest: saved.result.lifecycle.snapshotDigest,
          lifecycleVersion: saved.result.lifecycle.version,
          state: saved.result.lifecycle.state,
          releaseReference: saved.result.release?.releaseId ?? null,
        });
        return { status: response.body.status, record: saved.result };
      };
      const command = (action, version, n, time, effectivePeriod = null) => ({
        action,
        expectedVersion: version,
        operationReference: id(n),
        menuReference: scope.menuReference,
        menuVersionReference: id(801),
        snapshotDigest: digest,
        requestedAt: time,
        effectivePeriod,
      });
      const review = command("SubmitReview", 1, 100, at);
      for (const mismatch of [
        { tenantReference: id(999) },
        { brandReference: id(999) },
        { menuReference: id(999) },
        { menuVersionReference: id(999) },
        { lifecycleReference: id(999) },
        { snapshotDigest: "sha256:" + "f".repeat(64) },
      ]) {
        await assert.rejects(
          runner.run((tx) =>
            createPostgresMenuPublicationEvidenceSource({ ...binding, ...mismatch })(tx, review),
          ),
        );
      }
      let authorizationCalls = 0;
      await assert.rejects(
        runner.run((tx) =>
          createPostgresMenuPublicationEvidenceSource({
            ...binding,
            authorize: async () => ++authorizationCalls === 1,
          })(tx, review),
        ),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      for (const injected of [
        { brandReference: id(999) },
        { actorReference: id(999) },
        { requestedAt: at },
        { approvalEvidence: approval() },
      ])
        assert.equal((await send(review, injected)).status, 400);
      scopeKind = "Store";
      assert.equal((await send(review)).status, 403);
      scopeKind = "Brand";
      const reviewed = await execute(review);
      assert.equal(reviewed.record.lifecycle.state, "InReview");
      const approvalHead = {
        ...inReview,
        version: 3,
        state: "Approved",
        approvalEvidenceReference: approval().evidenceReference,
        changedAt: approval().approvedAt,
      };
      await persistEvidence("Approve", inReview, approvalHead, 10020, {
        approvalEvidence: approval(),
      });
      await assert.rejects(runner.run((tx) => source(tx, review)));
      assert.equal(
        (await send(command("Approve", 2, 101, "2026-09-14T08:01:00.000Z"), {}, id(701))).status,
        403,
      );
      const approved = await execute(command("Approve", 2, 101, "2026-09-14T08:01:00.000Z"));
      assert.equal(approved.record.lifecycle.state, "Approved");
      const period = {
        timeZone: "UTC",
        effectiveFrom: {
          instant: "2026-09-14T08:02:00.000Z",
          localDateTime: "2026-09-14T08:02:00.000",
          utcOffsetMinutes: 0,
        },
        effectiveUntil: {
          instant: "2026-09-14T09:02:00.000Z",
          localDateTime: "2026-09-14T09:02:00.000",
          utcOffsetMinutes: 0,
        },
      };
      const publish = command("Publish", 3, 102, "2026-09-14T08:02:00.000Z", period);
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.menu_publication_revision) revisions,(SELECT count(*)::int FROM rms_catalog.menu_publication_operation_snapshot) snapshots,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) events,(SELECT count(*)::int FROM rms_catalog.menu_publication_release) releases",
          )
        ).rows[0];
      const before = { revisions: 2, snapshots: 2, audits: 6, events: 0, releases: 0 };
      assert.deepEqual(await counts(), before);
      // DEC-MENU-REVISION: a submitted version cannot drift from what was reviewed.
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.menu_version SET localized_names_json=$2 WHERE menu_version_id=$1",
          [id(801), JSON.stringify({ "en-CA": "Changed draft" })],
        ),
        /submitted Menu version cannot change/u,
      );
      bindingAvailable = false;
      assert.equal((await send(publish)).status, 503);
      bindingAvailable = true;
      await assert.rejects(
        runner.run((tx) =>
          source(tx, {
            ...publish,
            requestedAt: "2026-09-15T08:00:00.000Z",
          }),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      for (const failure of ["audit", "event"]) {
        fault = failure;
        await assert.rejects(execute(publish));
        assert.deepEqual(await counts(), before);
      }
      fault = null;
      const published = await execute(publish);
      assert.equal(published.record.lifecycle.state, "Published");
      assert.deepEqual(await counts(), {
        revisions: 3,
        snapshots: 3,
        audits: 7,
        events: 1,
        releases: 1,
      });
      const publishedImpact = await impactSource.loadSnapshot(menuImpactRequest);
      assert.equal(publishedImpact.reviews[0].lifecycle.state, "Published");
      assert.equal(
        publishedImpact.reviews[0].releases[0].releaseReference,
        published.record.release.releaseId,
      );
      assert.equal(publishedImpact.reviews[0].releases[0].periods[0].temporalStatus, "Expired");
      assert.notEqual(publishedImpact.digest, pendingImpact.digest);
      assert.equal(JSON.stringify(publishedImpact).includes("allergen"), false);
      assert.equal(JSON.stringify(publishedImpact).includes("localizedNames"), false);
      assert.equal(
        (await impactSource.loadSnapshot({ ...menuImpactRequest, skuReference: id(20) })).reviews
          .length,
        1,
      );
      await assert.rejects(
        impactSource.loadSnapshot({ ...menuImpactRequest, productReference: id(999) }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        impactSource.loadSnapshot({ ...menuImpactRequest, skuReference: id(999) }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      const readsBefore = impactReads;
      impactDeniedAt = impactCalls + 1;
      await assert.rejects(impactSource.loadSnapshot(menuImpactRequest), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      assert.equal(impactReads, readsBefore);
      impactDeniedAt = impactCalls + 2;
      await assert.rejects(impactSource.loadSnapshot(menuImpactRequest), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      assert.equal(impactReads, readsBefore + 1);
      impactDeniedAt = 0;
      const publishedCategorySource = await categorySource.loadSnapshot();
      assert.equal(publishedCategorySource.reviewCategoryCoverage, "Known");
      assert.equal(publishedCategorySource.menus[0].reviewedSnapshots[0].lifecycle, "Published");
      assert.deepEqual(
        publishedCategorySource.menus[0].reviewedSnapshots[0].categoryBindings,
        content.categoryBindings,
      );
      assert.notEqual(publishedCategorySource.sourceDigest, initialCategorySource.sourceDigest);
      const repo = repository(runner);
      assert.equal(await repo.nextReleaseSequence(scope.menuReference), 2);
      assert.equal(
        (await repo.currentRelease(scope.menuReference)).releaseId,
        published.record.release.releaseId,
      );
      assert.equal(await repo.hasEffectiveOverlap(published.record), true);
      assert.equal(
        await repo.hasEffectiveOverlap({
          ...published.record,
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: period.effectiveUntil,
            effectiveUntil: null,
          },
        }),
        false,
      );
      const consumer = createPostgresCurrentMenuReleaseStore(runner, {
        brandReference: id(1),
        storeReference: scope.storeReference,
      });
      const query = {
        menuReference: scope.menuReference,
        channelCode: "WEB",
        orderTypeCode: "PICKUP",
        observedAt: "2026-09-14T08:03:00.000Z",
      };
      assert.equal(
        (await consumer.load(query)).releaseReference,
        published.record.release.releaseId,
      );
      const verifyArchivedDisplay = await exerciseMenuProjectionPublication({
        admin,
        role,
        runner,
        scope: { ...scope, brandReference: id(1) },
        contentStore,
        at: query.observedAt,
        generation: id(980),
      });
      bindingAvailable = false;
      // DEC-MENU-REVISION: the published version cannot be edited in place (a revision is needed).
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.menu_version SET localized_names_json=$2 WHERE menu_version_id=$1",
          [id(801), JSON.stringify({ "en-CA": "Later draft" })],
        ),
        /submitted Menu version cannot change/u,
      );
      const archived = await execute(command("Archive", 4, 103, query.observedAt));
      assert.equal(archived.record.lifecycle.state, "Archived");
      assert.equal(await consumer.load(query), null);
      await verifyArchivedDisplay();
      const exactInput = {
        brandReference: id(1),
        menuReference: scope.menuReference,
        menuVersionReference: id(801),
        releaseReference: published.record.release.releaseId,
        snapshotDigest: digest,
      };
      await admin.query("UPDATE rms_catalog.sku SET localized_names_json=$2 WHERE sku_id=$1", [
        id(20),
        JSON.stringify({ "en-CA": "Later product name" }),
      ]);
      const currentProduct = (
        await runner.run((tx) =>
          readProducts(tx, { ...productRequest, observedAt: query.observedAt }),
        )
      )[0];
      assert.equal(currentProduct.localizedNames["en-CA"], "Later product name");
      const retained = await runner.run((tx) => contentStore.loadExact(tx, exactInput));
      assert.equal(retained.sections[0].sellables[0].localizedNames["en-CA"], "Reviewed item");
      assert.equal(retained.localizedNames["en-CA"], "Synthetic");
      assert.equal(retained.sections[0].sellables[0].localizedNames["fr-CA"], "Produit");
      assert.equal(retained.sections[0].sellables[0].allergenDisclosure.items[0].code, "MILK");
      assert.equal(retained.effectiveFrom, period.effectiveFrom.instant);
      assert.equal(retained.effectiveUntil, period.effectiveUntil.instant);
      assert.equal(
        await runner.run((tx) =>
          contentStore.loadExact(tx, { ...exactInput, releaseReference: id(999) }),
        ),
        null,
      );
      assert.equal(
        await runner.run((tx) =>
          contentStore.loadExact(tx, { ...exactInput, snapshotDigest: "sha256:" + "f".repeat(64) }),
        ),
        null,
      );
      await assert.rejects(
        runner.run((tx) => contentStore.loadExact(tx, { ...exactInput, brandReference: id(999) })),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      assert.deepEqual(await execute({ ...review, requestedAt: "2026-09-16T08:00:00.000Z" }), {
        status: "AlreadyApplied",
        record: reviewed.record,
      });
      assert.deepEqual(await execute({ ...publish, requestedAt: "2026-09-16T08:00:00.000Z" }), {
        status: "AlreadyApplied",
        record: published.record,
      });
      await assert.rejects(execute({ ...review, snapshotDigest: "sha256:" + "b".repeat(64) }), {
        status: 409,
      });
      await assert.rejects(execute(command("Archive", 4, 104, query.observedAt)), {
        status: 409,
      });
      allowed = false;
      assert.equal((await send(review)).status, 403);
      await assert.rejects(repo.resolveOperation(review.operationReference), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      allowed = true;
      assert.equal((await repo.load(id(801))).lifecycle.state, "Archived");
      const archivedImpact = await impactSource.loadSnapshot(menuImpactRequest);
      assert.equal(archivedImpact.reviews[0].lifecycle.state, "Archived");
      assert.equal(archivedImpact.reviews[0].releases.length, 1);
      assert.notEqual(archivedImpact.digest, publishedImpact.digest);
      assert.equal(
        (await impactSource.loadSnapshot(menuImpactRequest)).digest,
        archivedImpact.digest,
      );
      // Actual orphan coverage path within rolled-back synthetic fixture transaction.
      await assert.rejects(
        runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [id(1)],
          );
          await tx.query(
            "INSERT INTO rms_catalog.menu_publication_revision(lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,changed_at) VALUES($1,1,$2,$3,$4,$5,'Draft',$6)",
            [id(12501), scope.menuReference, id(801), id(1), "sha256:" + "e".repeat(64), at],
          );
          const source = createPostgresProductMenuSourceStore({
            ...impactOptions,
            transactions: { run: (work) => work(tx) },
          });
          await assert.rejects(source.loadSnapshot(menuImpactRequest), {
            code: "CATALOG_DEPENDENCY_UNAVAILABLE",
          });
          throw new Error("synthetic orphan transaction rollback");
        }),
        /synthetic orphan transaction rollback/,
      );
      assert.equal(
        (await impactSource.loadSnapshot(menuImpactRequest)).digest,
        archivedImpact.digest,
      );
      const archivedCategorySource = await categorySource.loadSnapshot();
      assert.equal(archivedCategorySource.menus[0].reviewedSnapshots[0].lifecycle, "Archived");
      assert.notEqual(archivedCategorySource.sourceDigest, publishedCategorySource.sourceDigest);
      assert.deepEqual(
        (await categorySource.loadSnapshot()).sourceDigest,
        archivedCategorySource.sourceDigest,
      );
      allowed = false;
      await assert.rejects(categorySource.loadSnapshot(), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      allowed = true;
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_catalog.menu_publication_operation_snapshot SET operation_json='{}'",
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("DELETE FROM rms_catalog.menu_publication_operation_snapshot")).rowCount,
        0,
      );
      await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [id(999)],
        );
        assert.equal(
          (await tx.query("SELECT * FROM rms_catalog.menu_publication_operation_snapshot", [])).rows
            .length,
          0,
        );
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(1), scope.storeReference],
        );
        assert.equal(
          (await tx.query("SELECT * FROM rms_catalog.menu_publication_operation_snapshot", [])).rows
            .length,
          0,
        );
      });
      await admin.query(
        "INSERT INTO rms_catalog.menu_publication_operation_record VALUES($1,$2,$3,$4,'Archive',$5,5,$6)",
        [
          id(999),
          id(1),
          scope.menuReference,
          id(801),
          "sha256:" + "f".repeat(64),
          query.observedAt,
        ],
      );
      await assert.rejects(repo.resolveOperation(id(999)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), {
        revisions: 4,
        snapshots: 4,
        audits: 8,
        events: 1,
        releases: 1,
      });
      // Legacy compatibility is explicit unknown, never backfilled from current Draft.
      const legacyContent = globalThis.structuredClone(content);
      delete legacyContent.categoryBindings;
      const legacyReview = createMenuReviewContent({
        ...contentRecord,
        lifecycleReference: id(956),
        content: legacyContent,
      });
      await runner.run((tx) =>
        contentStore.save(tx, legacyReview, { ...contentAudit, auditId: id(12003) }),
      );
      const legacySource = await categorySource.loadSnapshot();
      assert.equal(legacySource.reviewCategoryCoverage, "Unavailable");
      assert.equal(legacySource.menus[0].reviewedSnapshots.length, 2);
      const legacySnapshot = legacySource.menus[0].reviewedSnapshots.find(
        (record) => record.lifecycleReference === id(956),
      );
      assert.equal(Object.hasOwn(legacySnapshot, "categoryBindings"), false);
      assert.equal(legacySnapshot.lifecycle, null);
      // Stored schedule fixture, not a new approval or production activation.
      const scheduleAt = new Date().toISOString(),
        currentFrom = new Date(Date.now() - 1000).toISOString(),
        currentUntil = new Date(Date.now() + 60000).toISOString(),
        futureFrom = new Date(Date.now() + 86400000).toISOString(),
        futureUntil = new Date(Date.now() + 90000000).toISOString();
      for (const [timing, from, until] of [
        [12504, currentFrom, currentUntil],
        [12505, futureFrom, futureUntil],
      ]) {
        await admin.query(
          "INSERT INTO rms_catalog.menu_release_effective_period(timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            id(timing),
            published.record.release.releaseId,
            scope.menuReference,
            id(1),
            "UTC",
            from,
            until,
            "sha256:" + "d".repeat(64),
            id(952),
            scheduleAt,
          ],
        );
      }
      const scheduledImpact = await impactSource.loadSnapshot(menuImpactRequest),
        scheduledReview = scheduledImpact.reviews.find((r) => r.reviewReference === id(950));
      assert.equal(scheduledReview.lifecycle.state, "Archived");
      assert.deepEqual(scheduledReview.releases[0].periods.map((p) => p.temporalStatus).sort(), [
        "Effective",
        "Expired",
        "Future",
      ]);
      assert.notEqual(scheduledImpact.digest, archivedImpact.digest);
      const legacyImpact = await impactSource.loadSnapshot(menuImpactRequest);
      assert.equal(legacyImpact.reviews.length, 2);
      assert.equal(legacyImpact.reviews.find((r) => r.reviewReference === id(956)).lifecycle, null);
      assert.equal(
        legacyImpact.reviews.every((r) => r.placements.length === 1),
        true,
      );
      // Malformed minimal immutable review is deliberately isolated negative data.
      // Missing sections cannot be target-filtered into false empty impact.
      const malformed = {
        lifecycleReference: id(12502),
        snapshotDigest: "sha256:" + "f".repeat(64),
        createdAt: at,
        content: {
          brandReference: id(1),
          menuReference: scope.menuReference,
          menuVersionReference: id(801),
        },
      };
      await admin.query(
        "INSERT INTO rms_catalog.menu_review_content(lifecycle_id,brand_id,menu_id,menu_version_id,snapshot_digest,snapshot_json,audit_reference) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
        [
          id(12502),
          id(1),
          scope.menuReference,
          id(801),
          malformed.snapshotDigest,
          JSON.stringify(malformed),
          id(12503),
        ],
      );
      await assert.rejects(impactSource.loadSnapshot(menuImpactRequest), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });

      assert.deepEqual(legacySource.menus[0].draftCategoryBindings[0].categoryReferences, [
        id(850),
      ]);
      assert.deepEqual(
        (await runner.run((tx) => contentStore.read(tx, id(801), digest, at))).content
          .categoryBindings,
        content.categoryBindings,
      );
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
