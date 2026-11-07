import {
  applyStockPlaceCommand,
  createPostgresStockPlaceStore,
} from "../../packages/rms/inventory/src/index.ts";
import {
  InternalTestStoreSetupError,
  internalTestStoreLabel,
} from "./pilot-internal-test-store-setup.mjs";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (coordinator 2026-10-31, option B) — InternalTest
 * only, a test-environment-only shortcut. A TEST Store opened in the product gets its default stock
 * site before its first service, as a real restaurant's stock place exists before it opens: the
 * Inventory owner's own stock-place Create commands (the same as Supply → Locations "set up"): the
 * default site and its default storage location, each recorded and audited under the approver with
 * the Owner's approval wording. Idempotent: a Store that already has its default site gets that
 * site back and nothing is written. Its stock starts empty: stock-tracked dishes are sold out there
 * until stock is received; nothing is ever drawn from another Store's stock.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*(?:\([a-z_, ]*\))?$/u;
const unavailable = (reason, cause) => {
  throw new InternalTestStoreSetupError(reason, cause === undefined ? undefined : { cause });
};

/** Exactly what creating the stock site writes and reads. */
export const internalTestStockSiteGrants = Object.freeze([
  ["schema", "bop_tenant"],
  ["schema", "rms_inventory"],
  ["schema", "platform_audit"],
  ["schema", "platform_helpers"],
  ["type", "platform_helpers.uuid_v7"],
  ["routine", "platform_helpers.current_brand_id()"],
  ["routine", "platform_helpers.current_store_id()"],
  ["routine", "platform_helpers.is_uuid_v7(uuid)"],
  ["table", "bop_tenant.store", "SELECT"],
  ["table", "bop_tenant.store_opening", "SELECT"],
  ["table", "rms_inventory.stock_site", "SELECT,INSERT"],
  ["table", "rms_inventory.stock_site_version", "SELECT,INSERT"],
  ["table", "rms_inventory.storage_location", "SELECT,INSERT"],
  ["table", "rms_inventory.storage_location_version", "SELECT,INSERT"],
  ["table", "rms_inventory.stock_place_operation", "SELECT,INSERT"],
  ["table", "platform_audit.audit_record", "SELECT,INSERT"],
  ["table", "platform_audit.audit_chain_head", "SELECT,INSERT"],
  ["column", "platform_audit.audit_chain_head", "UPDATE", ["next_sequence", "last_record_hash"]],
]);
export function stockSiteRoleName(database) {
  const name = database + "_internal_test_stock_site";
  return IDENTIFIER.test(name) ? name : unavailable("expected-database-invalid");
}
export function renderStockSiteRoleSql(role) {
  if (!IDENTIFIER.test(role)) return unavailable("expected-database-invalid");
  const q = (value) =>
    QUALIFIED.test(value) || IDENTIFIER.test(value) ? value : unavailable("grant-invalid");
  const statements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE; END IF; END $$`,
    `ALTER ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE`,
  ];
  const tables = [
    ...new Set(
      internalTestStockSiteGrants
        .filter(([type]) => type === "table" || type === "column")
        .map(([, object]) => object),
    ),
  ];
  for (const object of tables) statements.push(`REVOKE ALL ON TABLE ${q(object)} FROM "${role}"`);
  for (const [type, object, privileges, columns] of internalTestStockSiteGrants)
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

/** The Store's default stock site (its active one), as the given role reads it; null when none. */
export async function readStoreDefaultStockSite(client, { role, binding, storeReference }) {
  if (!IDENTIFIER.test(role) || !UUID_V7.test(storeReference ?? ""))
    return unavailable("input-invalid");
  const places = createPostgresStockPlaceStore(
    {
      run: async (work) => {
        await client.query("BEGIN READ ONLY");
        try {
          await client.query(`SET LOCAL ROLE "${role}"`);
          return await work({ query: (sql, values = []) => client.query(sql, [...values]) });
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
        }
      },
    },
    {
      tenantReference: binding.tenantReference,
      brandReference: binding.brandReference,
      storeReference,
    },
  );
  const { sites } = await places.list();
  const site = sites.find((entry) => entry.isDefault && entry.lifecycle === "Active");
  return site === undefined ? null : String(site.stockSiteReference);
}

/**
 * Creates the TEST Store's default stock site and storage location, or answers the one it has.
 * `client` is the operator's own connection (it SETs ROLE to the stock-site role).
 */
export async function createInternalTestStockSite(
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
  const scope = {
    tenantReference: binding.tenantReference,
    brandReference: binding.brandReference,
    storeReference,
  };
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    if ((await client.query("SELECT current_database() db")).rows[0]?.db !== database)
      unavailable("database-mismatch");
    await client.query(`SET LOCAL ROLE "${role}"`);
    const tx = { query: (sql, values = []) => client.query(sql, [...values]) };
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenantReference, scope.brandReference, storeReference],
    );
    // The TEST Store as opened in the product.
    const [target] = (
      await tx.query(
        "SELECT s.display_name,s.lifecycle,o.actor_id::text opener FROM bop_tenant.store s JOIN bop_tenant.store_opening o ON o.brand_id=s.brand_id AND o.store_id=s.store_id WHERE s.brand_id=$1 AND s.store_id=$2",
        [scope.brandReference, storeReference],
      )
    ).rows;
    if (target === undefined) unavailable("store-not-opened-in-product");
    if (target.lifecycle !== "Active") unavailable("store-not-active");
    if (!internalTestStoreLabel.test(String(target.display_name)))
      unavailable("store-not-labelled-test");
    const places = createPostgresStockPlaceStore({ run: async (work) => work(tx) }, scope);
    const { sites } = await places.list();
    const existing = sites.find((site) => site.isDefault && site.lifecycle === "Active");
    if (existing !== undefined) {
      await client.query("ROLLBACK");
      return Object.freeze({
        status: "AlreadyPresent",
        storeReference,
        stockSiteReference: String(existing.stockSiteReference),
      });
    }
    if (sites.length > 0) unavailable("store-has-other-stock-sites");
    const context = { ...scope, actorReference: approverActorReference, occurredAt: at };
    const create = async (command) => {
      const candidate = applyStockPlaceCommand(null, command, context);
      const target =
        "locationReference" in candidate
          ? candidate.locationReference
          : candidate.stockSiteReference;
      const operationReference = nextReference();
      return places.commit({
        operationReference,
        command,
        candidate,
        audit: {
          auditId: nextReference(),
          brandId: scope.brandReference,
          storeId: storeReference,
          actor: { type: "User", reference: approverActorReference },
          actionCode:
            "INVENTORY_STOCK_PLACE_CREATE" + (command.kind === "StockSite" ? "_SITE" : "_LOCATION"),
          targetType: command.kind,
          targetId: target,
          reasonCode: "STORE_INVENTORY_SETUP",
          correlationId: operationReference,
          occurredAt: at,
          sourceChannel: "DEPLOYMENT",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_STANDARD",
          retentionPolicyVersion: 1,
          afterSummary: {
            environment: "InternalTest",
            approvedBy: evidence.approvedBy,
            approval: evidence.approval,
            reason: evidence.reason ?? null,
            setupOperationReference: evidence.operationReference,
          },
        },
      });
    };
    const site = await create({
      kind: "StockSite",
      action: "Create",
      stockSiteReference: nextReference(),
      payload: {
        siteKind: "Store",
        code: "STORE",
        isDefault: true,
        localizedNames: { "en-CA": String(target.display_name).slice(0, 120) },
      },
    });
    const stockSiteReference = String(site.place.stockSiteReference);
    await create({
      kind: "StorageLocation",
      action: "Create",
      locationReference: nextReference(),
      payload: {
        stockSiteReference,
        code: "MAIN",
        isDefault: true,
        localizedNames: { "en-CA": "Main storage" },
        temperatureZone: "Ambient",
        sortOrder: 0,
      },
    });
    await client.query("COMMIT");
    return Object.freeze({ status: "Created", storeReference, stockSiteReference });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof InternalTestStoreSetupError) throw error;
    return unavailable("database-check-failed", error);
  }
}
