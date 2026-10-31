import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import {
  createInternalTestLiveGate,
  createPostgresPublishingMutationStore,
} from "../../packages/bop/publishing/src/index.ts";
import {
  createPostgresPublishedStoreOperatingStatusReader,
  createPostgresStorePublicationAuthorization,
  createPostgresStorePublicationMaterializer,
  createStoreConfigurationVersion,
} from "../../packages/rms/store/src/index.ts";
import { readPublishedStoreConfiguration } from "./pilot-store-publication.mjs";
import {
  storeConfigurationContentHash,
  storeConfigurationSetupSnapshotReferences,
  storeConfigurationValidationCheckCodes,
} from "./pilot-store-publication-codes.mjs";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3b — InternalTest only, a
 * test-environment-only shortcut (coordinator 2026-10-30, Owner standing authority). A TEST Store
 * opened in the product (Stores page) gets what an InternalTest installation needs to serve it,
 * through each owner's own writers, in one transaction, every change audited with the
 * Owner's approval wording:
 *
 * - Publishing: the Store configuration's lifecycle (draft → review with its validation evidence →
 *   approval → release 1);
 * - Publishing: the Store's first `SYNTHETIC-STORE-LIVE-GATE` (Approved, `SYNTHETIC_STORE_READY`
 *   until the installation's validity end);
 * - Store: configuration version 1 materialized from that release — a copy of the source Store's
 *   published weekly hours, service modes and business-day start, in the new Store's own time zone
 *   and language. Its address, contact, receipt, tax and payment references are new and not yet
 *   set: the Owner sets them in Store setup once the Store is served (segment 3c), which publishes
 *   the next version.
 *
 * It commits only when the services' own read role then reads the new Store's published operating
 * status. It refuses outside InternalTest, a Store not opened in the product, one whose name lacks
 * the TEST label ("not production"), and a Store that already has a configuration or launch gate.
 * A real Store is set up through its governed opening (B2), never through this.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*(?:\([a-z_, ]*\))?$/u;
export const internalTestStoreLabel = /not production/iu;
export class InternalTestStoreSetupError extends Error {
  constructor(reason, options) {
    super("INTERNAL_TEST_STORE_SETUP_UNAVAILABLE", options);
    this.reason = reason;
    this.name = "InternalTestStoreSetupError";
  }
}
const unavailable = (reason, cause) => {
  throw new InternalTestStoreSetupError(reason, cause === undefined ? undefined : { cause });
};

