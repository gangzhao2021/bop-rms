import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/config.ts";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import { extendInternalTestMembershipValidity } from "../../packages/bop/membership/src/index.ts";
import { extendInternalTestPermissionValidity } from "../../packages/bop/permission/src/index.ts";
import {
  createPostgresCurrentLiveGateSource,
  renewInternalTestLiveGates,
} from "../../packages/bop/publishing/src/index.ts";
import {
  createPostgresCurrentTaxConfigurationStore,
  renewInternalTestTaxEvidence,
} from "../../packages/rms/pricing/src/index.ts";
import {
  createInternalPricingPolicy,
  internalTestTaxVersionIdentity,
} from "./pilot-pricing-policy.mjs";
import { uuidV7 } from "./permission-catalog-install.mjs";

/**
 * WP-2423: the database half of the Owner-approved InternalTest renewal
 * (pilot-internal-test-renew.mjs). In one SERIALIZABLE transaction, through each owning
 * domain's own store function, it moves the synthetic DEMO facts that share the installation's
 * expiry to the approved new end:
 *
 * - Membership: the DEMO staff memberships and Store assignments (versioned owner change);
 * - Permission: the DEMO roles, their assignments and grants (versioned change, policy version);
 * - Publishing: the synthetic launch gate (a new append-only gate version);
 * - Pricing: the synthetic DEMO tax evidence (a new append-only Published tax version whose
 *   identity and digest come from the internal pricing policy, the synthetic tax authority).
 *
 * Every change is written to the platform audit with the approval wording. The domain functions
 * run as a dedicated NOLOGIN NOBYPASSRLS role holding only the privileges listed below, so row
 * security applies exactly as for the services. Before and after the change the same transaction
 * checks the product read paths at an instant just after the old expiry (staff authority, launch
 * gate, current tax configuration); the transaction commits only when every check passes after
 * the change and the staff's authority is the same as now. A dry run performs it all and rolls
 * back, so it shows exactly what would change.
 */
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const pg = require("pg");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const unavailable = (reason, details = {}) => {
  const error = new Error("PILOT_INTERNAL_TEST_RENEWAL_UNAVAILABLE");
  error.reason = reason;
  Object.assign(error, details);
  throw error;
};

