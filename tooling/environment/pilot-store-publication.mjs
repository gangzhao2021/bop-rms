import { createMerchantStoreConfigurationOrdinary } from "../../apps/api/dist/merchant-store-configuration-ordinary.js";
import { createMerchantStoreConfigurationReferenceSources } from "../../apps/api/dist/merchant-store-configuration-reference-sources.js";
import {
  evaluateStoreConfigurationPublication,
  storeConfigurationPublicationReady,
} from "../../apps/api/dist/merchant-store-configuration-publication-checks.js";
import {
  createPostgresAsPublishedStorePublicationProof,
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreBusinessDateSource,
  StoreConfigurationAdministrationServiceError,
} from "../../packages/rms/store/src/index.ts";
import { createPostgresCurrentLiveGateSource } from "../../packages/bop/publishing/src/index.ts";
import { currentStoreTaxConfigurationReference } from "../../packages/rms/pricing/src/index.ts";
import { appendAuditRecordInTransaction, sha256Hex } from "../../packages/bop/audit/src/index.ts";
import { createInternalRefundWorkforceContext } from "./pilot-refund-workforce.mjs";
import {
  storeConfigurationContentHash,
  storeConfigurationSetupSnapshotReferences,
  storeConfigurationValidationCheckCodes,
} from "./pilot-store-publication-codes.mjs";

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: the Owner publishes a Store setup draft as the Store's
 * configuration (Store setup step 8): create from the saved setup, send for approval, another
 * person with Owner access approves (or, Owner decision 2026-10-16, the Owner alone while sole
 * operator is in effect for them, re-verified within 15 minutes and recorded as such), publish. Versions stay append-only with Publishing review
 * records and audit. The checks every publication must pass are read in product (tax settings in
 * force, Brand settings unchanged, the Store's own time zone, opening hours, a start that is not in
 * the future, fees, and the Store's approved go-live check); the saved address, contact, payment
 * and receipt settings are read again from their owners when the configuration is sent.
 */
const fail = (code) => {
  throw new Error(code);
};
const DAY_MS = 86400000;
/** A configuration created from setup must be approved and published within 14 days. */
export const storeConfigurationPublicationWindowMs = 14 * DAY_MS;
export const storeConfigurationPublicationPermissions = Object.freeze({
  saveDraft: "store.service.save-draft",
  validate: "store.service.validate",
  submit: "store.service.submit",
  approve: "store.service.approve",
  publish: "store.service.publish",
});

/** The Store's current published configuration and its publication proof (current release). */
export async function readPublishedStoreConfiguration(
  operating,
  tx,
  at,
  authorize,
  basis = "Current",
) {
  // "AsPublished" verifies the configuration in force against the release that published it; the
  // publish step uses it after recording the new release in the same transaction.
  const prove =
    basis === "AsPublished"
      ? createPostgresAsPublishedStorePublicationProof
      : createPostgresCurrentStorePublicationProof;
  let proof;
  await createPostgresStoreBusinessDateSource({
    brandReference: operating.brandReference,
    storeReference: operating.storeReference,
    timeZone: operating.timeZone,
    authorize,
    publicationProof: async (transaction, candidate, observedAt) => {
      proof = await prove({
        tenantReference: operating.tenantReference,
        configurationType: operating.configurationType,
        purposeCode: operating.purposeCode,
        requiredLiveGateRequirementCodes: operating.requiredLiveGateRequirementCodes,
        requiredValidationCheckCodes: operating.requiredValidationCheckCodes,
        setupSnapshotReferences: operating.setupSnapshotReferences,
        hashContent: operating.hashContent,
        brandReference: operating.brandReference,
        storeReference: operating.storeReference,
        configurationReference: candidate.configurationReference,
        authorize,
      })(transaction, observedAt);
      return {
        contentDigest: proof.contentDigest,
        businessDayStartSource: proof.businessDayStartSource,
      };
    },
  })(tx, at);
  if (!proof) return fail("PILOT_STORE_CONFIGURATION_UNAVAILABLE");
  return proof;
}

/** The publication facts and checks of one configuration, read in the caller's transaction. */
export async function storeConfigurationPublicationChecks(operating, tx, input) {
  const { configuration, published, at, authorize } = input;
  let goLive = false;
  if (published.configuration.liveGateEvidenceReference !== null)
    try {
      await createPostgresCurrentLiveGateSource({
        tenantReference: operating.tenantReference,
        brandReference: operating.brandReference,
        storeReference: operating.storeReference,
        decisionEvidenceReference: published.configuration.liveGateEvidenceReference,
        requiredRequirementCodes: operating.requiredLiveGateRequirementCodes,
        authorize,
      })(tx, at);
      goLive = true;
    } catch {
      goLive = false;
    }
  const tax = await currentStoreTaxConfigurationReference(
    tx,
    { brandReference: operating.brandReference, storeReference: operating.storeReference },
    at,
  );
  return evaluateStoreConfigurationPublication({
    configuration,
    current: published.configuration,
    storeTimeZone: operating.timeZone,
    observedAt: at,
    facts: { tax, goLive },
  });
}

/**
 * The V2 ports (validation, approval deadline, go-live evidence). `context(tx)` is the per-run
 * context its composition registered: `references(configuration)` re-reads the saved references
 * (or, for an hours-only change, compares them with the published configuration) and `authorize`
 * holds the run's authority.
 */
export function createStoreConfigurationV2Ports(resources, context) {
  const operating = resources.operating;
  return {
    requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
    validateSubmit: async (tx, configuration, observedAt) => {
      const run = context(tx);
      if (!(await run.references(configuration)))
        throw new StoreConfigurationAdministrationServiceError(
          "STORE_CONFIGURATION_REFERENCE_INVALID",
        );
      const published = await run.published();
      const checks = await storeConfigurationPublicationChecks(operating, tx, {
        configuration,
        published,
        at: observedAt,
        authorize: run.authorize,
      });
      if (!storeConfigurationPublicationReady(checks))
        throw new StoreConfigurationAdministrationServiceError(
          "STORE_CONFIGURATION_REFERENCE_INVALID",
        );
      return {
        validUntil: new Date(
          Date.parse(configuration.createdAt) + storeConfigurationPublicationWindowMs,
        ).toISOString(),
        checkCodes: storeConfigurationValidationCheckCodes,
      };
    },
    // Same deadline as the validation: approval never outlives the checks it relied on.
    approvalValidUntil: async (_tx, input) =>
      new Date(
        Date.parse(input.configuration.createdAt) + storeConfigurationPublicationWindowMs,
      ).toISOString(),
    // The Store's approved go-live check, read now for the configuration being published. The new
    // release is already recorded in this transaction, so the configuration still in force is
    // verified against the release that published it.
    liveGateEvidence: async (tx, _configuration, observedAt) => {
      const run = context(tx);
      const published = await readPublishedStoreConfiguration(
        operating,
        tx,
        observedAt,
        run.authorize,
        "AsPublished",
      );
      const decision = published.configuration.liveGateEvidenceReference;
      if (decision === null) return fail("PILOT_STORE_GO_LIVE_UNAVAILABLE");
      const record = await createPostgresCurrentLiveGateSource({
        tenantReference: operating.tenantReference,
        brandReference: operating.brandReference,
        storeReference: operating.storeReference,
        decisionEvidenceReference: decision,
        requiredRequirementCodes: operating.requiredLiveGateRequirementCodes,
        authorize: run.authorize,
      })(tx, observedAt);
      return record.decisionEvidenceReference;
    },
  };
}

const audit = (input) =>
  Object.freeze({
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    ...input,
  });

/** The Store configuration publication port of the pilot merchant BFF (Store setup step 8). */
export async function createInternalStoreConfigurationOrdinary(
  resources,
  { persistence, authentication },
) {
  const operating = resources.operating;
  // The Store's publishing family: the one its current configuration was published in.
  const startup = await resources.transactions.run((tx) =>
    readPublishedStoreConfiguration(operating, tx, resources.now(), operating.authorize),
  );
  const familyReference = startup.familyReference;
  const runs = new WeakMap();
  const context = (tx) => runs.get(tx) ?? fail("PILOT_STORE_PUBLICATION_CONTEXT_UNAVAILABLE");
  const options = {
    persistence,
    authentication,
    actionPermissions: storeConfigurationPublicationPermissions,
    nextReference: () => resources.credentials.reference(),
    v2: createStoreConfigurationV2Ports(resources, context),
    // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: who else at the Store holds Store configuration
    // approval, each member read from Identity, Membership and Permission as an approval would be.
    soleOperator: {
      resolveContext: (tx, scope) =>
        createInternalRefundWorkforceContext({
          expected: {
            tenantReference: scope.selected.tenantReference,
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.store.storeReference,
          },
          persistence,
          sessionActorReference: String(scope.actorReference),
          sessionContext: async () => scope.context,
          current: async (t) => t === tx && (await scope.allowed()),
          permissions: ["store.service.approve"],
        }),
    },
    configure: (tx, scope, sourceHost) => {
      const authorize = async (transaction, at) =>
        (await scope.allowed()) && (await operating.authorize(transaction, at));
      let published;
      const readPublished = async (actual) =>
        (published ??= await readPublishedStoreConfiguration(
          operating,
          actual,
          resources.now(),
          authorize,
        ));
      const origin = persistence.now();
      const sources = createMerchantStoreConfigurationReferenceSources({
        persistence,
        sessionCookie: null,
        transaction: tx,
        scope,
        sourceHost,
        originalObservedAt: origin,
        originalValidUntil: new Date(Date.parse(origin) + 5000).toISOString(),
      });
      let verified;
      // The saved address, contact, payment and receipt settings, read from their owners.
      const references = async (configuration) => {
        if (verified === configuration.configurationReference) return true;
        const address = await sources.address(configuration.addressReference),
          contact = await sources.contact(configuration.contactReference),
          payment = await sources.payment(configuration.paymentConfigurationReference),
          receipt = await sources.receipt(configuration.receiptReference);
        const ok =
          String(address.reference) === configuration.addressReference &&
          String(contact.reference) === configuration.contactReference &&
          String(payment.configurationReference) === configuration.paymentConfigurationReference &&
          String(receipt.templateReference) === configuration.receiptReference;
        if (ok) verified = configuration.configurationReference;
        return ok;
      };
      runs.set(tx, { authorize, references, published: () => readPublished(tx) });
      return {
        publication: {
          tenantReference: operating.tenantReference,
          publishingFamilyReference: familyReference,
          configurationType: operating.configurationType,
          purposeCode: operating.purposeCode,
          requiredLiveGateRequirementCodes: operating.requiredLiveGateRequirementCodes,
          requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
          setupSnapshotReferences: storeConfigurationSetupSnapshotReferences,
          hashContent: storeConfigurationContentHash,
          authorize,
        },
        // The Owner chose this business-day start in Store setup.
        businessDayStartSource: "StoreOverride",
        nextReference: () => resources.credentials.reference(),
        publishedBaseline: async (actual) => (await readPublished(actual)).configuration,
        ports: () => ({
          authorization: { authorize: async () => scope.allowed() },
          references: {
            hashIntent: (text) => "sha256:" + sha256Hex(text),
            equals: (left, right) => left === right,
            validateControlledReferences: references,
            // Brand settings are not changed in Store setup: the live configuration's stay.
            validateBrandBaseCompatibility: async (configuration) =>
              (await readPublished(tx)).configuration.brandBaseVersionReference ===
              configuration.brandBaseVersionReference,
          },
        }),
        appendAudit: async (actual, input) =>
          appendAuditRecordInTransaction(
            actual,
            audit({
              auditId: input.audit.auditReference,
              brandId: scope.context.brand.brandReference,
              storeId: scope.store.storeReference,
              actor: { type: "User", reference: input.audit.actorReference },
              actionCode: "STORE_CONFIGURATION_CHANGED",
              targetType: "StoreConfiguration",
              targetId: input.operation.configuration.configurationReference,
              correlationId: input.operation.operationReference,
              // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the Owner's own approval, given alone.
              ...(input.approvalMode === "SoleOperator"
                ? {
                    reasonCode: "STORE_SETUP_PUBLICATION_SOLE_OPERATOR",
                    afterSummary: { approvalMode: "SoleOperator" },
                  }
                : { reasonCode: "STORE_SETUP_PUBLICATION" }),
              occurredAt: input.audit.occurredAt,
            }),
          ),
        publicationChecks: async (configuration) => {
          const at = resources.now();
          return storeConfigurationPublicationChecks(operating, tx, {
            configuration,
            published: await readPublished(tx),
            at,
            authorize,
          });
        },
      };
    },
  };
  return createMerchantStoreConfigurationOrdinary(options);
}
