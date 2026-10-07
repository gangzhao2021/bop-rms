import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  parseProductAggregate,
  createPostgresProductDraftStore,
  createPostgresProductLifecycleStore,
  parseCatalogOptionSetEditorContent,
  createPostgresFullOptionSetDraftStore,
  createPostgresFullOptionSetContentSealStore,
  fullOptionSealChecks,
  frozenFullOptionSetContentFields,
  productPublicationCheckCodes,
  applyCatalogProductCandidateValidationV2,
  applyCatalogProductContentPolicyValidationV2,
  parseProductPublicationCommandV2,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  createPostgresProductTaxClassificationRegistryStore,
  planCatalogProductPublicationV2,
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
  projectCatalogProductPublicationReferenceCoverage,
  buildProductVariantIdentityHistory,
  buildCatalogProductPublicationReferenceProvenance,
  deriveCatalogProductPublicationContentIdentity,
} from "../../rms/catalog/src/index.ts";
import { tenantBrandConfigurationRequiredFields } from "../../bop/tenant/src/index.ts";
import { createCurrentProductCandidateUniqueScopeSourceV2 } from "../../../apps/api/src/current-product-candidate-unique-scope-v2.ts";
import { prepareBrandRecipeOverridePublication } from "./brand-recipe-override-publication.mjs";
import { createCurrentProductPublicationOptionSelectionSource } from "../../../apps/api/src/current-product-publication-option-selection.ts";
import { createProductPublicationFrozenFullOptionBindingRuleSource } from "../../../apps/api/src/frozen-full-option-binding-rule-source.ts";

import { createCurrentProductPublicationVariantMappingSource } from "../../../apps/api/src/current-product-publication-variant-mapping.ts";
import { createCurrentProductPublicationContentPolicySource } from "../../../apps/api/src/current-product-publication-content-policy.ts";
import { createCurrentProductPublicationTaxResolutionSource } from "../../../apps/api/src/current-product-publication-tax-resolution.ts";
import { createCurrentProductPublicationScopeSource } from "../../../apps/api/src/current-product-publication-scope.ts";
import { exerciseProductFullPublicationSources } from "./product-full-publication-sources.mjs";

const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/** Real Option Create/seal, Product ReplaceDraft, Published policy/Brand release,
 * retirement coverage, and held joined V2 SQL. Tenant immutable metadata,
 * identities/permission holders, and unrelated validation checks are synthetic.
 * A mechanical Option prerequisite never supplies publication eligibility. */
