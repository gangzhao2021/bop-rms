import assert from "node:assert/strict";
import { prepareBrandRecipeOverridePublication } from "./brand-recipe-override-publication.mjs";
import { tenantBrandConfigurationRequiredFields } from "../../bop/tenant/src/index.ts";
import { vi } from "vitest";
import * as catalogModule from "../../rms/catalog/src/index.ts";
import * as brandScopeModule from "../../../apps/api/src/merchant-brand-scope.ts";
import { createMerchantProductPublicationCommand } from "../../../apps/api/src/merchant-product-publication-command.ts";
import { createPersistentMerchantBffService } from "../../../apps/api/src/persistent-merchant-bff.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createPublicationNativeHttpClient } from "./product-publication-client-http.mjs";
import {
  CatalogError,
  parseProductAggregate,
  parseCatalogOptionSetEditorContent,
  deriveCatalogProductPublicationContentIdentity,
  productPublicationCheckCodes,
  productValidationCandidateFields,
  productPublicationSourceFields,
  productEditorContentFields,
  productEditorContentReferenceChecks,
  createPostgresFullOptionSetDraftStore,
  createPostgresFullOptionSetContentSealStore,
  frozenFullOptionSetContentFields,
} from "../../rms/catalog/src/index.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { currentProductPolicyFields } from "../../../apps/api/src/current-product-publication-policy.ts";

