import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  catalogProductPublicationAuditAction,
  createPostgresProductContentRegistryStore,
  createPostgresProductCreationStore,
  createPostgresProductLifecycleStore,
  createPostgresProductPublicationStoreV2,
  createPostgresProductPublicationWarningAcknowledgementStore,
  deriveCatalogProductPublicationContentIdentity,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  productPublicationCheckCodes,
} from "../../rms/catalog/src/index.ts";
import {
  createPostgresPublishingMutationStore,
  publishingProductPublicationPolicyDigest,
  productPolicyScopeLevels,
} from "../../bop/publishing/src/index.ts";
import { createMerchantProductPublicationSources } from "../../../apps/api/src/merchant-product-publication-sources.ts";
import {
  createMerchantProductPublicationBusinessPolicy,
  buildMerchantProductPublicationBusinessConfiguration,
} from "../../../apps/api/src/merchant-product-publication-business-policy.ts";
import { exerciseProductFullPublicationRuntimeHttp } from "./product-full-publication-runtime-http.mjs";
import { exerciseProductCurrentAuthoringRuntimeHttp } from "./product-current-authoring-runtime-http.mjs";

const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const plus = (at, milliseconds) => new Date(Date.parse(at) + milliseconds).toISOString();

/** Production source assembly over actual owning SQL in the existing isolated
 * Product case. Identities, admission/field holders and the explicitly named
 * configuration identity are controlled. The configured business rules use the
 * accepted seven-day backdate and four explicit missing-reference warnings.
 * This first journey controls IAM holders; its final separate helper exercises
 * actual IAM and HTTP. Neither claims stock, sale price or real-world Store facts.
 * The nine source checks and three derived checks are never supplied as Pass. */
