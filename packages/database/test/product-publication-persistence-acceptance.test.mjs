import { exerciseProductAuthoringResolution } from "../test-support/product-authoring-resolution.mjs";
import { exerciseSellingUnitRegistry } from "../test-support/selling-unit-registry.mjs";
import { exerciseProductPublicationValidationReport } from "../test-support/product-publication-validation-report.mjs";
import { exerciseProductPublicationResolution } from "../test-support/product-publication-resolution.mjs";
import { exerciseProductPublicationCrossDomainReferencesV2 } from "../test-support/product-publication-cross-domain-references-v2.mjs";
import { exerciseCurrentApprovalDecisionHttp } from "../test-support/product-current-approval-decision-http.mjs";
import { exerciseProductScopeRetirement } from "../test-support/product-scope-retirement.mjs";
import { exerciseProductTaxClassificationRegistry } from "../test-support/product-tax-classification-registry.mjs";
import { exerciseProductPublicationReferenceSourcesV2 } from "../test-support/product-publication-reference-sources-v2.mjs";
import { createPublicationNativeHttpClient } from "../test-support/product-publication-client-http.mjs";
import { createCompleteDraftNativeHttpClient } from "../test-support/product-complete-draft-client-http.mjs";
import { exerciseEmptyProductDraft } from "../test-support/product-empty-draft-client-http.mjs";
import { exerciseCompleteProductCreation } from "../test-support/product-complete-creation-http.mjs";
import { exerciseClassifiedCompleteProductCreation } from "../test-support/product-classified-complete-creation-http.mjs";
import { exerciseCurrentProductCandidateRecipeMeasurements } from "../test-support/current-product-candidate-recipe-measurements.mjs";
import { exerciseCurrentProductCandidateStoreRecipePolicy } from "../test-support/current-product-candidate-store-recipe-policy.mjs";
import { exerciseCurrentProductCandidateRecipeBindingScope } from "../test-support/current-product-candidate-recipe-binding-scope.mjs";
import { deriveCatalogProductCandidateRecipeTarget } from "../../rms/catalog/src/index.ts";
import {
  createPostgresProductEditorSourceStore,
  parseCatalogProductEditorSnapshot,
  productEditorSnapshotFields,
} from "../../rms/catalog/src/index.ts";
import { createPostgresProductWholeScopeReplacementStore } from "../../rms/catalog/src/index.ts";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import {
  createMerchantProductEditorVariantContentAuthority,
  remainingProductEditorVariantReferenceChecks,
} from "../../../apps/api/src/merchant-product-editor-variant-content-authority.ts";
import {
  createMerchantProductEditorRegisteredContentAuthority,
  remainingProductEditorReferenceChecks,
} from "../../../apps/api/src/merchant-product-editor-registered-content-authority.ts";
import { createCurrentProductCandidateTaxReferenceSource } from "../../../apps/api/src/current-product-candidate-tax-references.ts";
import {
  createPostgresProductLifecycleStore,
  createPostgresProductValidationCandidateSource,
  productValidationCandidateFields,
  createPostgresProductContentRegistryStore,
  catalogProductContentRegistryDigest,
  validateCatalogProductRegisteredContent,
  contentRegistryFields,
  parseCatalogContentRegistryCommand,
  catalogContentRegistryRequest,
} from "../../rms/catalog/src/index.ts";
import {
  createPostgresPublishingMutationStore,
  publishingProductPublicationPolicyDigest,
  productPolicyScopeLevels,
} from "../../bop/publishing/src/index.ts";
import { createCurrentProductCandidateVariantIdentitySource } from "../../../apps/api/src/current-product-candidate-variant-identity.ts";
import { createCurrentProductCandidateRegisteredContentSource } from "../../../apps/api/src/current-product-candidate-registered-content.ts";
import { createCurrentProductCandidateUniqueScopeSource } from "../../../apps/api/src/current-product-candidate-unique-scope.ts";
import { createCurrentProductUniqueScopeSource } from "../../../apps/api/src/current-product-unique-scope.ts";
import { createCurrentProductApprovalDecisionSource } from "../../../apps/api/src/current-product-approval-decision.ts";
import { createCurrentProductApprovalSource } from "../../../apps/api/src/current-product-approval.ts";
import { createCurrentProductPublicationPolicySource } from "../../../apps/api/src/current-product-publication-policy.ts";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createMerchantProductPublicationQuery } from "../../../apps/api/src/merchant-product-publication-query.ts";
import { createMerchantStoreCapability } from "../../../apps/api/src/merchant-store-capability.ts";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { createMerchantProductPublicationCommand } from "../../../apps/api/src/merchant-product-publication-command.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createPostgresProductPublicationSourceStore } from "../../rms/catalog/src/infrastructure/persistence/product-publication-source-store.ts";
import { appendProductPublicationCommitArtifacts } from "../../rms/catalog/src/infrastructure/persistence/product-source-producer.ts";
import { createPostgresProductPublicationStore } from "../../rms/catalog/src/infrastructure/persistence/product-publication-store.ts";
import { createPostgresProductReferenceHistorySourceStore } from "../../rms/catalog/src/infrastructure/persistence/product-reference-history-source-store.ts";
import { catalogProductPublicationAuditAction } from "../../rms/catalog/src/contracts/product-publication-event.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  parseProductAggregate,
  planCatalogProductPublication,
  productPublicationCheckCodes,
  deriveCatalogProductPublicationContentIdentity,
  createCatalogProductPublicationMaterialization,
  parseCatalogProductPublicationContent,
  CatalogError,
  createCurrentProductPublicationService,
  createProductPublicationScheduledActivator,
  resolveCatalogProductPublication,
  productPublicationScopeLevels,
} from "../../rms/catalog/src/index.ts";
const id = (n) => "01902420-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-29T12:00:00.000Z",
  hash = (v) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