/** Least privilege of the renewal role (Owner standing approval 2026-10-14, WP-2423 renewal). */
export const internalTestRenewalGrants = Object.freeze([
  ["schema", "bop_membership"],
  ["schema", "bop_permission"],
  ["schema", "bop_publishing"],
  ["schema", "rms_pricing"],
  ["schema", "platform_audit"],
  ["schema", "platform_helpers"],
  ["type", "platform_helpers.uuid_v7"],
  ["routine", "platform_helpers.current_brand_id()"],
  ["routine", "platform_helpers.current_store_id()"],
  ["routine", "platform_helpers.is_uuid_v7(uuid)"],
  ["table", "bop_membership.membership", "SELECT,UPDATE"],
  ["table", "bop_membership.store_assignment", "SELECT,UPDATE"],
  ["table", "bop_permission.policy_state", "SELECT,UPDATE"],
  ["table", "bop_permission.role", "SELECT,UPDATE"],
  ["table", "bop_permission.role_assignment", "SELECT,UPDATE"],
  ["table", "bop_permission.permission_grant", "SELECT,UPDATE"],
  ["table", "bop_permission.permission_definition", "SELECT"],
  // UPDATE only for the read source's SHARE lock; the history triggers refuse every update.
  ["table", "bop_publishing.live_gate_version", "SELECT,INSERT,UPDATE"],
  ["table", "bop_publishing.live_gate_requirement", "SELECT,INSERT,UPDATE"],
  ["table", "rms_pricing.tax_configuration", "SELECT,UPDATE"],
  ["table", "rms_pricing.tax_configuration_version", "SELECT,INSERT"],
  ["table", "rms_pricing.tax_configuration_rule", "SELECT,INSERT"],
  // Read and maintained by the tax version triggers.
  ["table", "rms_pricing.tax_reference_generation", "SELECT,INSERT,UPDATE"],
  ["table", "rms_pricing.tax_reference_scope", "SELECT,INSERT,UPDATE"],
  ["table", "rms_pricing.tax_config_publication_candidate", "SELECT"],
  ["table", "rms_pricing.tax_config_candidate_rule", "SELECT"],
  ["table", "rms_pricing.tax_config_authoring_operation", "SELECT"],
  ["table", "platform_audit.audit_record", "SELECT,INSERT"],
  ["table", "platform_audit.audit_chain_head", "SELECT,INSERT,UPDATE"],
]);
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*(?:\([a-z_, ]*\))?$/u;
export function renewalRoleName(database) {
  const name = database + "_internal_test_renewal";
  return IDENTIFIER.test(name) ? name : unavailable("expected-database-invalid");
}
export function renderRenewalRoleSql(role) {
  if (!IDENTIFIER.test(role)) return unavailable("expected-database-invalid");
  const q = (value) => {
    if (!QUALIFIED.test(value) && !IDENTIFIER.test(value)) unavailable("grant-invalid");
    return value;
  };
  const statements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE; END IF; END $$`,
    // A role left from earlier must still be restricted.
    `ALTER ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE`,
  ];
  for (const [type, object, privileges] of internalTestRenewalGrants)
    if (type === "schema") statements.push(`GRANT USAGE ON SCHEMA ${q(object)} TO "${role}"`);
    else if (type === "type") statements.push(`GRANT USAGE ON TYPE ${q(object)} TO "${role}"`);
    else if (type === "routine")
      statements.push(`GRANT EXECUTE ON FUNCTION ${q(object)} TO "${role}"`);
    else statements.push(`GRANT ${privileges} ON TABLE ${q(object)} TO "${role}"`);
  return statements;
}

const rosterAuthoritySql = `SELECT m.actor_id::text actor,count(DISTINCT d.action_code)::int actions
FROM bop_membership.membership m
JOIN bop_membership.store_assignment s ON s.membership_id=m.membership_id AND s.brand_id=m.brand_id AND s.store_id=$2
  AND s.lifecycle='Active' AND s.effective_from<=$3::timestamptz AND (s.effective_until IS NULL OR s.effective_until>$3::timestamptz)
JOIN bop_permission.role_assignment a ON a.actor_id=m.actor_id AND a.membership_id=m.membership_id AND a.brand_id=m.brand_id
  AND (a.store_id IS NULL OR a.store_id=$2) AND a.lifecycle='Active'
  AND a.effective_from<=$3::timestamptz AND (a.effective_until IS NULL OR a.effective_until>$3::timestamptz)
JOIN bop_permission.role r ON r.role_id=a.role_id AND r.brand_id=a.brand_id AND r.lifecycle='Active'
  AND r.effective_from<=$3::timestamptz AND (r.effective_until IS NULL OR r.effective_until>$3::timestamptz)
JOIN bop_permission.permission_grant g ON g.role_id=r.role_id AND g.brand_id=r.brand_id AND g.lifecycle='Active'
  AND g.effective_from<=$3::timestamptz AND (g.effective_until IS NULL OR g.effective_until>$3::timestamptz)
JOIN bop_permission.permission_definition d ON d.permission_id=g.permission_id AND d.lifecycle='Active'
WHERE m.brand_id=$1 AND m.lifecycle='Active' AND m.effective_from<=$3::timestamptz
  AND (m.effective_until IS NULL OR m.effective_until>$3::timestamptz)
GROUP BY m.actor_id ORDER BY m.actor_id`;

async function rosterAuthority(tx, scope, at) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
  const rows = (
    await tx.query(rosterAuthoritySql, [scope.brandReference, scope.storeReference, at])
  ).rows;
  return Object.fromEntries(rows.map((row) => [String(row.actor), Number(row.actions)]));
}
async function attempt(work) {
  try {
    await work();
    return "Accepted";
  } catch {
    return "Refused";
  }
}
/** The product read paths at `at`, inside the renewal transaction (savepoints keep it usable). */
async function readChecks(tx, { scope, at, gates, requiredCodes, policy }) {
  const guarded = async (name, work) => {
    await tx.query(`SAVEPOINT ${name}`, []);
    const result = await attempt(work);
    await tx.query(`ROLLBACK TO SAVEPOINT ${name}`, []);
    return result;
  };
  const roster = await rosterAuthority(tx, scope, at);
  const launchGate =
    gates.length === 0
      ? "Refused"
      : await guarded("renew_check_gate", async () => {
          for (const gate of gates)
            await createPostgresCurrentLiveGateSource({
              ...scope,
              decisionEvidenceReference: gate.decisionEvidenceReference,
              requiredRequirementCodes: requiredCodes,
              authorize: async () => true,
            })(tx, at);
        });
  const tax = await guarded("renew_check_tax", async () => {
    const snapshot = await createPostgresCurrentTaxConfigurationStore(
      { run: (work) => work(tx) },
      { brandReference: scope.brandReference, storeReference: scope.storeReference },
      policy.currencyMetadata,
      {
        load: async () => ({
          registrationEvidence: policy.taxConfiguration.registrationEvidence,
          professionalEvidence: policy.taxConfiguration.professionalEvidence,
        }),
      },
    ).load({
      configurationReference: policy.taxConfiguration.configurationReference,
      observedAt: at,
    });
    if (snapshot === null) throw new Error("absent");
  });
  return { at, roster, launchGate, tax };
}

/**
 * Runs the database renewal on a connected owner (migration) client. `profile`/`menu` are the
 * installation's current files; `from` is their common expiry and `to` the approved new end.
 */
export async function renewInternalTestDatabase(
  client,
  {
    database,
    readRole,
    profile,
    menu,
    from,
    to,
    now,
    evidence,
    dryRun,
    nextReference = () => uuidV7(),
  },
) {
  // The read checks run as the services' database role, so they see what the services see.
  if (typeof readRole !== "string" || !IDENTIFIER.test(readRole))
    return unavailable("read-role-invalid");
  const at = new Date(now).toISOString();
  const scope = {
    tenantReference: profile.binding.tenantReference,
    brandReference: profile.binding.brandReference,
    storeReference: profile.binding.storeReference,
  };
  const pricing = (candidate) =>
    createInternalPricingPolicy({
      loadProfile: async () => candidate,
      loadMenu: async () => menu,
      expectedDatabaseName: database,
    });
  const currentPolicy = await pricing(profile);
  const requiredCodes = profile.operating?.liveGateRequirementCodes ?? ["SYNTHETIC_STORE_READY"];
  // Just after the old expiry (or now, when that has passed), and before the new end.
  const checkAt = new Date(
    Math.min(Math.max(Date.parse(from), now) + 3_600_000, Date.parse(to) - 60_000),
  ).toISOString();
  const role = renewalRoleName(database);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const actual = (await client.query("SELECT current_database() AS name")).rows[0]?.name;
    if (actual !== database) unavailable("database-mismatch");
    for (const statement of renderRenewalRoleSql(role)) await client.query(statement);
    const asRenewal = () => client.query(`SET LOCAL ROLE "${role}"`);
    const asReader = () => client.query(`SET LOCAL ROLE "${readRole}"`);
    const tx = { query: (sql, values = []) => client.query(sql, values) };
    await asRenewal();
    const audit = (transaction, record) => appendAuditRecordInTransaction(transaction, record);
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const gatesBefore = (
      await tx.query(
        "SELECT DISTINCT decision_evidence_reference::text d FROM bop_publishing.live_gate_version WHERE brand_id=$1 AND store_id=$2 AND gate_id LIKE 'SYNTHETIC-%'",
        [scope.brandReference, scope.storeReference],
      )
    ).rows.map((row) => ({ decisionEvidenceReference: String(row.d) }));
    await asReader();
    const before = await readChecks(tx, {
      scope,
      at: checkAt,
      gates: gatesBefore,
      requiredCodes,
      policy: currentPolicy,
    });
    const nowAuthority = await rosterAuthority(tx, scope, at);
    await asRenewal();
    const input = { ...scope, from, to, at, evidence, nextReference };
    const membership = await extendInternalTestMembershipValidity(tx, input, audit);
    const permission = await extendInternalTestPermissionValidity(tx, input, audit);
    const liveGates = await renewInternalTestLiveGates(tx, input, audit);
    const currentNumber = currentPolicy.taxConfiguration.versionNumber;
    const nextVersion = { versionNumber: currentNumber + 1, createdAt: at };
    const nextPolicy = await pricing({
      ...profile,
      binding: { ...profile.binding, validUntil: to },
      taxConfigurationVersion: nextVersion,
    });
    const nextIdentity = internalTestTaxVersionIdentity(nextVersion.versionNumber);
    const tax = await renewInternalTestTaxEvidence(
      tx,
      {
        ...input,
        configurationReference: currentPolicy.taxConfiguration.configurationReference,
        next: {
          versionReference: nextIdentity.versionReference,
          versionNumber: nextVersion.versionNumber,
          snapshotDigest: nextPolicy.taxConfiguration.snapshotDigest,
          rules: currentPolicy.taxConfiguration.rules.map((rule, index) => ({
            from: rule.ruleReference,
            to: nextIdentity.ruleReferences[index],
          })),
        },
      },
      audit,
    );
    // The profile's tax version after the renewal (resumed runs report the version in place).
    const taxConfigurationVersion =
      tax.status === "Renewed"
        ? nextVersion
        : tax.version.number === 1
          ? null
          : { versionNumber: tax.version.number, createdAt: tax.createdAt };
    const afterPolicy =
      tax.status === "Renewed"
        ? nextPolicy
        : await pricing({
            ...profile,
            binding: { ...profile.binding, validUntil: to },
            ...(taxConfigurationVersion === null ? {} : { taxConfigurationVersion }),
          });
    await asReader();
    const after = await readChecks(tx, {
      scope,
      at: checkAt,
      gates: liveGates.gates,
      requiredCodes,
      policy: afterPolicy,
    });
    const summary = {
      database,
      role,
      readRole,
      from,
      to,
      membership: membership.changes,
      permission: permission.changes,
      policyVersion: permission.policyVersion,
      liveGates: liveGates.renewed,
      tax,
      taxConfigurationVersion,
      alreadyRenewed:
        membership.alreadyRenewed + permission.alreadyRenewed + liveGates.alreadyRenewed,
      checks: { now: { at, roster: nowAuthority }, before, after },
    };
    const changed =
      membership.changes.length +
      permission.changes.length +
      liveGates.renewed.length +
      (tax.status === "Renewed" ? 1 : 0);
    if (
      after.launchGate !== "Accepted" ||
      after.tax !== "Accepted" ||
      Object.keys(nowAuthority).length === 0 ||
      JSON.stringify(after.roster) !== JSON.stringify(nowAuthority)
    )
      unavailable("database-check-failed", { databaseSummary: summary });
    if (dryRun || changed === 0) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    return {
      ...summary,
      status: changed === 0 ? "AlreadyRenewed" : dryRun ? "Planned" : "Renewed",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (typeof error?.reason === "string") throw error;
    const code = typeof error?.code === "string" ? error.code : "unexpected";
    return unavailable(
      /^INTERNAL_TEST_[A-Z_]+$/u.test(code)
        ? code.toLowerCase().replaceAll("_", "-")
        : "database-error",
      { databaseErrorCode: code, cause: error },
    );
  }
}

/** Connects with the migration environment file; the file must name the expected database. */
export async function connectRenewalDatabase(envFile, expectedDatabaseName) {
  let config;
  try {
    config = await loadMigrationConnectionConfig(root, envFile);
  } catch {
    return unavailable("env-file-invalid");
  }
  if (config.database !== expectedDatabaseName) return unavailable("database-mismatch");
  const client = new pg.Client({
    application_name: "bop-rms-internal-test-renewal",
    connectionTimeoutMillis: 10_000,
    database: config.database,
    host: config.host,
    password: config.password,
    port: config.port,
    ssl: config.ssl,
    user: config.user,
  });
  try {
    await client.connect();
  } catch {
    return unavailable("database-unreachable");
  }
  return client;
}