export async function exerciseProductFullPublicationSources(env) {
  const {
    admin,
    role,
    tenant,
    brand,
    actor,
    storeReference,
    configurationVersionReference,
    expectedBrandVersion,
    transactions,
    registerBeforeCommit,
    id,
  } = env;
  assert.match(role, /^wp2421_retire_[a-f0-9]+$/);
  let sequence = 2000000,
    overrideTime = null,
    mode = "normal",
    freshHolds = 0,
    businessReads = 0,
    consumerReturned = false,
    tentative;
  // Requests and SQL observations share the actual isolated database epoch.
  // Only elapsed monotonic time advances this controlled fixture clock; no
  // source timestamp or original deadline is rewritten or extended.
  const databaseClock = await admin.query(
      "SELECT date_trunc('milliseconds',clock_timestamp()) observed_at",
    ),
    databaseAnchor = databaseClock.rows[0].observed_at.getTime(),
    monotonicAnchor = performance.now();
  let clockAdjustment = 0;
  const reference = () => id(++sequence),
    clockMilliseconds = () =>
      databaseAnchor + performance.now() - monotonicAnchor + clockAdjustment,
    now = () => overrideTime ?? new Date(clockMilliseconds()).toISOString(),
    configurationReference = reference(),
    policyReference = reference(),
    policyVersion = 1;
  const actionsSeen = new Map();

  await admin.query("GRANT UPDATE(lifecycle) ON rms_catalog.product TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_catalog.product_content_registry_record TO " + role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_catalog.product_publication_warning_acknowledgement TO " + role,
  );
  await admin.query(
    "GRANT SELECT ON platform_audit.audit_record,platform_eventing.outbox_event TO " + role,
  );
  await admin.query(
    "GRANT SELECT ON rms_catalog.menu_reference_generation,rms_catalog.menu_review_content,rms_catalog.menu_publication_revision,rms_catalog.menu_publication_release,rms_catalog.menu_release_effective_period,rms_catalog.menu_release_effective_end,rms_catalog.bundle_reference_generation,rms_catalog.bundle,rms_catalog.bundle_version,rms_catalog.bundle_component_group,rms_catalog.bundle_component_sellable,rms_catalog.availability_rule,rms_catalog.availability_reference_generation TO " +
      role,
  );
  await admin.query("GRANT USAGE ON SCHEMA rms_recipe,rms_inventory,rms_pricing TO " + role);
  const recipeColumns = {
    recipe: "recipe_id,brand_id,aggregate_version,current_version_id,updated_at",
    recipe_version:
      "recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,effective_from,effective_until,effective_time_zone,created_at",
    recipe_reference_generation: "brand_id,generation,binding_count",
    recipe_reference_binding:
      "recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from,effective_until",
    recipe_ingredient_requirement:
      "requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id",
    recipe_modifier_version:
      "rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,effective_until,occurred_at",
  };
  for (const [table, columns] of Object.entries(recipeColumns)) {
    assert.match(table, /^[a-z_]+$/);
    assert.match(columns, /^[a-z_,]+$/);
    await admin.query(`GRANT SELECT(${columns}) ON rms_recipe.${table} TO ${role}`);
  }
  await admin.query(
    "GRANT SELECT ON " +
      [
        "rms_inventory.configuration_reference_generation",
        "rms_inventory.inventory_item",
        "rms_inventory.inventory_item_version",
        "rms_inventory.inventory_item_operation",
        "rms_inventory.item_sku_mapping_version",
        ...[
          "configuration_reference_generation",
          "price_book",
          "price_book_version",
          "price_entry",
          "option_price_rule",
          "option_price_rule_version",
          "promotion",
          "promotion_version",
          "promotion_eligibility_reference",
        ].map((table) => "rms_pricing." + table),
      ].join(",") +
      " TO " +
      role,
  );

  const audit = (
    operation,
    actorReference,
    actionCode,
    targetType,
    targetId,
    occurredAt,
    reasonCode,
  ) => ({
    auditId: reference(),
    brandId: brand,
    actor: { type: "User", reference: actorReference },
    actionCode,
    targetType,
    targetId,
    correlationId: operation,
    occurredAt,
    reasonCode,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "CONFIGURATION_AUDIT",
    retentionPolicyVersion: 1,
  });
  // A separate actual Published policy leaves all preceding override-disabled
  // negative cases intact. Publishing's review/approval evidence and principals
  // are controlled fixture inputs; the stored policy and release are real.
  const policyAt = now(),
    policyUntil = plus(policyAt, 86400000),
    policyScope = { kind: "Brand", brandReference: brand, storeReference: null },
    publisher = createPostgresPublishingMutationStore(transactions, tenant, policyScope),
    policyContent = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: tenant,
      brandReference: brand,
      familyReference: reference(),
      policyReference,
      policyVersion,
      scopeOrder: productPolicyScopeLevels,
      approvalPolicy: "Required",
      warningOverrideAllowed: true,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: policyAt,
      effectiveUntil: policyUntil,
    },
    policyDraft = {
      lifecycleId: reference(),
      familyReference: policyContent.familyReference,
      configurationType: "PRODUCT_PUBLICATION_POLICY",
      purposeCode: "PRODUCT_PUBLICATION_POLICY",
      snapshotReference: policyReference,
      snapshotDigest: publishingProductPublicationPolicyDigest(policyContent),
      scope: policyScope,
      version: 1,
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: policyAt,
      changedAt: policyAt,
    },
    policyValidation = {
      evidenceReference: reference(),
      snapshotReference: policyReference,
      snapshotDigest: policyDraft.snapshotDigest,
      scope: policyScope,
      result: "Pass",
      checkedAt: policyAt,
      validUntil: policyUntil,
      checkCodes: ["PRODUCT_POLICY_STRUCTURE"],
    },
    policyReview = {
      ...policyDraft,
      version: 2,
      state: "InReview",
      validationEvidenceReference: policyValidation.evidenceReference,
    },
    policyApproval = {
      evidenceReference: reference(),
      reviewLifecycleId: policyDraft.lifecycleId,
      reviewVersion: 2,
      snapshotReference: policyReference,
      snapshotDigest: policyDraft.snapshotDigest,
      scope: policyScope,
      decision: "Accepted",
      approvedActorReference: id(4),
      approvedAt: policyAt,
      validUntil: policyUntil,
    },
    policyApproved = {
      ...policyReview,
      version: 3,
      state: "Approved",
      approvalEvidenceReference: policyApproval.evidenceReference,
    },
    policyPublished = { ...policyApproved, version: 4, state: "Published" },
    policyRelease = {
      releaseId: reference(),
      familyReference: policyDraft.familyReference,
      configurationType: policyDraft.configurationType,
      purposeCode: policyDraft.purposeCode,
      snapshotReference: policyReference,
      snapshotDigest: policyDraft.snapshotDigest,
      scope: policyScope,
      sequence: 1,
      sourceLifecycleId: policyDraft.lifecycleId,
      kind: "Publish",
      previousReleaseId: null,
      createdAt: policyAt,
    };
  async function publishPolicyStep(operation, current, next, extra = {}) {
    const operationReference = reference();
    await publisher.commit({
      operation,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: operationReference,
      current,
      next,
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: null,
      approvalEvidence: null,
      audit: {
        ...audit(
          operationReference,
          ["CreateDraft", "SubmitReview"].includes(operation) ? actor : id(4),
          {
            CreateDraft: "PUBLISHING_DRAFT_CREATED",
            SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
            Approve: "PUBLISHING_REVIEW_APPROVED",
            Publish: "PUBLISHING_RELEASE_PUBLISHED",
          }[operation],
          "PublishingLifecycle",
          policyDraft.lifecycleId,
          policyAt,
          "ISOLATED_OWNER_POLICY_PUBLICATION",
        ),
        dataClassification: "Confidential",
        retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      },
      ...extra,
    });
  }
  await publishPolicyStep("CreateDraft", null, policyDraft, {
    productPolicyContent: policyContent,
  });
  await publishPolicyStep("SubmitReview", policyDraft, policyReview, {
    validationEvidence: policyValidation,
  });
  await publishPolicyStep("Approve", policyReview, policyApproved, {
    approvalEvidence: policyApproval,
  });
  await publishPolicyStep("Publish", policyApproved, policyPublished, {
    validationEvidence: policyValidation,
    approvalEvidence: policyApproval,
    release: policyRelease,
  });
  // Preserve an already established Brand registry. This new scenario uses no
  // Tag/Attribute references; it must still read a real owning registry snapshot.
  const existingRegistry = await admin.query(
    "SELECT count(*)::int n FROM rms_catalog.product_content_registry_record WHERE tenant_id=$1 AND brand_id=$2",
    [tenant, brand],
  );
  if (existingRegistry.rows[0].n === 0) {
    const registeredAt = now(),
      registry = {
        profile: "CatalogProductContentRegistryV1",
        tenantReference: tenant,
        brandReference: brand,
        registryReference: reference(),
        versionReference: reference(),
        registryVersion: 1,
        defaultLocale: "en-CA",
        previousSnapshotDigest: null,
        registeredAt,
        tags: [],
        attributes: [],
      };
    await createPostgresProductContentRegistryStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      clock: { now },
      transactions,
      authority: {
        async holdUntilTransactionCompletes(_tx, packet) {
          assert.equal(packet.tenantReference, tenant);
          assert.equal(packet.brandReference, brand);
          assert.equal(packet.actorReference, actor);
        },
      },
      audit: {
        create(command) {
          return audit(
            command.operationReference,
            actor,
            "CATALOG_CONTENT_REGISTRY_RECORDED",
            "CatalogContentRegistry",
            registry.registryReference,
            command.occurredAt,
            command.reasonCode,
          );
        },
      },
    }).execute({
      purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      operationReference: reference(),
      expectedRegistryVersion: 0,
      occurredAt: registeredAt,
      reasonCode: "ISOLATED_ASSEMBLY_REGISTRY",
      registry,
    });
  }

  const counts = async (productReference, tx = admin) =>
    (
      await tx.query(
        `SELECT
    p.aggregate_version root,
    (SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=p.product_id) operations,
    (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=p.product_id) snapshots,
    (SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=p.product_id) commits,
    (SELECT count(*)::int FROM rms_catalog.product_publication_revision WHERE product_id=p.product_id) revisions,
    (SELECT count(*)::int FROM rms_catalog.product_publication_validation_report WHERE product_id=p.product_id) reports,
    (SELECT count(*)::int FROM rms_catalog.product_publication_warning_acknowledgement WHERE product_id=p.product_id) acknowledgements,
    (SELECT count(*)::int FROM rms_catalog.product_scope_retirement_header WHERE product_id=p.product_id) headers,
    (SELECT count(*)::int FROM rms_catalog.product_approval_receipt WHERE product_id=p.product_id) approvals,
    (SELECT count(*)::int FROM rms_catalog.product_publication_content WHERE product_id=p.product_id) contents,
    (SELECT count(*)::int FROM platform_audit.audit_record) audit,
    (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,
    (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id),'[]'::jsonb) FROM rms_catalog.product_source_head h) heads,
    (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains
    FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2`,
        [brand, productReference],
      )
    ).rows[0];

  async function createProduct(activeSku, unknownTax = false, { activate = true } = {}) {
    const createdAt = now(),
      productReference = reference(),
      versionReference = reference(),
      aggregate = parseProductAggregate({
        productReference,
        brandReference: brand,
        internalCode: "NATIVE_ASSEMBLED_" + sequence,
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt,
        createdByActorReference: actor,
        updatedAt: createdAt,
        draft: {
          versionReference,
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Isolated assembled Product" },
          taxClassificationReference: unknownTax ? reference() : null,
          createdAt,
          updatedAt: createdAt,
          skus: activeSku
            ? [
                {
                  skuReference: reference(),
                  productReference,
                  brandReference: brand,
                  skuCode: "NATIVE_ONE_" + sequence,
                  lifecycle: "Draft",
                  localizedNames: { "en-CA": "One" },
                  variantSelections: [],
                  unitOfSale: "EA",
                  unitQuantity: "1",
                  createdAt,
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
      }),
      operationReference = reference();
    await createPostgresProductCreationStore({
      brandReference: brand,
      transactions,
      authorize: async () => true,
      editorContentAuthority: {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.equal(input.aggregate.productReference, productReference);
          assert.deepEqual(input.aggregate, aggregate);
        },
      },
    }).create({
      record: {
        action: "Create",
        operationReference,
        operationIntentHash: sha256Hex(canonicalizeRfc8785(aggregate)),
        aggregate,
      },
      audit: audit(
        operationReference,
        actor,
        "CATALOG_PRODUCT_CREATE",
        "CatalogProduct",
        productReference,
        createdAt,
        "ISOLATED_ASSEMBLY_CREATE",
      ),
    });
    if (!activeSku || !activate) return aggregate;
    // Creation accepts Draft SKUs only. Activate through the owning lifecycle
    // writer so CAS, transition validation, immutable history, Audit and Outbox
    // are all real before the publication sources inspect this Active member.
    const activatedAt = now(),
      activationOperation = reference(),
      activated = parseProductAggregate({
        ...aggregate,
        aggregateVersion: aggregate.aggregateVersion + 1,
        updatedAt: activatedAt,
        draft: {
          ...aggregate.draft,
          updatedAt: activatedAt,
          skus: aggregate.draft.skus.map((sku) => ({ ...sku, lifecycle: "Active" })),
        },
      });
    const activation = await createPostgresProductLifecycleStore({
      brandReference: brand,
      transactions,
      authorize: async (_tx, request) => {
        assert.equal(request.productReference, productReference);
        if (request.record !== undefined) {
          assert.equal(request.record.action, "ChangeLifecycle");
          assert.equal(request.record.operationReference, activationOperation);
        }
        return true;
      },
      editorContentAuthority: {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.deepEqual(
            input.aggregate,
            input.aggregate.aggregateVersion === aggregate.aggregateVersion ? aggregate : activated,
          );
        },
      },
    }).commit({
      expectedAggregateVersion: aggregate.aggregateVersion,
      record: {
        action: "ChangeLifecycle",
        operationReference: activationOperation,
        operationIntentHash: sha256Hex(
          `Lifecycle:${productReference}:${aggregate.draft.skus[0].skuReference}:Active:${aggregate.aggregateVersion}`,
        ),
        aggregate: activated,
      },
      audit: audit(
        activationOperation,
        actor,
        "CATALOG_PRODUCT_CHANGELIFECYCLE",
        "CatalogProduct",
        productReference,
        activatedAt,
        "ISOLATED_ASSEMBLY_SKU_ACTIVATION",
      ),
    });
    assert.equal(activation.aggregate.aggregateVersion, 2);
    assert.equal(activation.aggregate.draft.skus[0].lifecycle, "Active");
    const activatedCounts = await counts(productReference);
    assert.equal(activatedCounts.operations, 2);
    assert.equal(activatedCounts.snapshots, 2);
    assert.equal(activatedCounts.commits, 2);
    return activation.aggregate;
  }
  function command(aggregate, current, action = "Validate", actorReference = actor) {
    const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
      none = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
      occurredAt = now();
    return parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: tenant,
      brandReference: brand,
      actorReference,
      actorKind: "User",
      operationReference: reference(),
      productReference: aggregate.productReference,
      versionReference: aggregate.draft.versionReference,
      expectedProductAggregateVersion: aggregate.aggregateVersion,
      expectedPublicationVersion: current?.publicationVersion ?? 0,
      action,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: current?.scopeSet ?? [
        { level: "Store", reference: storeReference, channelCodes: [], orderTypeCodes: [] },
      ],
      effectivePeriod: current?.effectivePeriod ?? {
        timeZone: "UTC",
        effectiveFrom: {
          instant: occurredAt,
          localDateTime: occurredAt.slice(0, -1),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
      replacementIntent: current?.replacementIntent ?? { ...none, digest: hash(none) },
      replacementIntentDigest: current?.replacementIntentDigest ?? hash(none),
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: action === "Publish" ? reference() : null,
      occurredAt,
      reasonCode: "ISOLATED_ASSEMBLED_" + action.toUpperCase(),
    });
  }
  function acknowledgement(result, actorReference) {
    const report = result.validationReport.report;
    assert.equal(result.validationReport.status, "Recorded");
    assert.equal(report.details.coverage, "Complete");
    assert.equal(typeof report.warningBindingDigest, "string");
    return parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: tenant,
      brandReference: brand,
      actorReference,
      actorKind: "User",
      operationReference: reference(),
      productReference: result.aggregate.productReference,
      versionReference: result.publication.versionReference,
      expectedProductAggregateVersion: result.aggregate.aggregateVersion,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: report.validation.checks
        .filter((check) => check.outcome === "Warning")
        .map((check) => check.code)
        .sort(),
      reasonCode: "CONFIRMED_FOUR_MISSING_CONFIGURATIONS",
      occurredAt: now(),
    });
  }
  async function execute(c) {
    consumerReturned = false;
    return transactions.run(async (tx) => {
      const acknowledgementDiagnostic = {
        sourceEntered: false,
        consumerEntered: false,
        lastSource: "none",
        sourceError: "none",
        consumerError: "none",
      };
      const boundedCode = (error) =>
        error instanceof CatalogError ? error.code : "CONTROLLED_SOURCE_FAILURE";
      const underlyingQuery = tx.query.bind(tx);
      tx.query = async (sql, values) => {
        const result = await underlyingQuery(sql, values);
        for (const row of result.rows) {
          const sourceTime = Date.parse(row.source?.observedAt);
          if (Number.isFinite(sourceTime))
            clockAdjustment += Math.max(0, sourceTime - clockMilliseconds());
        }
        return result;
      };
      const observedAt = now(),
        originalValidUntil = plus(observedAt, 5000),
        originalIntentDigest = hash(c),
        checkClock = () => {
          if (now() >= originalValidUntil) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        },
        assertSource = (actual, packet, sourceName) => {
          acknowledgementDiagnostic.lastSource = sourceName;
          assert.equal(actual, tx);
          if (mode === "replay") throw new Error("ORIGINAL_REPLAY_MUST_NOT_ACQUIRE_" + sourceName);
          freshHolds++;
          const seen = actionsSeen.get(sourceName) ?? new Set();
          seen.add(c.action);
          actionsSeen.set(sourceName, seen);
          if (packet.command !== undefined) assert.deepEqual(packet.command, c);
          if (packet.originalIntentDigest !== undefined)
            assert.equal(packet.originalIntentDigest, originalIntentDigest);
          const request = packet.request ?? packet;
          if (request.originalIntentDigest !== undefined)
            assert.equal(request.originalIntentDigest, originalIntentDigest);
          if (request.tenantReference !== undefined) assert.equal(request.tenantReference, tenant);
          if (request.brandReference !== undefined) assert.equal(request.brandReference, brand);
          if (request.actorReference !== undefined)
            assert.equal(request.actorReference, c.actorReference);
          checkClock();
        },
        holder = (sourceName) => ({
          async holdUntilTransactionCompletes(actual, packet) {
            assertSource(actual, packet, sourceName);
          },
        }),
        references = Object.fromEntries(
          [
            "history",
            "availability",
            "bundle",
            "menu",
            "recipe",
            "recipeInventory",
            "inventory",
            "pricing",
            "priceBook",
            "optionPrice",
            "promotion",
          ].map((name) => [name + "Authority", holder(name)]),
        );
      const businessPolicy = createMerchantProductPublicationBusinessPolicy({
        clock: { now },
        configurations: {
          async withCurrentConfiguration(actual, input, work) {
            assertSource(actual, input.context, "businessPolicy");
            businessReads++;
            const capturedRevision = 1,
              configuration = buildMerchantProductPublicationBusinessConfiguration({
                context: input.context,
                policy: input.policy,
                configurationReference,
                configurationRevision: capturedRevision,
              });
            await input.registerBeforeCommit(
              tx,
              async () => {
                checkClock();
                assert.equal(configuration.configurationRevision, capturedRevision);
                if (consumerReturned && mode === "late-policy-denial") {
                  tentative = await counts(c.productReference, tx);
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
                }
              },
              () => {
                checkClock();
                assert.equal(configuration.configurationRevision, capturedRevision);
              },
            );
            return work(Object.freeze(configuration), tx);
          },
        },
      });
      const factories = createMerchantProductPublicationSources({
        contentPolicy: {
          configurationVersionReference,
          expectedBrandVersion,
          policyReference,
          policyVersion,
          brandAuthority: {
            async withCurrentContentRead(actual, packet, work) {
              assertSource(actual, packet, "brand");
              return work();
            },
            async isCurrent(actual, packet) {
              assertSource(actual, packet, "brand");
              return true;
            },
          },
          policyAuthority: holder("policy"),
        },
        scope: {
          historyAuthority: holder("scope-history"),
          tenantAuthority: {
            async withCurrentBrandReferenceRead(actual, packet, work) {
              assertSource(actual, packet, "stores");
              return work();
            },
            async isCurrent(actual, packet) {
              assertSource(actual, packet, "stores");
              return true;
            },
          },
        },
        variant: { authority: holder("variant") },
        options: { authority: holder("options") },
        tax: { authority: holder("tax") },
        registeredContent: { registryAuthority: holder("registry") },
        publicationReferences: references,
        acknowledgementReferences: references,
        evidenceReference: reference,
        reviewReference: reference,
        businessPolicy,
      });
      const isAcknowledgement = c.action === "AcknowledgeProductPublicationWarnings",
        host = {
          transaction: tx,
          command: c,
          tenantReference: tenant,
          brandReference: brand,
          actorReference: c.actorReference,
          storeReference,
          sessionReference: id(2000000),
          clock: { now },
          originalValidUntil,
          registerBeforeCommit,
          async authorizeMediaAccess() {
            assertSource(tx, { command: c }, "media");
          },
        },
        assembled = isAcknowledgement
          ? factories.acknowledgement(host)
          : factories.publication(host),
        writer = isAcknowledgement
          ? createPostgresProductPublicationWarningAcknowledgementStore({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: c.actorReference,
              clock: { now },
              transactions: { run: (work) => work(tx) },
              registerBeforeCommit,
              contentAuthority: holder("ack-content"),
              historyAuthority: holder("ack-history"),
              reportAuthority: holder("ack-report"),
              authority: {
                async holdUntilTransactionCompletes(actual, packet) {
                  assert.equal(actual, tx);
                  assert.deepEqual(packet.command, c);
                  assert.equal(packet.requiredScope, "FullBrandScope");
                  checkClock();
                },
              },
              sources: {
                async withHeldCurrentObservation(actual, input, work) {
                  acknowledgementDiagnostic.sourceEntered = true;
                  try {
                    return await assembled.sources.withHeldCurrentObservation(
                      actual,
                      input,
                      async (value) => {
                        acknowledgementDiagnostic.consumerEntered = true;
                        try {
                          return await work(value);
                        } catch (error) {
                          acknowledgementDiagnostic.consumerError = boundedCode(error);
                          throw error;
                        }
                      },
                    );
                  } catch (error) {
                    acknowledgementDiagnostic.sourceError = boundedCode(error);
                    throw error;
                  }
                },
              },
              audit: {
                create(receipt) {
                  return audit(
                    c.operationReference,
                    c.actorReference,
                    "CATALOG_PRODUCT_PUBLICATION_WARNINGS_ACKNOWLEDGED",
                    "Product",
                    c.productReference,
                    receipt.recordedAt,
                    c.reasonCode,
                  );
                },
              },
            })
          : createPostgresProductPublicationStoreV2({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: c.actorReference,
              actorKind: "User",
              clock: { now },
              transactions: { run: (work) => work(tx) },
              registerBeforeCommit,
              maximumApprovalValiditySeconds: 3600,
              authority: {
                async holdUntilTransactionCompletes(actual, packet) {
                  assert.equal(actual, tx);
                  assert.deepEqual(packet.command, c);
                  assert.equal(packet.requiredScope, "FullBrandScope");
                  checkClock();
                },
              },
              editorContentAuthority: {
                async holdUntilTransactionCompletes(actual, packet) {
                  // Native controlled Merchant admission, retaining the real factory's
                  // closed content/reference holder and its original transaction lease.
                  return assembled.editorContentAuthority(actual, {
                    ...packet,
                    tenantReference: tenant,
                    brandReference: brand,
                    storeReference,
                    actorReference: c.actorReference,
                    sessionReference: host.sessionReference,
                    productReference: c.productReference,
                    operationReference: c.operationReference,
                    permission: "catalog.manage",
                    owningAction: "catalog.product.read",
                    purposeCode: c.purposeCode,
                    command: c,
                    originalIntentDigest,
                    replacementIntentDigest: c.replacementIntentDigest,
                    observedAt,
                    validUntil: originalValidUntil,
                  });
                },
              },
              sources: assembled.sources,
              audit: {
                create(p, action) {
                  return audit(
                    p.operationReference,
                    p.actorReference,
                    catalogProductPublicationAuditAction(action),
                    "Product",
                    p.productReference,
                    p.occurredAt,
                    p.reasonCode,
                  );
                },
              },
            });
      let result;
      try {
        result = await writer.execute(c);
      } catch (error) {
        if (isAcknowledgement && mode === "normal")
          throw new Error(
            "ISOLATED_ACK_ASSEMBLY_DIAGNOSTIC " +
              JSON.stringify({ ...acknowledgementDiagnostic, resultError: boundedCode(error) }),
            { cause: error },
          );
        throw error;
      }
      consumerReturned = true;
      if (mode === "later-final-expiry")
        await registerBeforeCommit(
          tx,
          async () => {
            tentative = await counts(c.productReference, tx);
            overrideTime = originalValidUntil;
          },
          () => undefined,
        );
      return result;
    });
  }

  const invalid = await createProduct(false, true),
    invalidCommand = command(invalid, null),
    invalidResult = await execute(invalidCommand);
  assert.equal(invalidResult.publication.validationDecision, "HardError");
  assert.equal(invalidResult.validationReport.status, "Recorded");
  assert.equal(invalidResult.validationReport.report.details.coverage, "Complete");
  for (const code of ["PublishableSku", "TaxResolution", "HardErrorsCleared"])
    assert.equal(
      invalidResult.validationReport.report.validation.checks.find((check) => check.code === code)
        .outcome,
      "HardError",
    );
  assert.equal(
    invalidResult.validationReport.report.validation.checks.find(
      (check) => check.code === "ApprovalPolicy",
    ).outcome,
    "Pending",
  );
  assert(
    invalidResult.validationReport.report.details.findings.some(
      (finding) => finding.checkCode === "PublishableSku",
    ),
  );
  assert(
    invalidResult.validationReport.report.details.findings.some(
      (finding) => finding.checkCode === "TaxResolution",
    ),
  );

  const complete = await createProduct(true),
    operations = [],
    results = [],
    expectedReasons = [
      "REQUIRED_PRICING_REFERENCE_MISSING",
      "REQUIRED_RECIPE_REFERENCE_MISSING",
      "REQUIRED_INVENTORY_REFERENCE_MISSING",
      "REQUIRED_MENU_REFERENCE_MISSING",
    ].sort();
  let aggregate = complete,
    current = null;
  for (const action of ["Validate", "SubmitReview", "Approve", "Publish"]) {
    const c = command(aggregate, current, action, action === "Approve" ? id(4) : actor),
      result = await execute(c);
    assert.equal(result.status, "Applied");
    assert.equal(result.aggregate.aggregateVersion, aggregate.aggregateVersion + 1);
    assert.equal(result.validationReport.status, "Recorded");
    const report = result.validationReport.report;
    assert.equal(report.originalIntentDigest, hash(c));
    assert.equal(report.details.coverage, "Complete");
    assert.equal(report.validation.checks.length, productPublicationCheckCodes.length);
    assert.equal(
      report.validation.checks.find((check) => check.code === "ChangeImpact").outcome,
      "Warning",
    );
    assert.deepEqual(
      report.details.findings
        .filter((finding) => finding.checkCode === "ChangeImpact")
        .map((finding) => finding.reasonCode)
        .sort(),
      expectedReasons,
    );
    if (action === "Validate") assert.equal(report.validation.warningAcknowledgement, null);
    else {
      assert.equal(report.validation.warningAcknowledgement.actorReference, c.actorReference);
      assert.deepEqual(report.validation.warningAcknowledgement.warningCodes, ["ChangeImpact"]);
    }
    assert.equal(
      report.validation.checks.find((check) => check.code === "ApprovalPolicy").outcome,
      ["Validate", "SubmitReview"].includes(action) ? "Pending" : "Pass",
    );
    for (const check of report.validation.checks.filter(
      (check) => !["ApprovalPolicy", "ChangeImpact"].includes(check.code),
    ))
      assert.equal(check.outcome, "Pass");
    assert.equal(
      result.publication.state,
      { Validate: "Draft", SubmitReview: "InReview", Approve: "Approved", Publish: "Published" }[
        action
      ],
    );
    assert.equal(
      result.publication.validationDecision,
      {
        Validate: "WarningAcknowledgementRequired",
        SubmitReview: "ApprovalPending",
        Approve: "Pass",
        Publish: "Pass",
      }[action],
    );
    operations.push(c);
    results.push(result);
    aggregate = result.aggregate;
    current = result.publication;
    if (action === "Validate" || action === "SubmitReview") {
      if (action === "Validate") {
        const beforeUnacknowledgedReview = await counts(complete.productReference);
        await assert.rejects(execute(command(aggregate, current, "SubmitReview")), {
          code: "CATALOG_LIFECYCLE_CONFLICT",
        });
        assert.deepEqual(await counts(complete.productReference), beforeUnacknowledgedReview);
      }
      const ack = acknowledgement(result, action === "SubmitReview" ? id(4) : actor),
        beforeAck = await counts(complete.productReference),
        acknowledged = await execute(ack),
        afterAck = await counts(complete.productReference);
      assert.equal(acknowledged.status, "Applied");
      assert.deepEqual(acknowledged.receipt.command, ack);
      assert.equal(
        acknowledged.receipt.observation.warningBindingDigest,
        report.warningBindingDigest,
      );
      assert.equal(afterAck.root, beforeAck.root);
      assert.equal(afterAck.operations, beforeAck.operations);
      assert.equal(afterAck.reports, beforeAck.reports);
      assert.equal(afterAck.acknowledgements, beforeAck.acknowledgements + 1);
      assert.equal(afterAck.audit, beforeAck.audit + 1);
      assert.equal(afterAck.outbox, beforeAck.outbox + 1);
      operations.push(ack);
      results.push(acknowledged);
    }
  }
  assert.equal(current.publishedAt, current.occurredAt);
  assert.notEqual(aggregate.draft.versionReference, complete.draft.versionReference);
  const committed = await counts(complete.productReference);
  assert.equal(committed.approvals, 1);
  assert.equal(committed.reports, 4);
  assert.equal(committed.contents, 1);
  assert.equal(committed.acknowledgements, 2);
  assert(businessReads >= 5);
  for (const name of [
    "brand",
    "policy",
    "scope-history",
    "stores",
    "variant",
    "tax",
    "registry",
    "media",
    "history",
    "menu",
    "bundle",
    "availability",
    "recipe",
    "recipeInventory",
    "inventory",
    "pricing",
    "priceBook",
    "optionPrice",
    "promotion",
    "businessPolicy",
  ])
    for (const action of [
      "Validate",
      "SubmitReview",
      "Approve",
      "Publish",
      "AcknowledgeProductPublicationWarnings",
    ])
      assert(
        actionsSeen.get(name)?.has(action),
        "Missing actual held source action: " + name + "/" + action,
      );
  mode = "replay";
  freshHolds = 0;
  const previousBusinessReads = businessReads;
  overrideTime = plus(now(), 60000);
  for (const [index, c] of operations.entries())
    assert.deepEqual(await execute(c), { ...results[index], status: "Replayed" });
  assert.equal(freshHolds, 0);
  assert.equal(businessReads, previousBusinessReads);
  assert.deepEqual(await counts(complete.productReference), committed);
  overrideTime = null;
  mode = "normal";

  const rollbackProduct = await createProduct(true);
  for (const fault of ["late-policy-denial", "later-final-expiry"]) {
    const before = await counts(rollbackProduct.productReference);
    mode = fault;
    tentative = null;
    await assert.rejects(execute(command(rollbackProduct, null)), {
      code:
        fault === "late-policy-denial"
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    assert(tentative);
    assert.equal(tentative.root, before.root + 1);
    assert.equal(tentative.reports, before.reports + 1);
    assert(tentative.audit > before.audit);
    assert(tentative.outbox > before.outbox);
    overrideTime = null;
    mode = "normal";
    assert.deepEqual(await counts(rollbackProduct.productReference), before);
  }

  // Separate Product and real authenticated HTTP/runtime authority journey.
  // Preserve every controlled-authority assertion above; the new fixture uses
  // actual Session/Permission/FeatureControl readers and the same owning data.
  const runtimeEnvironment = {
    admin,
    role,
    tenant,
    brand,
    storeReference,
    configurationVersionReference,
    expectedBrandVersion,
    policyReference,
    policyVersion,
    transactions,
    reference,
    now,
    createProduct,
    command,
    acknowledgement,
    counts,
    observeSqlSourceTime(value) {
      const sourceTime = Date.parse(value);
      if (Number.isFinite(sourceTime))
        clockAdjustment += Math.max(0, sourceTime - clockMilliseconds());
    },
  };
  await exerciseProductFullPublicationRuntimeHttp(runtimeEnvironment);
  await exerciseProductCurrentAuthoringRuntimeHttp(runtimeEnvironment);
}
