import { createMerchantStoreConfiguration } from "../../apps/api/dist/merchant-store-configuration.js";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreBusinessDateSource,
  createStoreConfigurationVersion,
} from "../../packages/rms/store/src/index.ts";
import { appendAuditRecordInTransaction, sha256Hex } from "../../packages/bop/audit/src/index.ts";
import { logUnexpected } from "./pilot-merchant-pickup.mjs";

/**
 * WP-2423 Q4: store hours and holiday editing for the single-store pilot.
 *
 * A store manager drafts and submits weekly hours and dated closures; a different person (the
 * owner) approves and publishes. Only the weekly schedule, dated exceptions and the change reason
 * may differ from the published configuration: tax, payment, receipt, address, contact, service
 * modes, business-day start and time zone stay owned by their own setup flows.
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
  if (baseline === null || baseline.setupBasis !== undefined) return false;
  if (configuration.setupBasis !== undefined) return false;
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
    hashContent: operating.hashContent,
  };
  // The Store's current published configuration and its publication proof.
  const readPublished = async (tx, at, authorize) => {
    let proof;
    await createPostgresStoreBusinessDateSource({
      brandReference: operating.brandReference,
      storeReference: operating.storeReference,
      timeZone: operating.timeZone,
      authorize,
      publicationProof: async (transaction, candidate, observedAt) => {
        proof = await createPostgresCurrentStorePublicationProof({
          ...publication,
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
  };
  // Read once at start: a Store whose published configuration cannot be edited here refuses to
  // start instead of failing on the first save.
  const startup = await resources.transactions.run((tx) =>
    readPublished(tx, resources.now(), operating.authorize),
  );
  if (startup.configuration.setupBasis !== undefined)
    return fail("PILOT_STORE_CONFIGURATION_SETUP_BASIS_UNSUPPORTED");
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
  return createMerchantStoreConfiguration({
    persistence,
    authentication: service,
    actionPermissions: {
      saveDraft: "store.service.save-draft",
      validate: "store.service.validate",
      submit: "store.service.submit",
      approve: "store.service.approve",
      publish: "store.service.publish",
    },
    configure: (_tx, scope) => {
      const authorize = async (transaction, at) =>
        (await scope.allowed()) && (await operating.authorize(transaction, at));
      const publishedBaseline = logUnexpected(
        "INTERNAL_STORE_HOURS_BASELINE_UNAVAILABLE",
        async (tx) => (await readPublished(tx, resources.now(), authorize)).configuration,
      );
      return {
        publication: {
          ...publication,
          tenantReference: scope.selected.tenantReference,
          publishingFamilyReference: familyReference,
          authorize,
        },
        ports: (tx) => ({
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
              async (configuration) =>
                storeHoursChangeAllowed(
                  await publishedBaseline(tx),
                  createStoreConfigurationVersion(configuration),
                  resources.now(),
                ),
            ),
            validateBrandBaseCompatibility: logUnexpected(
              "INTERNAL_STORE_HOURS_BRAND_BASE_UNAVAILABLE",
              async (configuration) =>
                (await publishedBaseline(tx)).brandBaseVersionReference ===
                configuration.brandBaseVersionReference,
            ),
          },
        }),
        publishedBaseline,
        businessDayStartSource,
        nextReference: () => resources.credentials.reference(),
        appendAudit: (tx, input) =>
          logUnexpected("INTERNAL_STORE_HOURS_AUDIT_UNAVAILABLE", async () => {
            await appendAuditRecordInTransaction(
              tx,
              audit({
                auditId: input.audit.auditReference,
                brandId: scope.context.brand.brandReference,
                storeId: scope.store.storeReference,
                actor: { type: "User", reference: input.audit.actorReference },
                actionCode: "STORE_CONFIGURATION_CHANGED",
                targetType: "StoreConfiguration",
                targetId: input.operation.configuration.configurationReference,
                correlationId: input.operation.operationReference,
                reasonCode: "STORE_HOURS_CHANGE",
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
            await readPublished(
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
  });
}
