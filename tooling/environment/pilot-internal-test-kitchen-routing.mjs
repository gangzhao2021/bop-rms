import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import {
  createPostgresKitchenRoutingConfigurationStore,
  rebindKitchenRoutingEvidence,
} from "../../packages/rms/kitchen/src/index.ts";
import {
  InternalTestStoreSetupError,
  internalTestStoreLabel,
} from "./pilot-internal-test-store-setup.mjs";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (v15 2026-11-01) — InternalTest only, a
 * test-environment-only shortcut. A paid order at a TEST Store opened in the product never reached
 * the kitchen: the Store had no kitchen routing configuration (the installation's Store got its
 * one at installation; nothing in the product records one yet), so the kitchen's confirmed-order
 * consumer could not route any item and retried until the event was dead-lettered. This gives the
 * TEST Store its own routing, as its kitchen operates from its first service: the installation
 * Store's current stations and rules (selector and station capabilities, so the Brand's recipes
 * route the same way), under the Store's own station, rule and evidence identities. Recorded
 * through the Kitchen owner's routing store (its own audit) and audited again under the approver
 * with the approval wording. Idempotent: a Store with a routing configuration gets it back and
 * nothing is written.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*(?:\([a-z_, ]*\))?$/u;
const unavailable = (reason, cause) => {
  throw new InternalTestStoreSetupError(reason, cause === undefined ? undefined : { cause });
};
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
/** A Store's own identity for `purpose`, the same on every run (UUIDv7-shaped). */
function storeKitchenReference(storeReference, purpose) {
  const digest = createHash("sha256")
    .update("bop-rms/internal-test-kitchen:" + storeReference + ":" + purpose)
    .digest("hex");
  return (
    storeReference.slice(0, 14) +
    "7" +
    digest.slice(0, 3) +
    "-" +
    ((parseInt(digest.slice(3, 4), 16) & 3) | 8).toString(16) +
    digest.slice(4, 7) +
    "-" +
    digest.slice(7, 19)
  );
}