// Actual owning candidate/history/registered identities/policy and ordinary native HTTP/SQL.
// Configured cases additionally use actual Tenant metadata/current Publishing head.
// Remaining full checks, field holders, initial governance and business identities are synthetic.
export async function exerciseCurrentUniqueScopeHttp({
  admin,
  role,
  id,
  sessions,
  scope,
  policy,
  originalAggregate,
  at,
  from,
  until,
  state,
  base = 107000,
  variantCase = false,
  selectionCase = false,
  inheritedCase = false,
  contentCase = false,
  expiryCase = false,
  elapsedPeriodCase = false,
  previousBrand = null,
}) {
  assert.match(role, /^wp2421_approval_[a-f0-9]+$/);
  await admin.query(
    `GRANT SELECT ON bop_tenant.store_reference_generation,bop_tenant.store_reference_projection TO ${role}`,
  );
  let permission = (
    await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='catalog.product.history.read'",
    )
  ).rows[0]?.permission_id;
  if (!permission) {
    permission = id(base + 280);
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.product.history.read','Active',1,$2,$2)",
      [permission, from],
    );
  }
  for (const [index, roleRef] of [id(101100), id(101200)].entries())
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
      [id(base + 281 + index), roleRef, permission, id(2), from, until],
    );
  const hash = (v) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
  const databaseNow = async () =>
    (
      await admin.query(
        "SELECT to_char(date_trunc('milliseconds',statement_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at",
      )
    ).rows[0].at;
  let commandAt = await databaseNow(),
    override,
    mode = "normal",
    tentative = false,
    candidateAllowed = true,
    historyAllowed = true,
    rosterAllowed = true,
    policyAllowed = true,
    brandAllowed = true,
    brandReads = 0,
    brandCurrents = 0,
    brandQueries = 0,
    optionAllowed = true,
    optionHolds = 0,
    firstOptionObservedAt = null,
    expiryProbeStarted = 0,
    candidateHolds = 0,
    historyHolds = 0,
    rosterHolds = 0,
    policyHolds = 0,
    remainingCalls = 0;
  // Coherent advancing fixture time; source SQL uses actual statement time. No lease renewal.
  let contentClock, brandConfiguration, brandPublication;
  const now = () => override ?? new Date(Date.now() + 20).toISOString();
  if (contentCase) {
    contentClock = await databaseNow();
    commandAt = contentClock;
    brandConfiguration = {
      configurationVersionReference: id(base + 500),
      brandReference: id(2),
      configurationVersion: previousBrand ? 2 : 1,
      lifecycle: "Published",
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA", "fr-CA"],
      mediaThemeReference: null,
      catalogSourceReference: id(base + 501),
      platformTemplateReference: id(base + 502),
      overrideAllowedFieldCodes: [],
      hardRequirementFieldCodes: [],
      effectiveFrom: from,
      effectiveUntil: new Date(
        Date.parse(contentClock) + (expiryCase ? 4500 : 3600000),
      ).toISOString(),
      supersedesVersionReference:
        previousBrand?.configuration.configurationVersionReference ?? null,
      reasonCode: "SYNTHETIC_CURRENT_CONTENT",
      authoredByReference: id(3),
      approvedByReference: id(4),
      approvalEvidenceReference: id(base + 503),
      publicationReference: id(base + 504),
      createdAt: contentClock,
      updatedAt: contentClock,
      dataClassification: "ConfigurationMetadata",
    };
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM bop_tenant.brand_configuration_version WHERE brand_id=$1",
          [id(2)],
        )
      ).rows[0].n,
      previousBrand ? 1 : 0,
    );
    brandPublication = await prepareBrandRecipeOverridePublication({
      admin,
      role,
      id,
      configuration: brandConfiguration,
      tenantReference: id(1),
      lifecycleReference: id(base + 505),
      familyReference: previousBrand?.publication.release.familyReference ?? id(base + 506),
      previousRelease: previousBrand?.publication.release ?? null,
      operationBase: base + 600,
    });
    await admin.query("GRANT SELECT ON bop_tenant.brand_configuration_version TO " + role);
    // Actual advancing ordinary clock and SQL observations; expiry-only case
    // crosses its original metadata deadline after writing, within native5s.
  }
  const product = id(base + 5),
    version = id(base + 6);
  const selections = [{ dimensionReference: id(base + 70), valueReference: id(base + 71) }],
    secondSelections = [{ dimensionReference: id(base + 70), valueReference: id(base + 72) }];
  const variantSku = {
    skuReference: id(base + 73),
    productReference: product,
    brandReference: id(2),
    skuCode: "SYNTHETIC_VARIANT_" + base,
    lifecycle: "Active",
    localizedNames: { "en-CA": "Synthetic active Variant SKU" },
    variantSelections: selections,
    unitOfSale: "EA",
    unitQuantity: "1",
    createdAt: at,
    createdByActorReference: id(3),
  };
  let optionSeed;
  if (selectionCase) {
    let next = base + 80,
      event = 0;
    const transactions = {
      async run(work) {
        await admin.query("BEGIN");
        try {
          const answer = await work({ query: (sql, values) => admin.query(sql, [...values]) });
          await admin.query("COMMIT");
          return answer;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      },
    };
    const lease = {
      async holdUntilTransactionCompletes(_tx, input) {
        return {
          observedAt: input.observedAt,
          validUntil: new Date(Date.parse(input.observedAt) + 30000).toISOString(),
        };
      },
    };
    const audit = (input, actionCode) => ({
      auditId: id(base + 400 + ++event),
      brandId: id(2),
      actor: { type: "User", reference: id(3) },
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
    const writer = createPostgresFullOptionSetDraftStore({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      clock: { now: () => new Date().toISOString() },
      transactions,
      authority: lease,
      creation: { authority: lease, references: { generate: () => id(++next) } },
      audit: { create: (input) => audit(input, "CATALOG_OPTION_SET_CREATE") },
      events: { generateReference: () => id(base + 450 + ++event) },
    });
    const created = await writer.create({
      internalCode: "SYNTHETIC_SELECTION_" + base,
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic initial default rules" },
        localizedDescriptions: {},
        displayStyle: "SingleChoice",
        minimumSelection: inheritedCase ? 1 : 0,
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
          effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
      },
      operationReference: id(base + 183),
      occurredAt: new Date().toISOString(),
      reasonCode: "INITIAL_CONFIGURATION",
    });
    optionSeed = created.content.sourceAggregate;
    const sealer = createPostgresFullOptionSetContentSealStore({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      clock: { now: () => new Date().toISOString() },
      transactions,
      authority: lease,
      readAuthority: lease,
      references: { generateSuccessorVersion: () => id(++next) },
      audit: { create: (input) => audit(input, "CATALOG_OPTION_SET_CONTENT_SEALED") },
      events: { generateReference: () => id(base + 450 + ++event) },
    });
    const { sourceAggregate, ...details } = created.content;
    const sealedInput = parseCatalogOptionSetEditorContent(sourceAggregate, details);
    await sealer.seal({
      optionSetReference: optionSeed.optionSetReference,
      versionReference: optionSeed.draft.versionReference,
      expectedAggregateVersion: 1,
      sourceDigest: sealedInput.sourceDigest,
      contentDigest: sealedInput.contentDigest,
      configurationDigest: sealedInput.configurationDigest,
      operationReference: id(base + 184),
      occurredAt: new Date().toISOString(),
      reasonCode: "CONFIGURATION_EDIT",
    });
    await admin.query(
      "GRANT SELECT ON rms_catalog.option_set_version,rms_catalog.option_set_publication_content,rms_catalog.option_set_draft_content_snapshot,rms_catalog.option_set_operation_record TO " +
        role,
    );
    let optionPermission = (
      await admin.query(
        "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='catalog.option_set.read'",
      )
    ).rows[0]?.permission_id;
    if (!optionPermission) {
      optionPermission = id(base + 285);
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.option_set.read','Active',1,$2,$2)",
        [optionPermission, from],
      );
    }
    for (const [index, roleRef] of [id(101100), id(101200)].entries())
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
        [id(base + 286 + index), roleRef, optionPermission, id(2), from, until],
      );
  }
  const selectionBinding = {
    bindingReference: id(base + 80),
    optionSetReference: optionSeed?.optionSetReference ?? id(base + 81),
    optionSetVersionReference: optionSeed?.draft.versionReference ?? id(base + 82),
    purpose: "CUSTOMIZATION",
    sortOrder: 0,
    enabledOptionReferences: optionSeed ? [optionSeed.draft.options[0].optionReference] : [],
    defaultSelections: [],
    minimumSelectionOverride: inheritedCase ? null : 1,
    maximumSelectionOverride: inheritedCase ? null : 1,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: [],
    storeOverrideAllowed: false,
  };
  const aggregate = parseProductAggregate({
    ...originalAggregate,
    productReference: product,
    internalCode: "SYNTHETIC_CURRENT_APPROVAL_" + base,
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    draft: {
      ...originalAggregate.draft,
      versionReference: version,
      ...(variantCase ? { skus: [variantSku] } : {}),
      ...(selectionCase ? { optionBindings: [selectionBinding] } : {}),
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: { "en-CA": "Synthetic complete publication" },
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: variantCase
          ? [
              {
                dimensionReference: id(base + 70),
                code: "SIZE",
                localizedNames: { "en-CA": "Synthetic size" },
                sortOrder: 0,
                selectionRequirement: "Required",
                values: [71, 72].map((value, index) => ({
                  valueReference: id(base + value),
                  code: "VALUE_" + index,
                  localizedNames: { "en-CA": "Synthetic value" },
                  sortOrder: index,
                  attributeReference: null,
                  mediaReference: null,
                })),
              },
            ]
          : [],
        variantCombinations: variantCase
          ? [
              { selections, disposition: "Valid", skuReference: variantSku.skuReference },
              {
                selections: secondSelections,
                disposition:
                  selectionCase || contentCase || elapsedPeriodCase ? "Invalid" : "NotGenerated",
                skuReference: null,
              },
            ]
          : [],
        optionRules: selectionCase
          ? [
              {
                bindingReference: selectionBinding.bindingReference,
                versionResolution: "Pinned",
                pricingRule: null,
                conditionalRule: null,
                conflictRule: null,
                variantCondition: [],
              },
            ]
          : [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
  await admin.query(
    "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'PreparedFood','Active',1,$4,$5,$4)",
    [product, id(2), aggregate.internalCode, at, id(3)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at,editor_content_json) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5,$6)",
    [version, product, id(2), aggregate.draft.localizedNames, at, aggregate.draft.editorContent],
  );
  if (variantCase) {
    const sku = aggregate.draft.skus[0];
    assert.equal(sku.lifecycle, "Active");
    await admin.query(
      "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,'Active',$6,$7,$8,'EA',1,$9,$10)",
      [
        sku.skuReference,
        product,
        id(2),
        version,
        sku.skuCode,
        JSON.stringify(sku.localizedNames),
        JSON.stringify(sku.variantSelections),
        hash(sku.variantSelections),
        at,
        id(3),
      ],
    );
  }
  if (selectionCase) {
    // Actual owning Create/seal above supplies coherent Frozen history; synthetic validation holders do not qualify publication.
    await admin.query(
      "INSERT INTO rms_catalog.product_option_binding(binding_id,product_version_id,product_id,brand_id,option_set_id,option_set_version_id,purpose,sort_order,minimum_selection_override,maximum_selection_override,store_override_allowed) VALUES($1,$2,$3,$4,$5,$6,'CUSTOMIZATION',0,$7,$8,false)",
      [
        selectionBinding.bindingReference,
        version,
        product,
        id(2),
        selectionBinding.optionSetReference,
        selectionBinding.optionSetVersionReference,
        selectionBinding.minimumSelectionOverride,
        selectionBinding.maximumSelectionOverride,
      ],
    );
    await admin.query(
      "INSERT INTO rms_catalog.product_option_binding_option(binding_id,product_id,brand_id,option_id,option_set_id,default_quantity) VALUES($1,$2,$3,$4,$5,NULL)",
      [
        selectionBinding.bindingReference,
        product,
        id(2),
        selectionBinding.enabledOptionReferences[0],
        selectionBinding.optionSetReference,
      ],
    );
  }
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    start = at;
  const command = (action, root, pub, op, extra = {}) => ({
    operationReference: id(base + op),
    productReference: product,
    versionReference: version,
    expectedProductAggregateVersion: root,
    expectedPublicationVersion: pub,
    action,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: start, localDateTime: start.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: elapsedPeriodCase
        ? {
            instant: new Date(Date.parse(commandAt) + 3000).toISOString(),
            localDateTime: new Date(Date.parse(commandAt) + 3000).toISOString().slice(0, -1),
            utcOffsetMinutes: 0,
          }
        : null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: commandAt,
    reasonCode: "SYNTHETIC_CURRENT_APPROVAL",
    ...extra,
  });

  const sources = {
    async withHeldCurrentFacts(tx, input, work) {
      remainingCalls++;
      const c = input.command;
      const result = await work({
        now: input.observedAt,
        productAggregateVersion: c.expectedProductAggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        validation: {
          evidenceReference: id(base + 18),
          productAggregateVersion: c.expectedProductAggregateVersion,
          contentDigest: c.contentDigest,
          configurationDigest: c.configurationDigest,
          scopeDigest: hash(c.scopeSet),
          periodDigest: hash(c.effectivePeriod),
          policyReference: policy.policyReference,
          policyVersion: 1,
          approvalPolicy: mode === "initial-policy-contradiction" ? "NotRequired" : "Required",
          checks: productPublicationCheckCodes.map((code) => ({
            code,
            outcome:
              mode === "initial-warning-override" && code === "MediaReady" ? "Warning" : "Pass",
          })),
          warningAcknowledgement:
            mode === "initial-warning-override"
              ? {
                  actorReference: c.actorReference,
                  reasonCode: "SYNTHETIC_WARNING",
                  warningCodes: ["MediaReady"],
                }
              : null,
          checkedAt: input.observedAt,
          validUntil: until,
        },
        approval: null,
        reviewReference: id(base + 19),
        replacement: null,
      });
      assert.equal(
        (
          await tx.query("SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1", [
            product,
          ])
        ).rows[0].aggregate_version,
        c.expectedProductAggregateVersion + 1,
      );
      tentative = true;
      if (mode === "late-brand") brandAllowed = false;
      if (mode === "late-brand-expiry") {
        override = new Date(Date.parse(brandConfiguration.effectiveUntil) + 1).toISOString();
        assert.ok(Date.parse(override) < expiryProbeStarted + 5000);
      }
      if (mode === "late-candidate") candidateAllowed = false;
      if (mode === "late-history") historyAllowed = false;
      if (mode === "late-roster") rosterAllowed = false;
      if (mode === "late-policy") policyAllowed = false;
      if (mode === "late-option") optionAllowed = false;
      if (mode === "late-option-grant")
        await tx.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [id(base + 286)],
        );
      if (mode === "late-option-expiry") {
        assert.ok(firstOptionObservedAt);
        override = new Date(Date.parse(firstOptionObservedAt) + 3001).toISOString();
        assert.ok(Date.parse(override) < expiryProbeStarted + 5000);
      }
      if (mode === "late-expiry") override = new Date(Date.now() + 6000).toISOString();
      if (mode === "late-grant")
        await tx.query(
          "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
          [id(base + 281)],
        );
      return result;
    },
  };
  const deny = () => {
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  };
  const currentUniqueScope = {
    ...(contentCase
      ? {
          contentPolicy: {
            configurationVersionReference: brandConfiguration.configurationVersionReference,
            expectedBrandVersion: 1,
            brandAuthority: {
              async withCurrentContentRead(input, fields, work) {
                brandReads++;
                assert.equal(input.tenantReference, id(1));
                assert.equal(input.brandReference, id(2));
                assert.equal(input.actorReference, id(3));
                assert.equal(input.purposeCode, "CATALOG_PRODUCT_CONTENT");
                assert.equal(
                  input.configurationVersionReference,
                  brandConfiguration.configurationVersionReference,
                );
                assert.equal(input.expectedBrandVersion, 1);
                assert.match(input.originalIntentDigest, /^sha256:[0-9a-f]{64}$/);
                assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
                if (!brandAllowed) deny();
                return work();
              },
              async isCurrent(_tx, input, fields) {
                brandCurrents++;
                assert.equal(input.actorReference, id(3));
                assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
                if (!brandAllowed) deny();
                return true;
              },
            },
          },
        }
      : {}),
    ...(selectionCase
      ? {
          optionAuthority: {
            async holdUntilTransactionCompletes(_tx, input) {
              optionHolds++;
              firstOptionObservedAt ??= input.observedAt;
              assert.equal(input.action, "catalog.option_set.read");
              assert.equal(input.permission, "catalog.manage");
              assert.equal(input.purposeCode, "CATALOG_OPTION_SET_FROZEN_CONTENT");
              assert.deepEqual(input.requiredFields, frozenFullOptionSetContentFields);
              assert.equal(input.optionSetReference, selectionBinding.optionSetReference);
              assert.equal(input.versionReference, selectionBinding.optionSetVersionReference);
              if (!optionAllowed) deny();
              return {
                observedAt: input.observedAt,
                validUntil: new Date(
                  Date.parse(input.observedAt) + (mode === "late-option-expiry" ? 3000 : 5000),
                ).toISOString(),
              };
            },
          },
        }
      : {}),
    candidateAuthority: {
      async holdUntilTransactionCompletes(_tx, input) {
        candidateHolds++;
        assert.equal(input.productReference, product);
        assert.equal(input.owningAction, "catalog.product.validate");
        assert.deepEqual(input.requiredFields, productValidationCandidateFields);
        if (!candidateAllowed) deny();
      },
    },
    historyAuthority: {
      async holdUntilTransactionCompletes(_tx, input) {
        historyHolds++;
        assert.equal(input.productReference, product);
        assert.equal(input.owningAction, "catalog.product.history.read");
        assert.deepEqual(input.requiredFields, productPublicationSourceFields);
        if (!historyAllowed) deny();
      },
    },
    tenantAuthority: {
      async withCurrentBrandReferenceRead(input, work) {
        assert.equal(input.brandReference, id(2));
        assert.equal(input.actorReference, id(3));
        assert.equal(input.purposeCode, "CATALOG_PRODUCT_VERSION_PUBLICATION");
        if (!rosterAllowed) deny();
        return work();
      },
      async isCurrent(_tx, input) {
        rosterHolds++;
        assert.equal(input.brandReference, id(2));
        if (!rosterAllowed) deny();
        return true;
      },
    },
    policyAuthority: {
      async holdUntilTransactionCompletes(_tx, input) {
        policyHolds++;
        assert.equal(input.policyReference, policy.policyReference);
        assert.deepEqual(input.requiredFields, currentProductPolicyFields);
        if (!policyAllowed) deny();
      },
    },
  };
  const codeQueries = [];
  const merchant = {
    ...sessions[0].persistence,
    now,
    transactions: {
      run: (work) =>
        sessions[0].persistence.transactions.run((original) =>
          work(
            Object.freeze({
              async query(sql, values) {
                if (sql.includes("bop_tenant.brand_configuration_version")) brandQueries++;
                const result = await original.query(sql, values);
                if (sql.includes(" AS internal_code_unique")) {
                  assert.deepEqual(values, [id(2), aggregate.internalCode, product]);
                  assert.equal(result.rows.length, 1);
                  assert.equal(result.rows[0].candidate_matches, true);
                  assert.equal(result.rows[0].internal_code_unique, true);
                  // Observe the exact owning Brand advisory barrier on this same backend.
                  const locks = await original.query(
                    "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1) AS held",
                    ["CatalogProductSource:" + id(2)],
                  );
                  assert.equal(locks.rows[0]?.held, true);
                  assert.ok(candidateHolds > 0);
                  codeQueries.push({ candidateMatches: true, internalCodeUnique: true });
                  if (mode === "code-read-field-withdrawal") candidateAllowed = false;
                }
                return result;
              },
            }),
          ),
        ),
    },
  };
  let admissionErrorCode = null;
  const originalBrandScope = brandScopeModule.createMerchantBrandScope;
  const admissionObservation = vi
    .spyOn(brandScopeModule, "createMerchantBrandScope")
    .mockImplementation((configuration) => {
      const resolve = originalBrandScope(configuration);
      return async (...args) => {
        const current = await resolve(...args);
        return Object.freeze({
          ...current,
          async authorizeActions(actions) {
            try {
              const answer = await current.authorizeActions(actions);
              if (answer) {
                const scoped = await args[0].query(
                  "SELECT current_setting('bop.store_id',true) AS store_scope",
                  [],
                );
                assert.equal(scoped.rows[0].store_scope, "");
              }
              return answer;
            } catch (error) {
              admissionErrorCode =
                typeof error?.code === "string" && /^[A-Z_]{2,80}$/.test(error.code)
                  ? error.code
                  : "UNCLASSIFIED";
              throw error;
            }
          },
        });
      };
    });
  const handler = createMerchantProductPublicationCommand({
    merchant,
    authentication: createPersistentMerchantBffService(merchant),
    auditReference: (operation) => id(parseInt(operation.slice(-12), 16) + 5000),
    authority: {
      async holdUntilTransactionCompletes(_tx, input) {
        assert.equal(input.requiredScope, "FullBrandScope");
      },
    },
    editorContentAuthority: async (_tx, input) => {
      assert.equal(input.productReference, product);
      assert.equal(input.tenantReference, id(1));
      assert.equal(input.brandReference, id(2));
      assert.equal(input.actorReference, id(3));
      assert.deepEqual(input.requiredFields, productEditorContentFields);
      assert.deepEqual(
        input.requiredReferenceChecks,
        input.mode === "Read" ? [] : productEditorContentReferenceChecks,
      );
    },
    sources,
    currentUniqueScope,
  });
  const root = async () =>
    (
      await admin.query("SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1", [
        product,
      ])
    ).rows[0].aggregate_version;
  const decision = async () =>
    (
      await admin.query(
        "SELECT snapshot_json FROM rms_catalog.product_publication_revision WHERE product_id=$1 ORDER BY publication_version DESC LIMIT 1",
        [product],
      )
    ).rows[0].snapshot_json.validationDecision;
  const grant = async (ref, lifecycle) =>
    admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle=$2,version=version+1 WHERE grant_id=$1",
      [ref, lifecycle],
    );
  let observedElapsedChecks, requestPeriodStarted;
  const originalScopeAssessment = catalogModule.assessCatalogProductUniqueScope;
  const elapsedScopeObservation = elapsedPeriodCase
    ? vi.spyOn(catalogModule, "assessCatalogProductUniqueScope").mockImplementation((...args) => {
        const assessment = originalScopeAssessment(...args);
        const originalEnd = args[0].effectivePeriod.effectiveUntil.instant;
        assert.ok(args[4] < originalEnd);
        override = new Date(Date.parse(originalEnd) + 1).toISOString();
        assert.ok(override < assessment.validUntil);
        assert.ok(Date.parse(override) < requestPeriodStarted + 5000);
        return assessment;
      })
    : null;
  const originalCandidateMerge = catalogModule.applyCatalogProductCandidateValidation;
  const elapsedObservation = elapsedPeriodCase
    ? vi
        .spyOn(catalogModule, "applyCatalogProductCandidateValidation")
        .mockImplementation((...args) => {
          const result = originalCandidateMerge(...args);
          observedElapsedChecks = result.checks;
          return result;
        })
    : null;
  try {
    await withProductPublicationHttp(handler, sessions[0], scope, async (post) => {
      // Retain all prior probes; additive fixtures isolate Variant/default rules,
      // configured content policy and earlier original Brand expiry separately.
      for (const [probe, status] of contentCase
        ? [
            ...(expiryCase
              ? [["late-brand-expiry", 503]]
              : [
                  ["initial-brand", 403],
                  ["late-brand", 403],
                ]),
          ]
        : variantCase
          ? inheritedCase
            ? [
                ["initial-option-grant", 403],
                ["late-option", 403],
                ["late-option-grant", 403],
                ["late-option-expiry", 503],
              ]
            : []
          : [
              ["initial-policy-contradiction", 503],
              ["initial-warning-override", 503],
              ["initial-history", 403],
              ["code-read-field-withdrawal", 403],
              ["late-candidate", 403],
              ["late-history", 403],
              ["late-roster", 403],
              ["late-policy", 403],
              ["late-grant", 403],
              ["late-expiry", 503],
            ]) {
        commandAt = await databaseNow();
        override = undefined;
        mode = probe;
        firstOptionObservedAt = null;
        tentative = false;
        candidateAllowed = rosterAllowed = policyAllowed = true;
        historyAllowed = probe !== "initial-history";
        optionAllowed = true;
        brandAllowed = probe !== "initial-brand";
        if (selectionCase)
          await grant(id(base + 286), probe === "initial-option-grant" ? "Revoked" : "Active");
        const codeReadsBefore = codeQueries.length;
        const before = await state();
        expiryProbeStarted = Date.now();
        const reply = await post(command("Validate", 1, 0, 10));
        assert.equal(
          reply.status,
          status,
          probe +
            " " +
            JSON.stringify({
              reply: reply.body,
              admissionErrorCode,
              candidateHolds,
              historyHolds,
              rosterHolds,
              policyHolds,
              brandReads,
              brandCurrents,
              brandQueries,
              remainingCalls,
              tentative,
            }),
        );
        if (probe.startsWith("late-")) assert.equal(tentative, true, probe);
        if (probe === "code-read-field-withdrawal") {
          assert.equal(codeQueries.length, codeReadsBefore + 1);
          assert.equal(tentative, false);
        }
        assert.deepEqual(await state(), before, probe);
      }
      commandAt = await databaseNow();
      override = undefined;
      if (expiryCase) return;
      mode = "normal";
      brandAllowed = true;
      candidateAllowed = historyAllowed = rosterAllowed = policyAllowed = optionAllowed = true;
      if (selectionCase) await grant(id(base + 286), "Active");
      const codeReadsBefore = codeQueries.length;
      const body = command("Validate", 1, 0, 10),
        pending = createPublicationNativeHttpClient({
          post,
          command: body,
          scope,
          csrf: sessions[0].csrf,
        });
      const requestStarted = Date.now();
      requestPeriodStarted = requestStarted;
      const lost = await pending({ loseNextResponse: true });
      assert.equal(
        lost.nativeReply.status,
        200,
        JSON.stringify({
          reply: lost.nativeReply.body,
          synthetic: {
            base,
            mode,
            tentative,
            candidateHolds,
            historyHolds,
            rosterHolds,
            policyHolds,
            optionHolds,
            remainingCalls,
            elapsedMs: Date.now() - requestStarted,
            codeReads: codeQueries.length - codeReadsBefore,
          },
        }),
      );
      assert.equal(lost.error.code, "OutcomeUnknown");
      assert.equal(await root(), 2);
      assert.equal(codeQueries.length, codeReadsBefore + 2);
      // Original baseline has no SKU rows; the additional fixtures have an Active SKU
      // plus an unmapped combination, default violation, current content-policy failure
      // or ended EffectivePeriod. The period case has none of the other content failures.
      // Supplied Pass cannot override these owning failures; original recovery retains them.
      if (variantCase) {
        assert.equal(aggregate.draft.skus.length, 1);
        assert.equal(aggregate.draft.skus[0].lifecycle, "Active");
        assert.equal(
          aggregate.draft.editorContent.variantCombinations.filter(
            (c) => c.disposition === "NotGenerated",
          ).length,
          selectionCase || contentCase || elapsedPeriodCase ? 0 : 1,
        );
        assert.equal(
          aggregate.draft.editorContent.variantCombinations.filter((c) => c.disposition === "Valid")
            .length,
          1,
        );
      } else assert.equal(aggregate.draft.skus.length, 0);
      if (selectionCase) {
        assert.equal(aggregate.draft.optionBindings.length, 1);
        assert.equal(
          aggregate.draft.optionBindings[0].minimumSelectionOverride,
          inheritedCase ? null : 1,
        );
        assert.ok(optionHolds > 0);
        assert.equal(aggregate.draft.optionBindings[0].defaultSelections.length, 0);
      }
      if (elapsedPeriodCase) {
        assert.equal(aggregate.draft.optionBindings.length, 0);
        assert.ok(body.effectivePeriod.effectiveUntil.instant > body.occurredAt);
        assert.ok(override > body.effectivePeriod.effectiveUntil.instant);
        assert.equal(contentCase, false);
        assert.deepEqual(
          observedElapsedChecks
            ?.filter((check) => check.outcome === "HardError")
            .map((check) => check.code),
          ["EffectivePeriod", "HardErrorsCleared"],
        );
        assert.ok(
          observedElapsedChecks.every(
            (check) =>
              check.outcome === "Pass" ||
              ["EffectivePeriod", "HardErrorsCleared"].includes(check.code),
          ),
        );
      }
      assert.equal(await decision(), "HardError");
      if (contentCase) {
        assert.ok(brandReads > 0 && brandCurrents > 0 && brandQueries > 0);
        const stored = (
          await admin.query(
            "SELECT snapshot_json FROM rms_catalog.product_publication_revision WHERE product_id=$1 ORDER BY publication_version DESC LIMIT 1",
            [product],
          )
        ).rows[0].snapshot_json;
        assert.equal(stored.policyReference, policy.policyReference);
      }
      assert.ok(candidateHolds > 0 && historyHolds > 0 && rosterHolds > 0 && policyHolds > 0);
      // Unknown recovery has current write admission; it never reacquires source reads.
      await grant(id(101123), "Revoked");
      let before = await state();
      const denied = await pending();
      assert.equal(denied.nativeReply.status, 403);
      assert.equal(denied.error.code, "OutcomeUnknown");
      assert.deepEqual(await state(), before);
      await grant(id(101123), "Active");
      await grant(id(base + 281), "Revoked");
      override = new Date(Date.now() + 60000).toISOString();
      candidateAllowed = historyAllowed = rosterAllowed = policyAllowed = brandAllowed = false;
      brandReads = brandCurrents = brandQueries = 0;
      candidateHolds = historyHolds = rosterHolds = policyHolds = optionHolds = remainingCalls = 0;
      codeQueries.length = 0;
      before = await state();
      const replay = await pending();
      assert.equal(replay.receipt.status, "Replayed");
      assert.equal(replay.receipt.aggregateVersion, 2);
      assert.equal(codeQueries.length, 0);
      assert.equal(brandReads + brandCurrents + brandQueries, 0);
      assert.equal(
        candidateHolds + historyHolds + rosterHolds + policyHolds + optionHolds + remainingCalls,
        0,
      );
      assert.deepEqual(await state(), before);
      await grant(id(base + 281), "Active");
      override = undefined;
      candidateAllowed = historyAllowed = rosterAllowed = policyAllowed = brandAllowed = true;
      commandAt = await databaseNow();
      requestPeriodStarted = Date.now();
      const region = await post(
        command("Validate", 2, 1, 11, {
          scopeSet: [
            { level: "Region", reference: id(999999), channelCodes: [], orderTypeCodes: [] },
          ],
        }),
      );
      assert.equal(region.status, 200, JSON.stringify(region.body));
      assert.equal(await root(), 3);
      assert.equal(await decision(), "HardError");
    });
  } finally {
    elapsedScopeObservation?.mockRestore();
    elapsedObservation?.mockRestore();
    admissionObservation.mockRestore();
  }
  // This scenario has finished every assertion. Retire only its fixture grants
  // before another scenario creates the same role/permission pairs.
  for (const index of [0, 1]) {
    await grant(id(base + 281 + index), "Revoked");
    if (selectionCase) await grant(id(base + 286 + index), "Revoked");
  }
  return contentCase ? { configuration: brandConfiguration, publication: brandPublication } : null;
}
