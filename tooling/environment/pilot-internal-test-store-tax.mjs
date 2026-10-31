import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import {
  createInternalTestStoreTaxConfiguration,
  createPostgresCurrentTaxConfigurationStore,
  InternalTestTaxEvidenceRenewalError,
  renewInternalTestTaxEvidence,
} from "../../packages/rms/pricing/src/index.ts";
import {
  createInternalPricingPolicy,
  internalTestTaxVersionIdentity,
  servedStoreTaxPrefix,
} from "./pilot-pricing-policy.mjs";
import {
  InternalTestStoreSetupError,
  internalTestStoreLabel,
} from "./pilot-internal-test-store-setup.mjs";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (coordinator 2026-10-31) — InternalTest only, a
 * test-environment-only shortcut. A TEST Store opened in the product gets its own Store-scoped
 * synthetic tax configuration, as store 1's DEMO one came from the internal-test tooling: the same
 * rules, rates and tax classes (both Stores are in Ontario in this test), its own synthetic
 * identities and evidence (the internal pricing policy, the InternalTest synthetic tax authority)
 * ending with the installation's, so `renew` moves both. Written by the Pricing owner's own
 * function as a restricted role, audited under the approver with the approval wording; a rerun
 * answers AlreadyPresent and writes nothing.
 *
 * Refused: the installation's own Store, a Store not opened in the product or not labelled TEST,
 * a Store whose address (Store setup) is not set yet, or is in another province than the
 * configuration's — rates are never guessed. A real Store's tax configuration still needs the
 * Owner's registration and professional review evidence (External Evidence gate).
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*(?:\([a-z_, ]*\))?$/u;
const unavailable = (reason, cause) => {
  throw new InternalTestStoreSetupError(reason, cause === undefined ? undefined : { cause });
};
/** Pricing's own refusals, as fixed reasons. */
const taxReasons = Object.freeze({
  INTERNAL_TEST_TAX_INPUT_INVALID: "input-invalid",
  INTERNAL_TEST_TAX_NOT_SYNTHETIC: "installation-tax-not-synthetic",
  INTERNAL_TEST_TAX_SOURCE_MISMATCH: "installation-tax-differs",
  INTERNAL_TEST_TAX_WINDOW_MISMATCH: "evidence-window-differs-renew-first",
  INTERNAL_TEST_TAX_OTHER_CONFIGURATION: "store-has-other-tax-configuration",
  INTERNAL_TEST_TAX_CONFLICT: "tax-changed-try-again",
});