// Synthetic policy evidence, not an actual normal Publishing policy producer.
const syntheticScopePolicy = {
  async withHeldScopePolicy(_tx, input, work) {
    return work({
      policyReference: input.publication.policyReference,
      policyVersion: input.publication.policyVersion,
      policyEvidenceReference: id(990),
      scopeOrder: productPublicationScopeLevels,
      observedAt: input.observedAt,
      validUntil: new Date(Date.parse(input.observedAt) + 30_000).toISOString(),
    });
  },
};
it("persists owning publication revisions, immutable content and controlled successor parents with real SQL/RLS/rollback", async () => {
  await withIsolatedDatabase({ caseId: "product_publication" }, async (context) => {
    const admin = new pg.Client(context.clientConfig),
      writer = new pg.Client(context.clientConfig);
    await Promise.all([admin.connect(), writer.connect()]);
    const role = "wp2420_pub_" + context.runId;
    assert.match(role, /^wp2420_pub_[a-f0-9]+$/);
    const source = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_PUB",
      productType: "PreparedFood",
      lifecycle: "Active",
      aggregateVersion: 4,
      createdAt: at,
      createdByActorReference: id(3),
      updatedAt: at,
      draft: {
        versionReference: id(6),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic SQL fixture" },
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        skus: [
          {
            skuReference: id(70),
            productReference: id(5),
            brandReference: id(2),
            skuCode: "SYNTHETIC_PUB_SKU",
            lifecycle: "Active",
            localizedNames: { "en-CA": "Synthetic SKU" },
            variantSelections: [],
            unitOfSale: "EA",
            unitQuantity: "1",
            createdAt: at,
            createdByActorReference: id(3),
          },
        ],
        optionBindings: [
          {
            bindingReference: id(80),
            optionSetReference: id(81),
            optionSetVersionReference: id(82),
            purpose: "SELECT",
            sortOrder: 0,
            enabledOptionReferences: [],
            defaultSelections: [],
            minimumSelectionOverride: 0,
            maximumSelectionOverride: 1,
            includedSkuReferences: [],
            excludedSkuReferences: [],
            channelCodes: [],
            storeOverrideAllowed: false,
          },
        ],
      },
    });
    const identity = deriveCatalogProductPublicationContentIdentity(source);
    const command = (action, rootVersion, pubVersion, operation) => ({
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(operation),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: rootVersion,
      expectedPublicationVersion: pubVersion,
      action,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: action === "Publish" ? id(13) : null,
      occurredAt: at,
      reasonCode: "SCHEMA_FIXTURE",
    });
    const facts = (c) => ({
      now: at,
      productAggregateVersion: c.expectedProductAggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      validation: {
        evidenceReference: id(30),
        productAggregateVersion: c.expectedProductAggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        policyReference: id(31),
        policyVersion: 1,
        approvalPolicy: "NotRequired",
        checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
        warningAcknowledgement: null,
        checkedAt: at,
        validUntil: "2026-09-30T00:00:00.000Z",
      },
      approval: null,
      reviewReference: id(32),
      replacement: null,
    });
    const validate = planCatalogProductPublication(
        command("Validate", 4, 0, 100),
        null,
        facts(command("Validate", 4, 0, 100)),
      ),
      review = planCatalogProductPublication(
        command("SubmitReview", 5, 1, 101),
        validate,
        facts(command("SubmitReview", 5, 1, 101)),
      ),
      publish = planCatalogProductPublication(
        command("Publish", 6, 2, 102),
        review,
        facts(command("Publish", 6, 2, 102)),
      ),
      materialization = createCatalogProductPublicationMaterialization(
        { ...source, aggregateVersion: 6 },
        publish,
      );
    let revision = 0;
    const begin = async (tenant = id(1), brand = id(2), store = "") => {
      await writer.query("BEGIN");
      await writer.query(`SET LOCAL ROLE ${role}`);
      await writer.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenant, brand, store],
      );
      await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CatalogProductSource:" + id(2),
      ]);
    };
    const rootOperation = async (p) => {
      await writer.query(
        "UPDATE rms_catalog.product SET aggregate_version=$1 WHERE product_id=$2 AND brand_id=$3",
        [p.productAggregateVersion + 1, id(5), id(2)],
      );
      await writer.query(
        "INSERT INTO rms_catalog.product_operation_record(operation_id,brand_id,product_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,'ProductPublication',$4,$5,$6)",
        [p.operationReference, id(2), id(5), p.intentDigest, p.productAggregateVersion + 1, at],
      );
    };
    const row = async (p, action) =>
      writer.query(
        "INSERT INTO rms_catalog.product_publication_revision(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,source_aggregate_version,result_aggregate_version,action_code,state,intent_digest,content_digest,configuration_digest,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        [
          p.operationReference,
          id(1),
          id(2),
          id(5),
          id(6),
          p.publicationVersion,
          p.productAggregateVersion,
          p.productAggregateVersion + 1,
          action,
          p.state,
          p.intentDigest,
          p.contentDigest,
          p.configurationDigest,
          at,
          p,
        ],
      );
    const receipts = async (p, eventType, result) => {
      revision++;
      await writer.query(
        "INSERT INTO rms_catalog.product_operation_snapshot(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6)",
        [p.operationReference, id(2), id(5), p.productAggregateVersion + 1, at, result],
      );
      const action =
        eventType === "ProductValidationCompleted"
          ? "Validate"
          : eventType === "ProductReviewSubmitted"
            ? "SubmitReview"
            : "Publish";
      await appendProductPublicationCommitArtifacts(writer, p, result, action, {
        auditId: id(500 + revision),
        brandId: id(2),
        actor: { type: "User", reference: id(3) },
        actionCode: catalogProductPublicationAuditAction(action),
        targetType: "Product",
        targetId: id(5),
        reasonCode: p.reasonCode,
        correlationId: p.operationReference,
        occurredAt: at,
        sourceChannel: "API",
        dataClassification: "Internal",
        retentionPolicyCode: "OPERATIONAL",
        retentionPolicyVersion: 1,
      });
    };
    const grantsSeen = [];
    let denyAuthority = false;
    let invalidateAudit = false;
    const storeOptions = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      clock: { now: () => at },
      transactions: {
        async run(work) {
          await writer.query("BEGIN");
          try {
            await writer.query(`SET LOCAL ROLE ${role}`);
            const result = await work(writer);
            await writer.query("COMMIT");
            return result;
          } catch (error) {
            await writer.query("ROLLBACK");
            throw error;
          }
        },
      },
      authority: {
        async holdUntilTransactionCompletes(_tx, input) {
          if (denyAuthority) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.deepEqual(input.requiredPermissions, [
            "catalog.product.read",
            input.command.action === "Validate"
              ? "catalog.product.validate"
              : input.command.action === "SubmitReview"
                ? "catalog.product.submit"
                : "catalog.product.publish",
          ]);
          grantsSeen.push(input.command.operationReference);
        },
      },
      sources: {
        ...syntheticScopePolicy,
        async withHeldCurrentFacts(_tx, input, work) {
          return work(facts(input.command));
        },
      },
      audit: {
        create(p, action) {
          revision++;
          return {
            auditId: id(550 + revision),
            brandId: invalidateAudit ? id(9) : id(2),
            actor: { type: "User", reference: id(3) },
            actionCode: catalogProductPublicationAuditAction(action),
            targetType: "Product",
            targetId: id(5),
            reasonCode: p.reasonCode,
            correlationId: p.operationReference,
            occurredAt: at,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "OPERATIONAL",
            retentionPolicyVersion: 1,
          };
        },
      },
    };
    const store = createPostgresProductPublicationStore(storeOptions);
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT SELECT ON rms_catalog.product_publication_operation_abandonment TO ${role}`,
      );
      await admin.query(
        `GRANT INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);

      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_catalog.product_publication_revision,rms_catalog.product_scope_journal,rms_catalog.product_publication_content,rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.product_source_head,rms_catalog.product_version TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT ON rms_catalog.product,rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_channel,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_version_category_assignment TO ${role}`,
      );
      await admin.query(
        `GRANT INSERT ON rms_catalog.product_version_category_assignment TO ${role}`,
      );
      await admin.query(
        `GRANT UPDATE(aggregate_version,updated_at) ON rms_catalog.product TO ${role}`,
      );
      await admin.query(
        `GRANT UPDATE(status,localized_names_json) ON rms_catalog.product_version TO ${role}`,
      );
      await admin.query(
        `GRANT UPDATE(source_revision) ON rms_catalog.product_source_head TO ${role}`,
      );
      await admin.query(
        `GRANT UPDATE(product_version_id) ON rms_catalog.sku,rms_catalog.product_option_binding TO ${role}`,
      );
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_PUB','PreparedFood','Active',4,$3,$4,$3)",
        [id(5), id(2), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
        [id(6), id(5), id(2), source.draft.localizedNames, at],
      );
      await admin.query(
        "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'SYNTHETIC_PUB_SKU','Active',$5,'[]',$6,'EA',1,$7,$8)",
        [id(70), id(5), id(2), id(6), source.draft.skus[0].localizedNames, hash([]), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.option_set(option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_OPTION','Draft',1,$3,$4,$3)",
        [id(81), id(2), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,display_style,minimum_selection,maximum_selection,allow_repeated_option,per_option_maximum_quantity,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,'{}','SingleChoice',0,1,false,1,$5,$5)",
        [id(82), id(81), id(2), { "en-CA": "Synthetic option set" }, at],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_option_binding(binding_id,product_version_id,product_id,brand_id,option_set_id,option_set_version_id,purpose,sort_order,minimum_selection_override,maximum_selection_override,store_override_allowed) VALUES($1,$2,$3,$4,$5,$6,'SELECT',0,0,1,false)",
        [id(80), id(6), id(5), id(2), id(81), id(82)],
      );
      // The authoring abandonment fence admits an operation record only in its Brand scope.
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id','',false)",
        [id(2)],
      );
      for (let version = 1; version <= 4; version++) {
        await admin.query(
          "INSERT INTO rms_catalog.product_operation_record(operation_id,brand_id,product_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            id(600 + version),
            id(2),
            id(5),
            version === 1 ? "Create" : "ReplaceDraft",
            hash({ version }),
            version,
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_catalog.product_operation_snapshot(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6)",
          [id(600 + version), id(2), id(5), version, at, { ...source, aggregateVersion: version }],
        );
      }
      await begin();
      await rootOperation(validate);
      await row(validate, "Validate");
      await assert.rejects(writer.query("COMMIT"), (e) => e.code === "23514");
      await writer.query("ROLLBACK");
      assert.equal(
        (
          await admin.query(
            "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
            [id(5)],
          )
        ).rows[0].aggregate_version,
        4,
      );
      invalidateAudit = true;
      await assert.rejects(store.execute(command("Validate", 4, 0, 100)));
      invalidateAudit = false;
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer n FROM rms_catalog.product_operation_record WHERE operation_id=$1",
            [id(100)],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::integer n FROM platform_audit.audit_record")).rows[0]
          .n,
        0,
      );
      const validated = await store.execute(command("Validate", 4, 0, 100));
      assert.equal(validated.status, "Applied");
      assert.deepEqual(validated.publication, validate);
      assert.equal((await store.execute(command("Validate", 4, 0, 100))).status, "Replayed");
      for (const scope of [
        [id(9), id(2), ""],
        [id(1), id(9), ""],
        [id(1), id(2), id(9)],
      ]) {
        await begin(...scope);
        assert.equal(
          (await writer.query("SELECT * FROM rms_catalog.product_publication_revision")).rowCount,
          0,
        );
        await writer.query("ROLLBACK");
      }
      await begin();
      await assert.rejects(
        writer.query(
          "UPDATE rms_catalog.product_publication_revision SET state='Draft' WHERE operation_id=$1",
          [id(100)],
        ),
        (e) => e.code === "42501",
      );
      await writer.query("ROLLBACK");
      const submitted = await store.execute(command("SubmitReview", 5, 1, 101));
      assert.equal(submitted.status, "Applied");
      assert.deepEqual(submitted.publication, review);
      await begin();
      await writer.query(
        "UPDATE rms_catalog.product_version SET status='Frozen' WHERE product_version_id=$1",
        [id(6)],
      );
      await assert.rejects(writer.query("COMMIT"), (e) => e.code === "23514");
      await writer.query("ROLLBACK");
      const preparePublicationRows = async () => {
        await rootOperation(publish);
        await writer.query(
          "UPDATE rms_catalog.product_version SET status='Frozen' WHERE product_version_id=$1",
          [id(6)],
        );
        await writer.query(
          "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,base_product_version_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,$4,'Draft','en-CA',$5,$6,$6)",
          [id(13), id(5), id(2), id(6), source.draft.localizedNames, at],
        );
        await row(publish, "Publish");
        await writer.query(
          "INSERT INTO rms_catalog.product_publication_content(product_version_id,tenant_id,brand_id,product_id,publication_operation_id,source_aggregate_version,content_digest,configuration_digest,sealed_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            id(6),
            id(1),
            id(2),
            id(5),
            id(102),
            6,
            publish.contentDigest,
            publish.configurationDigest,
            at,
            materialization.content,
          ],
        );
      };
      await begin();
      await preparePublicationRows();
      await receipts(publish, "ProductVersionPublished", materialization.successor);
      await assert.rejects(writer.query("COMMIT"), (e) => e.code === "23514");
      await writer.query("ROLLBACK");
      revision--;
      assert.equal(
        (
          await admin.query(
            "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
            [id(5)],
          )
        ).rows[0].aggregate_version,
        6,
      );
      const journalCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.product_scope_journal) journals,(SELECT count(*)::int FROM rms_catalog.product_operation_record) operations,(SELECT count(*)::int FROM platform_audit.audit_record) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event) outbox",
            [id(5)],
          )
        ).rows[0];
      const beforeJournal = await journalCounts();
      await assert.rejects(
        createPostgresProductPublicationStore({
          ...storeOptions,
          sources: { withHeldCurrentFacts: storeOptions.sources.withHeldCurrentFacts },
        }).execute(command("Publish", 6, 2, 102)),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        createPostgresProductPublicationStore({
          ...storeOptions,
          sources: {
            ...storeOptions.sources,
            async withHeldScopePolicy(tx, input, work) {
              await syntheticScopePolicy.withHeldScopePolicy(tx, input, work);
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            },
          },
        }).execute(command("Publish", 6, 2, 102)),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await journalCounts(), beforeJournal);
      await assert.rejects(
        createPostgresProductPublicationStore({
          ...storeOptions,
          sources: {
            ...storeOptions.sources,
            async withHeldScopePolicy(tx, input, work) {
              return syntheticScopePolicy.withHeldScopePolicy(tx, input, (p) =>
                work({ ...p, validUntil: input.observedAt }),
              );
            },
          },
        }).execute(command("Publish", 6, 2, 102)),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await journalCounts(), beforeJournal);

      await assert.rejects(
        createPostgresProductPublicationStore({
          ...storeOptions,
          sources: {
            ...storeOptions.sources,
            async withHeldScopePolicy(_tx, input, work) {
              return work({
                policyReference: id(991),
                policyVersion: input.publication.policyVersion,
                policyEvidenceReference: id(990),
                scopeOrder: productPublicationScopeLevels,
                observedAt: input.observedAt,
                validUntil: input.observedAt,
              });
            },
          },
        }).execute(command("Publish", 6, 2, 102)),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await journalCounts(), beforeJournal);
      const published = await store.execute(command("Publish", 6, 2, 102));
      assert.equal(published.status, "Applied");
      assert.equal(published.scopeJournalStatus, "Recorded");
      assert.equal(published.scopeJournal.coverage, "CompleteLatestOwningPublicationHeads");
      assert.deepEqual(published.scopeJournal.plan.overlaps, []);
      const originalJournal = published.scopeJournal;
      assert.deepEqual(
        (await store.execute(command("Publish", 6, 2, 102))).scopeJournal,
        originalJournal,
      );
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.product_scope_journal SET journal_digest=journal_digest WHERE operation_id=$1",
          [id(102)],
        ),
        (e) => e.code === "55000",
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_catalog.product_scope_journal WHERE operation_id=$1", [
          id(102),
        ]),
        (e) => e.code === "55000",
      );
      await begin();
      await writer.query("SELECT set_config('bop.tenant_id',$1,true)", [id(9)]);
      assert.equal(
        (await writer.query("SELECT * FROM rms_catalog.product_scope_journal")).rows.length,
        0,
      );
      await writer.query("ROLLBACK");

      for (const ctx of [
        [id(1), id(9), ""],
        [id(1), id(2), id(20)],
      ]) {
        await begin(...ctx);
        assert.equal(
          (await writer.query("SELECT * FROM rms_catalog.product_scope_journal")).rows.length,
          0,
        );
        await writer.query("ROLLBACK");
      }
      await begin(id(9));
      await assert.rejects(
        writer.query(
          "INSERT INTO rms_catalog.product_scope_journal(operation_id,tenant_id,brand_id,product_id,source_aggregate_version,source_revision,intent_digest,journal_digest,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id(102),
            id(1),
            id(2),
            id(5),
            6,
            originalJournal.sourceRevision,
            publish.intentDigest,
            originalJournal.digest,
            originalJournal,
          ],
        ),
        (e) => e.code === "42501",
      );
      await writer.query("ROLLBACK");
      assert.deepEqual(published.publication, publish);
      assert.deepEqual(published.content, materialization.content);
      assert.equal((await store.execute(command("Publish", 6, 2, 102))).status, "Replayed");
      assert.ok(grantsSeen.length >= 8);
      const history = createPostgresProductReferenceHistorySourceStore({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => new Date().toISOString() },
        transactions: {
          async run(work) {
            await writer.query("BEGIN");
            try {
              await writer.query(`SET LOCAL ROLE ${role}`);
              const result = await work(writer);
              await writer.query("COMMIT");
              return result;
            } catch (error) {
              await writer.query("ROLLBACK");
              throw error;
            }
          },
        },
        authority: {
          async holdUntilTransactionCompletes() {
            return undefined;
          },
        },
      });
      const recorded = await history.loadSnapshot({
        purposeCode: "CATALOG_LIFECYCLE_REVIEW",
        brandReference: id(2),
        actorReference: id(3),
        productReference: id(5),
        skuReference: null,
        operationReference: id(700),
        expectedAggregateVersion: 7,
        originalProductVersionReference: id(13),
        beforeLifecycle: "Active",
        targetLifecycle: "Suspended",
        reasonCode: "SYNTHETIC_HISTORY_REVIEW",
        activeSkuCount: 1,
      });
      assert.equal(recorded.recordedAggregateVersion, 7);
      assert.deepEqual(recorded.configurations.map((c) => c.versionReference).sort(), [
        id(6),
        id(13),
      ]);
      assert.equal(recorded.publicationCoverage, "Unavailable");
      const publicationSource = createPostgresProductPublicationSourceStore({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => new Date().toISOString() },
        transactions: {
          async run(work) {
            await writer.query("BEGIN");
            try {
              const result = await work(writer);
              await writer.query("COMMIT");
              return result;
            } catch (error) {
              await writer.query("ROLLBACK");
              throw error;
            }
          },
        },
        authority: {
          async holdUntilTransactionCompletes() {
            if (denyAuthority) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const publicationGraph = await publicationSource.loadSnapshot({
        productReference: id(5),
        expectedAggregateVersion: 7,
      });
      assert.equal(publicationGraph.history.length, 3);
      assert.equal(publicationGraph.latest[0].state, "Published");
      assert.equal(publicationGraph.history[2].configuration.versionReference, id(6));
      assert.equal(publicationGraph.eligibility, "NotEvaluated");
      // Additive actual current scope-journal management consumer.
      let scopeReadMode = "normal",
        scopeReadAfterWork = false,
        scopeReadClock = null;
      const scopeSource = createPostgresProductPublicationSourceStore({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => scopeReadClock ?? new Date().toISOString() },
        transactions: {
          async run(work) {
            await writer.query("BEGIN");
            try {
              await writer.query(`SET LOCAL ROLE ${role}`);
              const r = await work(writer);
              await writer.query("COMMIT");
              return r;
            } catch (e) {
              await writer.query("ROLLBACK");
              throw e;
            }
          },
        },
        authority: {
          async holdUntilTransactionCompletes() {
            if (scopeReadAfterWork && scopeReadMode === "history-final-expiry")
              scopeReadClock = new Date(Date.now() + 10000).toISOString();
          },
        },
        scopeJournalAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_SCOPE_JOURNAL");
            assert.equal(input.owningAction, "catalog.product.history.read");
            assert.ok(input.requiredFields.includes("scopeJournalRelations"));
            if (scopeReadAfterWork && scopeReadMode === "journal-deny")
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const scopeRequest = { productReference: id(5), expectedAggregateVersion: 7 };
      const scopeReadCounts = await journalCounts();
      const scopeView = await scopeSource.withCurrentScopeJournals(
        scopeRequest,
        async (view) => view,
      );
      assert.equal(scopeView.versions.length, 1);
      assert.equal(scopeView.versions[0].recordStatus, "Recorded");
      assert.equal(scopeView.versions[0].journal.digest, originalJournal.digest);
      assert.deepEqual(scopeView.versions[0].journal.relations, []);
      assert.equal(scopeView.currentDisposition, "NotEvaluated");
      assert.equal(scopeView.eligibility, "NotEvaluated");
      for (const field of ["history", "latest", "incoming", "content", "approval"])
        assert.equal(Object.hasOwn(scopeView, field), false);
      for (const mode of ["journal-deny", "expiry", "history-final-expiry"]) {
        scopeReadMode = mode;
        scopeReadAfterWork = false;
        scopeReadClock = null;
        let wrote = 0;
        await assert.rejects(
          scopeSource.withCurrentScopeJournals(scopeRequest, async (view, tx) => {
            await tx.query(
              "UPDATE rms_catalog.product SET aggregate_version=aggregate_version+1 WHERE product_id=$1",
              [id(5)],
            );
            const changed = await tx.query(
              "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
              [id(5)],
            );
            assert.equal(changed.rows[0].aggregate_version, 8);
            wrote++;
            scopeReadAfterWork = true;
            if (mode === "expiry") scopeReadClock = view.validUntil;
            return "tentative";
          }),
          {
            code:
              mode === "journal-deny"
                ? "CATALOG_PERMISSION_DENIED"
                : "CATALOG_DEPENDENCY_UNAVAILABLE",
          },
        );
        assert.equal(wrote, 1);
        assert.deepEqual(await journalCounts(), scopeReadCounts);
      }
      scopeReadMode = "normal";
      scopeReadAfterWork = false;
      scopeReadClock = null;
      assert.deepEqual(
        await scopeSource
          .withCurrentScopeJournals(scopeRequest, async (v) => v)
          .then((v) => v.versions),
        scopeView.versions,
      );
      assert.deepEqual(await journalCounts(), scopeReadCounts);
      await assert.rejects(
        publicationSource.loadSnapshot({ productReference: id(5), expectedAggregateVersion: 6 }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      denyAuthority = true;
      await assert.rejects(
        publicationSource.loadSnapshot({ productReference: id(5), expectedAggregateVersion: 7 }),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      await assert.rejects(store.execute(command("Validate", 7, 3, 103)), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      denyAuthority = false;
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer n FROM rms_catalog.product_operation_record WHERE operation_id=$1",
            [id(103)],
          )
        ).rows[0].n,
        0,
      );
      await begin();
      const stored = (
        await writer.query("SELECT snapshot_json FROM rms_catalog.product_publication_content")
      ).rows[0].snapshot_json;
      assert.deepEqual(parseCatalogProductPublicationContent(stored), materialization.content);
      assert.equal(
        (
          await writer.query("SELECT product_version_id FROM rms_catalog.sku WHERE sku_id=$1", [
            id(70),
          ])
        ).rows[0].product_version_id,
        id(13),
      );
      await writer.query("ROLLBACK");
      await begin();
      await assert.rejects(
        writer.query(
          "UPDATE rms_catalog.product_version SET localized_names_json=$1 WHERE product_version_id=$2",
          [{ "en-CA": "Changed" }, id(6)],
        ),
        (e) => e.code === "55000",
      );
      await writer.query("ROLLBACK");
      await begin();
      await assert.rejects(
        writer.query("UPDATE rms_catalog.sku SET product_version_id=$1 WHERE sku_id=$2", [
          id(6),
          id(70),
        ]),
        (e) => e.code === "23514",
      );
      await writer.query("ROLLBACK");
      for (const publicationVersion of [4, 5]) {
        const invalid = {
          ...publish,
          operationReference: id(300 + publicationVersion),
          publicationVersion,
          productAggregateVersion: 7,
          state: "Draft",
        };
        await begin();
        await rootOperation(invalid);
        await assert.rejects(row(invalid, "Validate"), (e) => e.code === "23514");
        await writer.query("ROLLBACK");
      }
      await begin();
      assert.equal(
        (
          await writer.query(
            "SELECT product_version_id FROM rms_catalog.product_option_binding WHERE binding_id=$1",
            [id(80)],
          )
        ).rows[0].product_version_id,
        id(13),
      );
      await assert.rejects(
        writer.query(
          "UPDATE rms_catalog.product_option_binding SET product_version_id=$1 WHERE binding_id=$2",
          [id(6), id(80)],
        ),
        (e) => e.code === "23514",
      );
      await writer.query("ROLLBACK");
      await admin.query(
        `GRANT UPDATE,DELETE ON rms_catalog.product_publication_content,rms_catalog.product_publication_revision TO ${role}`,
      );
      for (const sql of [
        "UPDATE rms_catalog.product_publication_content SET data_classification='ConfigurationMetadata'",
        "DELETE FROM rms_catalog.product_publication_content",
        "UPDATE rms_catalog.product_publication_revision SET state=state",
        "DELETE FROM rms_catalog.product_publication_revision",
      ]) {
        await begin();
        await assert.rejects(writer.query(sql), (e) => e.code === "55000");
        await writer.query("ROLLBACK");
      }
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer n FROM rms_catalog.product_publication_revision",
          )
        ).rows[0].n,
        3,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::integer n FROM platform_audit.audit_record")).rows[0]
          .n,
        3,
      );
      const outbox = await admin.query(
        "SELECT event_type,payload_json,actor_type FROM platform_eventing.outbox_event ORDER BY aggregate_version",
      );
      assert.deepEqual(
        outbox.rows.map((r) => r.event_type),
        ["ProductValidationCompleted", "ProductReviewSubmitted", "ProductVersionPublished"],
      );
      assert.equal(outbox.rows[2].payload_json.productVersionReference, id(6));
      assert.equal(outbox.rows[2].payload_json.resultDraftVersionReference, id(13));
      // Actual source/barrier plus current validation fixture: no Store/policy grant is inferred.
      const currentPublication = createCurrentProductPublicationService(
        {
          clock: { now: () => new Date().toISOString() },
          snapshots: publicationSource,
          eligibility: {
            async withHeldCurrentFacts(input, work) {
              return work({
                tenantReference: id(1),
                brandReference: id(2),
                storeReference: id(20),
                observedAt: input.observedAt,
                validUntil: new Date(Date.parse(input.observedAt) + 60000).toISOString(),
                coverage: "Complete",
                storeGroupReferences: [],
                regionReferences: [],
                policyReference: id(31),
                policyVersion: 1,
                scopeOrder: productPublicationScopeLevels,
                versions: input.snapshot.latest.map((p) => ({
                  versionReference: p.versionReference,
                  validation: {
                    ...facts({
                      ...command("Publish", input.snapshot.aggregateVersion, 0, 600),
                      contentDigest: p.contentDigest,
                      configurationDigest: p.configurationDigest,
                      scopeSet: p.scopeSet,
                      effectivePeriod: p.effectivePeriod,
                    }).validation,
                    checkedAt: input.observedAt,
                    validUntil: new Date(Date.parse(input.observedAt) + 60000).toISOString(),
                  },
                  approval: null,
                })),
              });
            },
          },
        },
        { tenantReference: id(1), brandReference: id(2), storeReference: id(20) },
      );
      const effective = await currentPublication.withCurrentPublication(
        {
          productReference: id(5),
          expectedAggregateVersion: 7,
          channelCode: "WEB",
          orderTypeCode: "PICKUP",
        },
        async (view) => view,
      );
      assert.equal(effective.current.outcome, "Selected");
      assert.equal(effective.current.versionReference, id(6));
      const newIdentity = deriveCatalogProductPublicationContentIdentity(published.aggregate),
        due = "2026-09-29T13:00:00.000Z",
        laterDue = "2026-09-29T14:00:00.000Z";
      const periodAt = (instant) => ({
        timeZone: "UTC",
        effectiveFrom: { instant, localDateTime: instant.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      });
      const scheduleCommand = (action, root, pub, operation, instant = due) => ({
        ...command(action, root, pub, operation),
        versionReference: id(13),
        contentDigest: newIdentity.contentDigest,
        configurationDigest: newIdentity.configurationDigest,
        scopeSet: [{ level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: periodAt(instant),
        scheduleReference: [
          "SchedulePublish",
          "ReschedulePublish",
          "CancelScheduledPublish",
        ].includes(action)
          ? id(650)
          : null,
        successorDraftVersionReference: null,
      });
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner: storeOptions.transactions,
        role,
        scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(20) },
        actor: id(3),
        at,
      });
      const membership = "01909968-0000-7000-8000-000000000001",
        from = new Date(Date.parse(at) - 60000).toISOString(),
        until = new Date(Date.parse(at) + 3600000).toISOString();
      await admin.query(
        "INSERT INTO bop_permission.role VALUES($1,$2,NULL,'synthetic_publication_brand','Active',$3,$4,1,$3,$3)",
        [id(90001), id(2), from, until],
      );
      await admin.query(
        "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
        [id(90002), id(90001), membership, id(3), id(2), from, until],
      );
      const normalActions = [
        "catalog.manage",
        "catalog.product.manage",
        "catalog.product.read",
        "catalog.product.validate",
        "catalog.product.submit",
        "catalog.product.publish",
        "catalog.product.history.read",
        "catalog.sku.read",
      ];
      for (const [i, action] of normalActions.entries()) {
        let permission = (
          await admin.query(
            "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
            [action],
          )
        ).rows[0]?.permission_id;
        if (!permission) {
          permission = id(90100 + i);
          await admin.query(
            "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
            [permission, action, from],
          );
        }
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
          [id(90200 + i), id(90001), permission, id(2), from, until],
        );
      }
      const normal = createMerchantProductPublicationCommand({
        merchant: session.persistence,
        authentication: session.authentication,
        auditReference: (operation) => id(91000 + Number.parseInt(operation.slice(-12), 16)),
        authority: storeOptions.authority,
        sources: storeOptions.sources,
      });
      const bodyFor = (c) =>
        Object.fromEntries(
          Object.entries(c).filter(
            ([key]) =>
              ![
                "purposeCode",
                "tenantReference",
                "brandReference",
                "actorReference",
                "actorKind",
              ].includes(key),
          ),
        );
      const firstBody = bodyFor(scheduleCommand("Validate", 7, 0, 801));
      await withProductPublicationHttp(
        normal,
        session,
        { brandReference: id(2), storeReference: id(20) },
        async (post) => {
          assert.equal((await post({ ...firstBody, actorReference: id(99) })).status, 400);
          assert.equal((await post(firstBody, { "x-bop-csrf": "invalid" })).status, 403);
          assert.equal(
            (
              await post(firstBody, {
                "x-bop-catalog-scope": Buffer.from(
                  JSON.stringify({ brandReference: id(2), storeReference: id(21) }),
                ).toString("base64url"),
              })
            ).status,
            403,
          );
          const attempt = createPublicationNativeHttpClient({
            post,
            command: firstBody,
            scope: { brandReference: id(2), storeReference: id(20) },
            csrf: session.csrf,
          });
          const { nativeReply: applied, error: lost } = await attempt({ loseNextResponse: true });
          assert.equal(lost?.code, "OutcomeUnknown");
          assert.equal(applied.status, 200);
          assert.equal(applied.cacheControl, "no-store");
          assert.equal(applied.body.status, "Applied");
          assert.equal(applied.body.aggregateVersion, 8);
          const recovered = await attempt();
          assert.equal(recovered.nativeReply.body.status, "Replayed");
          assert.equal(recovered.receipt?.status, "Replayed");
          assert.equal(recovered.error, undefined);
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
            [id(90203)],
          );
          const deniedReplay = await attempt();
          assert.equal(deniedReplay.nativeReply.status, 403);
          assert.equal(deniedReplay.error?.code, "Denied");
          assert.equal(deniedReplay.receipt, undefined);
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
            [id(90203)],
          );
          const restoredReplay = await attempt();
          assert.equal(restoredReplay.nativeReply.body.status, "Replayed");
          assert.equal(restoredReplay.receipt?.status, "Replayed");
          assert.equal(restoredReplay.error, undefined);
        },
      );
      const executeNativeClient = async (candidate) =>
        withProductPublicationHttp(
          normal,
          session,
          { brandReference: id(2), storeReference: id(20) },
          async (post) => {
            const attempt = createPublicationNativeHttpClient({
              post,
              command: bodyFor(candidate),
              scope: { brandReference: id(2), storeReference: id(20) },
              csrf: session.csrf,
            });
            const result = await attempt();
            assert.equal(result.nativeReply.status, 200);
            assert.equal(result.error, undefined);
            assert.equal(result.receipt.status, "Applied");
          },
        );
      await executeNativeClient(scheduleCommand("SubmitReview", 8, 1, 802));
      await executeNativeClient(scheduleCommand("SchedulePublish", 9, 2, 803));
      const discovery = createPostgresProductPublicationSourceStore({
        ...storeOptions,
        actorKind: "System",
        clock: { now: () => due },
        authority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.productReference, null);
            assert.equal(input.owningAction, "catalog.product.publish");
            if (denyAuthority) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      assert.equal(
        (await discovery.discoverDueSchedules({ afterVersionReference: null, limit: 2 })).candidates
          .length,
        1,
      );
      await assert.rejects(
        publicationSource.discoverDueSchedules({ afterVersionReference: null, limit: 2 }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      await executeNativeClient(scheduleCommand("ReschedulePublish", 10, 3, 804, laterDue));
      assert.equal(
        (await discovery.discoverDueSchedules({ afterVersionReference: null, limit: 2 })).candidates
          .length,
        0,
      );
      await executeNativeClient(scheduleCommand("CancelScheduledPublish", 11, 4, 805, laterDue));
      assert.equal(
        (await discovery.discoverDueSchedules({ afterVersionReference: null, limit: 2 })).candidates
          .length,
        0,
      );
      // Normal current capability uses owner SQL and the exact persisted selected Store.
      await admin.query(`GRANT USAGE ON SCHEMA bop_feature_control TO ${role}`);
      await admin.query(
        `GRANT SELECT ON bop_feature_control.control_version,bop_feature_control.control_dependency TO ${role}`,
      );
      for (const [control, storeRef, source, value] of [
        [id(95001), null, "BrandOverride", "Enabled"],
        [id(95002), id(20), "StoreOverride", "Disabled"],
      ])
        await admin.query(
          "INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,$3,'catalog.product.capability',1,'Synthetic Product capability',$4,'PRODUCT_CAPABILITY',$5,'Disabled',$6,'Published',false,$7,NULL,$8,NULL,$4,$9,$10,$11,$7,'ConfigurationMetadata')",
          [
            control,
            id(2),
            storeRef,
            id(95003),
            source,
            value,
            at,
            until,
            id(95004),
            id(95005),
            id(95006),
          ],
        );
      let capabilitySourceCalls = 0;
      const capabilities = createMerchantStoreCapability({
        persistence: session.persistence,
        authentication: session.authentication,
        bindings: {
          async withCurrentBinding(input, work) {
            return work({
              capabilityKey: input.capabilityKey,
              controlKey: "catalog.product.capability",
              mappingReference: id(95007),
              mappingVersion: 1,
              phase: "phase_1",
              commitment: "Committed",
            });
          },
        },
        dependencies: {
          async withCurrentEvidence() {
            throw Error("No dependency source is configured by this fixture");
          },
        },
        definitionsAuthority: {
          async withAuthorizedDefinitionsScope(input, work) {
            capabilitySourceCalls++;
            assert.equal(input.actorReference, id(3));
            assert.equal(input.storeReference, id(20));
            assert.equal(input.purposeCode, "STORE_CAPABILITY_EVALUATION");
            return work();
          },
        },
      });
      // organization.manage is the canonical permission for the Store capability observation.
      let organizationPermission = (
        await admin.query(
          "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='organization.manage'",
        )
      ).rows[0]?.permission_id;
      if (!organizationPermission) {
        organizationPermission = id(95100);
        await admin.query(
          "INSERT INTO bop_permission.permission_definition VALUES($1,'organization.manage','Active',1,$2,$2)",
          [organizationPermission, from],
        );
      }
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
        [id(95101), id(90001), organizationPermission, id(2), from, until],
      );
      await withProductPublicationHttp(
        normal,
        session,
        { brandReference: id(2), storeReference: id(20) },
        async (post) => {
          const observed = await post(
            { capabilityKey: "catalog.cat_product_list" },
            {},
            "/merchant/store-capability",
          );
          assert.equal(observed.status, 200);
          assert.equal(observed.body.reason, "Disabled");
          assert.equal(observed.body.source, "StoreOverride");
          assert.equal(observed.body.backendExecution, "Deny");
          assert.equal(observed.body.frontendVisibility, "Hide");
          const before = capabilitySourceCalls;
          assert.equal(
            (
              await post(
                { capabilityKey: "catalog.cat_product_list", storeReference: id(21) },
                {},
                "/merchant/store-capability",
              )
            ).status,
            503,
          );
          assert.equal(capabilitySourceCalls, before);
        },
        { storeCapability: capabilities.observe },
      );
      let executed = false;
      await assert.rejects(
        capabilities.guard(
          { sessionCookie: session.sessionCookie, csrf: session.csrf },
          "catalog.cat_product_list",
          "catalog.product.read",
          async () => {
            executed = true;
          },
        ),
      );
      assert.equal(executed, false);
      await store.execute(scheduleCommand("Validate", 12, 5, 806));
      await store.execute(scheduleCommand("SubmitReview", 13, 6, 807));
      await store.execute(scheduleCommand("SchedulePublish", 14, 7, 808));
      const candidate = (
        await discovery.discoverDueSchedules({ afterVersionReference: null, limit: 2 })
      ).candidates[0];
      assert.equal(candidate.expectedAggregateVersion, 15);
      assert.equal(candidate.publication.scheduleVersion, 4);
      // Real owning policy body/history producer; current permissions/validation remain synthetic.
      await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
      );
      const policyScope = { kind: "Brand", brandReference: id(2), storeReference: null };
      // Finite immutable synthetic seed period, captured once before policy creation.
      const syntheticPolicyUntil = new Date(Date.now() + 3600000).toISOString();
      const policyBody = {
        profile: "PublishingProductPublicationPolicyV1",
        tenantReference: id(1),
        brandReference: id(2),
        familyReference: id(900),
        policyReference: id(31),
        policyVersion: 1,
        scopeOrder: productPolicyScopeLevels,
        approvalPolicy: "NotRequired",
        warningOverrideAllowed: false,
        requiredLocales: ["en-CA"],
        mediaRequirement: "Required",
        effectiveFrom: at,
        effectiveUntil: syntheticPolicyUntil,
      };
      const policyPublisher = createPostgresPublishingMutationStore(
        storeOptions.transactions,
        id(1),
        policyScope,
      );
      const policyDraft = {
        lifecycleId: id(901),
        familyReference: id(900),
        configurationType: "PRODUCT_PUBLICATION_POLICY",
        purposeCode: "PRODUCT_PUBLICATION_POLICY",
        snapshotReference: id(31),
        snapshotDigest: publishingProductPublicationPolicyDigest(policyBody),
        scope: policyScope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: at,
        changedAt: at,
      };
      const policyMutation = (operation, current, next, n, extra = {}) => ({
        operation,
        expectedVersion: current?.version ?? 1,
        idempotencyKey: id(n),
        current,
        next,
        release: null,
        supersededReleaseId: null,
        rollbackTargetReleaseId: null,
        validationEvidence: null,
        approvalEvidence: null,
        audit: {
          auditId: id(n + 1),
          brandId: id(2),
          actor: {
            type: "User",
            reference: operation === "CreateDraft" || operation === "SubmitReview" ? id(3) : id(4),
          },
          actionCode: {
            CreateDraft: "PUBLISHING_DRAFT_CREATED",
            SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
            Approve: "PUBLISHING_REVIEW_APPROVED",
            Publish: "PUBLISHING_RELEASE_PUBLISHED",
          }[operation],
          targetType: "PublishingLifecycle",
          targetId: id(901),
          reasonCode: "SYNTHETIC_POLICY",
          correlationId: id(n),
          occurredAt: at,
          sourceChannel: "API",
          dataClassification: "Confidential",
          retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
          retentionPolicyVersion: 1,
        },
        ...extra,
      });
      await policyPublisher.commit(
        policyMutation("CreateDraft", null, policyDraft, 910, { productPolicyContent: policyBody }),
      );
      const policyValidation = {
        evidenceReference: id(930),
        snapshotReference: id(31),
        snapshotDigest: policyDraft.snapshotDigest,
        scope: policyScope,
        result: "Pass",
        checkedAt: at,
        validUntil: syntheticPolicyUntil,
        checkCodes: ["PRODUCT_POLICY_STRUCTURE"],
      };
      const policyReview = {
        ...policyDraft,
        state: "InReview",
        version: 2,
        validationEvidenceReference: id(930),
      };
      await policyPublisher.commit(
        policyMutation("SubmitReview", policyDraft, policyReview, 912, {
          validationEvidence: policyValidation,
        }),
      );
      const policyApproval = {
        evidenceReference: id(931),
        reviewLifecycleId: id(901),
        reviewVersion: 2,
        snapshotReference: id(31),
        snapshotDigest: policyDraft.snapshotDigest,
        scope: policyScope,
        decision: "Accepted",
        approvedActorReference: id(4),
        approvedAt: at,
        validUntil: syntheticPolicyUntil,
      };
      const policyApproved = {
        ...policyReview,
        state: "Approved",
        version: 3,
        approvalEvidenceReference: id(931),
      };
      await policyPublisher.commit(
        policyMutation("Approve", policyReview, policyApproved, 914, {
          approvalEvidence: policyApproval,
        }),
      );
      const actualPolicyRelease = {
        releaseId: id(932),
        familyReference: id(900),
        configurationType: policyDraft.configurationType,
        purposeCode: policyDraft.purposeCode,
        snapshotReference: id(31),
        snapshotDigest: policyDraft.snapshotDigest,
        scope: policyScope,
        sequence: 1,
        sourceLifecycleId: id(901),
        kind: "Publish",
        previousReleaseId: null,
        createdAt: at,
      };
      await policyPublisher.commit(
        policyMutation(
          "Publish",
          policyApproved,
          { ...policyApproved, state: "Published", version: 4 },
          916,
          {
            validationEvidence: policyValidation,
            approvalEvidence: policyApproval,
            release: actualPolicyRelease,
          },
        ),
      );
      const actualScopePolicy = createCurrentProductPublicationPolicySource({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "System",
        clock: { now: () => due },
        authority: {
          async holdUntilTransactionCompletes() {
            if (denyAuthority) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const systemWriter = createPostgresProductPublicationStore({
        ...storeOptions,
        actorKind: "System",
        clock: { now: () => due },
        sources: {
          ...actualScopePolicy,
          async withHeldCurrentFacts(_tx, input, work) {
            return work({
              ...facts(input.command),
              now: due,
              validation: { ...facts(input.command).validation, checkedAt: due },
            });
          },
        },
        audit: {
          create(p, action) {
            const original = storeOptions.audit.create(p, action);
            return { ...original, actor: { type: "System" }, occurredAt: p.occurredAt };
          },
        },
      });
      const activation = createProductPublicationScheduledActivator({
        tenantReference: id(1),
        brandReference: id(2),
        systemActorReference: id(3),
        references: { operation: () => id(809), successorDraft: () => id(651) },
        writer: systemWriter,
      });
      denyAuthority = true;
      await assert.rejects(activation.activate(candidate), { code: "CATALOG_PERMISSION_DENIED" });
      denyAuthority = false;
      assert.equal(await activation.activate(candidate), "Applied");
      assert.equal(await activation.activate(candidate), "Replayed");
      const activationJournal = (
        await admin.query(
          "SELECT snapshot_json FROM rms_catalog.product_scope_journal WHERE operation_id=$1",
          [id(809)],
        )
      ).rows[0].snapshot_json;
      assert.equal(activationJournal.incoming.actorKind, "System");
      assert.equal(activationJournal.policyEvidenceReference, actualPolicyRelease.releaseId);
      assert.equal(activationJournal.plan.overlaps[0].relation, "IncomingSelectorPreferred");
      assert.equal(
        activationJournal.latest.find((p) => p.versionReference === id(6)).state,
        "Published",
      );
      assert.deepEqual(
        (await store.execute(command("Publish", 6, 2, 102))).scopeJournal,
        originalJournal,
      );

      assert.equal(
        (await discovery.discoverDueSchedules({ afterVersionReference: null, limit: 2 })).candidates
          .length,
        0,
      );
      const afterActivation = await publicationSource.loadSnapshot({
        productReference: id(5),
        expectedAggregateVersion: 16,
      });
      assert.equal(
        afterActivation.latest.find((p) => p.versionReference === id(13)).state,
        "Published",
      );
      // Current management reads actual activation overlap; original Publish remains recorded.
      const scopeAfterActivation = await scopeSource.withCurrentScopeJournals(
        { productReference: id(5), expectedAggregateVersion: 16 },
        async (v) => v,
      );
      const storeScopeRecord = scopeAfterActivation.versions.find(
        (v) => v.versionReference === id(13),
      );
      assert.equal(storeScopeRecord.recordStatus, "Recorded");
      assert.equal(storeScopeRecord.journal.relations[0].relation, "IncomingSelectorPreferred");
      assert.equal(storeScopeRecord.journal.digest, activationJournal.digest);
      assert.equal(
        scopeAfterActivation.versions.find((v) => v.versionReference === id(6)).journal.digest,
        originalJournal.digest,
      );
      assert.equal(
        resolveCatalogProductPublication(
          afterActivation.latest,
          {
            storeReference: id(20),
            storeGroupReferences: [],
            regionReferences: [],
            channelCode: "WEB",
            orderTypeCode: "PICKUP",
            at: due,
          },
          productPublicationScopeLevels,
        ).versionReference,
        id(13),
      );
      assert.equal(
        resolveCatalogProductPublication(
          afterActivation.latest,
          {
            storeReference: id(21),
            storeGroupReferences: [],
            regionReferences: [],
            channelCode: "WEB",
            orderTypeCode: "PICKUP",
            at: due,
          },
          productPublicationScopeLevels,
        ).versionReference,
        id(6),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer n FROM platform_audit.audit_record WHERE correlation_id=$1",
            [id(809)],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT actor_type FROM platform_eventing.outbox_event WHERE correlation_id=$1",
            [id(809)],
          )
        ).rows[0].actor_type,
        "System",
      );
      // Fresh encrypted session clock matches actual SQL observation time for the normal query.
      const liveAt = new Date().toISOString(),
        liveUntil = new Date(Date.parse(liveAt) + 3600000).toISOString();
      const readerSession = await seedMerchantAcceptanceSession({
        admin,
        runner: storeOptions.transactions,
        role,
        scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(20) },
        actor: id(3),
        at: liveAt,
        referencePrefix: "01909611",
        sessionReferencePrefix: "01909612",
      });
      await admin.query(
        "UPDATE bop_permission.role SET effective_until=$1,version=version+1 WHERE role_id=$2",
        [liveUntil, id(90001)],
      );
      await admin.query(
        "UPDATE bop_permission.permission_grant SET effective_until=$1,version=version+1 WHERE role_id=$2",
        [liveUntil, id(90001)],
      );
      await admin.query(
        "UPDATE bop_permission.role_assignment SET lifecycle='Ended',version=version+1 WHERE assignment_id=$1",
        [id(90002)],
      );
      await admin.query(
        "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
        [
          id(96001),
          id(90001),
          "01909611-0000-7000-8000-000000000001",
          id(3),
          id(2),
          liveAt,
          liveUntil,
        ],
      );
      // Actual owning management composition: current editor/history are held in one outer SQL transaction.
      // The independent screen/field declarations below are synthetic, not real Store capability evidence.
      let managementMode = "normal",
        managementHistoryCalls = 0,
        managementClock = null;
      const managementConfiguration = {
        contentAuthority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.productReference, id(5));
            assert.equal(input.owningAction, "catalog.product.manage");
          },
        },
        historyAuthority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.productReference, id(5));
            assert.equal(input.owningAction, "catalog.product.history.read");
            if (++managementHistoryCalls === 4) {
              if (managementMode === "late-deny")
                throw new CatalogError("CATALOG_PERMISSION_DENIED");
              if (managementMode === "late-expiry")
                managementClock = new Date(Date.now() + 10000).toISOString();
            }
          },
        },
        async holdScreenUntilCommit(_tx, input) {
          assert.equal(input.actorReference, id(3));
          assert.equal(input.storeReference, id(20));
          assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
          assert.equal(input.purposeCode, "CATALOG_PRODUCT_PUBLICATION_MANAGEMENT");
        },
      };
      const unusedManagementConfiguration = async () => {
        throw Error("Unconfigured synthetic Store service command");
      };
      const managementRuntime = createMerchantRuntime({
        persistence: {
          ...readerSession.persistence,
          now: () => managementClock ?? new Date().toISOString(),
        },
        acceptedHost: "merchant.invalid",
        exactOrigin: "https://merchant.invalid",
        serviceAudit: {
          reasonCode: "SYNTHETIC_PUBLICATION_MANAGEMENT",
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
          configure: unusedManagementConfiguration,
          review: {
            validate: unusedManagementConfiguration,
            snapshotAudit: unusedManagementConfiguration,
          },
        },
        productPublicationManagement: managementConfiguration,
      });
      assert.equal(typeof managementRuntime.productPublicationManagement, "function");
      const managementCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*) FROM rms_catalog.product_publication_revision) AS publications,(SELECT count(*) FROM platform_audit.audit_record) AS audits,(SELECT count(*) FROM platform_eventing.outbox_event) AS events",
          )
        ).rows;
      const beforeManagement = await managementCounts();
      await withProductPublicationHttp(
        normal,
        readerSession,
        { brandReference: id(2), storeReference: id(20) },
        async (post) => {
          const read = (
            query = { productReference: id(5), expectedAggregateVersion: 16 },
            headers = {},
          ) => post(query, headers, "/merchant/catalog/products/publication/management");
          const viewed = await read();
          assert.equal(viewed.status, 200);
          assert.equal(viewed.cacheControl, "no-store");
          assert.equal(viewed.body.profile, "CatalogProductPublicationManagementV1");
          assert.equal(viewed.body.storeReference, id(20));
          assert.equal(viewed.body.aggregateVersion, 16);
          assert.equal(viewed.body.draft.versionReference, id(651));
          assert.equal(viewed.body.eligibility, "NotEvaluated");
          assert.equal(viewed.body.publishValidation, "Incomplete");
          const recorded = viewed.body.versions.find((v) => v.versionReference === id(13));
          assert.equal(recorded.state, "Published");
          assert.equal(recorded.publicationVersion, 9);
          assert.equal(recorded.scheduleVersion, 5);
          assert.equal(
            (await read({ productReference: id(5), expectedAggregateVersion: 15 })).status,
            503,
          );
          assert.equal(
            (
              await read({
                productReference: id(5),
                expectedAggregateVersion: 16,
                actorReference: id(99),
              })
            ).status,
            400,
          );
          assert.equal((await read(undefined, { "x-bop-csrf": "invalid" })).status, 403);
          assert.equal((await read(undefined, { "x-bop-csrf": "z".repeat(43) })).status, 403);
          assert.equal(
            (
              await read(undefined, {
                "x-bop-catalog-scope": Buffer.from(
                  JSON.stringify({ brandReference: id(2), storeReference: id(21) }),
                ).toString("base64url"),
              })
            ).status,
            403,
          );
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
            [id(90207)],
          );
          assert.equal((await read()).status, 403);
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
            [id(90207)],
          );
          managementMode = "late-deny";
          managementHistoryCalls = 0;
          assert.equal((await read()).status, 403);
          managementMode = "late-expiry";
          managementHistoryCalls = 0;
          assert.equal((await read()).status, 503);
          managementMode = "normal";
          managementClock = null;
          managementHistoryCalls = 0;
          assert.equal((await read()).status, 200);
        },
        { productPublicationManagement: managementRuntime.productPublicationManagement },
      );
      assert.deepEqual(await managementCounts(), beforeManagement);
      const currentQuery = createMerchantProductPublicationQuery({
        merchant: { ...readerSession.persistence, now: () => new Date().toISOString() },
        authentication: readerSession.authentication,
        authority: {
          async holdUntilTransactionCompletes() {
            return undefined;
          },
        },
        eligibility: {
          async withHeldCurrentFacts(input, work) {
            return work({
              tenantReference: id(1),
              brandReference: id(2),
              storeReference: id(20),
              observedAt: input.observedAt,
              validUntil: new Date(Date.parse(input.observedAt) + 60000).toISOString(),
              coverage: "Complete",
              storeGroupReferences: [],
              regionReferences: [],
              policyReference: id(31),
              policyVersion: 1,
              scopeOrder: productPublicationScopeLevels,
              versions: input.snapshot.latest.map((p) => ({
                versionReference: p.versionReference,
                validation: {
                  ...facts({
                    ...command("Publish", input.snapshot.aggregateVersion, 0, 7000),
                    contentDigest: p.contentDigest,
                    configurationDigest: p.configurationDigest,
                    scopeSet: p.scopeSet,
                    effectivePeriod: p.effectivePeriod,
                  }).validation,
                  checkedAt: input.observedAt,
                  validUntil: new Date(Date.parse(input.observedAt) + 60000).toISOString(),
                },
                approval: null,
              })),
            });
          },
        },
      });
      await withProductPublicationHttp(
        normal,
        readerSession,
        { brandReference: id(2), storeReference: id(20) },
        async (post) => {
          const read = await post(
            {
              productReference: id(5),
              expectedAggregateVersion: 16,
              channelCode: "WEB",
              orderTypeCode: "PICKUP",
            },
            {},
            "/merchant/catalog/products/publication/query",
          );
          assert.equal(read.status, 200);
          assert.equal(read.cacheControl, "no-store");
          assert.equal(read.body.current.versionReference, id(13));
          assert.equal(read.body.future.length, 0);
          const denied = await post(
            {
              productReference: id(5),
              expectedAggregateVersion: 16,
              channelCode: "WEB",
              orderTypeCode: "PICKUP",
            },
            {
              "x-bop-catalog-scope": Buffer.from(
                JSON.stringify({ brandReference: id(2), storeReference: id(21) }),
              ).toString("base64url"),
            },
            "/merchant/catalog/products/publication/query",
          );
          assert.equal(denied.status, 503);
        },
        { productPublicationQuery: currentQuery },
      );

      // Additive ordinary journal HTTP over actual encrypted session, current
      // Membership/Permission and owner SQL; field/phase holders stay synthetic.
      let ordinaryJournalMode = "normal",
        ordinaryJournalClock = null,
        ordinaryJournalObserved = 0,
        ordinaryJournalPhaseCalls = 0;
      const unusedJournalRuntimeConfiguration = () => {
        throw Error("SYNTHETIC_UNRELATED_CONFIGURATION_UNAVAILABLE");
      };
      const ordinaryJournalRuntime = createMerchantRuntime({
        persistence: {
          ...readerSession.persistence,
          now: () => ordinaryJournalClock ?? new Date().toISOString(),
        },
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        serviceAudit: {
          reasonCode: "SYNTHETIC_SCOPE_JOURNAL_READ",
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
          configure: unusedJournalRuntimeConfiguration,
          review: {
            validate: unusedJournalRuntimeConfiguration,
            snapshotAudit: unusedJournalRuntimeConfiguration,
          },
        },
        productScopeJournals: {
          historyAuthority: {
            async holdUntilTransactionCompletes() {
              return undefined;
            },
          },
          journalAuthority: {
            async holdUntilTransactionCompletes(_tx, input) {
              assert.equal(input.purposeCode, "CATALOG_PRODUCT_SCOPE_JOURNAL");
              assert.equal(input.owningAction, "catalog.product.history.read");
              ordinaryJournalObserved++;
              // Initial/before-query/after-consumer/final-owning holds precede
              // the API's distinct final outer-COMMIT checks.
              if (ordinaryJournalObserved === 5) {
                if (ordinaryJournalMode === "late-journal-deny")
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
                if (ordinaryJournalMode === "late-journal-expiry")
                  ordinaryJournalClock = new Date(Date.now() + 10000).toISOString();
              }
            },
          },
          async holdScreenUntilCommit(_tx, input) {
            assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
            assert.equal(input.capability, "catalog.cat_product_edit");
            assert.equal(input.storeReference, id(20));
            assert.equal(input.productReference, id(5));
            assert.ok(input.historyFields.includes("publicationHistory"));
            assert.ok(input.journalFields.includes("scopeJournalRelations"));
            ordinaryJournalPhaseCalls++;
            // Once the four owning journal holds have completed, the next
            // screen check is the distinct API outer-COMMIT check.
            if (ordinaryJournalObserved === 4 && ordinaryJournalMode === "late-phase-deny")
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const ordinaryJournal = ordinaryJournalRuntime.productScopeJournals;
      assert.equal(typeof ordinaryJournal, "function");
      const ordinaryJournalBefore = await journalCounts();
      await withProductPublicationHttp(
        normal,
        readerSession,
        { brandReference: id(2), storeReference: id(20) },
        async (post) => {
          const path = "/merchant/catalog/products/publication/scope-journals",
            request = { productReference: id(5), expectedAggregateVersion: 16 };
          const read = await post(request, {}, path);
          assert.equal(read.status, 200);
          assert.equal(read.cacheControl, "no-store");
          assert.equal(read.body.aggregateVersion, 16);
          assert.equal(read.body.currentDisposition, "NotEvaluated");
          assert.equal(read.body.eligibility, "NotEvaluated");
          assert.equal(
            read.body.versions.find((v) => v.versionReference === id(6)).journal.digest,
            originalJournal.digest,
          );
          const activated = read.body.versions.find((v) => v.versionReference === id(13));
          assert.equal(activated.recordStatus, "Recorded");
          assert.equal(activated.journal.relations[0].relation, "IncomingSelectorPreferred");
          assert.equal(ordinaryJournalObserved, 5);
          assert.ok(ordinaryJournalPhaseCalls > 5);
          const wrongScope = await post(
            request,
            {
              "x-bop-catalog-scope": Buffer.from(
                JSON.stringify({ brandReference: id(2), storeReference: id(21) }),
              ).toString("base64url"),
            },
            path,
          );
          assert.equal(wrongScope.status, 403);
          const invalid = await post({ ...request, scopeJournal: {} }, {}, path);
          assert.equal(invalid.status, 400);
          for (const mode of ["late-journal-deny", "late-journal-expiry", "late-phase-deny"]) {
            ordinaryJournalMode = mode;
            ordinaryJournalObserved = 0;
            ordinaryJournalPhaseCalls = 0;
            ordinaryJournalClock = null;
            const refused = await post(request, {}, path);
            assert.equal(refused.status, mode === "late-journal-expiry" ? 503 : 403);
            assert.ok(ordinaryJournalObserved >= 4);
            assert.equal(Object.hasOwn(refused.body, "versions"), false);
            assert.deepEqual(await journalCounts(), ordinaryJournalBefore);
          }
          ordinaryJournalMode = "normal";
          ordinaryJournalObserved = 0;
          ordinaryJournalPhaseCalls = 0;
          ordinaryJournalClock = null;
          const recovered = await post(request, {}, path);
          assert.equal(recovered.status, 200);
          assert.deepEqual(recovered.body.versions, read.body.versions);
        },
        { productScopeJournals: ordinaryJournal },
      );
      assert.deepEqual(await journalCounts(), ordinaryJournalBefore);

      // Actual three-owner UniqueScope acquisition. Registry rows and current
      // Actor/field authority are controlled synthetic inputs, not Store/module
      // qualification. UniqueScope and its HardErrorsCleared summary are actual;
      // the other ten individual validation outcomes remain doubles.
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_SCOPE_STORE','Synthetic Scope Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [id(21), id(2), new Date().toISOString()],
      );
      await admin.query(
        `GRANT SELECT ON bop_tenant.store_reference_generation,bop_tenant.store_reference_projection TO ${role}`,
      );
      const currentDraft = await createPostgresProductLifecycleStore({
        brandReference: id(2),
        transactions: storeOptions.transactions,
        authorize: async () => true,
      }).load(id(5));
      assert.equal(currentDraft.aggregateVersion, 16);
      assert.equal(currentDraft.draft.versionReference, id(651));
      const currentIdentity = deriveCatalogProductPublicationContentIdentity(currentDraft);
      // Actual database request-start clock, shared by this synthetic batch.
      // Node and PostgreSQL wall clocks can differ by a few milliseconds;
      // a command later than a held SQL observation must remain unavailable.
      const scopeRequestStartedAt = (
        await admin.query(
          `SELECT to_char(date_trunc('milliseconds',statement_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at`,
        )
      ).rows[0].started_at;
      const uniqueCommand = (storeReference, operation = 97010) => ({
        ...command("Validate", 16, 0, operation),
        versionReference: currentDraft.draft.versionReference,
        contentDigest: currentIdentity.contentDigest,
        configurationDigest: currentIdentity.configurationDigest,
        occurredAt: scopeRequestStartedAt,
        scopeSet: [
          { level: "Store", reference: storeReference, channelCodes: [], orderTypeCodes: [] },
        ],
      });
      let denyUnique = false,
        expiredUniqueClock = null,
        lateUnique = false,
        expireUnique = false,
        expireAtFinalAuthority = false,
        repeatRosterWork = false,
        uniqueCalls = 0,
        uniqueHistoryCalls = 0;
      const uniqueAppliedOperations = [];
      const uniqueClock = { now: () => expiredUniqueClock ?? new Date().toISOString() };
      const uniquePolicy = createCurrentProductPublicationPolicySource({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        clock: uniqueClock,
        authority: {
          async holdUntilTransactionCompletes(_tx, request) {
            assert.equal(request.actorKind, "User");
            assert.equal(request.actorReference, id(3));
            if (denyUnique) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const uniqueSourceOptions = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: uniqueClock,
        policySource: uniquePolicy,
        validationAuthority: {
          async holdUntilTransactionCompletes(_tx, request) {
            assert.deepEqual(request.requiredPermissions, [
              "catalog.product.read",
              "catalog.product.validate",
            ]);
            assert.equal(request.requiredScope, "FullBrandScope");
            assert.equal(request.command.actorReference, id(3));
            if (
              expireAtFinalAuthority &&
              uniqueAppliedOperations.includes(request.command.operationReference)
            )
              expiredUniqueClock = new Date(Date.now() + 5000).toISOString();
            if (denyUnique) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
        historyAuthority: {
          async holdUntilTransactionCompletes(_tx, request) {
            assert.equal(request.permission, "catalog.manage");
            assert.equal(request.owningAction, "catalog.product.history.read");
            uniqueHistoryCalls++;
            if (denyUnique) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
        tenantAuthority: {
          async withCurrentBrandReferenceRead(request, work) {
            assert.equal(request.actorReference, id(3));
            assert.equal(request.brandReference, id(2));
            if (denyUnique) throw new Error("SYNTHETIC_CURRENT_REFERENCE_DENIED");
            if (repeatRosterWork) await work();
            return work();
          },
          async isCurrent() {
            return !denyUnique;
          },
        },
      };
      const uniqueSource = createCurrentProductUniqueScopeSource(uniqueSourceOptions);
      const candidateUniqueSource = createCurrentProductCandidateUniqueScopeSource({
        ...uniqueSourceOptions,
        candidateAuthority: {
          async holdUntilTransactionCompletes(_tx, request) {
            assert.equal(request.actorKind, "User");
            assert.equal(request.actorReference, id(3));
            assert.equal(request.purposeCode, "CATALOG_PRODUCT_VERSION_PUBLICATION");
            assert.equal(request.permission, "catalog.manage");
            assert.equal(request.owningAction, "catalog.product.validate");
            assert.deepEqual(request.requiredFields, productValidationCandidateFields);
            if (denyUnique) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const uniqueInput = (c) => ({ command: c, policyReference: id(31), policyVersion: 1 });
      const diagnosisObservations = [];
      const assessUnique = (c, work) =>
        storeOptions.transactions.run(async (tx) => {
          let consumerFailure;
          const diagnosis = {
            phase: "BeforeAcquisition",
            queryCount: 0,
            nodeMinusSqlMs: null,
            commandMinusSqlMs: null,
            consumerInvocations: 0,
          };
          const diagnosedTx = {
            async query(sql, values) {
              diagnosis.queryCount++;
              if (sql.includes("AS source FROM rms_catalog.product"))
                diagnosis.phase = "CatalogHistory";
              else if (sql.includes("bop_tenant.store_reference_projection"))
                diagnosis.phase = "TenantRoster";
              else if (sql.includes("bop_tenant.store_reference_generation"))
                diagnosis.phase = "TenantGeneration";
              else if (sql.includes("bop_publishing.publishing_mutation_record"))
                diagnosis.phase = "PublishingHistory";
              const result = await tx.query(sql, values);
              if (sql.includes("AS source FROM rms_catalog.product")) {
                const observedAt = result.rows[0]?.source?.observedAt;
                assert.equal(typeof observedAt, "string");
                diagnosis.nodeMinusSqlMs = Date.now() - Date.parse(observedAt);
                diagnosis.commandMinusSqlMs = Date.parse(c.occurredAt) - Date.parse(observedAt);
              }
              return result;
            },
          };
          try {
            const result = await uniqueSource.withCurrentAssessment(
              diagnosedTx,
              uniqueInput(c),
              async (assessment) => {
                diagnosis.consumerInvocations++;
                try {
                  return await work(assessment);
                } catch (error) {
                  consumerFailure = error;
                  throw error;
                }
              },
            );
            diagnosisObservations.push(diagnosis);
            return result;
          } catch (error) {
            if (consumerFailure) throw consumerFailure;
            throw new Error("SYNTHETIC_SCOPE_SOURCE_DIAG:" + JSON.stringify(diagnosis), {
              cause: error,
            });
          }
        });
      const passingScopeCommand = uniqueCommand(id(21));
      await assessUnique(passingScopeCommand, async (assessment) => {
        assert.equal(assessment.check.outcome, "Pass");
        assert.equal(assessment.publishValidation, "Incomplete");
        assert.equal(assessment.eligibility, "NotEvaluated");
        assert.equal(assessment.policyPublicationReference, actualPolicyRelease.releaseId);
        assert.equal(assessment.aggregateVersion, 16);
        assert.equal(assessment.originalIntentDigest, hash(passingScopeCommand));
        await admin.query("BEGIN");
        try {
          for (const key of ["CatalogProductSource:" + id(2), "TenantStoreReferenceV1:" + id(2)])
            assert.equal(
              (
                await admin.query(
                  "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
                  [key],
                )
              ).rows[0].acquired,
              false,
            );
          await assert.rejects(
            admin.query(
              "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE NOWAIT",
            ),
            { code: "55P03" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      });
      for (const storeReference of [id(20), id(999)]) {
        const assessment = await assessUnique(uniqueCommand(storeReference), async (a) => a);
        assert.equal(assessment.check.outcome, "HardError");
        assert(
          assessment.findings.some(
            (f) =>
              f.reason ===
              (storeReference === id(20)
                ? "EQUAL_RANK_REQUIRES_DISPOSITION"
                : "STORE_NOT_CURRENT_ACTIVE"),
          ),
        );
      }
      for (const level of ["Region", "StoreGroup"]) {
        const c = {
          ...uniqueCommand(id(21)),
          scopeSet: [{ level, reference: id(999), channelCodes: [], orderTypeCodes: [] }],
        };
        await assessUnique(c, async (assessment) => {
          assert.equal(assessment.check.outcome, "HardError");
          assert(assessment.findings.some((f) => f.reason === "CURRENT_TOPOLOGY_REQUIRED"));
        });
      }
      // One bounded diagnosis batch for the observed intermittent refusals,
      // not an ordinary benchmark or a repeated full-regression result.
      const diagnosisBefore = diagnosisObservations.length;
      for (let observation = 0; observation < 32; observation++) {
        const assessment = await assessUnique(uniqueCommand(id(21)), async (a) => a);
        assert.equal(assessment.check.outcome, "Pass");
      }
      const batch = diagnosisObservations.slice(diagnosisBefore);
      assert.equal(batch.length, 32);
      assert(batch.every((d) => d.consumerInvocations === 1 && d.nodeMinusSqlMs !== null));
      console.info(
        "SYNTHETIC_SCOPE_DIAG32",
        JSON.stringify({
          observations: batch.length,
          nodeMinusSqlMs: [
            Math.min(...batch.map((d) => d.nodeMinusSqlMs)),
            Math.max(...batch.map((d) => d.nodeMinusSqlMs)),
          ],
          commandMinusSqlMs: [
            Math.min(...batch.map((d) => d.commandMinusSqlMs)),
            Math.max(...batch.map((d) => d.commandMinusSqlMs)),
          ],
        }),
      );
      // The actual legacy minimal Draft has no complete editor content. The
      // combined candidate source must refuse before acquiring scope history.
      const beforeLegacyCandidateHistory = uniqueHistoryCalls;
      let legacyCandidateConsumerCalls = 0;
      await assert.rejects(
        storeOptions.transactions.run((tx) =>
          candidateUniqueSource.withCurrentAssessment(
            tx,
            uniqueInput(passingScopeCommand),
            async () => {
              legacyCandidateConsumerCalls++;
            },
          ),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(uniqueHistoryCalls, beforeLegacyCandidateHistory);
      assert.equal(legacyCandidateConsumerCalls, 0);
      for (const override of [
        { versionReference: id(999) },
        { contentDigest: "sha256:" + "a".repeat(64) },
        { configurationDigest: "sha256:" + "b".repeat(64) },
        { expectedProductAggregateVersion: 15 },
        { expectedProductAggregateVersion: 17 },
      ]) {
        const beforeHistory = uniqueHistoryCalls;
        let consumerCalls = 0;
        await assert.rejects(
          storeOptions.transactions.run((tx) =>
            candidateUniqueSource.withCurrentAssessment(
              tx,
              uniqueInput({ ...passingScopeCommand, ...override }),
              async () => {
                consumerCalls++;
              },
            ),
          ),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.equal(uniqueHistoryCalls, beforeHistory);
        assert.equal(consumerCalls, 0);
      }
      const uniqueWriter = createPostgresProductPublicationStore({
        ...storeOptions,
        clock: { now: () => new Date().toISOString() },
        audit: {
          create(p, action) {
            return { ...storeOptions.audit.create(p, action), occurredAt: p.occurredAt };
          },
        },
        sources: {
          ...syntheticScopePolicy,
          async withHeldCurrentFacts(tx, input, work) {
            uniqueCalls++;
            // Legacy minimal-Draft scope-only integration: acquire the actual
            // independent scope owner; all remaining checks stay synthetic.
            // This does not establish complete candidate/publication eligibility.
            return uniqueSource.withCurrentAssessment(
              tx,
              uniqueInput(input.command),
              async (assessment) => {
                // Writer observation is the validation's start instant. The
                // independent owning SQL observation bounds its source lease;
                // separate wall clocks must not impose an extra ordering check.
                const original = facts(input.command);
                const result = await work({
                  ...original,
                  now: input.observedAt,
                  validation: {
                    ...original.validation,
                    evidenceReference: input.command.operationReference,
                    checkedAt: input.observedAt,
                    validUntil: assessment.validUntil,
                    checks: original.validation.checks.map((check) =>
                      check.code === "UniqueScope"
                        ? assessment.check
                        : check.code === "HardErrorsCleared"
                          ? { ...check, outcome: assessment.check.outcome }
                          : check,
                    ),
                  },
                });
                assert.equal(result.aggregate.aggregateVersion, 17);
                assert.equal(result.publication.validationDecision, "HardError");
                uniqueAppliedOperations.push(input.command.operationReference);
                if (lateUnique) denyUnique = true;
                if (expireUnique)
                  expiredUniqueClock = new Date(
                    Date.parse(assessment.observedAt) + 5000,
                  ).toISOString();
                return result;
              },
            );
          },
        },
      });
      const uniqueCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*) FROM rms_catalog.product_publication_revision) revisions,(SELECT count(*) FROM rms_catalog.product_operation_record) operations,(SELECT count(*) FROM rms_catalog.product_source_commit) sources,(SELECT max(source_revision)::text FROM rms_catalog.product_source_head) sourceHead,(SELECT count(*) FROM rms_catalog.product_operation_snapshot) snapshots,(SELECT max(next_sequence)::text FROM platform_audit.audit_chain_head) next,(SELECT count(*) FROM platform_audit.audit_record) audits,(SELECT count(*) FROM platform_eventing.outbox_event) events",
            [id(5)],
          )
        ).rows[0];
      const beforeUnique = await uniqueCounts();
      lateUnique = true;
      await assert.rejects(uniqueWriter.execute(uniqueCommand(id(20), 97011)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      assert(uniqueAppliedOperations.includes(id(97011)));
      lateUnique = false;
      denyUnique = false;
      assert.deepEqual(await uniqueCounts(), beforeUnique);
      expireUnique = true;
      await assert.rejects(uniqueWriter.execute(uniqueCommand(id(20), 97012)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      assert(uniqueAppliedOperations.includes(id(97012)));
      expiredUniqueClock = null;
      expireUnique = false;
      assert.deepEqual(await uniqueCounts(), beforeUnique);
      expireAtFinalAuthority = true;
      await assert.rejects(uniqueWriter.execute(uniqueCommand(id(20), 97014)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      assert(uniqueAppliedOperations.includes(id(97014)));
      expiredUniqueClock = null;
      expireAtFinalAuthority = false;
      assert.deepEqual(await uniqueCounts(), beforeUnique);
      repeatRosterWork = true;
      await assert.rejects(uniqueWriter.execute(uniqueCommand(id(20), 97015)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal(uniqueAppliedOperations.filter((op) => op === id(97015)).length, 1);
      repeatRosterWork = false;
      assert.deepEqual(await uniqueCounts(), beforeUnique);
      const persistedCommand = uniqueCommand(id(20), 97013);
      const persistedUnique = await uniqueWriter.execute(persistedCommand);
      assert.equal(persistedUnique.publication.validationDecision, "HardError");
      assert.equal(persistedUnique.publication.state, "Draft");
      assert.equal((await uniqueCounts()).root, 17);
      const callsBeforeRecovery = uniqueCalls;
      denyUnique = true;
      const recoveredUnique = await uniqueWriter.execute(persistedCommand);
      assert.equal(recoveredUnique.status, "Replayed");
      assert.deepEqual(recoveredUnique.publication, persistedUnique.publication);
      assert.deepEqual(recoveredUnique.aggregate, persistedUnique.aggregate);
      assert.equal(uniqueCalls, callsBeforeRecovery);
      denyAuthority = true;
      await assert.rejects(uniqueWriter.execute(persistedCommand), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      denyAuthority = false;
      denyUnique = false;

      // New exact whole-scope orchestration uses actual owning writes and the
      // current Published Product-policy producer. Validation/Actor holders
      // remain explicit synthetic fixtures, not normal publication readiness.
      let replacementClock = new Date().toISOString(),
        replacementMode = "normal";
      const replacementAt = replacementClock;
      const replacementApplied = [];
      const replacementCommand = (action, root, pub, operation) => ({
        ...command(action, root, pub, operation),
        versionReference: currentDraft.draft.versionReference,
        contentDigest: currentIdentity.contentDigest,
        configurationDigest: currentIdentity.configurationDigest,
        occurredAt: replacementAt,
        successorDraftVersionReference: action === "Publish" ? id(98003) : null,
      });
      const oldCommand = {
        ...command("Supersede", 20, 3, 98002),
        actorKind: "System",
        actorReference: id(4),
        replacementVersionReference: currentDraft.draft.versionReference,
        occurredAt: replacementAt,
      };
      const replacementPolicy = createCurrentProductPublicationPolicySource({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        clock: { now: () => replacementClock },
        authority: {
          async holdUntilTransactionCompletes() {
            if (replacementMode === "late-policy")
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const replacementOwner = (actor, actorKind) => ({
        ...storeOptions,
        transactions: storeOptions.transactions,
        actorReference: id(actor),
        actorKind,
        clock: { now: () => replacementClock },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(input.command.actorReference, id(actor));
            // This fixture observes tentative roots under exact Tenant/Brand
            // RLS; owning authorization executes before the writer sets scope.
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
              [id(1), id(2)],
            );
            const root = (
              await tx.query(
                "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
                [id(5)],
              )
            ).rows[0].aggregate_version;
            if ([20, 21].includes(root)) replacementApplied.push(root);
            if (replacementMode === "second-denial" && actorKind === "System") {
              assert.equal(root, 20);
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            }
            if (replacementMode === "final-denial" && actorKind === "User" && root === 21)
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (replacementMode === "final-expiry" && actorKind === "System" && root === 21)
              replacementClock = new Date(Date.parse(replacementAt) + 5000).toISOString();
          },
        },
        sources: {
          ...replacementPolicy,
          async withHeldCurrentFacts(tx, input, work) {
            const c = input.command,
              original = facts(c);
            let replacement = null;
            if (actorKind === "System") {
              const read = await tx.query(
                "SELECT snapshot_json FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND product_version_id=$4 ORDER BY publication_version DESC LIMIT 1",
                [id(1), id(2), id(5), c.replacementVersionReference],
              );
              assert.equal(read.rows.length, 1);
              const actual = read.rows[0].snapshot_json;
              replacement = {
                productReference: actual.productReference,
                versionReference: actual.versionReference,
                scopeDigest: actual.scopeDigest,
                state: actual.state,
                publishedAt: actual.publishedAt,
              };
            }
            const result = await work({
              ...original,
              now: input.observedAt,
              replacement,
              validation: {
                ...original.validation,
                checkedAt: input.observedAt,
                validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
              },
            });
            const root = (
              await tx.query(
                "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
                [id(5)],
              )
            ).rows[0].aggregate_version;
            if ([20, 21].includes(root)) replacementApplied.push(root);
            if (replacementMode === "late-source" && actorKind === "System")
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            return result;
          },
        },
        audit: {
          create(p, action) {
            return {
              ...storeOptions.audit.create(p, action),
              actor:
                actorKind === "System"
                  ? { type: "System" }
                  : { type: "User", reference: id(actor) },
              occurredAt: p.occurredAt,
            };
          },
        },
      });
      const userOwner = replacementOwner(3, "User"),
        systemOwner = replacementOwner(4, "System");
      const preparationWriter = createPostgresProductPublicationStore(userOwner);
      await preparationWriter.execute(replacementCommand("Validate", 17, 1, 98000));
      await preparationWriter.execute(replacementCommand("SubmitReview", 18, 2, 98001));
      const pairInput = {
        publish: replacementCommand("Publish", 19, 3, 98004),
        supersede: oldCommand,
      };
      const replacementStore = createPostgresProductWholeScopeReplacementStore({
        publish: userOwner,
        supersede: systemOwner,
        clock: { now: () => replacementClock },
        transactions: storeOptions.transactions,
      });
      const replacementCounts = async () => ({
        ...(await uniqueCounts()),
        ...(await journalCounts()),
        frozen: (
          await admin.query("SELECT count(*)::int n FROM rms_catalog.product_publication_content")
        ).rows[0].n,
        drafts: (await admin.query("SELECT count(*)::int n FROM rms_catalog.product_version"))
          .rows[0].n,
      });
      const beforeReplacement = await replacementCounts();
      for (const mode of ["second-denial", "late-source", "final-denial", "final-expiry"]) {
        replacementMode = mode;
        replacementClock = replacementAt;
        replacementApplied.length = 0;
        await assert.rejects(replacementStore.execute(pairInput), {
          code: mode.includes("denial")
            ? "CATALOG_PERMISSION_DENIED"
            : "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
        assert(replacementApplied.includes(20));
        if (mode !== "second-denial") assert(replacementApplied.includes(21));
        assert.deepEqual(await replacementCounts(), beforeReplacement);
      }
      replacementMode = "normal";
      replacementClock = replacementAt;
      const actualReplacement = await replacementStore.execute(pairInput);
      assert.equal(actualReplacement.status, "Applied");
      assert.equal(actualReplacement.published.aggregate.aggregateVersion, 20);
      assert.equal(actualReplacement.superseded.aggregate.aggregateVersion, 21);
      assert.equal(
        actualReplacement.superseded.publication.supersededByVersionReference,
        currentDraft.draft.versionReference,
      );
      assert.equal(actualReplacement.published.scopeJournalStatus, "Recorded");
      assert(
        actualReplacement.published.scopeJournal.plan.overlaps.some(
          (relation) =>
            relation.previousVersionReference === id(6) &&
            relation.relation === "EqualPrecedenceOverlap",
        ),
      );
      const afterReplacement = await replacementCounts();
      assert.equal(afterReplacement.root, 21);
      assert.equal(afterReplacement.journals, beforeReplacement.journals + 1);
      assert.equal(afterReplacement.operations, beforeReplacement.operations + 2);
      assert.equal(afterReplacement.audit, beforeReplacement.audit + 2);
      assert.equal(afterReplacement.outbox, beforeReplacement.outbox + 2);
      assert.equal(afterReplacement.frozen, beforeReplacement.frozen + 1);
      assert.equal(afterReplacement.drafts, beforeReplacement.drafts + 1);
      replacementClock = new Date(Date.parse(replacementAt) + 60000).toISOString();
      const pairRecovery = await replacementStore.execute(pairInput);
      assert.equal(pairRecovery.status, "Replayed");
      assert.deepEqual(pairRecovery.published.publication, actualReplacement.published.publication);
      assert.deepEqual(
        pairRecovery.superseded.publication,
        actualReplacement.superseded.publication,
      );
      assert.deepEqual(pairRecovery.published, {
        ...actualReplacement.published,
        status: "Replayed",
      });
      assert.deepEqual(pairRecovery.superseded, {
        ...actualReplacement.superseded,
        status: "Replayed",
      });
      assert.deepEqual(await replacementCounts(), afterReplacement);
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled([admin.end(), writer.end()]);
    }
  });
});

it("round-trips complete editor content through owning create/replace/replay/publication/successor with fail-closed leases", async () => {
  // Current Tag/Attribute and Variant sources, SQL, forced RLS, immutable records,
  // CAS, Audit/Outbox and rollback are actual. Other scope/reference/policy and
  // current Actor/Brand field-authority holders remain explicitly synthetic.
  const {
    createPostgresProductCreationStore,
    createPostgresProductDraftStore,
    createPostgresProductLifecycleStore,
    productEditorContentFields,
    productEditorContentReferenceChecks,
    createPostgresProductVariantIdentityHistorySource,
    assertProductVariantIdentityHistory,
    productVariantHistoryFields,
  } = await import("../../rms/catalog/src/index.ts");
  await withIsolatedDatabase({ caseId: "full_prod_content" }, async (context) => {
    const admin = new pg.Client(context.clientConfig),
      writer = new pg.Client(context.clientConfig);
    await Promise.all([admin.connect(), writer.connect()]);
    const role = "wp2421_full_" + context.runId;
    assert.match(role, /^wp2421_full_[a-f0-9]+$/);
    const time = "2026-09-29T12:00:00.000Z";
    let authorized = true,
      denyContent = false,
      failAfterWrite = false,
      armed = false;
    const seen = [];
    const details = {
      profile: "CatalogProductEditorContentV1",
      localizedShortDescriptions: { "en-CA": "Synthetic short" },
      localizedDescriptions: { "en-CA": "Synthetic complete\nDescription" },
      preparationNotes: { "en-CA": "Synthetic operational note" },
      tagReferences: [id(701)],
      attributeValues: [
        { attributeReference: id(702), type: "Decimal", value: "1.25", unitCode: "KG" },
      ],
      media: [
        {
          mediaReference: id(703),
          assetReference: id(704),
          assetVersionReference: id(705),
          role: "Primary",
          altText: { "en-CA": "Synthetic photo" },
          sortOrder: 0,
          cropReference: null,
          focusReference: null,
        },
      ],
      variantDimensions: [
        {
          dimensionReference: id(709),
          code: "SIZE",
          localizedNames: { "en-CA": "Size" },
          sortOrder: 0,
          selectionRequirement: "Required",
          values: [
            {
              valueReference: id(710),
              code: "SMALL",
              localizedNames: { "en-CA": "Small" },
              sortOrder: 0,
              attributeReference: null,
              mediaReference: null,
            },
          ],
        },
      ],
      variantCombinations: [
        {
          selections: [{ dimensionReference: id(709), valueReference: id(710) }],
          disposition: "Valid",
          skuReference: id(602),
        },
      ],
      optionRules: [],
      allergenReferences: [id(706)],
      nutritionProfile: { reference: id(707), versionReference: id(708) },
    };
    const original = parseProductAggregate({
      productReference: id(600),
      brandReference: id(2),
      internalCode: "FULL_SYNTHETIC",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: time,
      createdByActorReference: id(3),
      updatedAt: time,
      draft: {
        versionReference: id(601),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic complete" },
        taxClassificationReference: null,
        createdAt: time,
        updatedAt: time,
        editorContent: details,
        skus: [
          {
            skuReference: id(602),
            productReference: id(600),
            brandReference: id(2),
            skuCode: "FULL_SYNTHETIC_ONE",
            lifecycle: "Draft",
            localizedNames: { "en-CA": "Synthetic SKU" },
            variantSelections: [{ dimensionReference: id(709), valueReference: id(710) }],
            unitOfSale: "EA",
            unitQuantity: "1",
            createdAt: time,
            createdByActorReference: id(3),
          },
        ],
        optionBindings: [],
      },
    });
    const transactions = {
      async run(work) {
        await writer.query("BEGIN");
        try {
          await writer.query(`SET LOCAL ROLE ${role}`);
          await writer.query("SELECT set_config('bop.tenant_id',$1,true)", [id(1)]);
          const result = await work(writer);
          await writer.query("COMMIT");
          return result;
        } catch (error) {
          await writer.query("ROLLBACK");
          throw error;
        }
      },
    };
    const variantSource = (sourceTransactions) =>
      createPostgresProductVariantIdentityHistorySource({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => new Date().toISOString() },
        transactions: sourceTransactions,
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(tx, writer);
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY");
            assert.equal(input.actorReference, id(3));
            if (!authorized) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
    const contentRegistrySource = (sourceTransactions) =>
      createPostgresProductContentRegistryStore({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        clock: { now: () => new Date().toISOString() },
        transactions: sourceTransactions,
        // Actual owning definitions/clock/source fence; current Actor/Brand field policy is synthetic.
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(tx, writer);
            assert.equal(input.action, "catalog.content-registry.read");
            if (!authorized) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
    const editorContentAuthority = {
      async holdUntilTransactionCompletes(tx, input) {
        assert.equal(tx, writer);
        assert.deepEqual(input.requiredFields, productEditorContentFields);
        assert.equal(input.aggregate.brandReference, id(2));
        assert.equal(input.aggregate.productReference, id(600));
        assert.deepEqual(
          input.requiredReferenceChecks,
          input.mode === "Read" ? [] : productEditorContentReferenceChecks,
        );
        seen.push(input.mode);
        if (denyContent || (armed && input.mode === "Read"))
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        if (failAfterWrite && input.mode === "DraftWrite") armed = true;
        if (input.mode !== "Read") {
          const observedAt = new Date().toISOString();
          await contentRegistrySource({ run: (work) => work(tx) }).withCurrentRegistry(
            {
              originalIntentDigest: deriveCatalogProductPublicationContentIdentity(input.aggregate)
                .configurationDigest,
              observedAt,
              validUntil: new Date(Date.parse(observedAt) + 30000).toISOString(),
            },
            async (source) =>
              validateCatalogProductRegisteredContent(input.aggregate, source.registry),
          );
        }
        if (input.mode !== "Read" && input.aggregate.aggregateVersion > 1) {
          // Actual Variant source joins this already owning transaction, never
          // opens or commits a nested transaction. Tag/Attribute sources are also
          // actual; remaining current reference and policy holders are synthetic.
          await variantSource({ run: (work) => work(tx) }).withCurrentSnapshot(
            {
              productReference: input.aggregate.productReference,
              expectedAggregateVersion:
                input.aggregate.aggregateVersion - (input.mode === "DraftWrite" ? 1 : 0),
              originalIntentDigest: deriveCatalogProductPublicationContentIdentity(input.aggregate)
                .configurationDigest,
            },
            async (snapshot) => assertProductVariantIdentityHistory(input.aggregate, snapshot),
          );
        }
      },
    };
    const options = {
      brandReference: id(2),
      transactions,
      editorContentAuthority,
      authorize: async () => authorized,
    };
    const creation = createPostgresProductCreationStore(options),
      draftStore = createPostgresProductDraftStore(options),
      reader = createPostgresProductLifecycleStore(options);
    const audit = (operation, action) => ({
      auditId: id(900 + operation),
      brandId: id(2),
      actor: { type: "User", reference: id(3) },
      actionCode: action,
      targetType: "CatalogProduct",
      targetId: id(600),
      correlationId: id(operation),
      occurredAt: time,
      reasonCode: "SYNTHETIC_CONTENT",
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Internal",
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    });
    const createRecord = {
      action: "Create",
      operationReference: id(610),
      operationIntentHash: sha256Hex("synthetic full creation"),
      aggregate: original,
    };
    const next = parseProductAggregate({
      ...original,
      aggregateVersion: 2,
      draft: {
        ...original.draft,
        editorContent: {
          ...original.draft.editorContent,
          localizedDescriptions: { "en-CA": "Changed complete content" },
        },
      },
    });
    const draftRecord = {
      action: "ReplaceDraft",
      operationReference: id(611),
      operationIntentHash: sha256Hex("synthetic full replacement"),
      aggregate: next,
    };
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id),'[]'::jsonb) FROM rms_catalog.product_source_head h) heads,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
          [id(600)],
        )
      ).rows[0];
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT SELECT ON rms_catalog.product_publication_operation_abandonment TO ${role}`,
      );
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.product_version_category_assignment TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.product_publication_revision,rms_catalog.product_scope_journal,rms_catalog.product_publication_content TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE ON rms_catalog.product_source_head,platform_audit.audit_chain_head TO ${role}`,
      );
      await admin.query(
        `GRANT INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_catalog.product_content_registry_record TO ${role}`,
      );
      const registry = {
        profile: "CatalogProductContentRegistryV1",
        tenantReference: id(1),
        brandReference: id(2),
        registryReference: id(780),
        versionReference: id(781),
        registryVersion: 1,
        defaultLocale: "en-CA",
        previousSnapshotDigest: null,
        registeredAt: time,
        tags: [
          {
            tagReference: id(701),
            code: "TAG",
            localizedNames: { "en-CA": "Synthetic registered tag" },
            lifecycle: "Active",
          },
        ],
        attributes: [
          {
            attributeReference: id(702),
            code: "WEIGHT",
            localizedNames: { "en-CA": "Synthetic registered weight" },
            lifecycle: "Active",
            type: "Decimal",
            unitCode: "KG",
            minimumValue: "0",
            maximumValue: "10",
          },
        ],
      };
      await createPostgresProductContentRegistryStore({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        clock: { now: () => time },
        transactions,
        authority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.action, "catalog.content-registry.manage");
            if (!authorized) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
        audit: {
          create() {
            return {
              auditId: id(880),
              brandId: id(2),
              actor: { type: "User", reference: id(3) },
              actionCode: "CATALOG_CONTENT_REGISTRY_RECORDED",
              targetType: "CatalogContentRegistry",
              targetId: id(780),
              reasonCode: "SYNTHETIC_REGISTRY",
              correlationId: id(782),
              occurredAt: time,
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Confidential",
              retentionPolicyCode: "CATALOG_CONFIGURATION",
              retentionPolicyVersion: 1,
            };
          },
        },
      }).execute({
        purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        operationReference: id(782),
        expectedRegistryVersion: 0,
        occurredAt: time,
        reasonCode: "SYNTHETIC_REGISTRY",
        registry,
      });
      await creation.create({ record: createRecord, audit: audit(610, "CATALOG_PRODUCT_CREATE") });
      assert.deepEqual(await reader.load(id(600)), original);
      await assert.rejects(
        createPostgresProductLifecycleStore({ ...options, editorContentAuthority: undefined }).load(
          id(600),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      denyContent = true;
      await assert.rejects(reader.resolveOperation(id(610)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      denyContent = false;
      await draftStore.commit({
        record: draftRecord,
        expectedAggregateVersion: 1,
        audit: audit(611, "CATALOG_PRODUCT_REPLACEDRAFT"),
      });
      assert.deepEqual(await reader.load(id(600)), next);
      // Actual current complete Draft; the current permission holder remains synthetic.
      let candidateNow = time,
        denyCandidate = false,
        candidateHolds = 0;
      const candidateOptions = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        transactions,
        clock: { now: () => candidateNow },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            candidateHolds++;
            assert.equal(tx, writer);
            assert.equal(input.tenantReference, id(1));
            assert.equal(input.brandReference, id(2));
            assert.equal(input.actorReference, id(3));
            assert.equal(input.actorKind, "User");
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_VERSION_PUBLICATION");
            assert.equal(input.owningAction, "catalog.product.validate");
            assert.equal(input.permission, "catalog.manage");
            assert.deepEqual(input.requiredFields, productValidationCandidateFields);
            if (denyCandidate) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      };
      const candidateSource = createPostgresProductValidationCandidateSource(candidateOptions);
      const candidateCommand = {
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        operationReference: id(886),
        productReference: id(600),
        versionReference: id(601),
        expectedProductAggregateVersion: 2,
        expectedPublicationVersion: 0,
        action: "Validate",
        contentDigest: deriveCatalogProductPublicationContentIdentity(next).contentDigest,
        configurationDigest:
          deriveCatalogProductPublicationContentIdentity(next).configurationDigest,
        scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: time, localDateTime: time.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
        scheduleReference: null,
        replacementVersionReference: null,
        successorDraftVersionReference: null,
        occurredAt: time,
        reasonCode: "SYNTHETIC_VALIDATE",
      };
      const currentCandidate = await candidateSource.withCurrentCandidate(
        candidateCommand,
        async (value, tx) => {
          assert.equal(tx, writer);
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::integer n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted",
              )
            ).rows[0].n > 0,
            true,
          );
          const recipeTarget = deriveCatalogProductCandidateRecipeTarget(
            candidateCommand,
            value.aggregate,
            value.observedAt,
          );
          assert.equal(recipeTarget.productReference, value.aggregate.productReference);
          assert.equal(recipeTarget.versionReference, value.aggregate.draft.versionReference);
          assert.equal(recipeTarget.catalogConfigurationDigest, value.configurationDigest);
          assert.equal(recipeTarget.skuReference, null);
          assert.deepEqual(
            recipeTarget.skuReferences,
            value.aggregate.draft.skus.map((sku) => sku.skuReference).sort(),
          );
          assert.deepEqual(
            recipeTarget.bindings.map((binding) => binding.bindingReference),
            value.aggregate.draft.optionBindings.map((binding) => binding.bindingReference).sort(),
          );
          assert(Object.isFrozen(recipeTarget.bindings));
          assert.throws(() =>
            deriveCatalogProductCandidateRecipeTarget(
              { ...candidateCommand, expectedProductAggregateVersion: 1 },
              value.aggregate,
              value.observedAt,
            ),
          );
          return value;
        },
      );
      assert.deepEqual(currentCandidate.aggregate, next);
      assert.equal(currentCandidate.completeContent, "Present");
      assert.equal(currentCandidate.publishValidation, "Incomplete");
      assert.equal(currentCandidate.referenceEligibility, "NotEvaluated");
      const holdsBeforeWrongActor = candidateHolds;
      await assert.rejects(
        candidateSource.withCurrentCandidate(
          { ...candidateCommand, actorReference: id(99) },
          async () => assert.fail("wrong Actor callback"),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(candidateHolds, holdsBeforeWrongActor);
      for (const patch of [
        { expectedProductAggregateVersion: 1 },
        { versionReference: id(999) },
        { contentDigest: hash("wrong") },
        { configurationDigest: hash("wrong") },
      ]) {
        await assert.rejects(
          candidateSource.withCurrentCandidate({ ...candidateCommand, ...patch }, async () =>
            assert.fail("wrong current identity callback"),
          ),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
      }
      const candidateWrite = async (tx) => {
        await createPostgresProductDraftStore({
          ...options,
          transactions: { run: (work) => work(tx) },
        }).commit({
          record: {
            action: "ReplaceDraft",
            operationReference: id(887),
            operationIntentHash: sha256Hex("synthetic candidate late rollback"),
            aggregate: parseProductAggregate({
              ...next,
              aggregateVersion: 3,
              draft: { ...next.draft, localizedNames: { "en-CA": "Rollback only" } },
            }),
          },
          expectedAggregateVersion: 2,
          audit: audit(887, "CATALOG_PRODUCT_REPLACEDRAFT"),
        });
      };
      let markerFor82;
      const pairEvidence80 = await exerciseCurrentProductCandidateRecipeBindingScope({
        admin,
        role,
        id,
        transactions,
        candidateCommand,
        candidateAuthority: candidateOptions.authority,
        skuReference: next.draft.skus[0].skuReference,
        changeCandidate: async (tx) => {
          await candidateWrite(tx);
          const row = await tx.query(
            "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
            [id(600)],
          );
          assert.equal(row.rows[0].aggregate_version, 3);
        },
        createMarker: async function createMarker(tx) {
          markerFor82 = createMarker;
          const marker = parseProductAggregate({
            ...original,
            productReference: id(86200),
            internalCode: "SYNTHETIC_PAIR80_MARKER",
            draft: {
              ...original.draft,
              versionReference: id(86201),
              skus: [],
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
          await createPostgresProductCreationStore({
            ...options,
            transactions: { run: (work) => work(tx) },
            editorContentAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                assert.equal(actual, tx);
                assert(["Read", "DraftWrite"].includes(input.mode));
                assert.deepEqual(input.aggregate, marker);
                assert.deepEqual(input.requiredFields, productEditorContentFields);
                assert.deepEqual(
                  input.requiredReferenceChecks,
                  input.mode === "Read" ? [] : productEditorContentReferenceChecks,
                );
                if (input.mode === "Read") return;
                const observedAt = new Date().toISOString();
                await contentRegistrySource({ run: (work) => work(actual) }).withCurrentRegistry(
                  {
                    originalIntentDigest:
                      deriveCatalogProductPublicationContentIdentity(marker).configurationDigest,
                    observedAt,
                    validUntil: new Date(Date.parse(observedAt) + 30000).toISOString(),
                  },
                  async (source) =>
                    validateCatalogProductRegisteredContent(marker, source.registry),
                );
              },
            },
          }).create({
            record: {
              action: "Create",
              operationReference: id(86202),
              operationIntentHash: sha256Hex("synthetic Pair80 independent rollback marker"),
              aggregate: marker,
            },
            audit: { ...audit(86202, "CATALOG_PRODUCT_CREATE"), targetId: id(86200) },
          });
          const proof = await tx.query(
            "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(target_id)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(aggregate_id)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
            [id(86200)],
          );
          assert.equal(proof.rows[0].root, 1);
          assert.equal(proof.rows[0].audit, 1);
          assert.equal(proof.rows[0].outbox, 1);
        },
      });
      assert(pairEvidence80.tableCount >= 20);
      assert.equal(pairEvidence80.lateRefusals, 6);
      assert.equal(pairEvidence80.pastRefusals, 1);
      // Actual current candidate + Tag/Attribute registry in the same caller UoW.
      let denyRegistry = false,
        registryCalls = 0,
        joinedWrites = 0;
      const registeredSource = createCurrentProductCandidateRegisteredContentSource({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => candidateNow },
        candidateAuthority: candidateOptions.authority,
        registryAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            registryCalls++;
            assert.equal(tx, writer);
            assert.equal(input.action, "catalog.content-registry.read");
            assert.deepEqual(input.requiredFields, contentRegistryFields);
            if (!authorized || denyRegistry) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const prepared = await transactions.run((tx) =>
        registeredSource.withCurrentAssessment(
          tx,
          candidateCommand,
          async (assessment) => assessment,
        ),
      );
      assert.equal(prepared.profile, "CurrentProductCandidateRegisteredContentV1");
      assert.equal(prepared.candidate.productReference, id(600));
      assert.equal(prepared.candidate.aggregateVersion, 2);
      assert.equal(prepared.candidate.contentDigest, candidateCommand.contentDigest);
      assert.equal(prepared.candidate.configurationDigest, candidateCommand.configurationDigest);
      assert.equal(prepared.currentCandidate, "Bound");
      assert.equal(prepared.publishValidation, "Incomplete");
      assert.equal(prepared.referenceEligibility, "NotEvaluated");
      assert.deepEqual(prepared.checks, ["TagRegistry", "AttributeRegistry"]);
      assert.equal(prepared.registryReference, registry.registryReference);
      assert.equal(prepared.registryVersion, registry.registryVersion);
      assert.equal(prepared.snapshotDigest, catalogProductContentRegistryDigest(registry));
      assert(!JSON.stringify(prepared).includes("Changed complete content"));
      const registryBeforeWrong = registryCalls;
      await assert.rejects(
        transactions.run((tx) =>
          registeredSource.withCurrentAssessment(
            tx,
            { ...candidateCommand, contentDigest: hash("wrong") },
            async () => assert.fail("wrong joined candidate"),
          ),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(registryCalls, registryBeforeWrong);
      const beforeJoined = await counts();
      for (const reason of ["candidate", "registry", "expiry"]) {
        joinedWrites = 0;
        await assert.rejects(
          transactions.run((tx) =>
            registeredSource.withCurrentAssessment(tx, candidateCommand, async () => {
              const write = await createPostgresProductDraftStore({
                ...options,
                transactions: { run: (callback) => callback(tx) },
              }).commit({
                record: {
                  action: "ReplaceDraft",
                  operationReference: id(889),
                  operationIntentHash: sha256Hex("synthetic joined late rollback"),
                  aggregate: parseProductAggregate({
                    ...next,
                    aggregateVersion: 3,
                    draft: { ...next.draft, localizedNames: { "en-CA": "Joined rollback only" } },
                  }),
                },
                expectedAggregateVersion: 2,
                audit: audit(889, "CATALOG_PRODUCT_REPLACEDRAFT"),
              });
              assert.equal(write.aggregate.aggregateVersion, 3);
              joinedWrites++;
              if (reason === "candidate") denyCandidate = true;
              if (reason === "registry") denyRegistry = true;
              if (reason === "expiry")
                candidateNow = new Date(
                  Date.parse(currentCandidate.observedAt) + 30000,
                ).toISOString();
            }),
          ),
          {
            code:
              reason === "expiry" ? "CATALOG_DEPENDENCY_UNAVAILABLE" : "CATALOG_PERMISSION_DENIED",
          },
        );
        denyCandidate = false;
        denyRegistry = false;
        candidateNow = time;
        assert.equal(joinedWrites, 1);
        assert.deepEqual(await counts(), beforeJoined);
        assert.deepEqual(await reader.load(id(600)), next);
      }
      // Actual current Draft identity binds complete owning Variant history.
      let variantNow = null,
        denyVariant = false,
        variantHolds = 0,
        variantWrites = 0;
      const currentVariantSource = createCurrentProductCandidateVariantIdentitySource({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => variantNow ?? new Date().toISOString() },
        candidateAuthority: candidateOptions.authority,
        variantAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            variantHolds++;
            assert.equal(tx, writer);
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY");
            assert.equal(input.permission, "catalog.product.history.read");
            if (!authorized || denyVariant) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const currentVariants = await transactions.run((tx) =>
        currentVariantSource.withCurrentAssessment(tx, candidateCommand, async (value) => value),
      );
      assert.equal(currentVariants.aggregateVersion, 2);
      assert.equal(currentVariants.contentDigest, candidateCommand.contentDigest);
      assert.equal(currentVariants.configurationDigest, candidateCommand.configurationDigest);
      assert.equal(currentVariants.variantIdentity, "Preserved");
      assert.equal(currentVariants.publishValidation, "Incomplete");
      assert.equal(currentVariants.referenceEligibility, "NotEvaluated");
      assert(!JSON.stringify(currentVariants).includes("dimensionCode"));
      assert(!JSON.stringify(currentVariants).includes("Changed complete content"));
      const variantBeforeWrong = variantHolds;
      await assert.rejects(
        transactions.run((tx) =>
          currentVariantSource.withCurrentAssessment(
            tx,
            { ...candidateCommand, contentDigest: hash("wrong") },
            async () => assert.fail("wrong current Variant candidate"),
          ),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(variantHolds, variantBeforeWrong);
      const beforeVariant = await counts();
      for (const failure of ["denial", "expiry"]) {
        variantWrites = 0;
        await assert.rejects(
          transactions.run((tx) =>
            currentVariantSource.withCurrentAssessment(tx, candidateCommand, async (assessment) => {
              const write = await createPostgresProductDraftStore({
                ...options,
                transactions: { run: (callback) => callback(tx) },
              }).commit({
                record: {
                  action: "ReplaceDraft",
                  operationReference: id(890),
                  operationIntentHash: sha256Hex("synthetic current Variant rollback"),
                  aggregate: parseProductAggregate({
                    ...next,
                    aggregateVersion: 3,
                    draft: { ...next.draft, localizedNames: { "en-CA": "Variant rollback only" } },
                  }),
                },
                expectedAggregateVersion: 2,
                audit: audit(890, "CATALOG_PRODUCT_REPLACEDRAFT"),
              });
              assert.equal(write.aggregate.aggregateVersion, 3);
              variantWrites++;
              if (failure === "denial") denyVariant = true;
              else variantNow = assessment.validUntil;
            }),
          ),
          {
            code:
              failure === "denial" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
          },
        );
        denyVariant = false;
        variantNow = null;
        assert.equal(variantWrites, 1);
        assert.deepEqual(await counts(), beforeVariant);
        assert.deepEqual(await reader.load(id(600)), next);
      }
      // Actual current candidate + Tenant/Pricing reference metadata. Stored
      // Draft rules and null classification do not resolve applicable tax.
      await admin.query(`GRANT USAGE ON SCHEMA bop_tenant,rms_pricing TO ${role}`);
      await admin.query(
        `GRANT SELECT ON bop_tenant.brand,bop_tenant.store_reference_generation,bop_tenant.store_reference_projection,rms_pricing.tax_reference_generation,rms_pricing.tax_reference_scope,rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule TO ${role}`,
      );
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES($1,'SYNTHETIC_TAX_BRAND','Synthetic Brand','en-CA','CAD','Active',1,$2,$2)",
        [id(2), time],
      );
      for (const [store, lifecycle] of [
        [20, "Active"],
        [21, "Archived"],
      ])
        await admin.query(
          "INSERT INTO bop_tenant.store VALUES($1,$2,$3,'Synthetic Store','America/Toronto','en-CA','CAD',$4,1,$5,$5)",
          [id(store), id(2), "SYNTHETIC_TAX_STORE_" + store, lifecycle, time],
        );
      for (const n of [90010, 90011, 90012])
        await admin.query(
          "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$5)",
          [id(n), id(2), id(20), "SYNTHETIC_TAX_ROOT_" + n, time, id(3)],
        );
      await admin.query("DELETE FROM rms_pricing.tax_configuration WHERE tax_configuration_id=$1", [
        id(90012),
      ]);
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,$4,1,$5,'Draft','CA-ON','CAD',1,$6,$5,$7,'America/Toronto',$7)`,
        [id(90013), id(90010), id(2), id(20), hash("synthetic tax metadata"), id(90015), time],
      );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
        [id(90013), id(90010)],
      );
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,receipt_presentation_code) VALUES($1,$2,$3,$4,$5,$6,'Pickup','Sellable','SYNTHETIC_COMPONENT','Taxable',0.13,'Exclusive','HalfUp',1,false,'SYNTHETIC_LINE')`,
        [id(90016), id(90013), id(90010), id(2), id(20), id(90014)],
      );
      let taxNow = null,
        denyTax = false,
        taxHeld = false,
        taxWrites = 0,
        taxHolds = 0,
        finalTaxExpiry = null,
        repeatTaxWork = false;
      const currentTaxSource = createCurrentProductCandidateTaxReferenceSource({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => taxNow ?? new Date().toISOString() },
        candidateAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            await candidateOptions.authority.holdUntilTransactionCompletes(tx, input);
            if (finalTaxExpiry !== null) taxNow = finalTaxExpiry;
          },
        },
        tenantAuthority: {
          async withCurrentBrandReferenceRead(input, work) {
            assert.equal(input.brandReference, id(2));
            assert.equal(input.actorReference, id(3));
            taxHeld = true;
            try {
              const result = await work();
              if (repeatTaxWork) {
                try {
                  await work();
                } catch {
                  /* Fault injection deliberately swallows a repeated owning callback. */
                }
              }
              return result;
            } finally {
              taxHeld = false;
            }
          },
          async isCurrent() {
            return taxHeld && !denyTax;
          },
        },
        brandTaxAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            taxHolds++;
            assert.equal(tx, writer);
            assert.equal(taxHeld, true);
            assert.equal(input.permission, "pricing.tax-config.manage");
            assert.equal(input.requiredScope, "Brand");
            assert.equal(input.request.operationReference, candidateCommand.operationReference);
            if (denyTax) throw new Error("synthetic current tax field denied");
          },
        },
        taxAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(tx, writer);
            assert.equal(taxHeld, true);
            assert.equal(input.tenantReference, id(1));
            assert.equal(input.permission, "pricing.tax-config.manage");
            if (denyTax) throw new Error("synthetic Store tax field denied");
          },
        },
      });
      const currentTax = await transactions.run((tx) =>
        currentTaxSource.withCurrentAssessment(tx, candidateCommand, async (value) => value),
      );
      assert.equal(currentTax.registeredStoreCount, 2);
      assert.equal(currentTax.unresolvedRootCount, 1);
      assert.equal(currentTax.retiredRootCount, 1);
      assert.equal(currentTax.classificationCoverage, "DefaultUnavailable");
      assert.equal(currentTax.matchingReferenceCount, 0);
      assert.equal(currentTax.taxResolution, "Unavailable");
      assert.equal(currentTax.publishValidation, "Incomplete");
      assert.equal(currentTax.contentDigest, candidateCommand.contentDigest);
      assert(!JSON.stringify(currentTax).includes(id(90014)));
      const beforeWrongTax = taxHolds;
      await assert.rejects(
        transactions.run((tx) =>
          currentTaxSource.withCurrentAssessment(
            tx,
            { ...candidateCommand, contentDigest: hash("wrong tax candidate") },
            async () => assert.fail("wrong candidate"),
          ),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(taxHolds, beforeWrongTax);
      const beforeTax = await counts();
      for (const failure of [
        "denial",
        "expiry",
        "final-candidate-expiry",
        "repeated-tenant-callback",
      ]) {
        taxWrites = 0;
        await assert.rejects(
          transactions.run((tx) =>
            currentTaxSource.withCurrentAssessment(tx, candidateCommand, async (assessment) => {
              const result = await createPostgresProductDraftStore({
                ...options,
                transactions: { run: (callback) => callback(tx) },
              }).commit({
                record: {
                  action: "ReplaceDraft",
                  operationReference: id(891),
                  operationIntentHash: sha256Hex("synthetic tax rollback"),
                  aggregate: parseProductAggregate({
                    ...next,
                    aggregateVersion: 3,
                    draft: { ...next.draft, localizedNames: { "en-CA": "Tax rollback only" } },
                  }),
                },
                expectedAggregateVersion: 2,
                audit: audit(891, "CATALOG_PRODUCT_REPLACEDRAFT"),
              });
              assert.equal(result.aggregate.aggregateVersion, 3);
              taxWrites++;
              if (failure === "denial") denyTax = true;
              else if (failure === "expiry") taxNow = assessment.validUntil;
              else if (failure === "final-candidate-expiry") finalTaxExpiry = assessment.validUntil;
              else repeatTaxWork = true;
            }),
          ),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        denyTax = false;
        taxNow = null;
        finalTaxExpiry = null;
        repeatTaxWork = false;
        assert.equal(taxWrites, 1);
        assert.deepEqual(await counts(), beforeTax);
        assert.deepEqual(await reader.load(id(600)), next);
      }
      // A real temporary root3 with explicit classification observes the real
      // stored Draft rule, then rolls back. A reference is still not TaxResolution.
      const explicitRollback = new Error("synthetic explicit-tax read rollback");
      await assert.rejects(
        transactions.run(async (tx) => {
          const explicit = parseProductAggregate({
            ...next,
            aggregateVersion: 3,
            draft: { ...next.draft, taxClassificationReference: id(90014) },
          });
          const saved = await createPostgresProductDraftStore({
            ...options,
            transactions: { run: (callback) => callback(tx) },
          }).commit({
            record: {
              action: "ReplaceDraft",
              operationReference: id(892),
              operationIntentHash: sha256Hex("synthetic explicit tax"),
              aggregate: explicit,
            },
            expectedAggregateVersion: 2,
            audit: audit(892, "CATALOG_PRODUCT_REPLACEDRAFT"),
          });
          assert.equal(saved.aggregate.aggregateVersion, 3);
          const identity = deriveCatalogProductPublicationContentIdentity(explicit);
          const observed = await currentTaxSource.withCurrentAssessment(
            tx,
            {
              ...candidateCommand,
              expectedProductAggregateVersion: 3,
              contentDigest: identity.contentDigest,
              configurationDigest: identity.configurationDigest,
            },
            async (value) => value,
          );
          assert.equal(observed.classificationCoverage, "CompleteExplicit");
          assert.equal(observed.matchingReferenceCount, 1);
          assert.equal(observed.taxResolution, "Unavailable");
          assert.equal(observed.publishValidation, "Incomplete");
          throw explicitRollback;
        }),
        (error) => error === explicitRollback,
      );
      assert.deepEqual(await counts(), beforeTax);
      assert.deepEqual(await reader.load(id(600)), next);
      const joinedEvidence82 = await exerciseCurrentProductCandidateStoreRecipePolicy({
        admin,
        role,
        id,
        transactions,
        candidateCommand,
        candidateAuthority: candidateOptions.authority,
        skuReference: next.draft.skus[0].skuReference,
        createMarker: markerFor82,
        changeCandidate: async (tx) => {
          await candidateWrite(tx);
        },
      });
      assert(joinedEvidence82.tableCount >= 30);
      assert.equal(joinedEvidence82.lateRefusals, 10);
      assert.equal(joinedEvidence82.beforeRefusals, 3);
      const joinedEvidence84 = await exerciseCurrentProductCandidateRecipeMeasurements({
        admin,
        role,
        id,
        transactions,
        candidateCommand,
        candidateAuthority: candidateOptions.authority,
        skuReference: next.draft.skus[0].skuReference,
        createMarker: markerFor82,
        changeCandidate: async (tx) => {
          await candidateWrite(tx);
        },
      });
      assert(joinedEvidence84.tableCount >= 40);
      assert.equal(joinedEvidence84.lateRefusals, 13);
      assert.equal(joinedEvidence84.beforeRefusals, 3);
      assert.equal(joinedEvidence84.nativePublishedRecipes, 2);
      const beforeCandidateWrite = await counts();
      await assert.rejects(
        candidateSource.withCurrentCandidate(candidateCommand, async (_value, tx) => {
          await candidateWrite(tx);
          denyCandidate = true;
        }),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      denyCandidate = false;
      assert.deepEqual(await counts(), beforeCandidateWrite);
      assert.deepEqual(await reader.load(id(600)), next);
      await assert.rejects(
        candidateSource.withCurrentCandidate(candidateCommand, async (_value, tx) => {
          await candidateWrite(tx);
          candidateNow = new Date(Date.parse(time) + 30000).toISOString();
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      candidateNow = time;
      assert.deepEqual(await counts(), beforeCandidateWrite);
      assert.deepEqual(await reader.load(id(600)), next);
      denyCandidate = true;
      await assert.rejects(
        candidateSource.withCurrentCandidate(candidateCommand, async () =>
          assert.fail("permission callback"),
        ),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      denyCandidate = false;
      for (const patch of [
        { tagReferences: [id(799)] },
        {
          attributeValues: [
            { attributeReference: id(702), type: "Decimal", value: "1.25", unitCode: "G" },
          ],
        },
      ]) {
        const invalidRegistered = parseProductAggregate({
          ...next,
          aggregateVersion: 3,
          draft: { ...next.draft, editorContent: { ...next.draft.editorContent, ...patch } },
        });
        const before = await counts();
        await assert.rejects(
          draftStore.commit({
            record: {
              ...draftRecord,
              operationReference: id(783),
              operationIntentHash: sha256Hex(JSON.stringify(patch)),
              aggregate: invalidRegistered,
            },
            expectedAggregateVersion: 2,
            audit: audit(783, "CATALOG_PRODUCT_REPLACEDRAFT"),
          }),
          { code: "CATALOG_LIFECYCLE_CONFLICT" },
        );
        assert.deepEqual(
          await counts(),
          before,
          "current registered references deny Product/Audit/Outbox writes",
        );
      }
      const variantHistory = variantSource(transactions);
      const variantRequest = {
        productReference: id(600),
        expectedAggregateVersion: 2,
        originalIntentDigest: hash("synthetic variant candidate intent"),
      };
      const observedVariants = await variantHistory.withCurrentSnapshot(
        variantRequest,
        async (snapshot) => {
          assertProductVariantIdentityHistory(next, snapshot);
          return snapshot;
        },
      );
      assert.deepEqual(observedVariants.used, [
        {
          dimensionReference: id(709),
          dimensionCode: "SIZE",
          valueReference: id(710),
          valueCode: "SMALL",
        },
      ]);
      assert(!JSON.stringify(observedVariants).includes("Changed complete content"));
      const renamedVariant = globalThis.structuredClone(next);
      renamedVariant.draft.editorContent.variantDimensions[0].code = "REINTERPRETED";
      assert.throws(() => assertProductVariantIdentityHistory(renamedVariant, observedVariants), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      await assert.rejects(
        variantHistory.withCurrentSnapshot(
          { ...variantRequest, expectedAggregateVersion: 1 },
          async (snapshot) => snapshot,
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        variantHistory.withCurrentSnapshot(variantRequest, async (snapshot) => {
          authorized = false;
          return snapshot;
        }),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      authorized = true;
      assert.deepEqual((await reader.resolveOperation(id(610))).aggregate, original);
      assert.deepEqual(
        await draftStore.commit({
          record: draftRecord,
          expectedAggregateVersion: 1,
          audit: audit(611, "CATALOG_PRODUCT_REPLACEDRAFT"),
        }),
        draftRecord,
      );
      const baseline = await counts();
      renamedVariant.aggregateVersion = 3;
      await assert.rejects(
        draftStore.commit({
          record: {
            ...draftRecord,
            operationReference: id(613),
            operationIntentHash: sha256Hex("synthetic reinterpretation"),
            aggregate: renamedVariant,
          },
          expectedAggregateVersion: 2,
          audit: audit(613, "CATALOG_PRODUCT_REPLACEDRAFT"),
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await counts(), baseline);
      const failedRecord = {
        ...draftRecord,
        operationReference: id(612),
        operationIntentHash: sha256Hex("synthetic rollback"),
        aggregate: parseProductAggregate({ ...next, aggregateVersion: 3 }),
      };
      failAfterWrite = true;
      await assert.rejects(
        draftStore.commit({
          record: failedRecord,
          expectedAggregateVersion: 2,
          audit: audit(612, "CATALOG_PRODUCT_REPLACEDRAFT"),
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      armed = false;
      failAfterWrite = false;
      assert.deepEqual(await counts(), baseline);
      assert.deepEqual(await reader.load(id(600)), next);
      const { editorContent, ...withoutContent } = next.draft;
      assert(editorContent);
      await assert.rejects(
        draftStore.commit({
          record: {
            ...failedRecord,
            aggregate: parseProductAggregate({
              ...next,
              aggregateVersion: 3,
              draft: withoutContent,
            }),
          },
          expectedAggregateVersion: 2,
          audit: audit(612, "CATALOG_PRODUCT_REPLACEDRAFT"),
        }),
        { code: "CATALOG_INPUT_INVALID" },
      );
      authorized = false;
      await assert.rejects(reader.resolveOperation(id(611)), { code: "CATALOG_PERMISSION_DENIED" });
      authorized = true;
      const identity = deriveCatalogProductPublicationContentIdentity(next);
      const publisher = createPostgresProductPublicationStore({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        clock: { now: () => time },
        transactions,
        editorContentAuthority,
        authority: {
          async holdUntilTransactionCompletes() {
            if (!authorized) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
        sources: {
          ...syntheticScopePolicy,
          async withHeldCurrentFacts(_tx, input, work) {
            const c = input.command;
            return work({
              now: time,
              productAggregateVersion: c.expectedProductAggregateVersion,
              contentDigest: c.contentDigest,
              configurationDigest: c.configurationDigest,
              scopeDigest: hash(c.scopeSet),
              periodDigest: hash(c.effectivePeriod),
              validation: {
                evidenceReference: id(720),
                productAggregateVersion: c.expectedProductAggregateVersion,
                contentDigest: c.contentDigest,
                configurationDigest: c.configurationDigest,
                scopeDigest: hash(c.scopeSet),
                periodDigest: hash(c.effectivePeriod),
                policyReference: id(721),
                policyVersion: 1,
                approvalPolicy: "NotRequired",
                checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
                warningAcknowledgement: null,
                checkedAt: time,
                validUntil: "2026-10-01T00:00:00.000Z",
              },
              approval: null,
              reviewReference: id(722),
              replacement: null,
            });
          },
        },
        audit: {
          create(p, action) {
            return {
              ...audit(
                Number.parseInt(p.operationReference.slice(-12), 16),
                catalogProductPublicationAuditAction(action),
              ),
              targetType: "Product",
            };
          },
        },
      });
      const command = (
        action,
        expectedProductAggregateVersion,
        expectedPublicationVersion,
        operation,
      ) => ({
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        operationReference: id(operation),
        productReference: id(600),
        versionReference: id(601),
        expectedProductAggregateVersion,
        expectedPublicationVersion,
        action,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: time, localDateTime: time.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
        scheduleReference: null,
        replacementVersionReference: null,
        successorDraftVersionReference: action === "Publish" ? id(603) : null,
        occurredAt: time,
        reasonCode: "SYNTHETIC_CONTENT",
      });
      await publisher.execute(command("Validate", 2, 0, 620));
      await publisher.execute(command("SubmitReview", 3, 1, 621));
      const result = await publisher.execute(command("Publish", 4, 2, 622));
      assert.equal(result.scopeJournalStatus, "Recorded");
      assert.deepEqual(result.scopeJournal.plan.overlaps, []);
      assert.equal(result.content.profile, "CatalogFullProductDraftContentV2");
      assert.deepEqual(result.content.sourceDraft.editorContent, next.draft.editorContent);
      assert.deepEqual(result.aggregate.draft.editorContent, next.draft.editorContent);
      assert.equal(result.aggregate.draft.versionReference, id(603));
      assert.deepEqual((await reader.load(id(600))).draft.editorContent, next.draft.editorContent);
      const publicationSource = createPostgresProductPublicationSourceStore({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => new Date().toISOString() },
        transactions,
        authority: {
          async holdUntilTransactionCompletes() {
            if (!authorized) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      const graph = await publicationSource.loadSnapshot({
        productReference: id(600),
        expectedAggregateVersion: 5,
      });
      assert.equal(graph.history.length, 3);
      assert.equal(graph.latest[0].state, "Published");
      assert.equal(graph.latest[0].contentDigest, identity.contentDigest);
      assert.equal(graph.latest[0].configurationDigest, identity.configurationDigest);
      assert.equal(graph.eligibility, "NotEvaluated");
      await variantHistory.withCurrentSnapshot(
        { ...variantRequest, expectedAggregateVersion: 5 },
        async (snapshot) => {
          assertProductVariantIdentityHistory(result.aggregate, snapshot);
          assert.equal(snapshot.used.length, 1);
        },
      );
      assert(!Object.hasOwn(graph.history[2].configuration, "editorContent"));
      assert(!JSON.stringify(graph).includes("Changed complete content"));
      authorized = false;
      await assert.rejects(
        publicationSource.loadSnapshot({ productReference: id(600), expectedAggregateVersion: 5 }),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      authorized = true;
      assert.deepEqual(parseCatalogProductPublicationContent(result.content), result.content);
      const mutated = globalThis.structuredClone(result.content);
      mutated.sourceDraft.editorContent.localizedDescriptions["en-CA"] = "Tampered";
      assert.throws(() => parseCatalogProductPublicationContent(mutated), {
        code: "CATALOG_INPUT_INVALID",
      });
      assert.equal((await publisher.execute(command("Publish", 4, 2, 622))).status, "Replayed");
      denyContent = true;
      await assert.rejects(publisher.execute(command("Publish", 4, 2, 622)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      denyContent = false;
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.product_version SET editor_content_json=$2 WHERE product_version_id=$1",
          [id(601), details],
        ),
        /PRODUCT_VERSION_IMMUTABLE/,
      );
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.product_publication_content SET snapshot_json=snapshot_json WHERE product_version_id=$1",
          [id(601)],
        ),
        /PRODUCT_PUBLICATION_IMMUTABLE/,
      );
      const missingProfile = globalThis.structuredClone(result.content);
      delete missingProfile.profile;
      missingProfile.versionReference = id(603);
      missingProfile.publicationOperationReference = id(999);
      missingProfile.sourceDraft.versionReference = id(603);
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_catalog.product_publication_content(product_version_id,tenant_id,brand_id,product_id,publication_operation_id,source_aggregate_version,content_digest,configuration_digest,sealed_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            id(603),
            id(1),
            id(2),
            id(600),
            id(999),
            result.content.sourceAggregateVersion,
            result.content.contentDigest,
            result.content.configurationDigest,
            time,
            missingProfile,
          ],
        ),
        (error) => error.constraint === "product_publication_content_profile_check",
      );
      assert(seen.includes("DraftWrite"));
      assert(seen.includes("Publish"));

      // Actual current complete-editor source; Actor/field purpose holders are
      // explicit synthetic fixtures. No reference readiness is inferred.
      let editorClock = new Date().toISOString(),
        editorMode = "normal",
        editorConsumed = false;
      const editorAt = editorClock;
      const editorOptions = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        transactions,
        clock: { now: () => editorClock },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(tx, writer);
            assert.equal(input.actorReference, id(3));
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_EDITOR_READ");
            assert.equal(input.owningAction, "catalog.product.manage");
            assert.deepEqual(input.requiredFields, productEditorSnapshotFields);
            if (editorMode === "denied" || (editorConsumed && editorMode === "late-denied"))
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (editorConsumed && editorMode === "late-expiry")
              editorClock = new Date(Date.parse(editorAt) + 5000).toISOString();
          },
        },
      };
      const editorSource = createPostgresProductEditorSourceStore(editorOptions),
        editorQuery = { productReference: id(600), expectedAggregateVersion: 5 },
        beforeEditor = await counts();
      const completeEditor = await editorSource.withCurrentSnapshot(editorQuery, async (v, tx) => {
        assert.equal(tx, writer);
        return v;
      });
      assert.equal(completeEditor.contentStatus, "Present");
      assert.equal(completeEditor.aggregate.draft.versionReference, id(603));
      assert.deepEqual(completeEditor.aggregate.draft.editorContent, next.draft.editorContent);
      const editorIdentity = deriveCatalogProductPublicationContentIdentity(result.aggregate);
      assert.equal(completeEditor.contentDigest, editorIdentity.contentDigest);
      assert.equal(completeEditor.configurationDigest, editorIdentity.configurationDigest);
      assert.equal(completeEditor.publishValidation, "Incomplete");
      assert.equal(completeEditor.referenceEligibility, "NotEvaluated");
      assert.equal(completeEditor.eligibility, "NotEvaluated");
      assert.deepEqual(parseCatalogProductEditorSnapshot(completeEditor), completeEditor);
      assert.deepEqual(await counts(), beforeEditor);
      for (const invalid of [
        { ...editorQuery, expectedAggregateVersion: 4 },
        { ...editorQuery, productReference: id(9999) },
        { ...editorQuery, clientReady: true },
      ]) {
        await assert.rejects(
          editorSource.withCurrentSnapshot(invalid, async () => {
            throw Error("SYNTHETIC_UNEXPECTED_CONSUMER");
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.deepEqual(await counts(), beforeEditor);
      }
      editorMode = "denied";
      await assert.rejects(
        editorSource.withCurrentSnapshot(editorQuery, async (v) => v),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      assert.deepEqual(await counts(), beforeEditor);
      for (const mode of ["late-denied", "late-expiry"]) {
        editorMode = mode;
        editorClock = editorAt;
        editorConsumed = false;
        let observedRoot = 0;
        await assert.rejects(
          editorSource.withCurrentSnapshot(editorQuery, async (_v, tx) => {
            // Controlled consumer mutation is not an owning Draft operation.
            await tx.query(
              "UPDATE rms_catalog.product SET aggregate_version=6 WHERE product_id=$1 AND brand_id=$2",
              [id(600), id(2)],
            );
            observedRoot = (
              await tx.query(
                "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
                [id(600)],
              )
            ).rows[0].aggregate_version;
            editorConsumed = true;
            return observedRoot;
          }),
          {
            code:
              mode === "late-denied"
                ? "CATALOG_PERMISSION_DENIED"
                : "CATALOG_DEPENDENCY_UNAVAILABLE",
          },
        );
        assert.equal(observedRoot, 6);
        assert.deepEqual(await counts(), beforeEditor);
      }
      editorMode = "normal";
      editorConsumed = false;
      editorClock = editorAt;
      const recoveredEditor = await editorSource.withCurrentSnapshot(editorQuery, async (v) => v);
      assert.deepEqual(recoveredEditor, completeEditor);
      assert.deepEqual(await counts(), beforeEditor);

      // Ordinary runtime + actual encrypted session/current membership/Brand grants,
      // BFF loopback HTTP + complete owning SQL. Page/field holders remain synthetic.
      const httpAt = new Date().toISOString(),
        httpFrom = new Date(Date.parse(httpAt) - 60000).toISOString(),
        httpUntil = new Date(Date.parse(httpAt) + 3600000).toISOString();
      const editorSession = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        role,
        scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(20) },
        actor: id(3),
        at: httpAt,
        referencePrefix: "01909642",
        sessionReferencePrefix: "01909643",
      });
      await admin.query(
        "INSERT INTO bop_permission.role VALUES($1,$2,NULL,'synthetic_full_editor_brand','Active',$3,$4,1,$3,$3)",
        [id(96401), id(2), httpFrom, httpUntil],
      );
      await admin.query(
        "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
        [
          id(96402),
          id(96401),
          "01909642-0000-7000-8000-000000000001",
          id(3),
          id(2),
          httpFrom,
          httpUntil,
        ],
      );
      const editorActions = [
        "catalog.manage",
        "catalog.product.manage",
        "catalog.product.read",
        "catalog.sku.read",
      ];
      for (const [i, action] of editorActions.entries()) {
        let permission = (
          await admin.query(
            "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
            [action],
          )
        ).rows[0]?.permission_id;
        if (!permission) {
          permission = id(96410 + i);
          await admin.query(
            "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
            [permission, action, httpFrom],
          );
        }
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
          [id(96420 + i), id(96401), permission, id(2), httpFrom, httpUntil],
        );
      }
      let fullHttpMode = "normal",
        fullHttpClock = httpAt,
        fullHttpHolds = 0,
        fullHttpFinalHold = 0;
      const unusedFullEditorConfiguration = async () => {
        throw Error("SYNTHETIC_UNRELATED_CONFIGURATION");
      };
      const fullEditorRuntime = createMerchantRuntime({
        persistence: { ...editorSession.persistence, now: () => fullHttpClock },
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        serviceAudit: {
          reasonCode: "SYNTHETIC_FULL_EDITOR_READ",
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
        productEditor: {
          contentAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(input.actorReference, id(3));
              assert.equal(input.productReference, id(600));
              assert.equal(input.purposeCode, "CATALOG_PRODUCT_EDITOR_READ");
              assert.deepEqual(input.requiredFields, productEditorSnapshotFields);
              fullHttpHolds++;
              if (fullHttpMode === "late-action" && fullHttpHolds === fullHttpFinalHold - 1) {
                // Controlled same-transaction revocation precedes the distinct API final action check.
                await tx.query(
                  "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                  [id(96423)],
                );
                assert.equal(
                  (
                    await tx.query(
                      "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
                      [id(96423)],
                    )
                  ).rows[0].lifecycle,
                  "Revoked",
                );
              }
              if (fullHttpHolds === fullHttpFinalHold) {
                if (fullHttpMode === "late-field")
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
                if (fullHttpMode === "late-expiry")
                  fullHttpClock = new Date(Date.parse(httpAt) + 5000).toISOString();
              }
            },
          },
          async holdScreenUntilCommit(_tx, input) {
            assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
            assert.equal(input.capability, "catalog.cat_product_edit");
            assert.equal(input.storeReference, id(20));
            assert.equal(input.productReference, id(600));
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_EDITOR_READ");
            assert.deepEqual(input.requiredFields, productEditorSnapshotFields);
            if (fullHttpMode === "phase-deny") throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      });
      assert.equal(typeof fullEditorRuntime.productEditor, "function");
      const beforeHttp = await counts();
      await withProductPublicationHttp(
        undefined,
        editorSession,
        { brandReference: id(2), storeReference: id(20) },
        async (post) => {
          const path = "/merchant/catalog/products/editor";
          const good = await post(editorQuery, {}, path);
          assert.equal(good.status, 200);
          assert.match(good.cacheControl, /no-store/);
          assert.deepEqual(parseCatalogProductEditorSnapshot(good.body), good.body);
          assert.deepEqual(good.body.aggregate, result.aggregate);
          assert.deepEqual(good.body.aggregate.draft.editorContent, next.draft.editorContent);
          assert.equal(good.body.publishValidation, "Incomplete");
          assert.equal(good.body.referenceEligibility, "NotEvaluated");
          fullHttpFinalHold = fullHttpHolds;
          assert.ok(fullHttpFinalHold >= 5);
          for (const [request, header, status] of [
            [{ ...editorQuery, clientReady: true }, {}, 400],
            [{ ...editorQuery, expectedAggregateVersion: 4 }, {}, 503],
            [
              editorQuery,
              {
                "x-bop-catalog-scope": Buffer.from(
                  JSON.stringify({ brandReference: id(2), storeReference: id(21) }),
                ).toString("base64url"),
              },
              403,
            ],
          ]) {
            const failed = await post(request, header, path);
            assert.equal(failed.status, status);
            assert.deepEqual(await counts(), beforeHttp);
          }
          // The stored current Brand SKU grant is independent from Product manage/read.
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
            [id(96423)],
          );
          const denied = await post(editorQuery, {}, path);
          assert.equal(denied.status, 403);
          assert.deepEqual(denied.body, { error: "request_denied" });
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
            [id(96423)],
          );
          for (const mode of ["phase-deny", "late-field", "late-expiry", "late-action"]) {
            fullHttpMode = mode;
            fullHttpClock = httpAt;
            fullHttpHolds = 0;
            const failed = await post(editorQuery, {}, path);
            assert.equal(failed.status, mode === "late-expiry" ? 503 : 403);
            assert.deepEqual(failed.body, {
              error: mode === "late-expiry" ? "product_editor_unavailable" : "request_denied",
            });
            assert.deepEqual(await counts(), beforeHttp);
            assert.equal(
              (
                await admin.query(
                  "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
                  [id(96423)],
                )
              ).rows[0].lifecycle,
              "Active",
            );
          }
          fullHttpMode = "normal";
          fullHttpClock = httpAt;
          fullHttpHolds = 0;
          const recovery = await post(editorQuery, {}, path);
          assert.equal(recovery.status, 200);
          assert.deepEqual(recovery.body, good.body);
          assert.deepEqual(await counts(), beforeHttp);
        },
        { productEditor: fullEditorRuntime.productEditor },
      );

      // Ordinary complete Draft write, actual session/current grants and owner
      // SQL. Complete field/reference holders below are explicitly synthetic;
      // their invocation does not qualify deployed Media/Safety/Nutrition facts.
      const updateAction = "catalog.product.update";
      let updatePermission = (
        await admin.query(
          "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
          [updateAction],
        )
      ).rows[0]?.permission_id;
      if (!updatePermission) {
        updatePermission = id(96480);
        await admin.query(
          "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
          [updatePermission, updateAction, httpFrom],
        );
      }
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
        [id(96481), id(96401), updatePermission, id(2), httpFrom, httpUntil],
      );
      let completeDraftClock = httpAt,
        completeDraftMode = "normal",
        completeDraftObserved = 0,
        completeDraftStages = [];
      const completeDraftRuntime = createMerchantRuntime({
        persistence: { ...editorSession.persistence, now: () => completeDraftClock },
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        serviceAudit: {
          reasonCode: "SYNTHETIC_FULL_DRAFT",
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
        productDraft: {
          auditReference: () => id(96500),
          async writeAuthority(_tx, input) {
            assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
            assert.equal(input.actionPermission, "catalog.product.update");
            assert.equal(input.productReference, id(600));
            assert.equal(input.storeReference, id(20));
            return "Allowed";
          },
          async editorContentAuthority(tx, input) {
            completeDraftStages.push(input.mode + ":" + input.aggregate.aggregateVersion);
            assert.equal(input.tenantReference, id(1));
            assert.equal(input.brandReference, id(2));
            assert.equal(input.actorReference, id(3));
            assert.equal(input.storeReference, id(20));
            assert.equal(input.productReference, id(600));
            assert.equal(input.operationReference, id(96490));
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_DRAFT_REPLACE");
            assert.deepEqual(input.requiredFields, productEditorContentFields);
            assert.deepEqual(
              input.requiredReferenceChecks,
              input.mode === "Read" ? [] : productEditorContentReferenceChecks,
            );
            assert.equal(Date.parse(input.validUntil) - Date.parse(input.observedAt), 5000);
            if (completeDraftMode === "missing-reference" && input.mode === "DraftWrite")
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            const currentRoot = (
              await tx.query(
                "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1 AND brand_id=$2",
                [id(600), id(2)],
              )
            ).rows[0].aggregate_version;
            if (currentRoot === 6 && input.aggregate.aggregateVersion === 6) {
              completeDraftObserved = currentRoot;
              if (completeDraftMode === "late-field")
                throw new CatalogError("CATALOG_PERMISSION_DENIED");
              if (completeDraftMode === "late-expiry") completeDraftClock = input.validUntil;
              if (completeDraftMode === "late-action") {
                await tx.query(
                  "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                  [id(96481)],
                );
                assert.equal(
                  (
                    await tx.query(
                      "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
                      [id(96481)],
                    )
                  ).rows[0].lifecycle,
                  "Revoked",
                );
              }
            }
          },
        },
      });
      const completeDraftCommand = {
        productReference: id(600),
        expectedAggregateVersion: 5,
        operationReference: id(96490),
        draft: {
          ...result.aggregate.draft,
          editorContent: {
            ...result.aggregate.draft.editorContent,
            localizedDescriptions: {
              "en-CA": "Synthetic ordinary complete Draft change",
              "fr-CA": "b".repeat(4096),
              "zh-CN": "茶".repeat(3000),
            },
          },
        },
      };
      const beforeCompleteDraft = await counts();
      await withProductPublicationHttp(
        undefined,
        editorSession,
        { brandReference: id(2), storeReference: id(20) },
        async (post) => {
          const path = "/merchant/catalog/products/draft";
          const clientAttempt = createCompleteDraftNativeHttpClient({
            post,
            command: completeDraftCommand,
            scope: { brandReference: id(2), storeReference: id(20) },
            csrf: editorSession.csrf,
          });
          const invalid = await post({ ...completeDraftCommand, clientReady: true }, {}, path);
          assert.equal(invalid.status, 400);
          assert.deepEqual(await counts(), beforeCompleteDraft);
          for (const mode of ["missing-reference", "late-field", "late-expiry", "late-action"]) {
            completeDraftMode = mode;
            completeDraftClock = httpAt;
            completeDraftObserved = 0;
            completeDraftStages = [];
            const failed = await post(completeDraftCommand, {}, path);
            assert.equal(
              failed.status,
              ["missing-reference", "late-expiry"].includes(mode) ? 503 : 403,
              "Synthetic mode=" +
                mode +
                "; observed root=" +
                completeDraftObserved +
                "; stages=" +
                completeDraftStages.join(","),
            );
            assert.deepEqual(failed.body, {
              error: ["missing-reference", "late-expiry"].includes(mode)
                ? "product_draft_unavailable"
                : "request_denied",
            });
            if (mode !== "missing-reference") assert.equal(completeDraftObserved, 6);
            assert.deepEqual(await counts(), beforeCompleteDraft);
            assert.equal(
              (
                await admin.query(
                  "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
                  [id(96481)],
                )
              ).rows[0].lifecycle,
              "Active",
            );
          }
          completeDraftMode = "normal";
          completeDraftClock = httpAt;
          const applied = await clientAttempt();
          assert.equal(applied.status, 200);
          assert.equal(applied.body.status, "Applied");
          assert.equal(applied.body.aggregateVersion, 6);
          assert.deepEqual(
            applied.body.draft.editorContent,
            completeDraftCommand.draft.editorContent,
          );
          const afterCompleteDraft = await counts();
          assert.notDeepEqual(afterCompleteDraft, beforeCompleteDraft);
          completeDraftClock = new Date(Date.parse(httpAt) + 1000).toISOString();
          const replay = await clientAttempt();
          assert.equal(replay.status, 200);
          assert.equal(replay.body.status, "AlreadyApplied");
          assert.deepEqual({ ...replay.body, status: "Applied" }, applied.body);
          assert.deepEqual(await counts(), afterCompleteDraft);
          const conflict = await post(
            {
              ...completeDraftCommand,
              draft: {
                ...completeDraftCommand.draft,
                editorContent: {
                  ...completeDraftCommand.draft.editorContent,
                  preparationNotes: { "en-CA": "Synthetic different original intent" },
                },
              },
            },
            {},
            path,
          );
          assert.equal(conflict.status, 409);
          assert.deepEqual(await counts(), afterCompleteDraft);
          // Current read permission remains required even to recover an old result.
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
            [id(96423)],
          );
          const deniedReplay = await post(completeDraftCommand, {}, path);
          assert.equal(deniedReplay.status, 403);
          assert.deepEqual(await counts(), afterCompleteDraft);
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
            [id(96423)],
          );
          const recovered = await clientAttempt();
          assert.equal(recovered.status, 200);
          assert.deepEqual(recovered.body, replay.body);
          assert.deepEqual(await counts(), afterCompleteDraft);
        },
        { productDraft: completeDraftRuntime.productDraft },
      );

      // New server composition uses actual owning current registry SQL/rules.
      // Full fields, Phase and the remaining six references are synthetic holders.
      let registeredClock = httpAt,
        registeredMode = "normal",
        registeredRootObserved = 0,
        registeredSourceHolds = 0,
        registeredStage = "Start",
        registeredLastCode = "None";
      const registeredAuthority = createMerchantProductEditorRegisteredContentAuthority({
        clock: { now: () => registeredClock },
        registryAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            registeredSourceHolds++;
            registeredStage = "Registry";
            assert.equal(input.tenantReference, id(1));
            assert.equal(input.brandReference, id(2));
            assert.equal(input.actorReference, id(3));
            assert.equal(input.actorKind, "User");
            assert.equal(input.action, "catalog.content-registry.read");
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_CONTENT_REGISTRY");
            assert.deepEqual(input.requiredFields, contentRegistryFields);
            const root = (
              await tx.query(
                "SELECT aggregate_version FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2",
                [id(2), id(600)],
              )
            ).rows[0].aggregate_version;
            if (registeredMode === "late-registry" && root === 7) {
              registeredRootObserved = root;
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            }
          },
        },
        async remainingAuthority(tx, input) {
          registeredStage = "Remaining:" + input.mode + ":" + input.aggregate.aggregateVersion;
          assert.equal(input.productReference, id(600));
          assert.equal(input.operationReference, id(96510));
          assert.deepEqual(
            input.requiredReferenceChecks,
            input.mode === "Read" ? [] : remainingProductEditorReferenceChecks,
          );
          assert.equal(
            input.validUntil,
            new Date(Date.parse(input.observedAt) + 5000).toISOString(),
          );
          const root = (
            await tx.query(
              "SELECT aggregate_version FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2",
              [id(2), id(600)],
            )
          ).rows[0].aggregate_version;
          if (root === 7 && input.aggregate.aggregateVersion === 7) {
            registeredRootObserved = root;
            if (registeredMode === "late-fields")
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (registeredMode === "late-expiry") registeredClock = input.validUntil;
          }
        },
      });
      const registeredRuntime = createMerchantRuntime({
        persistence: { ...editorSession.persistence, now: () => registeredClock },
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        serviceAudit: {
          reasonCode: "SYNTHETIC_REGISTERED_DRAFT",
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
        productDraft: {
          auditReference: () => id(96511),
          async writeAuthority(_tx, input) {
            assert.equal(input.actionPermission, "catalog.product.update");
            assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
            return "Allowed";
          },
          async editorContentAuthority(tx, input) {
            try {
              await registeredAuthority(tx, input);
            } catch (error) {
              registeredLastCode = error instanceof CatalogError ? error.code : "SyntheticUnknown";
              throw error;
            }
          },
        },
      });
      const registeredCommand = {
        ...completeDraftCommand,
        expectedAggregateVersion: 6,
        operationReference: id(96510),
        draft: {
          ...completeDraftCommand.draft,
          editorContent: {
            ...completeDraftCommand.draft.editorContent,
            localizedDescriptions: { "en-CA": "Synthetic current registered Draft change" },
          },
        },
      };
      const beforeRegistered = await counts();
      await withProductPublicationHttp(
        undefined,
        editorSession,
        { brandReference: id(2), storeReference: id(20) },
        async (post) => {
          const path = "/merchant/catalog/products/draft";
          for (const patch of [
            { tagReferences: [id(96599)] },
            {
              attributeValues: [
                { attributeReference: id(702), type: "Decimal", value: "1.25", unitCode: "G" },
              ],
            },
            {
              attributeValues: [
                {
                  attributeReference: id(702),
                  type: "Decimal",
                  value: "10.000001",
                  unitCode: "KG",
                },
              ],
            },
          ]) {
            registeredClock = httpAt;
            const refused = await post(
              {
                ...registeredCommand,
                draft: {
                  ...registeredCommand.draft,
                  editorContent: { ...registeredCommand.draft.editorContent, ...patch },
                },
              },
              {},
              path,
            );
            assert.equal(
              refused.status,
              409,
              "Synthetic registry stage=" +
                registeredStage +
                "; source holds=" +
                registeredSourceHolds +
                "; bounded code=" +
                registeredLastCode,
            );
            assert.deepEqual(refused.body, { error: "product_draft_conflict" });
            assert.deepEqual(await counts(), beforeRegistered);
          }
          for (const mode of ["late-fields", "late-expiry", "late-registry"]) {
            registeredMode = mode;
            registeredClock = httpAt;
            registeredRootObserved = 0;
            const refused = await post(registeredCommand, {}, path);
            assert.equal(refused.status, mode === "late-expiry" ? 503 : 403);
            assert.equal(registeredRootObserved, 7);
            assert.deepEqual(await counts(), beforeRegistered);
          }
          registeredMode = "normal";
          registeredClock = httpAt;
          const applied = await post(registeredCommand, {}, path);
          assert.equal(applied.status, 200);
          assert.equal(applied.body.aggregateVersion, 7);
          assert.equal(applied.body.status, "Applied");
          assert.deepEqual(applied.body.draft.editorContent, registeredCommand.draft.editorContent);
          assert(registeredSourceHolds > 0);
          const afterRegistered = await counts();
          registeredClock = new Date(Date.parse(httpAt) + 1000).toISOString();
          const originalRecovery = await post(registeredCommand, {}, path);
          assert.equal(originalRecovery.status, 200);
          assert.equal(originalRecovery.body.status, "AlreadyApplied");
          assert.deepEqual({ ...originalRecovery.body, status: "Applied" }, applied.body);
          assert.deepEqual(await counts(), afterRegistered);
        },
        { productDraft: registeredRuntime.productDraft },
      );

      // Actual Variant current-root source joins registered references and full
      // ordinary save; current history/fields/other-five policy remains synthetic.
      let variantClockOverride = null,
        variantMode = "normal",
        variantRootObserved = 0,
        variantHistoryHolds = 0,
        variantStage = "Start",
        variantLastCode = "None",
        variantDiagnostic = "None";
      const variantHistoryRoots = new Set();
      const variantObservedRoots = new Set();
      const liveVariantNow = () => variantClockOverride ?? new Date().toISOString();
      const fullVariantAuthority = createMerchantProductEditorRegisteredContentAuthority({
        clock: { now: liveVariantNow },
        registryAuthority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.action, "catalog.content-registry.read");
            assert.equal(input.tenantReference, id(1));
            assert.equal(input.brandReference, id(2));
          },
        },
        remainingAuthority: createMerchantProductEditorVariantContentAuthority({
          clock: { now: liveVariantNow },
          variantAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              variantHistoryHolds++;
              variantStage = "History:" + input.request.expectedAggregateVersion;
              variantHistoryRoots.add(input.request.expectedAggregateVersion);
              assert.equal(input.tenantReference, id(1));
              assert.equal(input.brandReference, id(2));
              assert.equal(input.actorReference, id(3));
              assert.equal(input.purposeCode, "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY");
              assert.equal(input.permission, "catalog.product.history.read");
              assert.deepEqual(input.requiredFields, productVariantHistoryFields);
              assert.equal(input.request.productReference, id(600));
              variantDiagnostic = "HistoryTupleChecked";
              const root = (
                await tx.query(
                  "SELECT aggregate_version FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2",
                  [id(2), id(600)],
                )
              ).rows[0]?.aggregate_version;
              variantDiagnostic = "ActualRoot:" + (root ?? "Missing");
              variantObservedRoots.add(root);
              assert.equal(input.request.expectedAggregateVersion, 7);
              assert.ok(root === 7 || root === 8);
              if (root === 8) {
                const own = await tx.query(
                  "SELECT result_aggregate_version FROM rms_catalog.product_operation_record WHERE brand_id=$1 AND product_id=$2 AND operation_id=$3",
                  [id(2), id(600), id(96520)],
                );
                assert.equal(own.rows.length, 1);
                assert.equal(own.rows[0].result_aggregate_version, 8);
              }
              if (variantMode === "late-history" && root === 8) {
                variantRootObserved = root;
                throw new CatalogError("CATALOG_PERMISSION_DENIED");
              }
            },
          },
          async remainingAuthority(tx, input) {
            variantStage = "Fields:" + input.mode + ":" + input.aggregate.aggregateVersion;
            assert.equal(input.operationReference, id(96520));
            assert.equal(input.productReference, id(600));
            assert.deepEqual(input.requiredFields, productEditorContentFields);
            assert.deepEqual(
              input.requiredReferenceChecks,
              input.mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks,
            );
            const root = (
              await tx.query(
                "SELECT aggregate_version FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2",
                [id(2), id(600)],
              )
            ).rows[0].aggregate_version;
            if (input.mode === "Read") assert(input.aggregate.aggregateVersion <= root);
            if (root === 8 && input.aggregate.aggregateVersion === 8) {
              variantRootObserved = root;
              if (variantMode === "late-fields")
                throw new CatalogError("CATALOG_PERMISSION_DENIED");
              if (variantMode === "late-expiry") variantClockOverride = input.validUntil;
            }
          },
        }),
      });
      const variantRuntime = createMerchantRuntime({
        persistence: { ...editorSession.persistence, now: liveVariantNow },
        exactOrigin: "https://merchant.invalid",
        acceptedHost: "merchant.invalid",
        serviceAudit: {
          reasonCode: "SYNTHETIC_VARIANT_DRAFT",
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
        productDraft: {
          auditReference: () => id(96521),
          async writeAuthority(_tx, input) {
            assert.equal(input.screenId, "CAT-PRODUCT-EDIT");
            assert.equal(input.actionPermission, "catalog.product.update");
            return "Allowed";
          },
          async editorContentAuthority(tx, input) {
            try {
              await fullVariantAuthority(tx, input);
            } catch (error) {
              variantLastCode = error instanceof CatalogError ? error.code : "SyntheticUnknown";
              throw error;
            }
          },
        },
      });
      const variantCommand = {
        ...registeredCommand,
        expectedAggregateVersion: 7,
        operationReference: id(96520),
        draft: {
          ...registeredCommand.draft,
          editorContent: {
            ...registeredCommand.draft.editorContent,
            localizedDescriptions: {
              "en-CA": "Synthetic complete Draft with current Variant history",
            },
          },
        },
      };
      const beforeVariantDraft = await counts();
      await withProductPublicationHttp(
        undefined,
        editorSession,
        { brandReference: id(2), storeReference: id(20) },
        async (post) => {
          const path = "/merchant/catalog/products/draft";
          for (const kind of ["dimension", "value"]) {
            const invalid = {
              ...variantCommand,
              draft: {
                ...variantCommand.draft,
                editorContent: {
                  ...variantCommand.draft.editorContent,
                  variantDimensions: variantCommand.draft.editorContent.variantDimensions.map(
                    (d) => ({
                      ...d,
                      code: kind === "dimension" ? "OTHER" : d.code,
                      values: d.values.map((v) => ({
                        ...v,
                        code: kind === "value" ? "OTHER" : v.code,
                      })),
                    }),
                  ),
                },
              },
            };
            const refused = await post(invalid, {}, path);
            assert.equal(refused.status, 503);
            assert.deepEqual(refused.body, { error: "product_draft_unavailable" });
            assert.deepEqual(await counts(), beforeVariantDraft);
          }
          for (const mode of ["late-fields", "late-expiry", "late-history"]) {
            variantMode = mode;
            variantClockOverride = null;
            variantRootObserved = 0;
            const refused = await post(variantCommand, {}, path);
            assert.equal(
              refused.status,
              mode === "late-expiry" ? 503 : 403,
              "Synthetic Variant mode=" +
                mode +
                "; stage=" +
                variantStage +
                "; observed=" +
                variantRootObserved +
                "; bounded code=" +
                variantLastCode +
                "; history=" +
                variantDiagnostic,
            );
            assert.equal(variantRootObserved, 8);
            assert.deepEqual(await counts(), beforeVariantDraft);
          }
          variantMode = "normal";
          variantClockOverride = null;
          const applied = await post(variantCommand, {}, path);
          assert.equal(applied.status, 200);
          assert.equal(applied.body.status, "Applied");
          assert.equal(applied.body.aggregateVersion, 8);
          assert.deepEqual(applied.body.draft.editorContent, variantCommand.draft.editorContent);
          assert.deepEqual([...variantHistoryRoots], [7]);
          assert(variantObservedRoots.has(7) && variantObservedRoots.has(8));
          const afterVariantDraft = await counts();
          assert.equal(afterVariantDraft.root, 8);
          for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
            assert.equal(afterVariantDraft[key], beforeVariantDraft[key] + 1);
          const historyBeforeRecovery = variantHistoryHolds;
          const replay = await post(variantCommand, {}, path);
          assert.equal(replay.status, 200);
          assert.equal(replay.body.status, "AlreadyApplied");
          assert.deepEqual({ ...replay.body, status: "Applied" }, applied.body);
          assert.equal(variantHistoryHolds, historyBeforeRecovery);
          assert.deepEqual(await counts(), afterVariantDraft);
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
            [id(96423)],
          );
          assert.equal((await post(variantCommand, {}, path)).status, 403);
          assert.deepEqual(await counts(), afterVariantDraft);
          await admin.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
            [id(96423)],
          );
          const recovered = await post(variantCommand, {}, path);
          assert.equal(recovered.status, 200);
          assert.deepEqual(recovered.body, replay.body);
        },
        { productDraft: variantRuntime.productDraft },
      );
      await exerciseEmptyProductDraft({
        admin,
        id,
        options,
        original,
        audit,
        editorSession,
        httpAt,
        unusedFullEditorConfiguration,
      });
      await exerciseCompleteProductCreation({
        admin,
        id,
        editorSession,
        httpAt,
        httpFrom,
        httpUntil,
        unusedFullEditorConfiguration,
      });
      await exerciseClassifiedCompleteProductCreation({
        admin,
        role,
        id,
        editorSession,
        httpAt,
        unusedFullEditorConfiguration,
      });
    } finally {
      await Promise.all([admin.end(), writer.end()]);
    }
  });
});

it("registers current Catalog Tag/Attribute definitions with original recovery, CAS and held SQL authority", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_registry" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_registry_" + context.runId;
    let created = false,
      allowed = true,
      failLate = false,
      expireLate = false,
      failOutbox = false,
      syntheticHistoryBytes = null,
      holdCalls = 0,
      clock = at;
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      created = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_eventing,platform_helpers TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.product_content_registry_record TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      const transactions = {
        async run(work) {
          const client = new pg.Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({
              query: async (sql, values) => {
                if (failOutbox && sql.includes("INSERT INTO platform_eventing.outbox_event"))
                  throw new Error("synthetic outbox failure");
                const response = await client.query(sql, [...values]);
                // Synthetic transport-copy boundary: never alter database history.
                if (syntheticHistoryBytes !== null && sql.startsWith("SELECT count(*)::text n,"))
                  return {
                    ...response,
                    rows: response.rows.map((r) => ({ ...r, bytes: syntheticHistoryBytes })),
                  };
                return response;
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
      const authority = {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.deepEqual(input.requiredFields, contentRegistryFields);
          assert.equal(input.purposeCode, "CATALOG_PRODUCT_CONTENT_REGISTRY");
          assert.equal(input.permission, "catalog.manage");
          assert.equal(input.actorReference, id(3));
          assert(["User", "System"].includes(input.actorKind));
          holdCalls++;
          if (expireLate && holdCalls === 2) clock = "2026-09-29T12:00:30.000Z";
          if (!allowed || (failLate && holdCalls === 2))
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
      };
      const options = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        clock: { now: () => clock },
        transactions,
        authority,
      };
      const audit = {
        create(c) {
          return {
            auditId: id(parseInt(c.operationReference.slice(-12), 16) + 5000),
            brandId: id(2),
            actor: { type: "User", reference: id(3) },
            actionCode: "CATALOG_CONTENT_REGISTRY_RECORDED",
            targetType: "CatalogContentRegistry",
            targetId: c.registry.registryReference,
            reasonCode: c.reasonCode,
            correlationId: c.operationReference,
            occurredAt: c.occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Confidential",
            retentionPolicyCode: "CATALOG_CONFIGURATION",
            retentionPolicyVersion: 1,
          };
        },
      };
      const store = createPostgresProductContentRegistryStore({ ...options, audit });
      const registry = {
        profile: "CatalogProductContentRegistryV1",
        tenantReference: id(1),
        brandReference: id(2),
        registryReference: id(10),
        versionReference: id(11),
        registryVersion: 1,
        defaultLocale: "en-CA",
        previousSnapshotDigest: null,
        registeredAt: at,
        tags: [
          {
            tagReference: id(100),
            code: "TAG",
            localizedNames: { "en-CA": "Synthetic registered tag" },
            lifecycle: "Active",
          },
        ],
        attributes: [
          {
            attributeReference: id(110),
            code: "WEIGHT",
            localizedNames: { "en-CA": "Synthetic registered weight" },
            lifecycle: "Active",
            type: "Decimal",
            unitCode: "KG",
            minimumValue: "0",
            maximumValue: "100",
          },
          {
            attributeReference: id(111),
            code: "MEMBER",
            localizedNames: { "en-CA": "Synthetic enum" },
            lifecycle: "Active",
            type: "Enum",
            values: [
              {
                valueReference: id(112),
                code: "ONE",
                localizedNames: { "en-CA": "Synthetic member" },
                lifecycle: "Active",
              },
            ],
          },
        ],
      };
      const command = (r, operation) => ({
        purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        operationReference: id(operation),
        expectedRegistryVersion: r.registryVersion - 1,
        occurredAt: r.registeredAt,
        reasonCode: "SYNTHETIC_REGISTRY",
        registry: r,
      });
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.product_content_registry_record) registry,(SELECT count(*)::int FROM platform_audit.audit_record) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,(SELECT COALESCE(max(next_sequence),0)::text FROM platform_audit.audit_chain_head) audit_next",
          )
        ).rows[0];
      const empty = await counts();
      const observation = () => ({
        originalIntentDigest: hash("synthetic product caller intent"),
        observedAt: clock,
        validUntil: new Date(Date.parse(at) + 30000).toISOString(),
      });
      await assert.rejects(
        store.withCurrentRegistry(observation(), async (value) => value),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      allowed = false;
      await assert.rejects(store.execute(command(registry, 20)), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      allowed = true;
      assert.deepEqual(await counts(), empty);
      const first = await store.execute(command(registry, 20));
      assert.equal(first.status, "Applied");
      assert.equal(first.snapshotDigest, catalogProductContentRegistryDigest(registry));
      assert.deepEqual(await counts(), { registry: 1, audit: 1, outbox: 1, audit_next: "2" });
      const baseline = await counts();
      assert.equal((await store.execute(command(registry, 20))).status, "Replayed");
      assert.deepEqual(await counts(), baseline);
      await assert.rejects(store.execute({ ...command(registry, 20), reasonCode: "CHANGED" }), {
        code: "CATALOG_IDEMPOTENCY_CONFLICT",
      });
      assert.deepEqual(await counts(), baseline);
      const candidate = {
        productReference: id(200),
        brandReference: id(2),
        internalCode: "REGISTRY_SQL",
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: at,
        createdByActorReference: id(3),
        updatedAt: at,
        draft: {
          versionReference: id(201),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic current registry candidate" },
          taxClassificationReference: null,
          skus: [],
          optionBindings: [],
          createdAt: at,
          updatedAt: at,
          editorContent: {
            profile: "CatalogProductEditorContentV1",
            localizedShortDescriptions: {},
            localizedDescriptions: {},
            preparationNotes: {},
            tagReferences: [id(100)],
            attributeValues: [
              { attributeReference: id(110), type: "Decimal", value: "1", unitCode: "KG" },
              { attributeReference: id(111), type: "Enum", valueReference: id(112) },
            ],
            media: [],
            variantDimensions: [],
            variantCombinations: [],
            optionRules: [],
            allergenReferences: [],
            nutritionProfile: null,
          },
        },
      };
      const current = await store.withCurrentRegistry(observation(), async (value) => {
        validateCatalogProductRegisteredContent(candidate, value.registry);
        await admin.query("BEGIN");
        try {
          assert.equal(
            (
              await admin.query(
                "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired",
                ["CatalogContentRegistry:" + id(1) + ":" + id(2)],
              )
            ).rows[0].acquired,
            false,
          );
        } finally {
          await admin.query("ROLLBACK");
        }
        return value;
      });
      assert.equal(current.eligibility, "NotEvaluated");
      assert.equal(current.registry.registryVersion, 1);
      const next = (version, ref, maximumValue) => ({
        ...current.registry,
        versionReference: id(ref),
        registryVersion: version,
        previousSnapshotDigest: current.snapshotDigest,
        attributes: current.registry.attributes.map((a) =>
          a.type === "Decimal" ? { ...a, maximumValue } : a,
        ),
      });
      const budgetCandidate = parseCatalogContentRegistryCommand(command(next(2, 12, "10"), 21)),
        budgetCommandJson = canonicalizeRfc8785(catalogContentRegistryRequest(budgetCandidate)),
        budgetRegistryJson = canonicalizeRfc8785(budgetCandidate.registry),
        compactBytes = Buffer.byteLength(budgetCommandJson) + Buffer.byteLength(budgetRegistryJson),
        actualJsonBytes = await admin.query(
          "SELECT (octet_length($1::jsonb::text)+octet_length($2::jsonb::text))::int bytes",
          [budgetCommandJson, budgetRegistryJson],
        );
      assert(actualJsonBytes.rows[0].bytes > compactBytes);
      syntheticHistoryBytes = String(8388608 - compactBytes);
      await assert.rejects(store.execute(command(next(2, 12, "10"), 21)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      syntheticHistoryBytes = null;
      assert.deepEqual(await counts(), baseline);
      holdCalls = 0;
      failLate = true;
      await assert.rejects(store.execute(command(next(2, 12, "10"), 21)), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      failLate = false;
      assert.deepEqual(await counts(), baseline);
      holdCalls = 0;
      expireLate = true;
      await assert.rejects(store.execute(command(next(2, 12, "10"), 21)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      expireLate = false;
      clock = at;
      assert.deepEqual(await counts(), baseline);
      failOutbox = true;
      await assert.rejects(store.execute(command(next(2, 12, "10"), 21)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      failOutbox = false;
      assert.deepEqual(await counts(), baseline);
      const race = await Promise.allSettled([
        store.execute(command(next(2, 12, "2"), 22)),
        store.execute(command(next(2, 13, "3"), 23)),
      ]);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      const denied = race.find((r) => r.status === "rejected");
      assert.equal(denied.reason.code, "CATALOG_VERSION_CONFLICT");
      const changed = await store.withCurrentRegistry(observation(), async (value) => value);
      assert.equal(changed.registry.registryVersion, 2);
      const outOfRange = {
        ...candidate,
        draft: {
          ...candidate.draft,
          editorContent: {
            ...candidate.draft.editorContent,
            attributeValues: [
              { attributeReference: id(110), type: "Decimal", value: "4", unitCode: "KG" },
            ],
          },
        },
      };
      assert.throws(() => validateCatalogProductRegisteredContent(outOfRange, changed.registry), {
        code: "CATALOG_LIFECYCLE_CONFLICT",
      });
      clock = new Date(Date.parse(at) + 30000).toISOString();
      assert.equal(
        (await store.execute(command(registry, 20))).registry.registryVersion,
        1,
        "original replay does not expire with the old registration clock",
      );
      const staleNew = {
        ...changed.registry,
        versionReference: id(15),
        registryVersion: 3,
        previousSnapshotDigest: changed.snapshotDigest,
      };
      await assert.rejects(store.execute(command(staleNew, 26)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      clock = at;
      const afterRace = await counts();
      assert.equal((await store.execute(command(registry, 20))).registry.registryVersion, 1);
      assert.deepEqual(await counts(), afterRace);
      const bad = {
        ...changed.registry,
        versionReference: id(14),
        registryVersion: 3,
        previousSnapshotDigest: changed.snapshotDigest,
        attributes: changed.registry.attributes.map((a) =>
          a.type === "Decimal" ? { ...a, unitCode: "G" } : a,
        ),
      };
      await assert.rejects(store.execute(command(bad, 24)), { code: "CATALOG_LIFECYCLE_CONFLICT" });
      assert.deepEqual(await counts(), afterRace);
      const retired = {
        ...changed.registry,
        versionReference: id(14),
        registryVersion: 3,
        previousSnapshotDigest: changed.snapshotDigest,
        tags: changed.registry.tags.map((t) => ({ ...t, lifecycle: "Retired" })),
      };
      await store.execute(command(retired, 25));
      await store.withCurrentRegistry(observation(), async (value) =>
        assert.throws(() => validateCatalogProductRegisteredContent(candidate, value.registry), {
          code: "CATALOG_LIFECYCLE_CONFLICT",
        }),
      );
      const final = await counts();
      await assert.rejects(
        store.withCurrentRegistry(observation(), async () => {
          allowed = false;
        }),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      allowed = true;
      assert.deepEqual(await counts(), final);
      await assert.rejects(
        store.withCurrentRegistry(observation(), async () => {
          clock = new Date(Date.parse(at) + 30000).toISOString();
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      clock = at;
      const system = createPostgresProductContentRegistryStore({ ...options, actorKind: "System" });
      await system.withCurrentRegistry(observation(), async (value) =>
        assert.equal(value.registry.registryVersion, 3),
      );
      const systemWriter = createPostgresProductContentRegistryStore({
        ...options,
        actorKind: "System",
        audit,
      });
      await assert.rejects(systemWriter.execute(command(registry, 20)), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      assert.deepEqual(await counts(), final);
      const foreign = createPostgresProductContentRegistryStore({
        ...options,
        tenantReference: id(999),
      });
      await assert.rejects(
        foreign.withCurrentRegistry(observation(), async (value) => value),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      const foreignBrand = createPostgresProductContentRegistryStore({
        ...options,
        brandReference: id(999),
      });
      await assert.rejects(
        foreignBrand.withCurrentRegistry(observation(), async (value) => value),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      for (const kind of ["UPDATE", "DELETE"]) {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [id(1), id(2)],
          );
          await assert.rejects(
            admin.query(
              kind === "UPDATE"
                ? "UPDATE rms_catalog.product_content_registry_record SET data_classification='ConfigurationMetadata'"
                : "DELETE FROM rms_catalog.product_content_registry_record",
            ),
            (e) => e.code === "55000",
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [id(1), id(2), id(99)],
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM rms_catalog.product_content_registry_record",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      assert.deepEqual(await counts(), final);
    } finally {
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
});

it("records independent Product approval receipts and holds actual current original expiry with SQL rollback/RLS", async () => {
  // Initial Draft, approval proposal/expiry, validation and Actor/field holders are synthetic.
  // Actual owning Product approval and Published Product policy are composed below;
  // policy-governance validation outcomes remain synthetic. SQL/Audit/Outbox are actual.
  await withIsolatedDatabase({ caseId: "wp2421_approval" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_approval_" + context.runId;
    let roleCreated = false,
      clock = at,
      failOutbox = false,
      denyLate = false,
      writeHolds = 0,
      readHolds = 0,
      denyReadAt = 0,
      actualDecisionMode = false,
      expireDecisionAfterWrite = false,
      reviewHolds = 0,
      denyReviewAt = 0,
      expireAtApprovalFinalAuthority = false,
      expireAtReviewFinalAuthority = false,
      completedSchedules = 0,
      completedDecisions = 0;
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      roleCreated = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_eventing,platform_helpers TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA rms_catalog,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_APPROVAL','PreparedFood','Active',1,$3,$4,$3)",
        [id(5), id(2), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
        [id(6), id(5), id(2), { "en-CA": "Synthetic approval fixture" }, at],
      );
      const aggregate = parseProductAggregate({
          productReference: id(5),
          brandReference: id(2),
          internalCode: "SYNTHETIC_APPROVAL",
          productType: "PreparedFood",
          lifecycle: "Active",
          aggregateVersion: 1,
          createdAt: at,
          createdByActorReference: id(3),
          updatedAt: at,
          draft: {
            versionReference: id(6),
            baseVersionReference: null,
            status: "Draft",
            defaultLocale: "en-CA",
            localizedNames: { "en-CA": "Synthetic approval fixture" },
            taxClassificationReference: null,
            skus: [],
            optionBindings: [],
            createdAt: at,
            updatedAt: at,
          },
        }),
        identity = deriveCatalogProductPublicationContentIdentity(aggregate);
      const transactions = {
        async run(work) {
          const c = new pg.Client(context.clientConfig);
          await c.connect();
          try {
            await c.query("BEGIN");
            await c.query("SET LOCAL ROLE " + role);
            const result = await work({
              query: async (sql, values) => {
                if (failOutbox && sql.includes("INSERT INTO platform_eventing.outbox_event"))
                  throw new Error("synthetic outbox failure");
                return c.query(sql, [...values]);
              },
            });
            await c.query("COMMIT");
            return result;
          } catch (error) {
            await c.query("ROLLBACK");
            throw error;
          } finally {
            await c.end();
          }
        },
      };
      const command = (action, root, pub, op, actor = 3) => ({
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(actor),
        actorKind: "User",
        operationReference: id(op),
        productReference: id(5),
        versionReference: id(6),
        expectedProductAggregateVersion: root,
        expectedPublicationVersion: pub,
        action,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: {
            instant: "2026-09-29T13:00:00.000Z",
            localDateTime: "2026-09-29T13:00:00.000",
            utcOffsetMinutes: 0,
          },
          effectiveUntil: null,
        },
        scheduleReference:
          action === "SchedulePublish" || action === "CancelScheduledPublish" ? id(40) : null,
        replacementVersionReference: null,
        successorDraftVersionReference: null,
        occurredAt: at,
        reasonCode: "SYNTHETIC_APPROVAL",
      });
      const approvalFor = (c) => ({
        evidenceReference: id(21),
        reviewReference: id(20),
        reviewVersion: 2,
        requestedByActorReference: id(3),
        approvedByActorReference: id(4),
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        policyReference: id(19),
        policyVersion: 1,
        approvedAt: at,
        validUntil: "2026-09-29T12:00:20.000Z",
      });
      const options = (actor) => ({
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(actor),
        actorKind: "User",
        clock: { now: () => clock },
        transactions,
        authority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.command.actorReference, id(actor));
            writeHolds++;
            if (denyLate && writeHolds === 2) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
        sources: {
          async withHeldCurrentFacts(tx, input, work) {
            const c = input.command;
            const f = {
              now: clock,
              productAggregateVersion: c.expectedProductAggregateVersion,
              contentDigest: c.contentDigest,
              configurationDigest: c.configurationDigest,
              scopeDigest: hash(c.scopeSet),
              periodDigest: hash(c.effectivePeriod),
              validation: {
                evidenceReference: id(18),
                productAggregateVersion: c.expectedProductAggregateVersion,
                contentDigest: c.contentDigest,
                configurationDigest: c.configurationDigest,
                scopeDigest: hash(c.scopeSet),
                periodDigest: hash(c.effectivePeriod),
                policyReference: id(19),
                policyVersion: 1,
                approvalPolicy: "Required",
                checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
                warningAcknowledgement: null,
                checkedAt: at,
                validUntil: "2026-09-30T12:00:00.000Z",
              },
              approval: c.action === "Approve" ? approvalFor(c) : null,
              reviewReference: id(20),
              replacement: null,
            };
            if (actualDecisionMode && c.action === "Approve") {
              return decisionSource(tx).withCurrentDecision(tx, c, async (decision) => {
                assert.equal(decision.approval.evidenceReference, c.operationReference);
                assert.equal(decision.validation, "NotEvaluated");
                const result = await work({ ...f, approval: decision.approval });
                assert.equal(result.aggregate.aggregateVersion, 9);
                assert.equal(result.publication.state, "Approved");
                completedDecisions++;
                if (expireDecisionAfterWrite) clock = "2026-09-29T12:00:13.000Z";
                return result;
              });
            }
            if (c.action === "SchedulePublish") {
              // Actual current approval AND actual Published policy in this same UoW.
              return composed(tx).withCurrentApproval(
                tx,
                {
                  ...request(c.expectedProductAggregateVersion, c.expectedPublicationVersion),
                  originalIntentDigest: hash(c),
                },
                async (proof) => {
                  assert.equal(
                    proof.currentPolicy.publicationReference,
                    actualPolicyRelease.releaseId,
                  );
                  const result = await work({ ...f, approval: proof.receipt.approval });
                  assert.equal(result.aggregate.aggregateVersion, 5);
                  assert.equal(result.publication.state, "Scheduled");
                  completedSchedules++;
                  if (expirePolicyAfterSchedule) clock = "2026-09-29T12:00:15.000Z";
                  return result;
                },
              );
            }
            return work(f);
          },
        },
        audit: {
          create(p, action) {
            return {
              auditId: id(parseInt(p.operationReference.slice(-12), 16) + 5000),
              brandId: id(2),
              actor: { type: "User", reference: id(actor) },
              actionCode: catalogProductPublicationAuditAction(action),
              targetType: "Product",
              targetId: id(5),
              reasonCode: p.reasonCode,
              correlationId: p.operationReference,
              occurredAt: p.occurredAt,
              sourceChannel: "API",
              dataClassification: "Internal",
              retentionPolicyCode: "CATALOG_APPROVAL",
              retentionPolicyVersion: 1,
            };
          },
        },
      });
      const user = createPostgresProductPublicationStore(options(3)),
        peer = createPostgresProductPublicationStore(options(4));
      await user.execute(command("Validate", 1, 0, 100));
      await user.execute(command("SubmitReview", 2, 1, 101));
      const counts = async () =>
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_catalog.product_approval_receipt) receipt,(SELECT count(*)::int FROM rms_catalog.product_publication_revision) revisions,(SELECT count(*)::int FROM rms_catalog.product_operation_record) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit) sources,(SELECT max(source_revision)::text FROM rms_catalog.product_source_head) sourceHead,(SELECT count(*)::int FROM platform_audit.audit_record) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,(SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT max(next_sequence)::text FROM platform_audit.audit_chain_head) next",
              [id(5)],
            )
          ).rows[0],
        baseline = await counts();
      await assert.rejects(user.execute(command("Approve", 3, 2, 102, 3)), {
        code: "CATALOG_LIFECYCLE_CONFLICT",
      });
      assert.deepEqual(await counts(), baseline);
      const approveCommand = command("Approve", 3, 2, 102, 4);
      writeHolds = 0;
      denyLate = true;
      await assert.rejects(peer.execute(approveCommand), { code: "CATALOG_PERMISSION_DENIED" });
      denyLate = false;
      assert.deepEqual(await counts(), baseline);
      failOutbox = true;
      await assert.rejects(peer.execute(approveCommand), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      failOutbox = false;
      assert.deepEqual(await counts(), baseline);
      const applied = await peer.execute(approveCommand);
      assert.equal(applied.publication.state, "Approved");
      assert.equal((await counts()).receipt, 1);
      const recorded = await counts();
      assert.equal((await peer.execute(approveCommand)).status, "Replayed");
      assert.deepEqual(await counts(), recorded);
      const sourceOptions = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        clock: { now: () => clock },
        transactions,
        authority: {
          async holdUntilTransactionCompletes() {
            throw new Error("ordinary history authority must not substitute for approval fields");
          },
        },
        approvalAuthority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_APPROVAL_SOURCE");
            assert.equal(input.actorKind, "User");
            assert.equal(input.owningAction, "catalog.product.approval.read");
            readHolds++;
            if (expireAtApprovalFinalAuthority && completedSchedules > 0)
              clock = "2026-09-29T12:00:15.000Z";
            if (readHolds === denyReadAt) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      };
      const reader = createPostgresProductPublicationSourceStore(sourceOptions),
        request = (root = 4, pub = 3) => ({
          productReference: id(5),
          versionReference: id(6),
          expectedAggregateVersion: root,
          expectedPublicationVersion: pub,
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
          scopeDigest: hash(approveCommand.scopeSet),
          periodDigest: hash(approveCommand.effectivePeriod),
          policyReference: id(19),
          policyVersion: 1,
          originalIntentDigest: hash("synthetic caller approval observation"),
          observedAt: at,
          validUntil: "2026-09-29T12:00:30.000Z",
        });
      // Real owning policy body/history producer; current permissions and policy-governance validation remain synthetic.
      await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
      );
      const policyScope = { kind: "Brand", brandReference: id(2), storeReference: null };
      const policyBody = {
        profile: "PublishingProductPublicationPolicyV1",
        tenantReference: id(1),
        brandReference: id(2),
        familyReference: id(900),
        policyReference: id(19),
        policyVersion: 1,
        scopeOrder: productPolicyScopeLevels,
        approvalPolicy: "Required",
        warningOverrideAllowed: false,
        requiredLocales: ["en-CA"],
        mediaRequirement: "Optional",
        effectiveFrom: at,
        effectiveUntil: "2026-09-29T12:00:15.000Z",
      };
      const policyPublisher = createPostgresPublishingMutationStore(
        transactions,
        id(1),
        policyScope,
      );
      const policyDraft = {
        lifecycleId: id(901),
        familyReference: id(900),
        configurationType: "PRODUCT_PUBLICATION_POLICY",
        purposeCode: "PRODUCT_PUBLICATION_POLICY",
        snapshotReference: id(19),
        snapshotDigest: publishingProductPublicationPolicyDigest(policyBody),
        scope: policyScope,
        version: 1,
        state: "Draft",
        validationEvidenceReference: null,
        approvalEvidenceReference: null,
        createdAt: at,
        changedAt: at,
      };
      const policyMutation = (operation, current, next, n, extra = {}) => ({
        operation,
        expectedVersion: current?.version ?? 1,
        idempotencyKey: id(n),
        current,
        next,
        release: null,
        supersededReleaseId: null,
        rollbackTargetReleaseId: null,
        validationEvidence: null,
        approvalEvidence: null,
        audit: {
          auditId: id(n + 1),
          brandId: id(2),
          actor: {
            type: "User",
            reference: operation === "CreateDraft" || operation === "SubmitReview" ? id(3) : id(4),
          },
          actionCode: {
            CreateDraft: "PUBLISHING_DRAFT_CREATED",
            SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
            Approve: "PUBLISHING_REVIEW_APPROVED",
            Publish: "PUBLISHING_RELEASE_PUBLISHED",
            Archive: "PUBLISHING_RELEASE_ARCHIVED",
          }[operation],
          targetType: "PublishingLifecycle",
          targetId: id(901),
          reasonCode: "SYNTHETIC_POLICY",
          correlationId: id(n),
          occurredAt: at,
          sourceChannel: "API",
          dataClassification: "Confidential",
          retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
          retentionPolicyVersion: 1,
        },
        ...extra,
      });
      await policyPublisher.commit(
        policyMutation("CreateDraft", null, policyDraft, 910, { productPolicyContent: policyBody }),
      );
      const policyValidation = {
        evidenceReference: id(930),
        snapshotReference: id(19),
        snapshotDigest: policyDraft.snapshotDigest,
        scope: policyScope,
        result: "Pass",
        checkedAt: at,
        validUntil: "2026-10-01T00:00:00.000Z",
        checkCodes: ["PRODUCT_POLICY_STRUCTURE"],
      };
      const policyReview = {
        ...policyDraft,
        state: "InReview",
        version: 2,
        validationEvidenceReference: id(930),
      };
      await policyPublisher.commit(
        policyMutation("SubmitReview", policyDraft, policyReview, 912, {
          validationEvidence: policyValidation,
        }),
      );
      const policyApproval = {
        evidenceReference: id(931),
        reviewLifecycleId: id(901),
        reviewVersion: 2,
        snapshotReference: id(19),
        snapshotDigest: policyDraft.snapshotDigest,
        scope: policyScope,
        decision: "Accepted",
        approvedActorReference: id(4),
        approvedAt: at,
        validUntil: "2026-10-01T00:00:00.000Z",
      };
      const policyApproved = {
        ...policyReview,
        state: "Approved",
        version: 3,
        approvalEvidenceReference: id(931),
      };
      await policyPublisher.commit(
        policyMutation("Approve", policyReview, policyApproved, 914, {
          approvalEvidence: policyApproval,
        }),
      );
      const actualPolicyRelease = {
        releaseId: id(932),
        familyReference: id(900),
        configurationType: policyDraft.configurationType,
        purposeCode: policyDraft.purposeCode,
        snapshotReference: id(19),
        snapshotDigest: policyDraft.snapshotDigest,
        scope: policyScope,
        sequence: 1,
        sourceLifecycleId: id(901),
        kind: "Publish",
        previousReleaseId: null,
        createdAt: at,
      };
      const publishPolicy = async () => {
        await policyPublisher.commit(
          policyMutation(
            "Publish",
            policyApproved,
            { ...policyApproved, state: "Published", version: 4 },
            916,
            {
              validationEvidence: policyValidation,
              approvalEvidence: policyApproval,
              release: actualPolicyRelease,
            },
          ),
        );
      };
      let policyHolds = 0,
        denyPolicyLate = false,
        expirePolicyAfterSchedule = false;
      const policyOptions = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        actorKind: "User",
        clock: { now: () => clock },
        authority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.actorReference, id(3));
            assert.equal(input.actorKind, "User");
            policyHolds++;
            if (denyPolicyLate && policyHolds === 2)
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      };
      const composed = (tx) =>
        createCurrentProductApprovalSource({
          approvalSource: createPostgresProductPublicationSourceStore({
            ...sourceOptions,
            transactions: { run: (work) => work(tx) },
          }),
          policySource: createCurrentProductPublicationPolicySource(policyOptions),
          clock: { now: () => clock },
        });
      const observe = (work) =>
        transactions.run((tx) => composed(tx).withCurrentApproval(tx, request(), work));
      await assert.rejects(
        observe(() => assert.fail("unpublished policy")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      await publishPolicy();
      await transactions.run(async (tx) => {
        const approvalOptions = { ...sourceOptions, transactions: { run: (work) => work(tx) } },
          mutablePolicyOptions = { ...policyOptions },
          frozenApproval = createPostgresProductPublicationSourceStore(approvalOptions),
          frozenPolicy = createCurrentProductPublicationPolicySource(mutablePolicyOptions);
        approvalOptions.actorKind = "System";
        mutablePolicyOptions.actorKind = "System";
        const observation = await createCurrentProductApprovalSource({
          approvalSource: frozenApproval,
          policySource: frozenPolicy,
          clock: { now: () => clock },
        }).withCurrentApproval(tx, request(), async (p) => p);
        assert.equal(frozenApproval.context.actorKind, "User");
        assert.equal(frozenPolicy.context.actorKind, "User");
        assert.equal(observation.currentPolicy.publicationReference, actualPolicyRelease.releaseId);
      });
      const composedProof = await observe(async (p) => {
        await admin.query("BEGIN");
        try {
          assert.equal(
            (
              await admin.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) held", [
                "CatalogProductSource:" + id(2),
              ])
            ).rows[0].held,
            false,
          );
          await assert.rejects(
            admin.query(
              "LOCK TABLE bop_publishing.publishing_mutation_record IN ROW EXCLUSIVE MODE NOWAIT",
            ),
            (e) => e.code === "55P03",
          );
        } finally {
          await admin.query("ROLLBACK");
        }
        return p;
      });
      assert.equal(composedProof.validUntil, "2026-09-29T12:00:15.000Z");
      assert.equal(composedProof.receipt.approval.validUntil, "2026-09-29T12:00:20.000Z");
      assert.equal(composedProof.currentPolicy.publicationReference, actualPolicyRelease.releaseId);
      assert.equal(
        composedProof.currentPolicy.contentDigest,
        publishingProductPublicationPolicyDigest(policyBody),
      );
      assert.equal(composedProof.validation, "NotEvaluated");
      assert.equal(composedProof.eligibility, "NotEvaluated");
      await assert.rejects(
        transactions.run((tx) =>
          createCurrentProductApprovalSource({
            approvalSource: reader,
            policySource: createCurrentProductPublicationPolicySource(policyOptions),
            clock: { now: () => clock },
          }).withCurrentApproval(tx, request(), () => assert.fail("nested source transaction")),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        transactions.run((tx) =>
          createCurrentProductApprovalSource({
            approvalSource: createPostgresProductPublicationSourceStore({
              ...sourceOptions,
              transactions: { run: (work) => work(tx) },
            }),
            policySource: createCurrentProductPublicationPolicySource({
              ...policyOptions,
              actorReference: id(4),
            }),
            clock: { now: () => clock },
          }).withCurrentApproval(tx, request(), () => assert.fail("different Actor")),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      const beforeArchive = await counts(),
        policyCount = (
          await admin.query("SELECT count(*)::int n FROM bop_publishing.publishing_mutation_record")
        ).rows[0].n;
      await assert.rejects(
        transactions.run(async (tx) => {
          const published = { ...policyApproved, state: "Published", version: 4 };
          await createPostgresPublishingMutationStore(
            { run: (work) => work(tx) },
            id(1),
            policyScope,
          ).commit(
            policyMutation(
              "Archive",
              published,
              { ...published, state: "Archived", version: 5 },
              918,
            ),
          );
          await assert.rejects(
            composed(tx).withCurrentApproval(tx, request(), () => assert.fail("archived policy")),
            { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
          );
          throw new Error("synthetic owning archive rollback");
        }),
        /synthetic owning archive rollback/,
      );
      assert.deepEqual(await counts(), beforeArchive);
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM bop_publishing.publishing_mutation_record"))
          .rows[0].n,
        policyCount,
      );
      await assert.rejects(
        observe(async () => {
          clock = "2026-09-29T12:00:15.000Z";
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      clock = at;
      await assert.rejects(
        createPostgresProductPublicationSourceStore({
          ...sourceOptions,
          approvalAuthority: undefined,
        }).withCurrentApproval(request(), () => assert.fail("no authority")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      const proof = await reader.withCurrentApproval(request(), async (p) => {
        await admin.query("BEGIN");
        try {
          assert.equal(
            (
              await admin.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) held", [
                "CatalogProductSource:" + id(2),
              ])
            ).rows[0].held,
            false,
          );
        } finally {
          await admin.query("ROLLBACK");
        }
        return p;
      });
      assert.equal(proof.receipt.approval.approvedByActorReference, id(4));
      assert.equal(proof.receipt.approval.requestedByActorReference, id(3));
      assert.equal(proof.validUntil, "2026-09-29T12:00:20.000Z");
      assert.equal(proof.currentPolicy, "NotEvaluated");
      assert.equal(proof.observedAggregateVersion, 4);
      assert.equal(proof.currentPublicationVersion, 3);
      assert.equal(proof.observationIntentDigest, request().originalIntentDigest);
      await assert.rejects(
        reader.withCurrentApproval({ ...request(), policyVersion: 2 }, () =>
          assert.fail("wrong policy"),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        reader.withCurrentApproval({ ...request(), expectedAggregateVersion: 5 }, () =>
          assert.fail("wrong root"),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      readHolds = 0;
      denyReadAt = 3;
      await assert.rejects(
        reader.withCurrentApproval(request(), async () => true),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      denyReadAt = 0;
      await assert.rejects(
        reader.withCurrentApproval(request(), async () => {
          clock = "2026-09-29T12:00:20.000Z";
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      clock = at;
      const foreign = createPostgresProductPublicationSourceStore({
        ...sourceOptions,
        tenantReference: id(99),
      });
      await assert.rejects(
        foreign.withCurrentApproval(request(), () => assert.fail("foreign Tenant")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      const foreignBrand = createPostgresProductPublicationSourceStore({
        ...sourceOptions,
        brandReference: id(99),
      });
      await assert.rejects(
        foreignBrand.withCurrentApproval(request(), () => assert.fail("foreign Brand")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      clock = "2026-09-29T12:00:20.000Z";
      await assert.rejects(
        reader.withCurrentApproval({ ...request(), observedAt: clock }, () =>
          assert.fail("original approval expired despite fresh observation"),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      clock = at;
      const beforeSchedule = await counts();
      expireAtApprovalFinalAuthority = true;
      completedSchedules = 0;
      await transactions
        .run(async (tx) => {
          const heldWriter = createPostgresProductPublicationStore({
            ...options(3),
            transactions: { run: (work) => work(tx) },
          });
          await assert.rejects(heldWriter.execute(command("SchedulePublish", 4, 3, 103)), {
            code: "CATALOG_DEPENDENCY_UNAVAILABLE",
          });
          throw new Error("SYNTHETIC_EXPECTED_OUTER_ROLLBACK");
        })
        .catch((error) => {
          assert.equal(completedSchedules, 1);
          assert.equal(error.message, "SYNTHETIC_EXPECTED_OUTER_ROLLBACK");
        });
      assert.equal(completedSchedules, 1);
      assert.deepEqual(await counts(), beforeSchedule);
      expireAtApprovalFinalAuthority = false;
      completedSchedules = 0;
      clock = at;
      policyHolds = 0;
      denyPolicyLate = true;
      await assert.rejects(user.execute(command("SchedulePublish", 4, 3, 103)), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      denyPolicyLate = false;
      assert.deepEqual(await counts(), beforeSchedule);
      expirePolicyAfterSchedule = true;
      await assert.rejects(user.execute(command("SchedulePublish", 4, 3, 103)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      clock = at;
      expirePolicyAfterSchedule = false;
      assert.deepEqual(await counts(), beforeSchedule);
      await user.execute(command("SchedulePublish", 4, 3, 103));
      assert.equal(
        (await reader.withCurrentApproval(request(5, 4), async (p) => p)).receipt
          .approvalOperationReference,
        id(102),
      );
      assert.equal((await peer.execute(approveCommand)).status, "Replayed");
      assert.equal((await counts()).receipt, 1);
      await user.execute(command("CancelScheduledPublish", 5, 4, 104));
      await assert.rejects(
        reader.withCurrentApproval(request(6, 5), () => assert.fail("canceled approval")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      // Second review cycle: original approval is now derived from actual current review/policy.
      await user.execute(command("Validate", 6, 5, 110));
      await user.execute(command("SubmitReview", 7, 6, 111));
      clock = "2026-09-29T12:00:01.000Z";
      const decisionCommand = command("Approve", 8, 7, 112, 4),
        reviewAuthority = {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.actorReference, id(4));
            assert.equal(input.actorKind, "User");
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_APPROVAL_DECISION");
            assert.equal(input.owningAction, "catalog.product.approve");
            reviewHolds++;
            if (expireAtReviewFinalAuthority && completedDecisions > 0)
              clock = "2026-09-29T12:00:13.000Z";
            if (reviewHolds === denyReviewAt) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
        reviewOptions = { ...sourceOptions, actorReference: id(4), reviewAuthority },
        decisionSource = (tx) =>
          createCurrentProductApprovalDecisionSource({
            reviewSource: createPostgresProductPublicationSourceStore({
              ...reviewOptions,
              transactions: { run: (work) => work(tx) },
            }),
            policySource: createCurrentProductPublicationPolicySource({
              ...policyOptions,
              actorReference: id(4),
              authority: {
                async holdUntilTransactionCompletes(_tx, input) {
                  assert.equal(input.actorReference, id(4));
                },
              },
            }),
            clock: { now: () => clock },
            maximumApprovalValiditySeconds: 12,
          });
      await assert.rejects(
        createPostgresProductPublicationSourceStore({
          ...reviewOptions,
          reviewAuthority: undefined,
        }).withCurrentReview(decisionCommand, () =>
          assert.fail("missing current review authority"),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(reviewHolds, 0);
      await assert.rejects(
        createPostgresProductPublicationSourceStore(reviewOptions).withCurrentReview(
          { ...decisionCommand, expectedProductAggregateVersion: 9 },
          () => assert.fail("changed review root"),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      const beforeDecision = await counts();
      actualDecisionMode = true;
      reviewHolds = 0;
      denyReviewAt = 3;
      await assert.rejects(peer.execute(decisionCommand), { code: "CATALOG_PERMISSION_DENIED" });
      denyReviewAt = 0;
      assert.deepEqual(await counts(), beforeDecision);
      expireDecisionAfterWrite = true;
      await assert.rejects(peer.execute(decisionCommand), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      clock = "2026-09-29T12:00:01.000Z";
      expireDecisionAfterWrite = false;
      assert.deepEqual(await counts(), beforeDecision);
      expireAtReviewFinalAuthority = true;
      completedDecisions = 0;
      await transactions
        .run(async (tx) => {
          const heldWriter = createPostgresProductPublicationStore({
            ...options(4),
            transactions: { run: (work) => work(tx) },
          });
          await assert.rejects(heldWriter.execute(decisionCommand), {
            code: "CATALOG_DEPENDENCY_UNAVAILABLE",
          });
          throw new Error("SYNTHETIC_EXPECTED_OUTER_ROLLBACK");
        })
        .catch((error) => {
          assert.equal(completedDecisions, 1);
          assert.equal(error.message, "SYNTHETIC_EXPECTED_OUTER_ROLLBACK");
        });
      assert.equal(completedDecisions, 1);
      assert.deepEqual(await counts(), beforeDecision);
      expireAtReviewFinalAuthority = false;
      completedDecisions = 0;
      clock = "2026-09-29T12:00:01.000Z";
      const generated = await peer.execute(decisionCommand);
      assert.equal(
        generated.publication.approvalEvidenceReference,
        decisionCommand.operationReference,
      );
      assert.equal(generated.publication.occurredAt, at); // Original command intent is not restamped.
      const actualReceipt = (
        await admin.query(
          "SELECT snapshot_json FROM rms_catalog.product_approval_receipt WHERE operation_id=$1",
          [id(112)],
        )
      ).rows[0].snapshot_json;
      assert.equal(actualReceipt.approval.approvedAt, "2026-09-29T12:00:01.000Z");
      assert.equal(actualReceipt.approval.validUntil, "2026-09-29T12:00:13.000Z");
      assert.equal(actualReceipt.approval.requestedByActorReference, id(3));
      assert.equal(actualReceipt.approval.approvedByActorReference, id(4));
      const afterDecision = await counts(),
        beforeRecoveryHolds = reviewHolds;
      clock = "2026-09-29T12:00:14.000Z";
      assert.equal((await peer.execute(decisionCommand)).status, "Replayed");
      assert.equal(reviewHolds, beforeRecoveryHolds);
      assert.deepEqual(await counts(), afterDecision);
      await assert.rejects(
        reader.withCurrentApproval({ ...request(9, 8), observedAt: clock }, () =>
          assert.fail("original generated approval expired"),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      clock = at;
      actualDecisionMode = false;
      for (const sql of [
        "UPDATE rms_catalog.product_approval_receipt SET data_classification='ApprovalEvidence'",
        "DELETE FROM rms_catalog.product_approval_receipt",
      ]) {
        await admin.query("BEGIN");
        try {
          await assert.rejects(admin.query(sql), (e) => e.code === "55000");
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      for (const [tenant, brand, store] of [
        [id(99), id(2), ""],
        [id(1), id(99), ""],
        [id(1), id(2), id(9)],
      ]) {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, store],
          );
          assert.equal(
            (await admin.query("SELECT count(*)::int n FROM rms_catalog.product_approval_receipt"))
              .rows[0].n,
            0,
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [id(99), id(2)],
        );
        await assert.rejects(
          admin.query(
            "INSERT INTO rms_catalog.product_approval_receipt(operation_id,approval_id,tenant_id,brand_id,product_id,product_version_id,publication_version,result_aggregate_version,receipt_digest,snapshot_json,recorded_at) VALUES($1,$2,$3,$4,$5,$6,3,4,$7,$8::jsonb,$9)",
            [
              id(102),
              id(21),
              id(1),
              id(2),
              id(5),
              id(6),
              proof.receipt.digest,
              JSON.stringify(proof.receipt),
              at,
            ],
          ),
          (e) => e.code === "42501",
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      await exerciseCurrentApprovalDecisionHttp({
        admin,
        role,
        id,
        transactions,
        originalAggregate: aggregate,
      });
    } finally {
      if (roleCreated) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
});

it("persists permanent exact Store-selector retirement with Required approval, late System activation and complete SQL coverage", async () => {
  await exerciseProductScopeRetirement();
});

it("registers and resolves Catalog tax classifications with actual SQL, recovery and rollback", async () => {
  await exerciseProductTaxClassificationRegistry();
});

it("reads publication V2 Catalog reference sources with held native history", async () => {
  await exerciseProductPublicationReferenceSourcesV2();
});

it("composes publication V2 cross-domain stored references with native rollback", async () => {
  await exerciseProductPublicationCrossDomainReferencesV2();
});

it("records immutable publication validation reports with actual SQL replay and rollback", async () => {
  await exerciseProductPublicationValidationReport();
});

it("resolves or permanently abandons original publication requests with native races and rollback", async () => {
  await exerciseProductPublicationResolution();
});

it("registers selling units and consumes actual original SKU proof with SQL/RLS/recovery/rollback", async () => {
  await exerciseSellingUnitRegistry();
});

it("resolves original authoring operations and permanently fences absence with SQL/RLS/rollback", async () => {
  await exerciseProductAuthoringResolution();
});