export async function exerciseProductCurrentValidationV2(env, complete, aggregate) {
  const {
    admin,
    role,
    tenant,
    brand,
    actor,
    policyReference,
    policySource,
    transactions,
    replacementCommand,
    counts,
    id,
    time,
    clock,
    registerBeforeCommit,
  } = env;
  assert.match(role, /^wp2421_retire_[a-f0-9]+$/);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict TO " +
      role,
  );
  await admin.query("GRANT DELETE ON rms_catalog.option_conflict TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot,rms_catalog.option_set_publication_content TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT ON rms_catalog.option_set_authoring_identity TO " + role);
  await admin.query(
    "GRANT EXECUTE ON FUNCTION rms_catalog.option_set_authoring_operation_available(uuid) TO " +
      role,
  );
  await admin.query("GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO " + role);
  await admin.query("GRANT SELECT ON bop_tenant.brand_configuration_version TO " + role);
  clock.set(time(20000));
  const configuration = {
    configurationVersionReference: id(45100),
    brandReference: brand,
    configurationVersion: 1,
    lifecycle: "Published",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA", "fr-CA"],
    mediaThemeReference: null,
    catalogSourceReference: id(45101),
    platformTemplateReference: id(45102),
    overrideAllowedFieldCodes: [],
    hardRequirementFieldCodes: [],
    effectiveFrom: time(20000),
    effectiveUntil: time(86400000),
    supersedesVersionReference: null,
    reasonCode: "SYNTHETIC_CURRENT_V2",
    authoredByReference: actor,
    approvedByReference: id(4),
    approvalEvidenceReference: id(45103),
    publicationReference: id(45104),
    createdAt: time(20000),
    updatedAt: time(20000),
    dataClassification: "ConfigurationMetadata",
  };
  const brandPublication = await prepareBrandRecipeOverridePublication({
    admin,
    role,
    configuration,
    lifecycleReference: id(45105),
    familyReference: id(45106),
    operationBase: 45200,
    id,
    tenantReference: tenant,
  });
  assert.equal(brandPublication.release.releaseId, configuration.publicationReference);

  let referenceSequence = 46000,
    eventSequence = 46500;
  const lease = {
    async holdUntilTransactionCompletes(_tx, input) {
      assert.equal(input.tenantReference, tenant);
      assert.equal(input.brandReference, brand);
      assert.equal(input.actorReference, actor);
      return {
        observedAt: input.observedAt,
        validUntil: new Date(Date.parse(input.observedAt) + 30000).toISOString(),
      };
    },
  };
  const optionAudit = (input, actionCode) => ({
    auditId: id(++eventSequence),
    brandId: brand,
    actor: { type: "User", reference: actor },
    actionCode,
    targetType: "CatalogOptionSet",
    targetId:
      input.result.sourceAggregate?.optionSetReference ??
      input.result.supportedContent.optionSetReference,
    reasonCode: input.reasonCode,
    correlationId: input.operationReference,
    occurredAt: input.occurredAt,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "OPERATIONAL",
    retentionPolicyVersion: 1,
  });
  const option = await createPostgresFullOptionSetDraftStore({
    tenantReference: tenant,
    brandReference: brand,
    actorReference: actor,
    clock: { now: () => clock.now() },
    transactions,
    authority: lease,
    creation: { authority: lease, references: { generate: () => id(++referenceSequence) } },
    audit: { create: (input) => optionAudit(input, "CATALOG_OPTION_SET_CREATE") },
    events: { generateReference: () => id(++eventSequence) },
  }).create({
    internalCode: "SYNTH_CURRENT_V2",
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic fixed choice" },
      localizedDescriptions: {},
      displayStyle: "SingleChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [
        {
          stableCode: "ONE",
          sortOrder: 0,
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: [],
        },
      ],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          stableCode: "ONE",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: clock.now(),
          localDateTime: clock.now().slice(0, 23),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
    },
    operationReference: id(46100),
    occurredAt: clock.now(),
    reasonCode: "INITIAL_CONFIGURATION",
  });
  const { sourceAggregate, ...details } = option.content;
  const sealedInput = parseCatalogOptionSetEditorContent(sourceAggregate, details);
  await createPostgresFullOptionSetContentSealStore({
    tenantReference: tenant,
    brandReference: brand,
    actorReference: actor,
    clock: { now: () => clock.now() },
    transactions,
    authority: {
      async holdUntilTransactionCompletes(tx, input) {
        assert.deepEqual(input.requiredChecks, input.phase === "Apply" ? fullOptionSealChecks : []);
        return lease.holdUntilTransactionCompletes(tx, input);
      },
    },
    readAuthority: lease,
    references: { generateSuccessorVersion: () => id(++referenceSequence) },
    audit: { create: (input) => optionAudit(input, "CATALOG_OPTION_SET_CONTENT_SEALED") },
    events: { generateReference: () => id(++eventSequence) },
  }).seal({
    optionSetReference: sourceAggregate.optionSetReference,
    versionReference: sourceAggregate.draft.versionReference,
    expectedAggregateVersion: 1,
    sourceDigest: sealedInput.sourceDigest,
    contentDigest: sealedInput.contentDigest,
    configurationDigest: sealedInput.configurationDigest,
    operationReference: id(46101),
    occurredAt: clock.now(),
    reasonCode: "CONFIGURATION_EDIT",
  });
  const binding = {
    bindingReference: id(46110),
    optionSetReference: sourceAggregate.optionSetReference,
    optionSetVersionReference: sourceAggregate.draft.versionReference,
    purpose: "CUSTOMIZATION",
    sortOrder: 0,
    enabledOptionReferences: [sourceAggregate.draft.options[0].optionReference],
    defaultSelections: [
      { optionReference: sourceAggregate.draft.options[0].optionReference, quantity: 1 },
    ],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: [],
    storeOverrideAllowed: false,
  };
  const next = parseProductAggregate({
    ...aggregate,
    aggregateVersion: aggregate.aggregateVersion + 1,
    updatedAt: clock.now(),
    draft: {
      ...aggregate.draft,
      updatedAt: clock.now(),
      optionBindings: [binding],
      editorContent: {
        ...aggregate.draft.editorContent,
        optionRules: [
          {
            bindingReference: binding.bindingReference,
            versionResolution: "Pinned",
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          },
        ],
      },
    },
  });
  const productOptions = {
    brandReference: brand,
    transactions,
    authorize: async () => true,
    editorContentAuthority: {
      async holdUntilTransactionCompletes(_tx, input) {
        assert.equal(input.aggregate.productReference, next.productReference);
        assert.equal(input.aggregate.brandReference, brand);
        assert(
          [aggregate.aggregateVersion, next.aggregateVersion].includes(
            input.aggregate.aggregateVersion,
          ),
        );
      },
    },
  };
  await createPostgresProductDraftStore(productOptions).commit({
    record: {
      action: "ReplaceDraft",
      operationReference: id(46200),
      operationIntentHash: sha256Hex("synthetic current V2 pinned Option draft"),
      aggregate: next,
    },
    expectedAggregateVersion: aggregate.aggregateVersion,
    audit: {
      auditId: id(46201),
      brandId: brand,
      actor: { type: "User", reference: actor },
      actionCode: "CATALOG_PRODUCT_REPLACEDRAFT",
      targetType: "CatalogProduct",
      targetId: next.productReference,
      correlationId: id(46200),
      occurredAt: clock.now(),
      reasonCode: "SYNTHETIC_CURRENT_V2",
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    },
  });
  assert.deepEqual(
    await createPostgresProductLifecycleStore(productOptions).load(next.productReference),
    next,
  );

  clock.set(time(30000));
  const command = replacementCommand(complete, next, 0, "Validate", 46300, { selectorIndex: 1 });
  let activeTx,
    fault = "normal",
    consumerFinished = false,
    advanced = false;
  let optionHolds = 0,
    brandReads = 0,
    brandChecks = 0,
    historyReads = 0;
  const source = createCurrentProductCandidateUniqueScopeSourceV2({
    tenantReference: tenant,
    brandReference: brand,
    actorReference: actor,
    clock: { now: () => clock.now() },
    policySource,
    candidateAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, activeTx);
        assert.equal(input.productReference, command.productReference);
        assert.equal(input.actorReference, actor);
        assert(input.requiredFields.includes("editorContent"));
        assert(input.requiredFields.includes("replacementIntentDigest"));
        if (consumerFinished && fault === "candidate-denial")
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
    optionAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, activeTx);
        assert.deepEqual(input.command, command);
        assert.equal(input.originalIntentDigest, hash(command));
        assert.equal(input.replacementIntentDigest, command.replacementIntentDigest);
        assert.equal(input.optionSetReference, binding.optionSetReference);
        assert.equal(input.versionReference, binding.optionSetVersionReference);
        assert.deepEqual(input.requiredFields, frozenFullOptionSetContentFields);
        optionHolds++;
        if ((consumerFinished && fault === "option-denial") || fault === "initial-option-denial")
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        // Never renew this original shorter lease during final authority checks.
        return { observedAt: input.observedAt, validUntil: time(34000) };
      },
    },
    validationAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, activeTx);
        assert.deepEqual(input.command, command);
        if (!advanced) {
          clock.set(time(30001));
          advanced = true;
        }
      },
    },
    historyAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, activeTx);
        assert.equal(input.productReference, command.productReference);
        assert(input.requiredFields.includes("scopeRetirements"));
        historyReads++;
      },
    },
    tenantAuthority: {
      async withCurrentBrandReferenceRead(request, work) {
        assert.equal(request.originalIntentDigest, hash(command));
        return work();
      },
      async isCurrent(actual, request) {
        assert.equal(actual, activeTx);
        assert.equal(request.originalIntentDigest, hash(command));
        return true;
      },
    },
    contentPolicy: {
      configurationVersionReference: configuration.configurationVersionReference,
      expectedBrandVersion: 1,
      brandAuthority: {
        async withCurrentContentRead(request, fields, work) {
          assert.equal(request.originalIntentDigest, hash(command));
          assert.equal(request.purposeCode, "CATALOG_PRODUCT_CONTENT");
          assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
          brandReads++;
          return work();
        },
        async isCurrent(actual, request, fields) {
          assert.equal(actual, activeTx);
          assert.equal(request.originalIntentDigest, hash(command));
          assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
          brandChecks++;
          return !(consumerFinished && fault === "brand-denial");
        },
      },
    },
  });
  const read = (work) =>
    transactions.run(async (tx) => {
      activeTx = tx;
      return source.withCurrentAssessment(tx, { command, policyReference, policyVersion: 1 }, work);
    });
  const proof = await read(async (assessment) => {
    assert.equal(assessment.currentCandidate, "Bound");
    assert.equal(assessment.completeContent, "Present");
    assert.equal(assessment.originalIntentDigest, hash(command));
    assert.equal(assessment.replacementIntentDigest, command.replacementIntentDigest);
    assert.equal(assessment.aggregateVersion, next.aggregateVersion);
    assert.equal(assessment.contentDigest, command.contentDigest);
    assert.equal(assessment.configurationDigest, command.configurationDigest);
    assert.equal(assessment.candidateObservedAt, time(30000));
    assert.equal(assessment.candidateValidUntil, time(60000));
    assert.equal(assessment.observedAt, time(30001));
    assert.equal(assessment.validUntil, time(34000));
    assert.deepEqual(assessment.check, { code: "UniqueScope", outcome: "Pass" });
    assert.equal(assessment.skuPrerequisite, "NoActiveMember");
    assert.equal(assessment.optionRulePrerequisite, "NoMechanicalContradiction");
    const options = assessment.optionRulesAssessment;
    assert.equal(options.profile, "CurrentProductCandidateOptionRulesV2");
    assert.equal(options.originalIntentDigest, hash(command));
    assert.equal(options.replacementIntentDigest, command.replacementIntentDigest);
    assert.equal(options.aggregateVersion, next.aggregateVersion);
    assert.equal(options.candidateObservedAt, time(30000));
    assert.equal(options.candidateValidUntil, time(60000));
    assert.equal(options.bindingCount, 1);
    assert.equal(options.bindings[0].bindingDigest, hash(binding));
    assert.equal(options.bindings[0].rootOptionSetReference, binding.optionSetReference);
    assert.equal(options.bindings[0].rootVersionReference, binding.optionSetVersionReference);
    assert.match(options.bindings[0].graphDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(options.bindings[0].rules.status, "Satisfiable");
    assert.equal(options.validUntil, time(34000));
    assert.equal(options.publishValidation, "Incomplete");
    assert.equal(options.referenceEligibility, "NotEvaluated");
    const content = assessment.contentPolicyAssessment;
    assert.equal(content.profile, "CatalogProductContentPolicyAssessmentV2");
    assert.equal(content.originalIntentDigest, hash(command));
    assert.equal(content.replacementIntentDigest, command.replacementIntentDigest);
    assert.equal(
      content.brandSource.configurationVersionReference,
      configuration.configurationVersionReference,
    );
    assert.equal(
      content.brandSource.currentPublicationReference,
      brandPublication.release.releaseId,
    );
    assert.equal(content.policyReference, policyReference);
    assert.equal(content.policyContentDigest, assessment.policyContentDigest);
    assert.equal(content.decision, "PassForAssessedRules");
    assert.equal(content.publishValidation, "Incomplete");
    assert.equal(content.mediaReadiness, "NotEvaluated");
    // This complete12 receipt deliberately retains missing SKU and independent Tax
    // errors. The real joined facts may only merge their owning necessary checks.
    const preliminary = {
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: command.replacementIntentDigest,
      evidenceReference: id(46301),
      productAggregateVersion: command.expectedProductAggregateVersion,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      scopeDigest: hash(command.scopeSet),
      periodDigest: hash(command.effectivePeriod),
      policyReference,
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome:
          code === "ApprovalPolicy"
            ? "Pending"
            : ["PublishableSku", "TaxResolution", "HardErrorsCleared"].includes(code)
              ? "HardError"
              : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: time(30000),
      validUntil: time(60000),
    };
    const candidateMerged = applyCatalogProductCandidateValidationV2(
      command,
      preliminary,
      {
        profile: "CatalogProductCandidateValidationBindingV2",
        scopeAssessment: assessment.scopeAssessment,
        candidateObservedAt: assessment.candidateObservedAt,
        candidateValidUntil: assessment.candidateValidUntil,
        validUntil: assessment.validUntil,
        skuPrerequisite: assessment.skuPrerequisite,
        internalCodeCheck: assessment.internalCodeCheck,
        variantMappingPrerequisite: assessment.variantMappingPrerequisite,
        optionSelectionPrerequisite: assessment.optionSelectionPrerequisite,
        optionRulePrerequisite: assessment.optionRulePrerequisite,
      },
      clock.now(),
    );
    const merged = applyCatalogProductContentPolicyValidationV2(
      command,
      candidateMerged,
      content,
      clock.now(),
    );
    for (const code of ["PublishableSku", "TaxResolution", "HardErrorsCleared"])
      assert.equal(merged.checks.find((check) => check.code === code).outcome, "HardError");
    assert.equal(merged.checks.find((check) => check.code === "ApprovalPolicy").outcome, "Pending");
    assert.equal(merged.evidenceReference, preliminary.evidenceReference);
    assert.equal(merged.replacementIntentDigest, command.replacementIntentDigest);
    assert.equal(merged.validUntil, time(34000));
    return assessment;
  });
  assert.equal(proof.optionRulesAssessment.bindingCount, 1);
  assert(optionHolds > 1 && brandReads > 0 && brandChecks > 1 && historyReads > 1);

  fault = "initial-option-denial";
  clock.set(time(30000));
  advanced = false;
  let consumers = 0;
  await assert.rejects(
    read(async () => {
      consumers++;
    }),
    { code: "CATALOG_PERMISSION_DENIED" },
  );
  assert.equal(consumers, 0);
  for (const selected of [
    "candidate-denial",
    "option-denial",
    "brand-denial",
    "expiry",
    "clock-rollback",
  ]) {
    fault = selected;
    clock.set(time(30000));
    advanced = false;
    consumerFinished = false;
    const before = await counts(command.productReference);
    const row = (
      await admin.query("SELECT updated_at FROM rms_catalog.product WHERE product_id=$1", [
        command.productReference,
      ])
    ).rows[0];
    consumers = 0;
    let tentativeUpdate, tentativeRow, updateFailure, observedError;
    try {
      await read(async () => {
        consumers++;
        try {
          tentativeUpdate = await activeTx.query(
            "UPDATE rms_catalog.product SET updated_at=$1 WHERE product_id=$2",
            [time(30002), command.productReference],
          );
          tentativeRow = (
            await activeTx.query("SELECT updated_at FROM rms_catalog.product WHERE product_id=$1", [
              command.productReference,
            ])
          ).rows[0];
        } catch (error) {
          updateFailure = { code: error.code, name: error.name };
          throw error;
        }
        consumerFinished = true;
        if (selected === "expiry") clock.set(time(34000));
        if (selected === "clock-rollback") clock.set(time(30000));
      });
    } catch (error) {
      observedError = error;
    }
    assert.equal(updateFailure, undefined, selected + " must execute its tentative UPDATE");
    assert.equal(
      observedError?.code,
      selected === "candidate-denial" || selected === "option-denial"
        ? "CATALOG_PERMISSION_DENIED"
        : "CATALOG_DEPENDENCY_UNAVAILABLE",
      selected,
    );
    assert.equal(consumers, 1);
    // Assert outside the caught consumer so the test cannot impersonate its
    // expected refusal. Prove a real tentative write before claiming rollback.
    // A separate read is required by the table's conditional INSTEAD rule.
    assert.equal(tentativeUpdate?.rowCount, 1);
    assert.equal(new Date(tentativeRow.updated_at).toISOString(), time(30002));
    assert.deepEqual(await counts(command.productReference), before);
    assert.deepEqual(
      (
        await admin.query("SELECT updated_at FROM rms_catalog.product WHERE product_id=$1", [
          command.productReference,
        ])
      ).rows[0],
      row,
    );
  }

  // Real sealed Option content, now consumed under each actual request identity.
  // Command metadata and permission collaborators are synthetic; this does not
  // claim a Product command, Ack or System activation has been committed here.
  clock.set(time(30000));
  let finishedPinned = false,
    pinnedMode = "normal",
    pinnedReads = 0;
  const pinnedAuthority = {
    async holdUntilTransactionCompletes(tx, input) {
      assert.equal(tx, activeTx);
      assert.equal(input.originalIntentDigest, hash(input.command));
      assert.equal(input.actorKind, input.command.actorKind);
      assert.equal(input.actorReference, input.command.actorReference);
      assert.equal(input.purposeCode, input.command.purposeCode);
      assert.equal(input.optionSetReference, binding.optionSetReference);
      assert.equal(input.versionReference, binding.optionSetVersionReference);
      assert.equal(input.requestObservedAt, time(30000));
      assert.equal(input.requestValidUntil, time(35000));
      pinnedReads++;
      if (finishedPinned && pinnedMode === "late-denial")
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return { observedAt: input.observedAt, validUntil: time(34000) };
    },
  };
  const selection = (work) =>
    transactions.run(async (tx) => {
      activeTx = tx;
      const source = createCurrentProductPublicationOptionSelectionSource({
        transaction: tx,
        clock: { now: () => clock.now() },
        authority: pinnedAuthority,
        registerBeforeCommit,
      });
      return source.withPublication(
        { command, aggregate: next, current: null, content: null, observedAt: time(30000) },
        time(35000),
        work,
      );
    });
  const pinned = await selection(async (result) => result);
  assert.deepEqual(pinned.check, { code: "OptionSelection", outcome: "Pass" });
  assert.equal(pinned.findings.length, 0);
  assert.equal(pinned.sources[0].sourceCode, "PINNED_OPTION_RULES");
  assert.equal(pinned.validUntil, time(34000));
  assert(pinnedReads > 2);
  const syntheticRequests = [
    parseProductPublicationCommandV2({
      ...command,
      action: "Publish",
      expectedPublicationVersion: 1,
      operationReference: id(46600),
      successorDraftVersionReference: id(46601),
    }),
    parseProductPublicationCommandV2({
      ...command,
      action: "ActivateScheduled",
      actorKind: "System",
      actorReference: id(46602),
      expectedPublicationVersion: 1,
      operationReference: id(46603),
      scheduleReference: id(46604),
      successorDraftVersionReference: id(46605),
    }),
    parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      operationReference: id(46606),
      productReference: command.productReference,
      versionReference: command.versionReference,
      expectedProductAggregateVersion: next.aggregateVersion,
      reportOperationReference: id(46607),
      reportDigest: hash("synthetic original report locator"),
      warningBindingDigest: hash("synthetic warnings"),
      warningCodes: ["ChangeImpact"],
      reasonCode: "SYNTHETIC_PINNED_READ",
      occurredAt: time(30000),
    }),
  ];
  for (const request of syntheticRequests) {
    await transactions.run(async (tx) => {
      activeTx = tx;
      const graph = createProductPublicationFrozenFullOptionBindingRuleSource({
        command: request,
        observedAt: time(30000),
        validUntil: time(35000),
        clock: { now: () => clock.now() },
        authority: pinnedAuthority,
        registerBeforeCommit,
        defaultQuantityAssessment: "Prerequisites",
      });
      await graph.withPinnedAssessment(tx, binding, async (proof) => {
        assert.equal(proof.rules.status, "Satisfiable");
        assert.equal(proof.validUntil, time(34000));
      });
    });
  }
  for (const fault of ["late-denial", "later-guard-expiry"]) {
    pinnedMode = fault;
    finishedPinned = false;
    clock.set(time(30000));
    const before = await counts(command.productReference);
    let updated = 0,
      readBack = null,
      expectedTx;
    await assert.rejects(
      selection(async () => {
        expectedTx = activeTx;
        updated = (
          await activeTx.query("UPDATE rms_catalog.product SET updated_at=$1 WHERE product_id=$2", [
            time(30002),
            command.productReference,
          ])
        ).rowCount;
        readBack = (
          await activeTx.query("SELECT updated_at FROM rms_catalog.product WHERE product_id=$1", [
            command.productReference,
          ])
        ).rows[0];
        if (fault === "late-denial") finishedPinned = true;
        else
          await registerBeforeCommit(
            activeTx,
            async () => {
              assert.equal(activeTx, expectedTx);
              clock.set(time(34000));
            },
            () => undefined,
          );
      }),
      {
        code:
          fault === "late-denial" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
      },
    );
    assert.equal(updated, 1);
    assert.equal(new Date(readBack.updated_at).toISOString(), time(30002));
    assert.deepEqual(await counts(command.productReference), before);
    assert.equal(
      new Date(
        (
          await admin.query("SELECT updated_at FROM rms_catalog.product WHERE product_id=$1", [
            command.productReference,
          ])
        ).rows[0].updated_at,
      ).toISOString(),
      next.updatedAt,
    );
  }
  // Actual three-owner acquisition around one consumer. Full command/report
  // metadata and IAM collaborators below are synthetic, as in the preceding
  // source cases; no additional Product publication or Ack is claimed.
  await admin.query(
    "GRANT SELECT,INSERT ON rms_catalog.product_tax_classification_registry_record TO " + role,
  );
  clock.set(time(30000));
  const taxRegistry = {
    profile: "CatalogProductTaxClassificationRegistryV1",
    tenantReference: tenant,
    brandReference: brand,
    registryReference: id(46800),
    versionReference: id(46801),
    registryVersion: 1,
    defaultLocale: "en-CA",
    previousSnapshotDigest: null,
    registeredAt: time(30000),
    definitions: [
      {
        classificationReference: id(46802),
        code: "SYNTHETIC_STANDARD",
        localizedNames: { "en-CA": "Synthetic classification" },
        lifecycle: "Active",
      },
    ],
    defaultClassificationReference: id(46802),
  };
  await createPostgresProductTaxClassificationRegistryStore({
    tenantReference: tenant,
    brandReference: brand,
    actorReference: actor,
    actorKind: "User",
    clock: { now: () => clock.now() },
    transactions,
    registerBeforeCommit,
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(input.tenantReference, tenant);
        assert.equal(input.brandReference, brand);
        assert.equal(input.actorReference, actor);
        assert.equal(input.actorKind, "User");
      },
    },
    audit: {
      create(c) {
        return {
          auditId: id(46804),
          brandId: brand,
          actor: { type: "User", reference: actor },
          actionCode: "CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED",
          targetType: "CatalogTaxClassificationRegistry",
          targetId: taxRegistry.registryReference,
          reasonCode: c.reasonCode,
          correlationId: c.operationReference,
          occurredAt: c.occurredAt,
          sourceChannel: "API",
          dataClassification: "Confidential",
          retentionPolicyCode: "CATALOG_CONFIGURATION",
          retentionPolicyVersion: 1,
        };
      },
    },
  }).execute({
    purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
    tenantReference: tenant,
    brandReference: brand,
    actorReference: actor,
    actorKind: "User",
    operationReference: id(46803),
    expectedRegistryVersion: 0,
    occurredAt: taxRegistry.registeredAt,
    reasonCode: "SYNTHETIC_CLASSIFICATION",
    registry: taxRegistry,
  });
  // Binding-only historical report, using the actual Draft content. These
  // declared synthetic checks never stand in for results of the real sources.
  const reportCommand = parseProductPublicationCommandV2({
    ...command,
    operationReference: id(46810),
    expectedProductAggregateVersion: next.aggregateVersion - 1,
  });
  const syntheticValidation = {
    profile: "CatalogProductPublicationValidationV2",
    replacementIntentDigest: reportCommand.replacementIntentDigest,
    evidenceReference: id(46811),
    productAggregateVersion: reportCommand.expectedProductAggregateVersion,
    contentDigest: reportCommand.contentDigest,
    configurationDigest: reportCommand.configurationDigest,
    scopeDigest: hash(reportCommand.scopeSet),
    periodDigest: hash(reportCommand.effectivePeriod),
    policyReference,
    policyVersion: 1,
    approvalPolicy: "Required",
    checks: productPublicationCheckCodes.map((code) => ({
      code,
      outcome: code === "ApprovalPolicy" ? "Pending" : code === "ChangeImpact" ? "Warning" : "Pass",
    })),
    warningAcknowledgement: null,
    checkedAt: time(30000),
    validUntil: time(35000),
  };
  const metadataHead = planCatalogProductPublicationV2(reportCommand, null, {
    now: time(30000),
    productAggregateVersion: reportCommand.expectedProductAggregateVersion,
    contentDigest: reportCommand.contentDigest,
    configurationDigest: reportCommand.configurationDigest,
    scopeDigest: hash(reportCommand.scopeSet),
    periodDigest: hash(reportCommand.effectivePeriod),
    validation: syntheticValidation,
    approval: null,
    reviewReference: null,
    replacement: null,
  });
  const metadataReport = buildCatalogProductPublicationValidationReport({
    command: reportCommand,
    publication: metadataHead,
    validation: syntheticValidation,
    details: parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SYNTHETIC_GAP",
          outcome: "Warning",
          subjectReference: next.productReference,
          reasonCode: "SYNTHETIC",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC_SOURCE",
          sourceDigest: hash("synthetic report"),
          generation: null,
          relevantReferenceDigest: hash("synthetic reference"),
          observedAt: time(30000),
          validUntil: time(35000),
        },
      ],
    }),
    recordedAt: time(30000),
  });
  let qualificationFault = "normal",
    qualificationFinished = false,
    timeOverride = null;
  const seenQualification = [];
  let qualificationStage = "initial",
    guardEvidence,
    historyDiagnostic;
  // The isolated PostgreSQL server may run on a VM with a different wall
  // clock. Keep this fixture in its actual database clock domain; monotonic
  // elapsed time still consumes the original five-second source lease.
  const databaseClock = await admin.query(
      "SELECT date_trunc('milliseconds',clock_timestamp()) observed_at",
    ),
    databaseAnchor = databaseClock.rows[0].observed_at.getTime(),
    monotonicAnchor = performance.now();
  let clockAdjustment = 0;
  const clockMilliseconds = () =>
      databaseAnchor + performance.now() - monotonicAnchor + clockAdjustment,
    qualificationClock = {
      now: () => timeOverride ?? new Date(clockMilliseconds()).toISOString(),
    };
  const runQualification = async (kind, consume = async (value) => value) => {
    const observedAt = qualificationClock.now(),
      validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
    const request =
      kind === "Ack"
        ? parseCatalogProductPublicationWarningAcknowledgementCommand({
            profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
            purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
            action: "AcknowledgeProductPublicationWarnings",
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            actorKind: "User",
            operationReference: id(46820),
            productReference: next.productReference,
            versionReference: next.draft.versionReference,
            expectedProductAggregateVersion: next.aggregateVersion,
            reportOperationReference: metadataReport.operationReference,
            reportDigest: metadataReport.digest,
            warningBindingDigest: metadataReport.warningBindingDigest,
            warningCodes: ["ChangeImpact"],
            reasonCode: "SYNTHETIC_SOURCE_READ",
            occurredAt: observedAt,
          })
        : parseProductPublicationCommandV2({
            ...command,
            action: kind,
            occurredAt: observedAt,
            // The earlier fixture period ended roughly an hour ago. This is a
            // new Validate intent for the same real, unretired Store selector;
            // unlike the metadata-only controls it must qualify at real time.
            effectivePeriod:
              kind === "Validate"
                ? {
                    timeZone: "UTC",
                    effectiveFrom: {
                      instant: observedAt,
                      localDateTime: observedAt.slice(0, -1),
                      utcOffsetMinutes: 0,
                    },
                    effectiveUntil: null,
                  }
                : command.effectivePeriod,
            operationReference: id(46821),
            actorKind: kind === "ActivateScheduled" ? "System" : "User",
            actorReference: kind === "ActivateScheduled" ? id(46822) : actor,
            expectedPublicationVersion: kind === "Validate" ? 0 : metadataHead.publicationVersion,
            successorDraftVersionReference: ["Publish", "ActivateScheduled"].includes(kind)
              ? id(46823)
              : null,
            scheduleReference: kind === "ActivateScheduled" ? id(46824) : null,
          });
    const input =
      kind === "Ack"
        ? {
            command: request,
            aggregate: next,
            current: metadataHead,
            report: metadataReport,
            observedAt,
            validUntil,
          }
        : {
            command: request,
            aggregate: next,
            current: kind === "Validate" ? null : metadataHead,
            content: null,
            observedAt,
          };
    qualificationStage = "variant";
    guardEvidence = { sources: [], laterGuard: false };
    return transactions.run(async (tx) => {
      activeTx = tx;
      const underlyingQuery = tx.query.bind(tx);
      let historyRequest, historySample;
      // Diagnose only after failure; extra parsing in the live lease would
      // change the timing of the source being tested. Never report source data.
      historyDiagnostic = () => {
        const evidence = { queried: historySample !== undefined };
        if (!historySample) return evidence;
        const { raw, returnedAt } = historySample;
        try {
          buildProductVariantIdentityHistory(raw, brand, {
            productReference: request.productReference,
            expectedAggregateVersion: request.expectedProductAggregateVersion,
            originalIntentDigest: hash(request),
          });
          evidence.oldVariant = true;
          const last = raw.history.at(-1);
          evidence.exactRoot = last.snapshotDigest === hash(next);
          evidence.sameVersion = last.aggregate.draft.versionReference === request.versionReference;
          const identity = deriveCatalogProductPublicationContentIdentity(last.aggregate);
          evidence.sameContent = identity.contentDigest === command.contentDigest;
          evidence.sameConfiguration = identity.configurationDigest === command.configurationDigest;
          evidence.sourceAfterRequest = raw.observedAt >= observedAt;
          evidence.sourceBeforeClock = raw.observedAt <= returnedAt;
          buildCatalogProductPublicationReferenceProvenance(raw, historyRequest, raw.observedAt);
          evidence.provenance = true;
        } catch {
          evidence.parseFailed = true;
        }
        return evidence;
      };
      tx.query = async (sql, values) => {
        const result = await underlyingQuery(sql, values);
        for (const row of result.rows) {
          const sourceTime = Date.parse(row.source?.observedAt);
          if (Number.isFinite(sourceTime))
            clockAdjustment += Math.max(0, sourceTime - clockMilliseconds());
        }
        if (sql.includes("jsonb_build_object('aggregateVersion',p.aggregate_version,'observedAt'"))
          historySample = { raw: result.rows[0]?.source, returnedAt: qualificationClock.now() };
        return result;
      };
      const sourceRegister = (name) => async (actual, guard, finalAssert) => {
        const evidence = { name, asyncReturned: false, finalError: null };
        guardEvidence.sources.push(evidence);
        return registerBeforeCommit(
          actual,
          async () => {
            const result = await guard();
            evidence.asyncReturned = true;
            return result;
          },
          () => {
            try {
              return finalAssert();
            } catch (error) {
              evidence.finalError = error;
              throw error;
            }
          },
        );
      };
      if (
        ["variant", "brand", "policy", "tax", "scope-history", "scope-stores"].includes(
          qualificationFault,
        )
      )
        await registerBeforeCommit(
          tx,
          async () => {
            qualificationFinished = true;
          },
          () => undefined,
        );
      const assertAuthority = (actual, value, source) => {
        assert.equal(actual, tx);
        assert.deepEqual(value.command, request);
        assert.equal(value.originalIntentDigest, hash(request));
        assert.equal(value.actorKind, request.actorKind);
        seenQualification.push({ source, action: request.action, kind: request.actorKind });
        if (qualificationFinished && qualificationFault === source)
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
      };
      const variant = createCurrentProductPublicationVariantMappingSource({
        transaction: tx,
        clock: qualificationClock,
        registerBeforeCommit: sourceRegister("variant"),
        authority: {
          async holdUntilTransactionCompletes(actual, value) {
            historyRequest = value.request;
            assertAuthority(actual, value, "variant");
          },
        },
      });
      const content = createCurrentProductPublicationContentPolicySource({
        transaction: tx,
        clock: qualificationClock,
        registerBeforeCommit: sourceRegister("content"),
        configurationVersionReference: configuration.configurationVersionReference,
        expectedBrandVersion: 1,
        policyReference,
        policyVersion: 1,
        brandAuthority: {
          async withCurrentContentRead(actual, value, work) {
            assertAuthority(actual, value, "brand");
            return work();
          },
          async isCurrent(actual, value) {
            assertAuthority(actual, value, "brand");
            return true;
          },
        },
        policyAuthority: {
          async holdUntilTransactionCompletes(actual, value) {
            assertAuthority(actual, value, "policy");
          },
        },
      });
      const tax = createCurrentProductPublicationTaxResolutionSource({
        transaction: tx,
        clock: qualificationClock,
        registerBeforeCommit: sourceRegister("tax"),
        authority: {
          async holdUntilTransactionCompletes(actual, value) {
            assertAuthority(actual, value, "tax");
          },
        },
      });
      const scope = createCurrentProductPublicationScopeSource({
        transaction: tx,
        clock: qualificationClock,
        registerBeforeCommit: sourceRegister("scope"),
        historyAuthority: {
          async holdUntilTransactionCompletes(actual, value) {
            assertAuthority(actual, value, "scope-history");
          },
        },
        tenantAuthority: {
          async withCurrentBrandReferenceRead(actual, value, work) {
            assertAuthority(actual, value, "scope-stores");
            return work();
          },
          async isCurrent(actual, value) {
            assertAuthority(actual, value, "scope-stores");
            return true;
          },
        },
      });
      const call = (source, callback) =>
        kind === "Ack"
          ? source.withAcknowledgement(input, callback)
          : source.withPublication(input, validUntil, callback);
      return call(variant, (v) => {
        qualificationStage = "content";
        return call(content, (c) => {
          qualificationStage = "tax";
          return call(tax, async (t) => {
            qualificationStage = "consumer";
            assert.equal(v.originalIntentDigest, hash(request));
            assert.equal(c.originalIntentDigest, hash(request));
            assert.equal(t.originalIntentDigest, hash(request));
            assert.deepEqual(v.check, { code: "VariantMapping", outcome: "Pass" });
            assert.deepEqual(c.check, { code: "DefaultLocaleName", outcome: "Pass" });
            assert.deepEqual(t.check, { code: "TaxResolution", outcome: "Pass" });
            const deliver = (scope) =>
              consume({
                variant: v,
                content: c,
                tax: t,
                scope,
                observedAt,
                validUntil,
                tx,
              });
            // This fixture's other action/report heads are explicitly metadata
            // controls, not persisted heads. Only Validate matches the actual
            // current SQL root/head and can qualify against complete coverage.
            if (kind !== "Validate") return deliver(null);
            qualificationStage = "scope";
            return scope.withPublication(input, validUntil, c.policy, async (s) => {
              const references = projectCatalogProductPublicationReferenceCoverage(
                v.referenceProvenance.request,
                v.referenceProvenance,
                s.coverage,
                qualificationClock.now(),
              );
              const originalReferences = references.entries.find(
                (entry) =>
                  entry.publication.versionReference ===
                  complete.original.publication.versionReference,
              );
              assert(originalReferences);
              assert.equal(
                originalReferences.sourceOperation.resultAggregateVersion,
                originalReferences.publication.productAggregateVersion,
              );
              assert.equal(
                originalReferences.resultOperation.resultAggregateVersion,
                originalReferences.publication.productAggregateVersion + 1,
              );
              assert.equal(
                originalReferences.referenceConfiguration.versionReference,
                complete.original.publication.versionReference,
              );
              assert.notEqual(
                originalReferences.referenceConfiguration.versionReference,
                originalReferences.resultOperation.versionReference,
              );
              assert.equal(originalReferences.referenceConfiguration.bindings.length, 0);
              assert(next.draft.optionBindings.length > 0);
              assert.equal(originalReferences.retirements.length, 1);
              assert.equal(s.assessment.originalIntentDigest, hash(request));
              assert.equal(s.coverage.aggregateVersion, next.aggregateVersion);
              assert.deepEqual(s.check, { code: "UniqueScope", outcome: "Pass" });
              assert.deepEqual(
                s.assessment.activeSkuReferences,
                next.draft.skus
                  .filter((sku) => sku.lifecycle === "Active")
                  .map((sku) => sku.skuReference)
                  .sort(),
              );
              assert.equal(
                s.publishableSkuCheck.outcome,
                next.draft.skus.some((sku) => sku.lifecycle === "Active") ? "Pass" : "HardError",
              );
              qualificationStage = "consumer";
              return deliver(s);
            });
          });
        });
      });
    });
  };
  for (const kind of ["Validate", "Publish", "ActivateScheduled", "Ack"]) {
    qualificationFinished = false;
    timeOverride = null;
    try {
      await runQualification(kind);
    } catch (error) {
      throw new Error(
        "Actual qualification failed at " +
          kind +
          "/" +
          qualificationStage +
          " " +
          JSON.stringify(historyDiagnostic()),
        {
          cause: error,
        },
      );
    }
  }
  for (const source of ["variant", "brand", "policy", "tax"])
    for (const action of [
      "Validate",
      "Publish",
      "ActivateScheduled",
      "AcknowledgeProductPublicationWarnings",
    ])
      assert(seenQualification.some((value) => value.source === source && value.action === action));
  for (const fault of [
    "variant",
    "brand",
    "policy",
    "tax",
    "scope-history",
    "scope-stores",
    "later-guard-expiry",
  ]) {
    qualificationFault = fault;
    qualificationFinished = false;
    timeOverride = null;
    const before = await counts(command.productReference);
    let updated = 0,
      actualTime = null,
      expectedTime;
    await assert.rejects(
      runQualification("Validate", async ({ tx, observedAt, validUntil }) => {
        expectedTime = observedAt;
        updated = (
          await tx.query("UPDATE rms_catalog.product SET updated_at=$1 WHERE product_id=$2", [
            observedAt,
            next.productReference,
          ])
        ).rowCount;
        actualTime = new Date(
          (
            await tx.query("SELECT updated_at FROM rms_catalog.product WHERE product_id=$1", [
              next.productReference,
            ])
          ).rows[0].updated_at,
        ).toISOString();
        if (fault === "later-guard-expiry")
          await registerBeforeCommit(
            tx,
            async () => {
              guardEvidence.laterGuard = true;
              timeOverride = validUntil;
            },
            () => undefined,
          );
        // A host guard registered before source acquisition withdraws permission
        // only after their callbacks return, so refusal must survive outer COMMIT.
      }),
      {
        code:
          fault === "later-guard-expiry"
            ? "CATALOG_DEPENDENCY_UNAVAILABLE"
            : "CATALOG_PERMISSION_DENIED",
      },
    );
    assert.equal(updated, 1);
    assert.equal(actualTime, expectedTime);
    if (fault === "later-guard-expiry") {
      assert.equal(guardEvidence.laterGuard, true);
      assert.equal(guardEvidence.sources.length, 5);
      assert(guardEvidence.sources.every((evidence) => evidence.asyncReturned));
      assert(guardEvidence.sources[0].finalError instanceof CatalogError);
      assert.equal(guardEvidence.sources[0].finalError.code, "CATALOG_DEPENDENCY_UNAVAILABLE");
    }
    assert.deepEqual(await counts(command.productReference), before);
    assert.equal(
      new Date(
        (
          await admin.query("SELECT updated_at FROM rms_catalog.product WHERE product_id=$1", [
            next.productReference,
          ])
        ).rows[0].updated_at,
      ).toISOString(),
      next.updatedAt,
    );
  }
  await exerciseProductFullPublicationSources({
    admin,
    role,
    tenant,
    brand,
    actor,
    storeReference: env.storeA,
    configurationVersionReference: configuration.configurationVersionReference,
    expectedBrandVersion: 1,
    policyReference,
    policyVersion: 1,
    transactions,
    registerBeforeCommit,
    id,
  });
}