/** Exactly what creating, checking and renewing the Store's tax configuration needs. */
export const internalTestStoreTaxGrants = Object.freeze([
  ["schema", "bop_tenant"],
  ["schema", "rms_store"],
  ["schema", "rms_pricing"],
  ["schema", "platform_audit"],
  ["schema", "platform_helpers"],
  ["type", "platform_helpers.uuid_v7"],
  ["routine", "platform_helpers.current_brand_id()"],
  ["routine", "platform_helpers.current_store_id()"],
  ["routine", "platform_helpers.is_uuid_v7(uuid)"],
  ["table", "bop_tenant.store", "SELECT"],
  ["table", "bop_tenant.store_opening", "SELECT"],
  // The Store's address as staff set it in Store setup (its province).
  ["table", "rms_store.store_setup_reference_version", "SELECT"],
  ["table", "rms_pricing.tax_configuration", "SELECT,INSERT"],
  [
    "column",
    "rms_pricing.tax_configuration",
    "UPDATE",
    ["aggregate_version", "current_version_id", "updated_at"],
  ],
  ["table", "rms_pricing.tax_configuration_version", "SELECT,INSERT"],
  ["table", "rms_pricing.tax_configuration_rule", "SELECT,INSERT"],
  // The renewal restores a missing Brand projection row as the root trigger would.
  ["table", "rms_pricing.tax_reference_generation", "SELECT,INSERT"],
  ["column", "rms_pricing.tax_reference_generation", "UPDATE", ["generation", "reference_count"]],
  ["table", "rms_pricing.tax_reference_scope", "SELECT,INSERT"],
  ["table", "rms_pricing.tax_config_publication_candidate", "SELECT"],
  ["table", "rms_pricing.tax_config_candidate_rule", "SELECT"],
  ["table", "rms_pricing.tax_config_authoring_operation", "SELECT"],
  ["table", "platform_audit.audit_record", "SELECT,INSERT"],
  ["table", "platform_audit.audit_chain_head", "SELECT,INSERT"],
  ["column", "platform_audit.audit_chain_head", "UPDATE", ["next_sequence", "last_record_hash"]],
]);
export function storeTaxRoleName(database) {
  const name = database + "_internal_test_store_tax";
  return IDENTIFIER.test(name) ? name : unavailable("expected-database-invalid");
}
export function renderStoreTaxRoleSql(role) {
  if (!IDENTIFIER.test(role)) return unavailable("expected-database-invalid");
  const q = (value) =>
    QUALIFIED.test(value) || IDENTIFIER.test(value) ? value : unavailable("grant-invalid");
  const statements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE; END IF; END $$`,
    `ALTER ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE`,
  ];
  const tables = [
    ...new Set(
      internalTestStoreTaxGrants
        .filter(([type]) => type === "table" || type === "column")
        .map(([, object]) => object),
    ),
  ];
  for (const object of tables) statements.push(`REVOKE ALL ON TABLE ${q(object)} FROM "${role}"`);
  for (const [type, object, privileges, columns] of internalTestStoreTaxGrants)
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

/** The served Store's profile naming its own tax configuration created at `createdAt`. */
export function profileWithStoreTax(profile, createdAt) {
  const next = { ...profile, storeTaxConfiguration: { createdAt } };
  // The installation Store's renewed version is not this Store's.
  delete next.taxConfigurationVersion;
  return next;
}
const policyOf = (profile, menu, database) =>
  createInternalPricingPolicy({
    loadProfile: async () => profile,
    loadMenu: async () => menu,
    expectedDatabaseName: database,
  });
/** The quote's read of the configuration, as the services' role sees it, at `at`. */
async function servicesRead(client, tx, { readRole, policy, at }) {
  await client.query("SAVEPOINT store_tax_read_check");
  try {
    await client.query(`SET LOCAL ROLE "${readRole}"`);
    const snapshot = await createPostgresCurrentTaxConfigurationStore(
      { run: (work) => work(tx) },
      {
        brandReference: policy.scope.brandReference,
        storeReference: policy.scope.storeReference,
      },
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
    return snapshot !== null && snapshot.snapshotDigest === policy.taxConfiguration.snapshotDigest;
  } catch {
    return false;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT store_tax_read_check");
  }
}
const pricingFailure = (error) =>
  error instanceof InternalTestTaxEvidenceRenewalError
    ? unavailable(taxReasons[error.code] ?? "database-check-failed")
    : error instanceof InternalTestStoreSetupError
      ? Promise.reject(error)
      : unavailable("database-check-failed", error);

/**
 * Creates the TEST Store's tax configuration, or answers the one it has. `client` is the
 * operator's own connection (it SETs ROLE to the tax role, and to `readRole` for the check);
 * `installationProfile`/`installationMenu` and `storeProfile`/`menu` are the installation's and
 * the Store's directory files.
 * Returns the profile the Store's directory must hold.
 */
export async function createInternalTestStoreTax(
  client,
  {
    environment,
    database,
    role,
    readRole,
    installationProfile,
    installationMenu,
    storeProfile,
    menu,
    approverActorReference,
    now,
    evidence,
    nextReference,
  },
) {
  if (environment !== "InternalTest") return unavailable("internal-test-only");
  const binding = installationProfile?.binding;
  const storeReference = storeProfile?.binding?.storeReference;
  if (
    ![
      binding?.tenantReference,
      binding?.brandReference,
      binding?.storeReference,
      storeReference,
      approverActorReference,
      evidence?.operationReference,
    ].every((value) => typeof value === "string" && UUID_V7.test(value)) ||
    storeReference === binding.storeReference ||
    storeProfile.binding.brandReference !== binding.brandReference ||
    storeProfile.binding.tenantReference !== binding.tenantReference ||
    !IDENTIFIER.test(role) ||
    !IDENTIFIER.test(readRole) ||
    typeof nextReference !== "function" ||
    typeof evidence.approval !== "string" ||
    evidence.approval.trim() === "" ||
    typeof evidence.approvedBy !== "string" ||
    evidence.approvedBy.trim() === ""
  )
    return unavailable("input-invalid");
  const at = now();
  const source = await policyOf(installationProfile, installationMenu, database);
  const target = await policyOf(profileWithStoreTax(storeProfile, at), menu, database);
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    if ((await client.query("SELECT current_database() db")).rows[0]?.db !== database)
      unavailable("database-mismatch");
    await client.query(`SET LOCAL ROLE "${role}"`);
    const tx = { query: (sql, values = []) => client.query(sql, [...values]) };
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [binding.tenantReference, binding.brandReference, storeReference],
    );
    // The TEST Store as opened in the product.
    const [store] = (
      await tx.query(
        "SELECT s.display_name,s.lifecycle FROM bop_tenant.store s JOIN bop_tenant.store_opening o ON o.brand_id=s.brand_id AND o.store_id=s.store_id WHERE s.brand_id=$1 AND s.store_id=$2",
        [binding.brandReference, storeReference],
      )
    ).rows;
    if (store === undefined) unavailable("store-not-opened-in-product");
    if (store.lifecycle !== "Active") unavailable("store-not-active");
    if (!internalTestStoreLabel.test(String(store.display_name)))
      unavailable("store-not-labelled-test");
    // Its province: the address staff set in Store setup (its latest revision).
    const [address] = (
      await tx.query(
        "SELECT snapshot_json->'content'->>'countryCode' country,snapshot_json->'content'->>'regionCode' region FROM rms_store.store_setup_reference_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reference_kind='Address' ORDER BY revision DESC LIMIT 1",
        [binding.tenantReference, binding.brandReference, storeReference],
      )
    ).rows;
    if (address === undefined) unavailable("store-address-not-set-in-store-setup");
    const [country, province] = String(target.taxConfiguration.jurisdictionCode).split("-");
    const region = String(address.region)
      .toUpperCase()
      .replace(/^[A-Z]{2}-/u, "");
    if (String(address.country).toUpperCase() !== country || region !== province)
      unavailable("store-province-differs");
    let result;
    try {
      result = await createInternalTestStoreTaxConfiguration(
        tx,
        {
          brandReference: binding.brandReference,
          sourceStoreReference: binding.storeReference,
          sourceConfigurationReference: source.taxConfiguration.configurationReference,
          target: target.taxConfiguration,
          approverActorReference,
          evidence: {
            operationReference: evidence.operationReference,
            approvedBy: evidence.approvedBy,
            approval: evidence.approval,
            reason: evidence.reason ?? "",
          },
          nextReference,
        },
        (transaction, record) => appendAuditRecordInTransaction(transaction, record),
      );
    } catch (error) {
      await pricingFailure(error);
    }
    if (result.status === "AlreadyPresent") {
      await client.query("ROLLBACK");
      const profile =
        storeProfile.storeTaxConfiguration?.createdAt === result.createdAt
          ? storeProfile
          : result.versionNumber === 1
            ? profileWithStoreTax(storeProfile, result.createdAt)
            : unavailable("store-profile-out-of-step");
      return Object.freeze({ ...result, profile });
    }
    // The services' quote reads it with the Store's evidence, or nothing is kept.
    if (!(await servicesRead(client, tx, { readRole, policy: target, at })))
      unavailable("read-check-failed");
    await client.query("COMMIT");
    return Object.freeze({ ...result, profile: profileWithStoreTax(storeProfile, at) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof InternalTestStoreSetupError) throw error;
    return unavailable("database-check-failed", error);
  }
}

/**
 * In the Store's `renew`: its own tax evidence moves from `from` to `to` (a new synthetic
 * version, as the installation's renewal does for store 1). A Store without its own tax
 * configuration has nothing to renew. Returns the profile's next `taxConfigurationVersion`.
 */
export async function renewInternalTestStoreTax(
  client,
  { database, role, readRole, profile, menu, from, to, now, evidence, dryRun, nextReference },
) {
  if (profile?.storeTaxConfiguration === undefined) return Object.freeze({ status: "None" });
  if (!IDENTIFIER.test(role) || !IDENTIFIER.test(readRole)) return unavailable("input-invalid");
  const at = now();
  const current = await policyOf(profile, menu, database);
  const nextVersion = {
    versionNumber: current.taxConfiguration.versionNumber + 1,
    createdAt: at,
  };
  const renewedProfile = {
    ...profile,
    binding: { ...profile.binding, validUntil: to },
    taxConfigurationVersion: nextVersion,
  };
  const next = await policyOf(renewedProfile, menu, database);
  const identity = internalTestTaxVersionIdentity(
    nextVersion.versionNumber,
    servedStoreTaxPrefix(profile.binding.storeReference),
  );
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    if ((await client.query("SELECT current_database() db")).rows[0]?.db !== database)
      unavailable("database-mismatch");
    await client.query(`SET LOCAL ROLE "${role}"`);
    const tx = { query: (sql, values = []) => client.query(sql, [...values]) };
    let tax;
    try {
      tax = await renewInternalTestTaxEvidence(
        tx,
        {
          brandReference: profile.binding.brandReference,
          storeReference: profile.binding.storeReference,
          configurationReference: current.taxConfiguration.configurationReference,
          from,
          to,
          at,
          next: {
            versionReference: identity.versionReference,
            versionNumber: nextVersion.versionNumber,
            snapshotDigest: next.taxConfiguration.snapshotDigest,
            rules: current.taxConfiguration.rules.map((rule, index) => ({
              from: rule.ruleReference,
              to: identity.ruleReferences[index],
            })),
          },
          evidence: {
            renewalReference: evidence.renewalReference,
            approvedBy: evidence.approvedBy,
            approval: evidence.approval,
            reason: evidence.reason,
            operatorAccount: evidence.operatorAccount,
          },
          nextReference,
        },
        (transaction, record) => appendAuditRecordInTransaction(transaction, record),
      );
    } catch (error) {
      await pricingFailure(error);
    }
    if (tax.status === "AlreadyRenewed") {
      await client.query("ROLLBACK");
      return Object.freeze({
        status: "AlreadyRenewed",
        taxConfigurationVersion: profile.taxConfigurationVersion ?? null,
      });
    }
    if (!(await servicesRead(client, tx, { readRole, policy: next, at })))
      unavailable("read-check-failed");
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return Object.freeze({ status: "Renewed", taxConfigurationVersion: nextVersion });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof InternalTestStoreSetupError) throw error;
    return unavailable("database-check-failed", error);
  }
}
