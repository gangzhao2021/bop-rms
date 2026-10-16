import { createMerchantStoreConfiguration } from "../../apps/api/dist/merchant-store-configuration.js";
import {
  createMerchantStoreHoursSetupDraft,
  createMerchantStoreHoursSetupRestore,
} from "../../apps/api/dist/merchant-store-hours-setup-draft.js";
import {
  createPersistentStoreConfigurationV2Preparation,
  createStoreConfigurationVersion,
} from "../../packages/rms/store/src/index.ts";
import { appendAuditRecordInTransaction, sha256Hex } from "../../packages/bop/audit/src/index.ts";
import { logUnexpected } from "./pilot-merchant-pickup.mjs";
import { createInternalRefundWorkforceContext } from "./pilot-refund-workforce.mjs";
import {
  createStoreConfigurationV2Ports,
  readPublishedStoreConfiguration,
} from "./pilot-store-publication.mjs";

/**
 * WP-2423 Q4: store hours and holiday editing for the single-store pilot.
 *
 * A store manager drafts and submits weekly hours and dated closures; a different person (the
 * owner) approves and publishes. Only the weekly schedule, dated exceptions and the change reason
 * may differ from the published configuration: tax, payment, receipt, address, contact, service
 * modes, business-day start and time zone stay owned by their own setup flows.
 *
 * Once the Owner has published a configuration from Store setup (it carries a setup basis), an
 * hours change is an hours-only Store setup revision and the draft configuration made from it
 * (`hoursDraft`, one transaction); its Submit, Approve and Publish are Publishing review steps
 * (the V2 preparation), with the same people: the Store Manager submits, the Owner approves and
 * publishes.
 */
const fail = (code) => {
  throw new Error(code);
};
const DAY_MS = 86400000;
// Every content field other than hours, closures, the reason and the effective window.
const LOCKED_FIELDS = Object.freeze([
  "brandReference",
  "storeReference",
  "source",
  "brandBaseVersionReference",
  "defaultLocale",
  "currencyCode",
  "timeZone",
  "businessDayStartLocalTime",
  "addressReference",
  "contactReference",
  "receiptReference",
  "taxConfigurationReference",
  "paymentConfigurationReference",
  "capacityConfigurationReference",
  "enabledServiceModes",
  "dataClassification",
]);

/**
 * WP-2423 Q4: a candidate may change only hours and dated exceptions. It takes effect from no later
 * than now and no earlier than the published version, with no end, so the operating reader always
 * selects it as the successor once published (a future or bounded window would leave a gap).
 */
export function storeHoursChangeAllowed(baseline, configuration, now) {
  if (baseline === null) return false;
  // A configuration from Store setup stays one: same tenant and fee settings (its basis may name a
  // newer, hours-only Store setup revision). An installed configuration stays without one.
  if ((baseline.setupBasis === undefined) !== (configuration.setupBasis === undefined))
    return false;
  if (
    baseline.setupBasis !== undefined &&
    (configuration.setupBasis.tenantReference !== baseline.setupBasis.tenantReference ||
      JSON.stringify(configuration.setupBasis.feeContexts) !==
        JSON.stringify(baseline.setupBasis.feeContexts))
  )
    return false;
  for (const field of LOCKED_FIELDS)
    if (JSON.stringify(configuration[field]) !== JSON.stringify(baseline[field])) return false;
  return (
    configuration.effectiveUntil === null &&
    Date.parse(configuration.effectiveFrom) <= Date.parse(now) &&
    Date.parse(configuration.effectiveFrom) >= Date.parse(baseline.effectiveFrom)
  );
}

/** WP-2423 Q4: the review evidence an owner's approval records; valid for seven days. */
export function storeHoursReview(baseline, at) {
  if (baseline === null || baseline.liveGateEvidenceReference === null)
    return fail("PILOT_STORE_CONFIGURATION_UNAVAILABLE");
  return Object.freeze({
    validUntil: new Date(Date.parse(at) + 7 * DAY_MS).toISOString(),
    checkCodes: Object.freeze(["STORE_HOURS_REFERENCES_UNCHANGED"]),
    liveGateEvidenceReference: baseline.liveGateEvidenceReference,
  });
}