/** Exactly what the setup writes and reads; history is SELECT and INSERT only. */
export const internalTestStoreSetupGrants = Object.freeze([
  ["schema", "bop_tenant"],
  ["schema", "bop_publishing"],
  ["schema", "rms_store"],
  ["schema", "platform_audit"],
  ["schema", "platform_helpers"],
  ["type", "platform_helpers.uuid_v7"],
  ["routine", "platform_helpers.current_brand_id()"],
  ["routine", "platform_helpers.current_store_id()"],
  ["routine", "platform_helpers.is_uuid_v7(uuid)"],
  ["table", "bop_tenant.store", "SELECT"],
  ["table", "bop_tenant.store_opening", "SELECT"],
  // The owners' current-fact reads lock these (LOCK TABLE ... IN SHARE MODE needs MAINTAIN).
  ["table", "bop_publishing.publishing_mutation_record", "SELECT,INSERT,MAINTAIN"],
  // The owners' current-fact reads lock these (LOCK TABLE ... IN SHARE MODE needs MAINTAIN).
  ["table", "bop_publishing.live_gate_version", "SELECT,INSERT,MAINTAIN"],
  // The owners' current-fact reads lock these (LOCK TABLE ... IN SHARE MODE needs MAINTAIN).
  ["table", "bop_publishing.live_gate_requirement", "SELECT,INSERT,MAINTAIN"],
  ["table", "rms_store.store_configuration_version", "SELECT,INSERT"],
  ["table", "rms_store.store_configuration_authoring_operation", "SELECT,INSERT"],
  ["table", "rms_store.store_configuration_publication_content", "SELECT,INSERT"],
  ["table", "rms_store.store_weekly_service_period", "SELECT,INSERT"],
  ["table", "rms_store.store_service_exception", "SELECT,INSERT"],
  ["table", "rms_store.store_service_exception_content", "SELECT,INSERT"],
  ["table", "rms_store.store_service_exception_interval", "SELECT,INSERT"],
  ["table", "rms_store.store_configuration_sole_operator_approval", "SELECT"],
  ["table", "platform_audit.audit_record", "SELECT,INSERT"],
  ["table", "platform_audit.audit_chain_head", "SELECT,INSERT"],
  ["column", "platform_audit.audit_chain_head", "UPDATE", ["next_sequence", "last_record_hash"]],
]);
export function storeSetupRoleName(database) {
  const name = database + "_internal_test_store_setup";
  return IDENTIFIER.test(name) ? name : unavailable("expected-database-invalid");
}
export function renderStoreSetupRoleSql(role) {
  if (!IDENTIFIER.test(role)) return unavailable("expected-database-invalid");
  const q = (value) =>
    QUALIFIED.test(value) || IDENTIFIER.test(value) ? value : unavailable("grant-invalid");
  const statements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE; END IF; END $$`,
    `ALTER ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE`,
  ];
  const tables = [
    ...new Set(
      internalTestStoreSetupGrants
        .filter(([type]) => type === "table" || type === "column")
        .map(([, object]) => object),
    ),
  ];
  for (const object of tables) statements.push(`REVOKE ALL ON TABLE ${q(object)} FROM "${role}"`);
  for (const [type, object, privileges, columns] of internalTestStoreSetupGrants)
    if (type === "schema") statements.push(`GRANT USAGE ON SCHEMA ${q(object)} TO "${role}"`);
    else if (type === "type") statements.push(`GRANT USAGE ON TYPE ${q(object)} TO "${role}"`);
    else if (type === "routine")
      statements.push(`GRANT EXECUTE ON FUNCTION ${q(object)} TO "${role}"`);
    else if (type === "column")
      statements.push(
        `GRANT ${privileges} (${columns.map((column) => q(column)).join(",")}) ON TABLE ${q(object)} TO "${role}"`,
      );
    else statements.push(`GRANT ${privileges} ON TABLE ${q(object)} TO "${role}"`);
  return statements;
}

const operatingOf = (scope, timeZone, binding) => ({
  ...scope,
  configurationType: "STORE_CONFIGURATION",
  purposeCode: "STORE_CONFIGURATION",
  requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
  requiredValidationCheckCodes: storeConfigurationValidationCheckCodes,
  setupSnapshotReferences: storeConfigurationSetupSnapshotReferences,
  authorize: async (_tx, at) => at >= binding.validFrom && at < binding.validUntil,
  hashContent: storeConfigurationContentHash,
  timeZone,
});

/**
 * Sets up one TEST Store. `client` is the operator's own connection (it may SET ROLE to the setup
 * role and the services' read role); `binding` is the installation's (tenant, brand, validity).
 */
export async function setUpInternalTestStore(
  client,
  {
    /** The installation profile's environment; anything but InternalTest is refused. */
    environment,
    database,
    setupRole,
    readRole,
    binding,
    sourceStoreReference,
    targetStoreReference,
    approverActorReference,
    now,
    evidence,
    dryRun = true,
    nextReference,
  },
) {
  if (environment !== "InternalTest") return unavailable("internal-test-only");
  const at = now();
  if (
    ![
      binding?.tenantReference,
      binding?.brandReference,
      sourceStoreReference,
      targetStoreReference,
      approverActorReference,
      evidence?.setupReference,
    ].every((value) => typeof value === "string" && UUID_V7.test(value)) ||
    sourceStoreReference === targetStoreReference ||
    binding.storeReference !== sourceStoreReference ||
    !IDENTIFIER.test(setupRole) ||
    !IDENTIFIER.test(readRole) ||
    typeof nextReference !== "function" ||
    !(at >= binding.validFrom && at < binding.validUntil) ||
    Date.parse(binding.validUntil) > Date.parse(at) + 30 * 86_400_000
  )
    return unavailable("input-invalid");
  const brand = binding.brandReference,
    tenant = binding.tenantReference;
  const tx = { query: (sql, values = []) => client.query(sql, [...values]) };
  const scope = (store) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const audit = (transaction, record) => appendAuditRecordInTransaction(transaction, record);
  // READ COMMITTED: Publishing writes only there. The Store's launch gate lock (taken before the
  // gate is written) and the checks below make a concurrent second setup fail.
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    if ((await client.query("SELECT current_database() db")).rows[0]?.db !== database)
      unavailable("database-mismatch");
    await client.query(`SET LOCAL ROLE "${setupRole}"`);
    // The TEST Store as opened in the product, still without configuration or launch gate.
    await scope(targetStoreReference);
    const [target] = (
      await tx.query(
        "SELECT s.display_name,s.time_zone,s.locale,s.lifecycle,o.actor_id::text opener FROM bop_tenant.store s JOIN bop_tenant.store_opening o ON o.brand_id=s.brand_id AND o.store_id=s.store_id WHERE s.brand_id=$1 AND s.store_id=$2",
        [brand, targetStoreReference],
      )
    ).rows;
    if (target === undefined) unavailable("store-not-opened-in-product");
    if (target.lifecycle !== "Active") unavailable("store-not-active");
    if (!internalTestStoreLabel.test(String(target.display_name)))
      unavailable("store-not-labelled-test");
    if (target.opener === approverActorReference) unavailable("approver-is-opener");
    for (const sql of [
      "SELECT 1 FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 LIMIT 1",
      "SELECT 1 FROM bop_publishing.live_gate_version WHERE brand_id=$1 AND store_id=$2 LIMIT 1",
    ])
      if ((await tx.query(sql, [brand, targetStoreReference])).rows.length > 0)
        unavailable("store-already-set-up");
    // The source Store's configuration in force (its own publication proof), read as the services.
    await client.query(`SET LOCAL ROLE "${readRole}"`);
    await scope(sourceStoreReference);
    const [sourceStore] = (
      await tx.query("SELECT time_zone FROM bop_tenant.store WHERE brand_id=$1 AND store_id=$2", [
        brand,
        sourceStoreReference,
      ])
    ).rows;
    if (sourceStore === undefined) unavailable("source-store-unavailable");
    const source = (
      await readPublishedStoreConfiguration(
        operatingOf(
          { tenantReference: tenant, brandReference: brand, storeReference: sourceStoreReference },
          String(sourceStore.time_zone),
          binding,
        ),
        tx,
        at,
        async () => true,
      )
    ).configuration;
    await client.query(`SET LOCAL ROLE "${setupRole}"`);
    const target_ = {
      tenantReference: tenant,
      brandReference: brand,
      storeReference: targetStoreReference,
    };
    const author = String(target.opener),
      approver = approverActorReference;
    const configuration = createStoreConfigurationVersion({
      brandReference: brand,
      storeReference: targetStoreReference,
      configurationReference: nextReference(),
      configurationVersion: 1,
      lifecycle: "Published",
      source: "StoreOverride",
      brandBaseVersionReference: source.brandBaseVersionReference,
      defaultLocale: String(target.locale),
      currencyCode: "CAD",
      timeZone: String(target.time_zone),
      businessDayStartLocalTime: source.businessDayStartLocalTime,
      // Not yet set: the Owner sets them in Store setup (segment 3c).
      addressReference: nextReference(),
      contactReference: nextReference(),
      receiptReference: nextReference(),
      taxConfigurationReference: nextReference(),
      paymentConfigurationReference: nextReference(),
      capacityConfigurationReference: null,
      enabledServiceModes: source.enabledServiceModes,
      weeklySchedule: source.weeklySchedule,
      exceptions: [],
      effectiveFrom: at,
      effectiveUntil: null,
      supersedesConfigurationReference: null,
      reasonCode: "INTERNAL_TEST_STORE_SETUP",
      authoredByReference: author,
      approvedByReference: approver,
      approvalEvidenceReference: nextReference(),
      publicationReference: nextReference(),
      liveGateEvidenceReference: nextReference(),
      createdAt: at,
      updatedAt: at,
      dataClassification: "ConfigurationMetadata",
    });
    const digest = storeConfigurationContentHash(configuration);
    // Publishing: the configuration's lifecycle to its first release.
    await scope(targetStoreReference);
    const publishingScope = {
      kind: "Store",
      brandReference: brand,
      storeReference: targetStoreReference,
    };
    const publishing = createPostgresPublishingMutationStore(
      { run: (work) => work(tx) },
      tenant,
      publishingScope,
    );
    const familyReference = nextReference(),
      lifecycleId = nextReference();
    const base = {
      lifecycleId,
      familyReference,
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      snapshotReference: configuration.configurationReference,
      snapshotDigest: digest,
      scope: publishingScope,
      version: 1,
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: at,
      changedAt: at,
    };
    const mutation = (operation, current, next, actor, extra = {}) => ({
      operation,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: nextReference(),
      current,
      next,
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: null,
      approvalEvidence: null,
      audit: {
        auditId: nextReference(),
        brandId: brand,
        storeId: targetStoreReference,
        actor: { type: "User", reference: actor },
        actionCode: {
          CreateDraft: "PUBLISHING_DRAFT_CREATED",
          SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
          Approve: "PUBLISHING_REVIEW_APPROVED",
          Publish: "PUBLISHING_RELEASE_PUBLISHED",
        }[operation],
        targetType: "PublishingLifecycle",
        targetId: next.lifecycleId,
        reasonCode: "INTERNAL_TEST_STORE_SETUP",
        correlationId: evidence.setupReference,
        occurredAt: at,
        sourceChannel: "DEPLOYMENT",
        dataClassification: "Confidential",
        retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
        retentionPolicyVersion: 1,
      },
      ...extra,
    });
    await publishing.commit(mutation("CreateDraft", null, base, author));
    const validation = {
      evidenceReference: nextReference(),
      snapshotReference: base.snapshotReference,
      snapshotDigest: digest,
      scope: publishingScope,
      result: "Pass",
      checkedAt: at,
      validUntil: binding.validUntil,
      checkCodes: [...storeConfigurationValidationCheckCodes],
    };
    const review = {
      ...base,
      version: 2,
      state: "InReview",
      validationEvidenceReference: validation.evidenceReference,
    };
    await publishing.commit(
      mutation("SubmitReview", base, review, author, { validationEvidence: validation }),
    );
    const approval = {
      evidenceReference: configuration.approvalEvidenceReference,
      reviewLifecycleId: lifecycleId,
      reviewVersion: 2,
      snapshotReference: base.snapshotReference,
      snapshotDigest: digest,
      scope: publishingScope,
      decision: "Accepted",
      approvedActorReference: approver,
      approvedAt: at,
      validUntil: binding.validUntil,
    };
    const approved = {
      ...review,
      version: 3,
      state: "Approved",
      approvalEvidenceReference: approval.evidenceReference,
    };
    await publishing.commit(
      mutation("Approve", review, approved, approver, { approvalEvidence: approval }),
    );
    await publishing.commit(
      mutation("Publish", approved, { ...approved, version: 4, state: "Published" }, approver, {
        validationEvidence: validation,
        approvalEvidence: approval,
        release: {
          releaseId: configuration.publicationReference,
          familyReference,
          configurationType: base.configurationType,
          purposeCode: base.purposeCode,
          snapshotReference: base.snapshotReference,
          snapshotDigest: digest,
          scope: publishingScope,
          sequence: 1,
          sourceLifecycleId: lifecycleId,
          kind: "Publish",
          previousReleaseId: null,
          createdAt: at,
        },
      }),
    );
    // Publishing: the Store's first (synthetic) launch gate, decided by the configuration's evidence.
    await createInternalTestLiveGate(
      tx,
      {
        ...target_,
        gateReference: nextReference(),
        decisionEvidenceReference: configuration.liveGateEvidenceReference,
        requirementReference: nextReference(),
        requirementEvidenceReference: nextReference(),
        submittedBy: author,
        approvedBy: approver,
        validUntil: binding.validUntil,
        at,
        evidence,
        auditReference: nextReference(),
      },
      audit,
    );
    // Store: configuration version 1 from that release, proven by the Store's own authorization.
    const operating = operatingOf(target_, String(target.time_zone), binding);
    const authorize = createPostgresStorePublicationAuthorization({
      ...operating,
      publishingFamilyReference: familyReference,
      authorize: async () => true,
    });
    await createPostgresStorePublicationMaterializer({
      brandReference: brand,
      storeReference: targetStoreReference,
      publishingFamilyReference: familyReference,
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      businessDayStartSource: "StoreOverride",
      nextReference,
      hashContent: storeConfigurationContentHash,
      authorize: async (transaction, input) => {
        await authorize(transaction, input.operation.configuration, input.audit.occurredAt);
        return true;
      },
    })(tx, {
      operation: {
        brandReference: brand,
        storeReference: targetStoreReference,
        command: "Publish",
        configuration,
      },
      audit: { occurredAt: at },
    });
    await audit(tx, {
      auditId: nextReference(),
      brandId: brand,
      storeId: targetStoreReference,
      actor: { type: "System" },
      actionCode: "INTERNAL_TEST_STORE_CONFIGURATION_PUBLISHED",
      targetType: "StoreConfiguration",
      targetId: configuration.configurationReference,
      afterSummary: {
        configurationVersion: 1,
        copiedFromStoreReference: sourceStoreReference,
        environment: "InternalTest",
        approvedBy: evidence.approvedBy,
        approval: evidence.approval,
        reason: evidence.reason,
        operatorAccount: evidence.operatorAccount,
      },
      reasonCode: "INTERNAL_TEST_STORE_SETUP",
      correlationId: evidence.setupReference,
      occurredAt: at,
      sourceChannel: "DEPLOYMENT",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    });
    // The services read the new Store's published operating status, as their own role.
    await client.query("SAVEPOINT store_setup_read_check");
    await client.query(`SET LOCAL ROLE "${readRole}"`);
    const status = await createPostgresPublishedStoreOperatingStatusReader(operating)(tx, at);
    if (
      status.businessDate.brandReference !== brand ||
      status.businessDate.storeReference !== targetStoreReference
    )
      unavailable("read-check-failed");
    await client.query("RELEASE SAVEPOINT store_setup_read_check");
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return Object.freeze({
      status: dryRun ? "DryRun" : "SetUp",
      storeReference: targetStoreReference,
      configurationReference: configuration.configurationReference,
      businessDate: status.businessDate.businessDate,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof InternalTestStoreSetupError) throw error;
    return unavailable("database-check-failed", error);
  }
}