/** Exactly what recording and reading the routing needs. */
export const internalTestKitchenRoutingGrants = Object.freeze([
  ["schema", "bop_tenant"],
  ["schema", "rms_kitchen"],
  ["schema", "platform_audit"],
  ["schema", "platform_helpers"],
  ["type", "platform_helpers.uuid_v7"],
  ["routine", "platform_helpers.current_brand_id()"],
  ["routine", "platform_helpers.current_store_id()"],
  ["routine", "platform_helpers.is_uuid_v7(uuid)"],
  ["table", "bop_tenant.store", "SELECT"],
  ["table", "bop_tenant.store_opening", "SELECT"],
  ["table", "rms_kitchen.kitchen_routing_configuration", "SELECT,INSERT"],
  ["table", "platform_audit.audit_record", "SELECT,INSERT"],
  ["table", "platform_audit.audit_chain_head", "SELECT,INSERT"],
  ["column", "platform_audit.audit_chain_head", "UPDATE", ["next_sequence", "last_record_hash"]],
]);
export function kitchenRoutingRoleName(database) {
  const name = database + "_internal_test_kitchen";
  return IDENTIFIER.test(name) ? name : unavailable("expected-database-invalid");
}
export function renderKitchenRoutingRoleSql(role) {
  if (!IDENTIFIER.test(role)) return unavailable("expected-database-invalid");
  const q = (value) =>
    QUALIFIED.test(value) || IDENTIFIER.test(value) ? value : unavailable("grant-invalid");
  const statements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE; END IF; END $$`,
    `ALTER ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE`,
  ];
  const tables = [
    ...new Set(
      internalTestKitchenRoutingGrants
        .filter(([type]) => type === "table" || type === "column")
        .map(([, object]) => object),
    ),
  ];
  for (const object of tables) statements.push(`REVOKE ALL ON TABLE ${q(object)} FROM "${role}"`);
  for (const [type, object, privileges, columns] of internalTestKitchenRoutingGrants)
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

/** The kitchen's own routing read for `storeReference` at `at`, as the given role (null: none). */
export async function readStoreKitchenRouting(client, { role, binding, storeReference, at }) {
  if (!IDENTIFIER.test(role) || !UUID_V7.test(storeReference ?? ""))
    return unavailable("input-invalid");
  await client.query("BEGIN READ ONLY");
  try {
    await client.query(`SET LOCAL ROLE "${role}"`);
    const tx = { query: (sql, values = []) => client.query(sql, [...values]) };
    return await createPostgresKitchenRoutingConfigurationStore({
      brandReference: binding.brandReference,
      storeReference,
      sha256,
      authorizeRead: async () => true,
      authorizeWrite: async () => false,
      validateConfiguration: async () => false,
      audit: async () => unavailable("read-only"),
    }).resolve({
      transaction: tx,
      query: {
        actorType: "System",
        actorReference: null,
        action: "ResolveKitchenStationRoutingEvidence",
        purpose: "CreateKitchenWork",
        brandReference: binding.brandReference,
        storeReference,
        effectiveAt: at,
      },
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

/** Records the TEST Store's kitchen routing, or answers the one it has. */
export async function createInternalTestKitchenRouting(
  client,
  {
    environment,
    database,
    role,
    binding,
    storeReference,
    approverActorReference,
    now,
    evidence,
    nextReference,
  },
) {
  if (environment !== "InternalTest") return unavailable("internal-test-only");
  const at = now();
  if (
    ![
      binding?.tenantReference,
      binding?.brandReference,
      binding?.storeReference,
      storeReference,
      approverActorReference,
      evidence?.operationReference,
    ].every((value) => typeof value === "string" && UUID_V7.test(value)) ||
    binding.storeReference === storeReference ||
    !IDENTIFIER.test(role) ||
    typeof nextReference !== "function" ||
    typeof evidence.approval !== "string" ||
    evidence.approval.trim() === "" ||
    typeof evidence.approvedBy !== "string" ||
    evidence.approvedBy.trim() === ""
  )
    return unavailable("input-invalid");
  const routingOf = (store, audit) =>
    createPostgresKitchenRoutingConfigurationStore({
      brandReference: binding.brandReference,
      storeReference: store,
      sha256,
      authorizeRead: async () => true,
      authorizeWrite: async () => true,
      validateConfiguration: async () => true,
      audit,
    });
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    if ((await client.query("SELECT current_database() db")).rows[0]?.db !== database)
      unavailable("database-mismatch");
    await client.query(`SET LOCAL ROLE "${role}"`);
    const tx = { query: (sql, values = []) => client.query(sql, [...values]) };
    const scope = (store) =>
      tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
        binding.brandReference,
        store,
      ]);
    await scope(storeReference);
    const [target] = (
      await tx.query(
        "SELECT s.display_name,s.lifecycle FROM bop_tenant.store s JOIN bop_tenant.store_opening o ON o.brand_id=s.brand_id AND o.store_id=s.store_id WHERE s.brand_id=$1 AND s.store_id=$2",
        [binding.brandReference, storeReference],
      )
    ).rows;
    if (target === undefined) unavailable("store-not-opened-in-product");
    if (target.lifecycle !== "Active") unavailable("store-not-active");
    if (!internalTestStoreLabel.test(String(target.display_name)))
      unavailable("store-not-labelled-test");
    const [present] = (
      await tx.query(
        "SELECT version_id::text version,version_number::int number FROM rms_kitchen.kitchen_routing_configuration WHERE brand_id=$1 AND store_id=$2 ORDER BY version_number DESC LIMIT 1",
        [binding.brandReference, storeReference],
      )
    ).rows;
    if (present !== undefined) {
      await client.query("ROLLBACK");
      return Object.freeze({
        status: "AlreadyPresent",
        storeReference,
        evidenceReference: present.version,
        evidenceVersion: present.number,
      });
    }
    // The installation Store's current routing: its stations and rules.
    const source = await routingOf(binding.storeReference, async () =>
      unavailable("read-only"),
    ).resolve({
      transaction: tx,
      query: {
        actorType: "System",
        actorReference: null,
        action: "ResolveKitchenStationRoutingEvidence",
        purpose: "CreateKitchenWork",
        brandReference: binding.brandReference,
        storeReference: binding.storeReference,
        effectiveAt: at,
      },
    });
    if (source === null || source.candidates.length < 1)
      unavailable("installation-store-has-no-kitchen-routing");
    const own = (purpose, value) => storeKitchenReference(storeReference, purpose + ":" + value);
    const record = {
      operationReference: evidence.operationReference,
      actorReference: approverActorReference,
      purposeCode: "SyntheticConfiguration",
      permissionCode: "synthetic.configure",
      reasonCode: "INTERNAL_TEST_STORE_KITCHEN",
      recordedAt: at,
      expectedVersion: 0,
      configuration: rebindKitchenRoutingEvidence(
        {
          brandReference: binding.brandReference,
          storeReference,
          evidenceReference: own("evidence", "1"),
          evidenceVersion: 1,
          effectiveAt: at,
          evidenceDigest: sha256("placeholder"),
          candidates: source.candidates.map((candidate) => ({
            ...candidate,
            stationReference: own("station", candidate.stationReference),
            stationVersion: 1,
            routingRuleReference: own("rule", candidate.routingRuleReference),
            routingRuleVersion: 1,
            targetStationReference: own("station", candidate.targetStationReference),
            routingRuleDigest: sha256("placeholder"),
          })),
        },
        at,
        sha256,
      ),
    };
    await scope(storeReference);
    const committed = await routingOf(storeReference, async (value) => ({
      auditId: nextReference(),
      brandId: binding.brandReference,
      storeId: storeReference,
      actor: { type: "User", reference: value.actorReference },
      actionCode: "KITCHEN_ROUTING_CONFIGURATION_RECORDED",
      targetType: "KitchenRoutingConfiguration",
      targetId: value.configuration.evidenceReference,
      correlationId: value.operationReference,
      reasonCode: value.reasonCode,
      occurredAt: value.recordedAt,
      sourceChannel: "DEPLOYMENT",
      afterSummary: { version: value.configuration.evidenceVersion },
      dataClassification: "Restricted",
      retentionPolicyCode: "KITCHEN_BUSINESS_RECORD",
      retentionPolicyVersion: 1,
    })).commit({ transaction: tx, record });
    if (committed.status !== "Committed") unavailable("routing-not-recorded");
    await scope(storeReference);
    await appendAuditRecordInTransaction(tx, {
      auditId: nextReference(),
      brandId: binding.brandReference,
      storeId: storeReference,
      actor: { type: "User", reference: approverActorReference },
      actionCode: "INTERNAL_TEST_STORE_KITCHEN_ROUTING",
      targetType: "KitchenRoutingConfiguration",
      targetId: record.configuration.evidenceReference,
      afterSummary: {
        stations: record.configuration.candidates.length,
        copiedFromInstallationStore: true,
        environment: "InternalTest",
        approvedBy: evidence.approvedBy,
        approval: evidence.approval,
        reason: evidence.reason ?? null,
      },
      reasonCode: "INTERNAL_TEST_STORE_KITCHEN",
      correlationId: evidence.operationReference,
      occurredAt: at,
      sourceChannel: "DEPLOYMENT",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    });
    await client.query("COMMIT");
    return Object.freeze({
      status: "Created",
      storeReference,
      evidenceReference: record.configuration.evidenceReference,
      evidenceVersion: 1,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof InternalTestStoreSetupError) throw error;
    return unavailable("database-check-failed", error);
  }
}
