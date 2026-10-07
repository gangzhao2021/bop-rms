import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { request } from "node:http";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { URL } from "node:url";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import { createBrandConfigurationVersion } from "../../bop/tenant/src/index.ts";
import { createEffectivePeriod } from "../../bop/effective-period/src/index.ts";
import {
  createTaxConfigurationSnapshot,
  createCurrencyMetadataSnapshot,
} from "../../rms/pricing/src/index.ts";
import {
  createPostgresStoreConfigurationAuthoringSource,
  createPostgresStoreConfigurationHistorySource,
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreSetupDraftStore,
  createStoreConfigurationPublicationHash,
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryReceipt,
  storeSetupDraftContentFields,
  storeConfigurationHistoryRequiredFields,
} from "../../rms/store/src/index.ts";
import { createPostgresCurrentLiveGateSource } from "../../bop/publishing/src/index.ts";
import { createMerchantRuntime } from "../../../apps/api/dist/merchant-runtime.js";
import { createMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { createMerchantStoreScope } from "../../../apps/api/dist/merchant-store-scope.js";
import { createMerchantStoreConfigurationReferenceSources } from "../../../apps/api/dist/merchant-store-configuration-reference-sources.js";

const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const refs = {
  canonicalize: canonicalizeRfc8785,
  hashIntent: (text) => "sha256:" + sha256Hex(text),
};
const checkCodes = [
  "CONTROLLED_REFERENCE_BINDING",
  "ACTUAL_RECEIPT_PUBLICATION",
  "ACTUAL_SETUP_BASIS",
];

/** Actual encrypted Session/current IAM, borrowed PostgreSQL, public Core,
 * Store/Audit and ordinary HTTP. External Tax/Brand requirements and recorded
 * LiveGate evidence below are explicitly controlled InternalTest material, not
 * professional qualification, Provider results or an externally ready Store. */
export async function exerciseStoreConfigurationOrdinaryRuntimeHttp(input) {
  const {
    admin,
    role,
    transactions,
    ownerHooks,
    session,
    manager,
    scope,
    now,
    id,
    sendSetup,
    savedSetup,
  } = input;
  const {
    tenantReference: tenant,
    brandReference: brand,
    storeReference: store,
    actorReference: actor,
  } = scope;
  let allocated = 90000,
    latePermission = null,
    lateSetupMutation = false,
    lastFailure = null,
    lateSetupCheckpoint = "BeforeAppend",
    factsCheckpoint = "NotStarted",
    factFailure = null,
    lateChildStage = "NotStarted",
    lateChildFailure = null,
    falseFields = [];
  const ordinaryTransactions = {
    async run(work) {
      try {
        return await transactions.run(work);
      } catch (error) {
        const code =
          typeof error?.code === "string" &&
          /^(STORE_SETUP|STORE_CONFIGURATION|RECEIPT_TEMPLATE|PAYMENT_CONFIGURATION)_[A-Z_]{1,96}$/u.test(
            error.code,
          )
            ? error.code
            : "NONE";
        const kind =
          error instanceof assert.AssertionError
            ? "Assertion"
            : error instanceof TypeError
              ? "TypeError"
              : error instanceof Error
                ? "Error"
                : "Other";
        lastFailure = { code, kind };
        throw error;
      }
    },
  };
  const next = () => id(allocated++);
  const requestClock = new AsyncLocalStorage();
  const originalClock = () => {
    const originalObservedAt = requestClock.getStore();
    assert.equal(typeof originalObservedAt, "string");
    return {
      originalObservedAt,
      originalValidUntil: new Date(Date.parse(originalObservedAt) + 5000).toISOString(),
    };
  };
  const at = now(),
    businessUntil = new Date(Date.parse(at) + 3600000).toISOString();
  const permissions = [
    "organization.manage",
    "store.service.read",
    "store.service.save-draft",
    "store.service.validate",
    "store.service.submit",
    "store.service.approve",
    "store.service.publish",
    "publishing.draft.create",
    "publishing.review.submit",
    "publishing.review.approve",
    "publishing.release.publish",
  ];
  const grants = new Map();
  for (const action of permissions) {
    let permission = (
      await admin.query(
        "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
        [action],
      )
    ).rows[0]?.permission_id;
    if (!permission) {
      permission = next();
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [permission, action, at],
      );
    }
    for (const [reader, prefix] of [
      [session, "01902431"],
      [manager, "01902433"],
    ]) {
      const roleId = prefix + "-0000-7000-8000-000000000004";
      const existing = (
        await admin.query(
          "SELECT grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,effective_until FROM bop_permission.permission_grant WHERE role_id=$1 AND permission_id=$2 AND lifecycle='Active'",
          [roleId, permission],
        )
      ).rows;
      assert(existing.length <= 1);
      if (existing.length === 1) {
        const grant = existing[0];
        assert.equal(grant.role_id, roleId);
        assert.equal(grant.permission_id, permission);
        assert.equal(grant.brand_id, brand);
        assert.equal(grant.store_id, store);
        assert.equal(grant.lifecycle, "Active");
        assert(grant.effective_from instanceof Date && grant.effective_from.toISOString() <= at);
        assert(
          grant.effective_until === null ||
            (grant.effective_until instanceof Date && grant.effective_until.toISOString() > now()),
        );
        grants.set(reader.sessionCookie + action, grant.grant_id);
        continue;
      }
      const grant = next();
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
        [grant, roleId, permission, brand, store, at, businessUntil],
      );
      grants.set(reader.sessionCookie + action, grant);
    }
  }
  await admin.query(
    "GRANT SELECT,INSERT ON rms_store.store_configuration_authoring_operation,rms_store.store_configuration_original_operation,rms_store.store_configuration_version,rms_store.store_configuration_publication_content TO " +
      role,
  );
  await admin.query(
    "GRANT UPDATE ON rms_store.store_configuration_authoring_operation,rms_store.store_configuration_original_operation,rms_store.store_configuration_version,rms_store.store_configuration_publication_content,bop_publishing.live_gate_version,bop_publishing.live_gate_requirement TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
  );
  await admin.query(
    "GRANT SELECT ON bop_publishing.live_gate_version,bop_publishing.live_gate_requirement TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_store.store_weekly_service_period,rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval TO " +
      role,
  );

  const brandBase = createBrandConfigurationVersion({
    configurationVersionReference: next(),
    brandReference: brand,
    configurationVersion: 1,
    lifecycle: "Published",
    defaultLocale: savedSetup.defaultLocale,
    supportedLocales: ["en-CA", "fr-CA"],
    mediaThemeReference: next(),
    catalogSourceReference: next(),
    platformTemplateReference: next(),
    overrideAllowedFieldCodes: ["STORE.CONFIGURATION"],
    hardRequirementFieldCodes: ["SECURITY.REAUTH"],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesVersionReference: null,
    reasonCode: "INTERNAL_TEST",
    authoredByReference: actor,
    approvedByReference: manager.actorReference ?? id(9),
    approvalEvidenceReference: next(),
    publicationReference: next(),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
  // Explicit controlled configuration reference, not an inferred Tax eligibility result.
  const taxReference = next(),
    taxVersion = next(),
    taxDigest = hash({ profile: "INTERNAL_TEST_TAX", configurationReference: taxReference });
  const offsetName = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    timeZoneName: "shortOffset",
  })
    .formatToParts(new Date(at))
    .find((part) => part.type === "timeZoneName")?.value;
  assert.match(offsetName, /^GMT-(4|5)$/u);
  const offsetMinutes = -Number(offsetName.slice(4)) * 60;
  const local = new Date(Date.parse(at) + offsetMinutes * 60000).toISOString().slice(0, -1);
  const controlledTax = createTaxConfigurationSnapshot({
    configurationReference: taxReference,
    versionReference: taxVersion,
    brandReference: brand,
    storeReference: store,
    stableCode: "INTERNAL_TEST_TAX",
    aggregateVersion: 1,
    versionNumber: 1,
    snapshotDigest: taxDigest,
    lifecycle: "Published",
    jurisdictionCode: "CA-ON",
    currencyMetadata: createCurrencyMetadataSnapshot({
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: next(),
      metadataDigest: hash({ currency: "CAD", internalTest: true }),
    }),
    effectivePeriod: createEffectivePeriod({
      timeZone: "America/Toronto",
      effectiveFrom: { instant: at, localDateTime: local, utcOffsetMinutes: offsetMinutes },
      effectiveUntil: null,
    }),
    registrationEvidence: {
      applicabilityReference: next(),
      operatingEntityTaxReference: next(),
      jurisdictionProfileReference: next(),
      status: "Verified",
      validUntil: businessUntil,
    },
    professionalEvidence: {
      evidenceReference: next(),
      snapshotReference: taxVersion,
      snapshotDigest: taxDigest,
      professionalReviewReference: next(),
      fixtureSuiteReference: next(),
      fixtureSuiteDigest: hash({ internalTest: "fixture" }),
      result: "Pass",
      reviewedAt: at,
      validUntil: businessUntil,
    },
    rules: [
      {
        ruleReference: next(),
        taxClassificationReference: next(),
        orderType: "Pickup",
        chargeType: "Sellable",
        taxComponentCode: "SYNTHETIC_COMPONENT",
        treatment: "Taxable",
        rate: "0.13",
        priceInclusion: "Exclusive",
        roundingMode: "HalfUp",
        calculationOrder: 1,
        compoundOnPriorTax: false,
        exceptionEvidenceReference: null,
        receiptPresentationCode: "SYNTHETIC_RECEIPT_LINE",
      },
    ],
    createdAt: at,
  });
  const weeklySchedule = Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals:
      index === 0
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "17:00:00",
              endsNextDay: false,
              serviceModes: ["DineIn", "Pickup"],
              orderCutoffSeconds: 0,
              leadTimeSeconds: 0,
            },
          ]
        : [],
  }));
  const fields = {
    source: "StoreOverride",
    brandBaseVersionReference: brandBase.configurationVersionReference,
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: savedSetup.content.addressReference.value,
    contactReference: savedSetup.content.contactReference.value,
    receiptReference: savedSetup.content.receiptReference.value,
    taxConfigurationReference: taxReference,
    paymentConfigurationReference: savedSetup.content.paymentConfigurationReference.value,
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule,
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
  };
  assert.equal(Object.keys(fields).length, storeSetupDraftContentFields.length);
  const complete = await sendSetup("POST", {
    command: "SaveDraft",
    operationReference: next(),
    expectedSetupReference: savedSetup.setupDraftReference,
    expectedRevision: savedSetup.revision,
    content: {
      ...Object.fromEntries(
        storeSetupDraftContentFields.map((key) => [
          key,
          { state: "Configured", value: fields[key] },
        ]),
      ),
      feeContexts: {
        state: "Configured",
        value: ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
          chargeType,
          state: "Disabled",
        })),
      },
    },
  });
  assert.equal(complete.status, 200);
  const setup = complete.body.snapshot;
  assert.equal(setup.profile, "StoreSetupDraftV2");
  const family = next(),
    gate = next(),
    gateDecision = next();
  // Recorded synthetic external gate facts. The real public current owner, not
  // this UUID, supplies every publication decision and holds its SHARE fence.
  await admin.query(
    "INSERT INTO bop_publishing.live_gate_version VALUES ($1,'SYNTHETIC-ORDINARY-STORE-GATE',$2,$3,$4,1,'Production','Approved',$5,$6,$5,$7,$8,$8,'ConfigurationMetadata')",
    [gate, tenant, brand, store, id(9), actor, gateDecision, at],
  );
  await admin.query(
    "INSERT INTO bop_publishing.live_gate_requirement VALUES ($1,$2,$3,$4,1,'INTERNAL_TEST','CONTROLLED_STORE_REQUIREMENT',$5,true,'Accepted',$6,1,$7,NULL,'ConfigurationMetadata')",
    [next(), brand, store, gate, id(9), next(), businessUntil],
  );
  const children = new WeakMap();
  const sourceHosts = new WeakMap();
  const facts = async (tx, selected, persistence, sessionCookie) => {
    let held = children.get(tx);
    if (held) return held;
    const { originalObservedAt, originalValidUntil } = originalClock();
    const sourceHost = sourceHosts.get(tx);
    assert(sourceHost);
    factsCheckpoint = "ReferenceConstruction";
    const source = createMerchantStoreConfigurationReferenceSources({
      persistence,
      sessionCookie,
      transaction: tx,
      scope: selected,
      sourceHost,
      originalObservedAt,
      originalValidUntil,
    });
    factsCheckpoint = "AddressVersionRead";
    const address = await source.address(fields.addressReference);
    assert(address);
    assert.equal(address.reference, fields.addressReference);
    factsCheckpoint = "ContactVersionRead";
    const contact = await source.contact(fields.contactReference);
    assert(contact);
    assert.equal(contact.reference, fields.contactReference);
    factsCheckpoint = "PaymentRead";
    const paid = await source.payment(fields.paymentConfigurationReference);
    assert(paid);
    factsCheckpoint = "ReceiptResolve";
    const publishedReceipt = await source.receipt(fields.receiptReference);
    assert(publishedReceipt);
    held = { references: { address, contact }, paid, publishedReceipt };
    children.set(tx, held);
    return held;
  };
  const actionPermissions = {
    saveDraft: "store.service.save-draft",
    validate: "store.service.validate",
    submit: "store.service.submit",
    approve: "store.service.approve",
    publish: "store.service.publish",
  };
  const optionsFor = (reader) => {
    const persistence = {
      ...reader.persistence,
      transactions: ordinaryTransactions,
      now,
      publication: {
        configurationType: "STORE_CONFIGURATION",
        purposeCode: "STORE_CONFIGURATION",
        requiredLiveGateRequirementCodes: ["CONTROLLED_STORE_REQUIREMENT"],
      },
    };
    return {
      persistence,
      acceptedHost: "merchant.invalid",
      exactOrigin: "https://merchant.invalid",
      serviceAudit: {
        reasonCode: "INTERNAL_TEST",
        retentionPolicyCode: "OPERATIONAL",
        retentionPolicyVersion: 1,
      },
      configuration: {
        actionPermissions,
        configure: () => {
          throw new Error("LEGACY_CONFIGURATION_NOT_SELECTED");
        },
      },
      storeConfigurationOrdinary: {
        actionPermissions,
        nextReference: next,
        v2: {
          requiredValidationCheckCodes: checkCodes,
          validateSubmit: async (tx, configuration, observedAt) => {
            assert(await validators.get(tx)(configuration));
            assert(observedAt < businessUntil);
            return { validUntil: businessUntil, checkCodes };
          },
          approvalValidUntil: async (_tx, input) => {
            assert(input.occurredAt < businessUntil);
            return businessUntil;
          },
          liveGateEvidence: async (tx, configuration, observedAt) => {
            const source = gateSources.get(tx),
              record = await source(tx, observedAt);
            assert.equal(configuration.receiptReference, fields.receiptReference);
            const sourceHost = sourceHosts.get(tx);
            assert(sourceHost);
            await sourceHost.registerBeforeCommit(
              tx,
              async () => assert.deepEqual(await source(tx, now()), record),
              () => {
                assert.equal(gateSources.get(tx), source);
              },
            );
            return record.decisionEvidenceReference;
          },
        },
        configure: (tx, selected, sourceHost) => {
          assert(sourceHost);
          assert.equal(typeof sourceHost.registerBeforeCommit, "function");
          assert.equal(typeof sourceHost.registerAfterCommit, "function");
          assert.equal(sourceHosts.has(tx), false);
          sourceHosts.set(tx, sourceHost);
          const authorize = async (actual) => actual === tx && (await selected.allowed());
          const publication = {
            tenantReference: tenant,
            publishingFamilyReference: family,
            configurationType: "STORE_CONFIGURATION",
            purposeCode: "STORE_CONFIGURATION",
            requiredLiveGateRequirementCodes: ["CONTROLLED_STORE_REQUIREMENT"],
            requiredValidationCheckCodes: checkCodes,
            setupSnapshotReferences: refs,
            hashContent: createStoreConfigurationPublicationHash(refs),
            authorize,
          };
          gateSources.set(
            tx,
            createPostgresCurrentLiveGateSource({
              tenantReference: tenant,
              brandReference: brand,
              storeReference: store,
              decisionEvidenceReference: gateDecision,
              requiredRequirementCodes: ["CONTROLLED_STORE_REQUIREMENT"],
              authorize,
            }),
          );
          const validate = async (configuration) => {
            let actual;
            try {
              actual = await facts(tx, selected, persistence, reader.sessionCookie);
            } catch (error) {
              const code =
                typeof error?.code === "string" &&
                /^(STORE_SETUP|STORE_PAYMENT|STORE_CONFIGURATION|RECEIPT_TEMPLATE)_[A-Z_]{1,96}$/u.test(
                  error.code,
                )
                  ? error.code
                  : "NONE";
              factFailure = {
                code,
                kind:
                  error instanceof assert.AssertionError
                    ? "Assertion"
                    : error instanceof TypeError
                      ? "TypeError"
                      : error instanceof Error
                        ? "Error"
                        : "Other",
              };
              throw error;
            }
            factsCheckpoint = "ReferenceCompare";
            falseFields = storeSetupDraftContentFields.filter(
              (key) => canonicalizeRfc8785(configuration[key]) !== canonicalizeRfc8785(fields[key]),
            );
            if (configuration.addressReference !== actual.references.address?.reference)
              falseFields.push("actualAddressReference");
            if (configuration.contactReference !== actual.references.contact?.reference)
              falseFields.push("actualContactReference");
            if (configuration.paymentConfigurationReference !== actual.paid.configurationReference)
              falseFields.push("actualPaymentReference");
            if (configuration.receiptReference !== actual.publishedReceipt.templateReference)
              falseFields.push("actualReceiptReference");
            return (
              configuration.brandReference === brand &&
              configuration.storeReference === store &&
              configuration.defaultLocale === setup.defaultLocale &&
              configuration.currencyCode === "CAD" &&
              configuration.addressReference === actual.references.address?.reference &&
              configuration.contactReference === actual.references.contact?.reference &&
              configuration.paymentConfigurationReference === actual.paid.configurationReference &&
              configuration.receiptReference === actual.publishedReceipt.templateReference &&
              configuration.taxConfigurationReference === controlledTax.configurationReference &&
              controlledTax.brandReference === brand &&
              controlledTax.storeReference === store &&
              controlledTax.lifecycle === "Published" &&
              controlledTax.currencyMetadata.currencyCode === configuration.currencyCode &&
              controlledTax.registrationEvidence.validUntil > now() &&
              controlledTax.professionalEvidence.validUntil > now() &&
              configuration.capacityConfigurationReference === null &&
              configuration.brandBaseVersionReference === brandBase.configurationVersionReference &&
              storeSetupDraftContentFields.every(
                (key) =>
                  canonicalizeRfc8785(configuration[key]) === canonicalizeRfc8785(fields[key]),
              )
            );
          };
          validators.set(tx, validate);
          return {
            publication,
            businessDayStartSource: "StoreOverride",
            nextReference: next,
            publishedBaseline: async (actual) => {
              const latest = await createPostgresStoreConfigurationAuthoringSource({
                brandReference: brand,
                storeReference: store,
                authorize,
              })(actual, now());
              if (latest?.lifecycle !== "Published") return null;
              return (
                await createPostgresCurrentStorePublicationProof({
                  ...publication,
                  brandReference: brand,
                  storeReference: store,
                  configurationReference: latest.configurationReference,
                })(actual, now())
              ).configuration;
            },
            ports: () => ({
              authorization: { authorize: selected.allowed },
              references: {
                hashIntent: refs.hashIntent,
                equals: (a, b) => a === b,
                validateControlledReferences: validate,
                validateBrandBaseCompatibility: async (configuration) => {
                  factsCheckpoint = "BrandCompare";
                  const checks = {
                    brandBaseVersionReference:
                      configuration.brandBaseVersionReference ===
                      brandBase.configurationVersionReference,
                    actualBrandCurrency:
                      configuration.currencyCode === selected.context.brand.currencyCode,
                    actualStoreCurrency: configuration.currencyCode === selected.store.currencyCode,
                    defaultLocale: brandBase.supportedLocales.includes(configuration.defaultLocale),
                  };
                  falseFields = Object.keys(checks).filter((key) => checks[key] !== true);
                  return Object.values(checks).every((value) => value === true);
                },
              },
            }),
            appendAudit: async (actual, packet) => {
              await appendAuditRecordInTransaction(actual, {
                auditId: packet.audit.auditReference,
                brandId: brand,
                storeId: store,
                actor: { type: "User", reference: packet.audit.actorReference },
                actionCode: "STORE_CONFIGURATION_CHANGED",
                targetType: "StoreConfiguration",
                targetId: packet.operation.configuration.configurationReference,
                correlationId: packet.operation.operationReference,
                reasonCode: "CONTROLLED_REFERENCE_BINDING",
                occurredAt: packet.audit.occurredAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "STORE_CONFIGURATION_AUDIT",
                retentionPolicyVersion: 1,
              });
              if (latePermission !== null) {
                const grant = latePermission;
                latePermission = null;
                await actual.query("RESET ROLE", []);
                assert.equal(
                  (
                    await actual.query(
                      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
                      [grant],
                    )
                  ).rowCount,
                  1,
                );
                await actual.query("SET LOCAL ROLE " + role, []);
              }
              if (lateSetupMutation) {
                lateSetupMutation = false;
                lateSetupCheckpoint = "AppendReached";
                try {
                  const { originalObservedAt, originalValidUntil } = originalClock();
                  lateChildStage = "Construction";
                  const owned = createPostgresStoreSetupDraftStore({
                    ...scope,
                    transaction: actual,
                    clock: { now },
                    originalObservedAt,
                    originalValidUntil,
                    registerBeforeCommit: (same, guard, final) => {
                      lateChildStage = "Registration";
                      assert.equal(same, actual);
                      sourceHost.registerAfterCommit(same, () => {
                        owned.assertFinalized(same);
                      });
                      return sourceHost.registerBeforeCommit(same, guard, final);
                    },
                    references: { ...refs, nextReference: next },
                    authority: {
                      async holdUntilTransactionCompletes(same, p) {
                        lateChildStage = "Authority";
                        assert.equal(same, actual);
                        assert.equal(p.permission, "organization.manage");
                        assert.equal(
                          (await selected.authorizeAction("organization.manage"))?.effect,
                          "Allow",
                        );
                        return {
                          validUntil:
                            selected.authorizationValidUntil() < originalValidUntil
                              ? selected.authorizationValidUntil()
                              : originalValidUntil,
                        };
                      },
                    },
                    withCurrentSaveScope: async (same, _p, work) => {
                      lateChildStage = "SaveScope";
                      assert.equal(same, actual);
                      assert(await selected.allowed());
                      const completed = await work({
                        tenantReference: tenant,
                        brandReference: brand,
                        storeReference: store,
                        actorReference: actor,
                        defaultLocale: selected.store.locale,
                        currencyCode: selected.store.currencyCode,
                        baseConfigurationReference: null,
                      });
                      lateChildStage = "ReturnedSaveScope";
                      return completed;
                    },
                    appendAudit: async (same, p) => {
                      lateChildStage = "ChildAudit";
                      assert.equal(same, actual);
                      await appendAuditRecordInTransaction(same, {
                        auditId: p.auditReference,
                        brandId: brand,
                        storeId: store,
                        actor: { type: "User", reference: p.actorReference },
                        actionCode: "STORE_SETUP_DRAFT_SAVED",
                        targetType: "StoreSetupDraft",
                        targetId: setup.setupDraftReference,
                        correlationId: p.operationReference,
                        reasonCode: "INTERNAL_TEST",
                        occurredAt: p.occurredAt,
                        sourceChannel: "MERCHANT_WEB",
                        dataClassification: "Internal",
                        retentionPolicyCode: "OPERATIONAL",
                        retentionPolicyVersion: 1,
                      });
                      lateChildStage = "ChildAuditCompleted";
                    },
                  });
                  lateChildStage = "Save";
                  await owned.save({
                    profile: "StoreSetupSaveV2",
                    ...scope,
                    operationReference: next(),
                    expectedSetupReference: setup.setupDraftReference,
                    expectedRevision: setup.revision,
                    purposeCode: "STORE_SETUP_DRAFT",
                    content: {
                      ...setup.content,
                      businessDayStartLocalTime: { state: "Configured", value: "05:00:00" },
                    },
                  });
                  lateSetupCheckpoint = "SuccessorSaved";
                } catch (error) {
                  lateChildFailure = {
                    kind:
                      error instanceof assert.AssertionError
                        ? "Assertion"
                        : error instanceof TypeError
                          ? "TypeError"
                          : error instanceof Error
                            ? "Error"
                            : "Other",
                    code:
                      typeof error?.code === "string" &&
                      /^STORE_SETUP_OPERATION_[A-Z_]{1,96}$/u.test(error.code)
                        ? error.code
                        : "NONE",
                  };
                  throw error;
                }
              }
            },
          };
        },
      },
    };
  };
  const validators = new WeakMap(),
    gateSources = new WeakMap();
  const listen = async (reader, work) => {
    const app = express();
    app.use((_request, _response, nextMiddleware) => requestClock.run(now(), nextMiddleware));
    app.use("/merchant", createMerchantBffRouter(createMerchantRuntime(optionsFor(reader))));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const selected = { ...scope, actorReference: reader === manager ? id(9) : actor };
    const send = (
      path,
      body,
      { csrf = reader.csrf, dropReply = false, expectedScope = selected } = {},
    ) =>
      new Promise((resolve, reject) => {
        const bytes = body === undefined ? null : JSON.stringify(body);
        const req = request(
          {
            host: "127.0.0.1",
            port: address.port,
            method: bytes === null ? "GET" : "POST",
            path: "/merchant/store-configuration/" + path,
            headers: {
              host: "merchant.invalid",
              origin: "https://merchant.invalid",
              "sec-fetch-site": "same-origin",
              cookie: "__Host-bop-merchant=" + reader.sessionCookie,
              "x-bop-store-setup-scope": Buffer.from(canonicalizeRfc8785(expectedScope)).toString(
                "base64url",
              ),
              ...(bytes === null
                ? {}
                : {
                    "x-bop-csrf": csrf,
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(bytes),
                  }),
            },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              assert.equal(response.headers["cache-control"], "no-store");
              resolve(
                dropReply
                  ? { outcome: "Unknown" }
                  : {
                      status: response.statusCode,
                      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                    },
              );
            });
          },
        );
        req.on("error", reject);
        req.end(bytes ?? undefined);
      });
    try {
      return await work(send, selected);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*) FROM rms_store.store_configuration_authoring_operation)::text legacy,(SELECT count(*) FROM rms_store.store_configuration_original_operation)::text originals,(SELECT count(*) FROM platform_audit.audit_record)::text audits,(SELECT count(*) FROM bop_publishing.publishing_mutation_record)::text core,(SELECT count(*) FROM rms_store.store_setup_draft_revision)::text setupRevisions,(SELECT count(*) FROM rms_store.store_setup_draft_operation)::text setupOperations,(SELECT count(*) FROM rms_store.store_configuration_version)::text published",
      )
    ).rows[0];
  const resolve = (command) => ({
    ...command,
    profile: "StoreConfigurationOrdinaryResolveV1",
    intentDigest: hash(command),
  });
  const bounded = (workspace) => {
    assert(Date.parse(workspace.validUntil) > Date.parse(workspace.observedAt));
    assert(Date.parse(workspace.validUntil) - Date.parse(workspace.observedAt) <= 5000);
    assert.equal(workspace.businessReferenceValidation, "NotEvaluated");
  };
  await listen(session, async (send, selected) => {
    let workspace = (await send("ordinary?expectedStoreReference=" + store)).body;
    bounded(workspace);
    assert.equal(workspace.latest, null);
    const command = (action, head, extra = {}) =>
      parseStoreConfigurationOrdinaryCommand({
        profile: "StoreConfigurationOrdinaryCommandV1",
        ...selected,
        operationReference: next(),
        action,
        expectedHead: head,
        ...extra,
      });
    const materialize = command("Materialize", workspace.expectedHead, {
      setupSelector: {
        setupDraftReference: setup.setupDraftReference,
        sourceRevision: setup.revision,
        sourceSnapshotDigest: hash(setup),
      },
      reasonCode: "INTERNAL_TEST",
    });
    const before = await counts();
    assert.equal(
      (
        await send("ordinary?expectedStoreReference=" + store, undefined, {
          expectedScope: { ...selected, actorReference: next() },
        })
      ).status,
      403,
    );
    assert.deepEqual(await counts(), before);
    lateSetupMutation = true;
    lastFailure = null;
    lateSetupCheckpoint = "BeforeAppend";
    factsCheckpoint = "NotStarted";
    factFailure = null;
    lateChildStage = "NotStarted";
    lateChildFailure = null;
    falseFields = [];
    const lateSetupReply = await send("ordinary-command", {
      command: { ...materialize, operationReference: next() },
    });
    assert.equal(
      lateSetupReply.status,
      409,
      "LATE_SETUP_DIAGNOSTIC:" +
        lateSetupCheckpoint +
        ":" +
        (lastFailure?.kind ?? "NONE") +
        ":" +
        (lastFailure?.code ?? "NONE") +
        ":Facts:" +
        factsCheckpoint +
        ":" +
        (factFailure?.kind ?? "NONE") +
        ":" +
        (factFailure?.code ?? "NONE") +
        ":LateChild:" +
        lateChildStage +
        ":" +
        (lateChildFailure?.kind ?? "NONE") +
        ":" +
        (lateChildFailure?.code ?? "NONE") +
        ":FalseFields:" +
        falseFields.join(","),
    );
    assert.deepEqual(await counts(), before);
    latePermission = grants.get(session.sessionCookie + "store.service.save-draft");
    assert.equal(
      (await send("ordinary-command", { command: { ...materialize, operationReference: next() } }))
        .status,
      403,
    );
    assert.deepEqual(await counts(), before);
    assert.deepEqual(
      await send("ordinary-command", { command: materialize }, { dropReply: true }),
      { outcome: "Unknown" },
    );
    const materialized = await send("ordinary-command", { command: resolve(materialize) });
    assert.equal(materialized.status, 200);
    assert.equal(materialized.body.outcome, "Committed");
    const after = await counts();
    assert.equal(Number(after.originals), Number(before.originals) + 1);
    assert.deepEqual(
      (await send("ordinary-command", { command: materialize })).body,
      materialized.body,
    );
    assert.deepEqual(await counts(), after);
    workspace = (
      await send("ordinary-state", {
        original: resolve(materialize),
        expectedStoreReference: store,
      })
    ).body;
    assert.deepEqual(workspace.original, materialized.body);
    assert.equal(workspace.latest.setupBasis.sourceSnapshotDigest, hash(setup));
    const competing = [
      command("Validate", workspace.expectedHead),
      command("Validate", workspace.expectedHead),
    ];
    const race = await Promise.all(
      competing.map((own) => send("ordinary-command", { command: own })),
    );
    assert.equal(race.filter((value) => value.status === 200).length, 1);
    assert(race.every((value) => [200, 409, 503].includes(value.status)));
    const raceCounts = await counts();
    assert.equal(Number(raceCounts.originals), Number(after.originals) + 1);
    assert.equal(Number(raceCounts.legacy), Number(after.legacy) + 1);
    workspace = (await send("ordinary?expectedStoreReference=" + store)).body;
    for (const action of ["Validate", "Submit"]) {
      const response = await send("ordinary-command", {
        command: command(action, workspace.expectedHead),
      });
      assert.equal(response.status, 200);
      parseStoreConfigurationOrdinaryReceipt(response.body);
      workspace = (await send("ordinary?expectedStoreReference=" + store)).body;
    }
    assert.equal(workspace.latest.lifecycle, "PendingApproval");
    await listen(manager, async (second, managerScope) => {
      let state = (await second("ordinary?expectedStoreReference=" + store)).body;
      for (const action of ["Approve", "Publish"]) {
        const own = parseStoreConfigurationOrdinaryCommand({
          profile: "StoreConfigurationOrdinaryCommandV1",
          ...managerScope,
          operationReference: next(),
          action,
          expectedHead: state.expectedHead,
        });
        if (action === "Publish") {
          const beforePublish = await counts();
          latePermission = grants.get(manager.sessionCookie + "store.service.publish");
          assert.equal(
            (await second("ordinary-command", { command: { ...own, operationReference: next() } }))
              .status,
            403,
          );
          assert.deepEqual(await counts(), beforePublish);
        }
        const response = await second("ordinary-command", { command: own });
        assert.equal(response.status, 200);
        assert.equal(response.body.outcome, "Committed");
        const snapshot = await counts();
        assert.deepEqual(
          (await second("ordinary-command", { command: resolve(own) })).body,
          response.body,
        );
        assert.deepEqual(await counts(), snapshot);
        state = (
          await second("ordinary-state", { original: resolve(own), expectedStoreReference: store })
        ).body;
        bounded(state);
      }
      assert.equal(state.current.lifecycle, "Published");
      assert.equal(state.current.approvedByReference, id(9));
      assert.equal(state.current.authoredByReference, actor);
      assert.deepEqual(state.current.setupBasis.feeContexts, setup.content.feeContexts.value);
      const beforeHistory = await counts(),
        allEntries = [];
      let beforeSequence = null;
      do {
        const response = await second("ordinary-history", {
          expectedStoreReference: store,
          beforeSequence,
        });
        assert.equal(response.status, 200);
        const page = response.body;
        assert.equal(page.tenantReference, tenant);
        assert.equal(page.brandReference, brand);
        assert.equal(page.storeReference, store);
        assert.equal(page.readerActorReference, managerScope.actorReference);
        assert.equal(page.beforeSequence, beforeSequence);
        assert(page.entries.length <= 2);
        assert(Date.parse(page.validUntil) - Date.parse(page.observedAt) <= 5000);
        for (const entry of page.entries) {
          assert(
            entry.sequenceNumber < (allEntries.at(-1)?.sequenceNumber ?? Number.MAX_SAFE_INTEGER),
          );
          allEntries.push(entry);
        }
        beforeSequence = page.nextBeforeSequence;
      } while (beforeSequence !== null);
      assert.equal(allEntries.length, Number(beforeHistory.legacy) - Number(before.legacy));
      assert.equal(allEntries.at(-1).operationReference, materialize.operationReference);
      assert.equal(allEntries.at(-1).actorReference, actor);
      assert.notEqual(allEntries.at(-1).actorReference, managerScope.actorReference);
      assert.equal(allEntries[0].actorReference, managerScope.actorReference);
      assert.deepEqual(await counts(), beforeHistory);
    });
    workspace = (await send("ordinary?expectedStoreReference=" + store)).body;
    bounded(workspace);
    const historical = await send("ordinary-state", {
      original: resolve(materialize),
      expectedStoreReference: store,
    });
    assert.equal(historical.status, 200);
    assert.deepEqual(historical.body.original, materialized.body);
    assert.equal(historical.body.current.lifecycle, "Published");
    assert.notDeepEqual(historical.body.expectedHead, materialize.expectedHead);
    // Controlled raw legacy schema integrity attack, not an actual Audit or
    // business operation. PostgreSQL preserves the submillisecond value; the
    // public owning history reader must refuse the complete page and rollback.
    const beforeRaw = await counts(),
      rawOperation = next();
    await assert.rejects(
      transactions.run(async (tx) => {
        const originalObservedAt = now(),
          originalValidUntil = new Date(Date.parse(originalObservedAt) + 5000).toISOString();
        const currentScope = await createMerchantStoreScope({
          ...session.persistence,
          transactions,
          now,
        })(tx, session.sessionCookie, "store.service.read");
        assert(await currentScope.allowed());
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        assert.equal(
          (
            await tx.query(
              "INSERT INTO rms_store.store_configuration_authoring_operation(operation_id,brand_id,store_id,sequence_number,configuration_id,configuration_version,command_type,lifecycle,expected_version,intent_digest,configuration_json,actor_reference,purpose_code,audit_reference,occurred_at,data_classification) SELECT $1::platform_helpers.uuid_v7,brand_id,store_id,sequence_number+1,configuration_id,configuration_version,command_type,lifecycle,expected_version,intent_digest,configuration_json,actor_reference,purpose_code,$2::platform_helpers.uuid_v7,occurred_at+interval '0.000123 second',data_classification FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$3::platform_helpers.uuid_v7 AND store_id=$4::platform_helpers.uuid_v7 ORDER BY sequence_number DESC LIMIT 1",
              [rawOperation, next(), brand, store],
            )
          ).rowCount,
          1,
        );
        const raw = (
          await tx.query(
            "SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') exact_time FROM rms_store.store_configuration_authoring_operation WHERE operation_id=$1",
            [rawOperation],
          )
        ).rows[0];
        assert.match(raw.exact_time, /\.[0-9]{3}123Z$/u);
        const history = createPostgresStoreConfigurationHistorySource({
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          readerActorReference: actor,
          transaction: tx,
          clock: { now },
          originalObservedAt,
          originalValidUntil,
          canonicalize: canonicalizeRfc8785,
          registerBeforeCommit: (actual, guard, final) => {
            assert.equal(actual, tx);
            ownerHooks.get(tx).push({ guard, final });
          },
          authority: {
            async holdUntilTransactionCompletes(actual, packet) {
              assert.equal(actual, tx);
              assert.equal(packet.permission, "store.service.read");
              assert.equal(packet.purposeCode, "STORE_CONFIGURATION_HISTORY");
              for (const [key, value] of Object.entries(scope)) assert.equal(packet[key], value);
              assert.deepEqual(packet.requiredFields, storeConfigurationHistoryRequiredFields);
              assert(await currentScope.allowed());
              return {
                validUntil:
                  currentScope.authorizationValidUntil() < originalValidUntil
                    ? currentScope.authorizationValidUntil()
                    : originalValidUntil,
              };
            },
          },
        });
        await history.readPage({ beforeSequence: null });
        assert.fail("submillisecond legacy history must refuse the full page");
      }),
      { code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE" },
    );
    assert.deepEqual(await counts(), beforeRaw);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::text count FROM rms_store.store_configuration_authoring_operation WHERE operation_id=$1",
          [rawOperation],
        )
      ).rows[0].count,
      "0",
    );
    const absent = command("Validate", workspace.expectedHead),
      noWrite = await counts();
    const abandoned = await send("ordinary-command", { command: resolve(absent) });
    assert.equal(abandoned.status, 200);
    assert.equal(abandoned.body.outcome, "Abandoned");
    const terminal = await counts();
    assert.equal(terminal.legacy, noWrite.legacy);
    assert.equal(terminal.core, noWrite.core);
    assert.deepEqual((await send("ordinary-command", { command: absent })).body, abandoned.body);
    assert.deepEqual(await counts(), terminal);
    const denied = await send("ordinary-command", { command: absent }, { csrf: "x".repeat(43) });
    assert.equal(denied.status, 403);
    assert.deepEqual(await counts(), terminal);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grants.get(session.sessionCookie + "store.service.validate")],
    );
    assert.equal((await send("ordinary-command", { command: resolve(absent) })).status, 403);
    assert.deepEqual(await counts(), terminal);
  });
}