export async function createInternalStoreConfiguration(resources, { persistence, service }) {
  const operating = resources.operating;
  const publication = {
    tenantReference: operating.tenantReference,
    configurationType: operating.configurationType,
    purposeCode: operating.purposeCode,
    requiredLiveGateRequirementCodes: operating.requiredLiveGateRequirementCodes,
    // A configuration from Store setup is verified with its own check inventory and provenance.
    requiredValidationCheckCodes: operating.requiredValidationCheckCodes,
    setupSnapshotReferences: operating.setupSnapshotReferences,
    hashContent: operating.hashContent,
  };
  // The Store's publishing family and business-day start source, read once at start (either an
  // installed configuration or one published from Store setup).
  const startup = await resources.transactions.run((tx) =>
    readPublishedStoreConfiguration(operating, tx, resources.now(), operating.authorize),
  );
  const familyReference = startup.familyReference,
    businessDayStartSource = startup.businessDayStartSource;
  const hashIntent = (text) => "sha256:" + sha256Hex(text);
  const audit = (input) =>
    Object.freeze({
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
      ...input,
    });
  // The run context of the V2 ports (validation, approval deadline, go-live evidence).
  const runs = new WeakMap();
  const v2 = createStoreConfigurationV2Ports(
    resources,
    (tx) => runs.get(tx) ?? fail("PILOT_STORE_HOURS_CONTEXT_UNAVAILABLE"),
  );
  const options = {
    persistence,
    authentication: service,
    actionPermissions: {
      saveDraft: "store.service.save-draft",
      validate: "store.service.validate",
      submit: "store.service.submit",
      approve: "store.service.approve",
      publish: "store.service.publish",
    },
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
    configure: (tx, scope, publishing) => {
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
      const publishedBaseline = logUnexpected(
        "INTERNAL_STORE_HOURS_BASELINE_UNAVAILABLE",
        async (actual) => (await readPublished(actual)).configuration,
      );
      // Only hours, dated exceptions and the effective window differ from the published one.
      const hoursOnly = async (configuration) =>
        storeHoursChangeAllowed(
          await publishedBaseline(tx),
          createStoreConfigurationVersion(configuration),
          resources.now(),
        );
      runs.set(tx, { authorize, references: hoursOnly, published: () => readPublished(tx) });
      // The run's own original observation (its command time), as the preparation requires.
      const origin = publishing.observedAt;
      // Submit, Approve and Publish of a configuration from Store setup are Publishing review
      // steps, taken with the Publishing decisions this run resolved for the command.
      const preparation = createPersistentStoreConfigurationV2Preparation({
        ...v2,
        tenantReference: scope.selected.tenantReference,
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
        publishingFamilyReference: familyReference,
        configurationType: operating.configurationType,
        purposeCode: operating.purposeCode,
        originalObservedAt: origin,
        originalValidUntil: new Date(Date.parse(origin) + 5000).toISOString(),
        clock: { now: resources.now },
        setupSnapshotReferences: operating.setupSnapshotReferences,
        nextReference: () => resources.credentials.reference(),
        hashContent: operating.hashContent,
        currentTenantContext: async () => scope.context,
        publishingAuthorization: () => publishing,
        // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: only when the Owner asked to approve their own
        // hours change alone; the API decides it in this transaction.
        ...(publishing.soleOperatorApproval === undefined
          ? {}
          : { soleOperatorApproval: publishing.soleOperatorApproval }),
      });
      return {
        publication: {
          ...publication,
          tenantReference: scope.selected.tenantReference,
          publishingFamilyReference: familyReference,
          authorize,
        },
        ports: (actual) => ({
          authorization: {
            authorize: logUnexpected("INTERNAL_STORE_HOURS_AUTHORIZE_UNAVAILABLE", () =>
              scope.allowed(),
            ),
          },
          references: {
            hashIntent,
            equals: (left, right) => left === right,
            validateControlledReferences: logUnexpected(
              "INTERNAL_STORE_HOURS_REFERENCES_UNAVAILABLE",
              hoursOnly,
            ),
            validateBrandBaseCompatibility: logUnexpected(
              "INTERNAL_STORE_HOURS_BRAND_BASE_UNAVAILABLE",
              async (configuration) =>
                (await publishedBaseline(tx)).brandBaseVersionReference ===
                configuration.brandBaseVersionReference,
            ),
          },
          // An installed configuration keeps the hours editor's own review path.
          prepareFresh: async (action, packet, prior) =>
            packet.configuration.setupBasis === undefined
              ? packet.configuration
              : preparation.forTransaction(actual)(action, packet, prior),
        }),
        publishedBaseline,
        businessDayStartSource,
        nextReference: () => resources.credentials.reference(),
        appendAudit: (actual, input) =>
          logUnexpected("INTERNAL_STORE_HOURS_AUDIT_UNAVAILABLE", async () => {
            await appendAuditRecordInTransaction(
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
                      reasonCode: "STORE_HOURS_CHANGE_SOLE_OPERATOR",
                      afterSummary: { approvalMode: "SoleOperator" },
                    }
                  : { reasonCode: "STORE_HOURS_CHANGE" }),
                occurredAt: input.audit.occurredAt,
              }),
            );
          })(),
      };
    },
    review: {
      validate: async (tx, scope, _configuration, at) =>
        storeHoursReview(
          (
            await readPublishedStoreConfiguration(
              operating,
              tx,
              at,
              async (transaction, observedAt) =>
                (await scope.allowed()) && (await operating.authorize(transaction, observedAt)),
            )
          ).configuration,
          at,
        ),
      snapshotAudit: async (tx, input) =>
        appendAuditRecordInTransaction(
          tx,
          audit({
            auditId: input.auditReference,
            brandId: operating.brandReference,
            storeId: operating.storeReference,
            actor: { type: "User", reference: input.actorReference },
            actionCode: "STORE_CONFIGURATION_CHANGED",
            targetType: "StoreConfiguration",
            targetId: input.reviewedPublication.configurationReference,
            correlationId: input.lifecycleReference,
            reasonCode: "STORE_HOURS_REVIEW",
            occurredAt: input.recordedAt,
          }),
        ),
    },
  };
  // WP-2423 Q4: `hoursDraft` saves an hours change on a Store whose configuration came from Store
  // setup, through the same owner ports.
  return Object.assign(createMerchantStoreConfiguration(options), {
    hoursDraft: createMerchantStoreHoursSetupDraft(options),
    // WP-2423 (2026-10-16 v15): after a withdrawal, Store setup's saved hours return to the
    // published hours (an appended hours-only revision).
    hoursRestore: createMerchantStoreHoursSetupRestore(options),
  });
}
