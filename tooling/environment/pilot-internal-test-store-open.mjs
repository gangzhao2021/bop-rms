#!/usr/bin/env node
import console from "node:console";
import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  issueInternalTestStoreDirectory,
  provisionStoreSimulator,
} from "./pilot-internal-test-store-directory.mjs";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segments 3b/3d — InternalTest only, a
 * test-environment-only shortcut (coordinator 2026-10-30). After the Owner opened a TEST Store on
 * the Stores page ("… – not production"):
 *
 *   merchant  — WP-2423 DEC-MULTI-MERCHANT-ONE-INSTALLATION A6: instead of the Stores page, a new
 *               merchant from nothing: its Brand, first Store, Owner, one tax class and one empty
 *               menu (database, one transaction, as the services' role). The other commands then
 *               take `--merchant <the same --operation>`. Prints the new merchant's references;
 *   setup     — its first published configuration and synthetic launch gate (database, one
 *               audited transaction; `--dry-run` rolls it back);
 *   tax       — after `directory`, and once its address is set in Store setup: its own synthetic
 *               tax configuration, a copy of the installation Store's (same province only;
 *               database, audited under the approver; the Store's profile then names it). A
 *               Store that has it gets it back, nothing written. Staff then publish Store setup
 *               (Review), which carries the Store's tax settings;
 *   kitchen   — its own kitchen routing (the installation Store's stations and rules under the
 *               Store's own identities; database, audited under the approver), so its paid orders
 *               reach its kitchen; a Store that has one gets it back, nothing written;
 *   stock-site — its default stock site and storage location (database, audited under the
 *               approver; a Store that has its default site gets it back, nothing written);
 *   directory — its runtime directory `stores/<name>/`, listed in `stores.json`, so the next
 *               planned restart serves it: only the files its services read, its own identities
 *               (the same on every run for the same Store) and its own default stock site, read
 *               from the database (`--stock-site` must name it if given; never another Store's);
 *   provider  — the Store's TEST payment simulator through its own initialiser (created when
 *               absent, missing tables added, no record removed); the directory given is the
 *               Store's (`…/stores/<name>`). `directory` runs it; this repairs a directory
 *               written before it did;
 *   settlement — optional: once the Store's first business day has closed, an explicit record
 *               of where its day-end settlement starts (that first day, never the latest closed
 *               day, read as the services do). The settlement worker starts without it, from the
 *               same first day; a rerun answers AlreadyRecorded, a different record is refused and
 *               nothing is written. The directory given is the Store's (`…/stores/<name>`);
 *   renew     — after the installation's own renewal: the Store's synthetic launch gate and its
 *               own tax evidence (`tax`; database) and its files' common expiry (task queue, its
 *               staff file's entries at that expiry, profile) move to the same `--until` (the
 *               Store's directory). A TEST merchant's Store too (v15 2026-11-06), once proven:
 *               served by `stores.json`, its own Tenant and Brand, both labelled "not production"
 *               and opened by `merchant`.
 *
 * Refuses outside development mode or an InternalTest installation. Prints fixed codes only.
 */
const unavailable = (reason) => {
  const error = new Error("PILOT_INTERNAL_TEST_STORE_OPEN_UNAVAILABLE");
  error.reason = reason;
  throw error;
};
function uuidV7(now = Date.now()) {
  const time = now.toString(16).padStart(12, "0"),
    hex = randomBytes(10).toString("hex");
  const variant = ((parseInt(hex.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex.slice(0, 3)}-${variant}${hex.slice(4, 7)}-${hex.slice(7, 19)}`;
}
const flags = {
  merchant: {
    "--database": "expectedDatabaseName",
    "--migration-env": "envFile",
    "--operation": "operationReference",
    "--owner": "ownerActorReference",
    "--operator": "operatorActorReference",
    "--brand-code": "brandCode",
    "--brand-name": "brandName",
    "--store-code": "storeCode",
    "--store-name": "storeName",
    "--time-zone": "timeZone",
    "--locale": "locale",
  },
  setup: {
    "--merchant": "merchantOperation",
    "--database": "expectedDatabaseName",
    "--migration-env": "envFile",
    "--store": "storeReference",
    "--approver": "approverActorReference",
    "--reason": "reason",
    "--approved-by": "approvedBy",
    "--approval": "approval",
  },
  "stock-site": {
    "--merchant": "merchantOperation",
    "--database": "expectedDatabaseName",
    "--migration-env": "envFile",
    "--store": "storeReference",
    "--approver": "approverActorReference",
    "--reason": "reason",
    "--approved-by": "approvedBy",
    "--approval": "approval",
  },
  kitchen: {
    "--database": "expectedDatabaseName",
    "--migration-env": "envFile",
    "--store": "storeReference",
    "--approver": "approverActorReference",
    "--reason": "reason",
    "--approved-by": "approvedBy",
    "--approval": "approval",
  },
  tax: {
    "--merchant": "merchantOperation",
    "--database": "expectedDatabaseName",
    "--migration-env": "envFile",
    "--store": "storeReference",
    "--approver": "approverActorReference",
    "--reason": "reason",
    "--approved-by": "approvedBy",
    "--approval": "approval",
  },
  directory: {
    "--merchant": "merchantOperation",
    "--database": "expectedDatabaseName",
    "--migration-env": "envFile",
    "--store": "storeReference",
    "--name": "name",
    "--stock-site": "stockSiteReference",
    "--owner": "ownerActorReference",
  },
  settlement: { "--database": "expectedDatabaseName", "--migration-env": "envFile" },
  provider: {},
  renew: {
    "--database": "expectedDatabaseName",
    "--migration-env": "envFile",
    "--until": "until",
    "--reason": "reason",
    "--approved-by": "approvedBy",
    "--approval": "approval",
  },
};
/** Flags a command may leave out: `directory` reads the Store's own default stock site. */
const optionalFlags = new Set([
  "directory:stockSiteReference",
  "setup:merchantOperation",
  "stock-site:merchantOperation",
  "tax:merchantOperation",
  "directory:merchantOperation",
  "directory:ownerActorReference",
]);
export function parseStoreOpenArguments(args) {
  const [command, directory, ...rest] = args;
  const known = flags[command];
  if (!known || typeof directory !== "string" || directory.startsWith("--"))
    return unavailable("arguments-invalid");
  const options = { command, directory, dryRun: false };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (
      flag === "--dry-run" &&
      (command === "setup" || command === "renew") &&
      !options.dryRunSeen
    ) {
      options.dryRun = options.dryRunSeen = true;
      continue;
    }
    const name = known[flag],
      value = rest[index + 1];
    if (
      !name ||
      Object.hasOwn(options, name) ||
      typeof value !== "string" ||
      value.startsWith("--")
    )
      return unavailable("arguments-invalid");
    options[name] = value;
    index += 1;
  }
  if (
    Object.values(known).some(
      (name) => !Object.hasOwn(options, name) && !optionalFlags.has(command + ":" + name),
    )
  )
    return unavailable("arguments-invalid");
  delete options.dryRunSeen;
  return Object.freeze(options);
}

/** The new merchant's references, derived from its opening operation as it derived them. */
async function merchantOf(options) {
  if (options.merchantOperation === undefined) return undefined;
  const { merchantOpeningReferences } = await import("../../apps/api/dist/merchant-opening.js");
  return merchantOpeningReferences(options.merchantOperation);
}
const withMerchant = (binding, merchant) =>
  merchant === undefined
    ? binding
    : {
        ...binding,
        tenantReference: merchant.tenantReference,
        brandReference: merchant.brandReference,
      };

/** A new merchant, in one transaction as the services' role. A rerun finds its own result. */
async function merchant(options) {
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const opening = await import("../../apps/api/dist/merchant-opening.js");
  const read = async (name) => JSON.parse(await readFile(join(options.directory, name), "utf8"));
  const installation = await read("installation.json"),
    profile = await read("internal-test-profile.json");
  if (installation.environment !== "InternalTest" || profile.environment !== "InternalTest")
    unavailable("not-internal-test");
  if (installation.database !== options.expectedDatabaseName) unavailable("database-mismatch");
  if (!/not production/u.test(options.brandName) || !/not production/u.test(options.storeName))
    unavailable("merchant-not-labelled-test");
  if (options.ownerActorReference === options.operatorActorReference)
    unavailable("owner-is-operator");
  const client = await database.connectRenewalDatabase(
    options.envFile,
    options.expectedDatabaseName,
  );
  try {
    const command = {
      operationReference: options.operationReference,
      ownerActorReference: options.ownerActorReference,
      brandCode: options.brandCode,
      brandName: options.brandName,
      storeCode: options.storeCode,
      storeName: options.storeName,
      timeZone: options.timeZone,
      locale: options.locale,
    };
    const openedAt = new Date().toISOString();
    await client.query("BEGIN");
    try {
      // TEST-ONLY: the Owner's authenticator status, as the DEMO staff have (a real Owner's comes
      // with their Cognito account). Identity's own row; the file's first person shows its shape.
      const staff = await read("internal-test-merchant.json");
      await client.query(
        "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) SELECT $1,status,NULL,NULL,NULL,1 FROM bop_identity.workforce_mfa_status WHERE actor_id=$2 ON CONFLICT (actor_id) DO NOTHING",
        [options.ownerActorReference, staff.actors[0].actorReference],
      );
      await client.query(`SET LOCAL ROLE "${installation.roles.api}"`);
      const result = await opening.recordMerchantOpening(client, {
        command,
        openedByActorReference: options.operatorActorReference,
        sourceChannel: "DEPLOYMENT",
        openedAt,
      });
      if (result.status === "Opened")
        await opening.recordMerchantFirstContent(client, { command, openedAt });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof opening.MerchantOpeningError)
        unavailable("merchant-" + error.code.toLowerCase());
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function setup(options) {
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const store = await import("./pilot-internal-test-store-setup.mjs");
  const read = async (name) => JSON.parse(await readFile(join(options.directory, name), "utf8"));
  const installation = await read("installation.json"),
    profile = await read("internal-test-profile.json");
  if (installation.environment !== "InternalTest" || profile.environment !== "InternalTest")
    unavailable("not-internal-test");
  if (installation.database !== options.expectedDatabaseName) unavailable("database-mismatch");
  const client = await database.connectRenewalDatabase(
    options.envFile,
    options.expectedDatabaseName,
  );
  try {
    const target = await merchantOf(options);
    const setupRole = store.storeSetupRoleName(options.expectedDatabaseName);
    for (const sql of store.renderStoreSetupRoleSql(setupRole)) await client.query(sql);
    return await store.setUpInternalTestStore(client, {
      environment: profile.environment,
      database: options.expectedDatabaseName,
      setupRole,
      readRole: installation.roles.api,
      binding: profile.binding,
      ...(target === undefined
        ? {}
        : {
            merchant: {
              tenantReference: target.tenantReference,
              brandReference: target.brandReference,
            },
          }),
      sourceStoreReference: profile.binding.storeReference,
      targetStoreReference: options.storeReference,
      approverActorReference: options.approverActorReference,
      now: () => new Date().toISOString(),
      evidence: {
        setupReference: uuidV7(),
        approvedBy: options.approvedBy,
        approval: options.approval,
        reason: options.reason,
        operatorAccount: "uid:" + process.getuid?.(),
      },
      dryRun: options.dryRun,
      nextReference: () => uuidV7(),
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function stockSite(options) {
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const site = await import("./pilot-internal-test-stock-site.mjs");
  const read = async (name) => JSON.parse(await readFile(join(options.directory, name), "utf8"));
  const installation = await read("installation.json"),
    profile = await read("internal-test-profile.json");
  if (installation.environment !== "InternalTest" || profile.environment !== "InternalTest")
    unavailable("not-internal-test");
  if (installation.database !== options.expectedDatabaseName) unavailable("database-mismatch");
  const client = await database.connectRenewalDatabase(
    options.envFile,
    options.expectedDatabaseName,
  );
  try {
    const role = site.stockSiteRoleName(options.expectedDatabaseName);
    for (const sql of site.renderStockSiteRoleSql(role)) await client.query(sql);
    return await site.createInternalTestStockSite(client, {
      environment: profile.environment,
      database: options.expectedDatabaseName,
      role,
      binding: withMerchant(profile.binding, await merchantOf(options)),
      storeReference: options.storeReference,
      approverActorReference: options.approverActorReference,
      now: () => new Date().toISOString(),
      evidence: {
        operationReference: uuidV7(),
        approvedBy: options.approvedBy,
        approval: options.approval,
        reason: options.reason,
      },
      nextReference: () => uuidV7(),
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function kitchen(options) {
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const routing = await import("./pilot-internal-test-kitchen-routing.mjs");
  const read = async (name) => JSON.parse(await readFile(join(options.directory, name), "utf8"));
  const installation = await read("installation.json"),
    profile = await read("internal-test-profile.json");
  if (installation.environment !== "InternalTest" || profile.environment !== "InternalTest")
    unavailable("not-internal-test");
  if (installation.database !== options.expectedDatabaseName) unavailable("database-mismatch");
  const client = await database.connectRenewalDatabase(
    options.envFile,
    options.expectedDatabaseName,
  );
  try {
    const role = routing.kitchenRoutingRoleName(options.expectedDatabaseName);
    for (const sql of routing.renderKitchenRoutingRoleSql(role)) await client.query(sql);
    const result = await routing.createInternalTestKitchenRouting(client, {
      environment: profile.environment,
      database: options.expectedDatabaseName,
      role,
      binding: profile.binding,
      storeReference: options.storeReference,
      approverActorReference: options.approverActorReference,
      now: () => new Date().toISOString(),
      evidence: {
        operationReference: uuidV7(),
        approvedBy: options.approvedBy,
        approval: options.approval,
        reason: options.reason,
      },
      nextReference: () => uuidV7(),
    });
    // The kitchen's own read, as the services' role: it routes the Store's items now.
    const routed = await routing.readStoreKitchenRouting(client, {
      role: installation.roles.api,
      binding: profile.binding,
      storeReference: options.storeReference,
      at: new Date().toISOString(),
    });
    if (routed === null) unavailable("read-check-failed");
    // Its sections and not-prepared dishes, as the services' role reads them.
    const setup = await routing.readStoreKitchenSetup(client, {
      role: installation.roles.api,
      binding: profile.binding,
      storeReference: options.storeReference,
    });
    if (
      setup.sections < result.setup.counts.sections ||
      setup.notPrepared < result.setup.counts.notPrepared
    )
      unavailable("read-check-failed");
    return Object.freeze({
      status: result.status,
      storeReference: options.storeReference,
      copied: result.setup.counts,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The served Store's directory (`stores/<name>`) from `stores.json`: the one serving `store`. */
export async function servedStoreDirectory(directory, storeReference) {
  let list;
  try {
    list = JSON.parse(await readFile(join(directory, "stores.json"), "utf8"));
  } catch {
    return unavailable("store-not-served-run-directory-first");
  }
  if (list?.schemaVersion !== 1 || !Array.isArray(list.stores))
    return unavailable("stores-list-invalid");
  for (const relative of list.stores) {
    if (typeof relative !== "string" || !/^stores\/[a-z0-9][a-z0-9-]{0,62}$/u.test(relative))
      return unavailable("stores-list-invalid");
    const profile = JSON.parse(
      await readFile(join(directory, relative, "internal-test-profile.json"), "utf8"),
    );
    if (profile?.binding?.storeReference === storeReference) return join(directory, relative);
  }
  return unavailable("store-not-served-run-directory-first");
}

async function storeTax(options) {
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const tax = await import("./pilot-internal-test-store-tax.mjs");
  const { rename, writeFile } = await import("node:fs/promises");
  const read = async (base, name) => JSON.parse(await readFile(join(base, name), "utf8"));
  const installation = await read(options.directory, "installation.json"),
    profile = await read(options.directory, "internal-test-profile.json");
  if (installation.environment !== "InternalTest" || profile.environment !== "InternalTest")
    unavailable("not-internal-test");
  if (installation.database !== options.expectedDatabaseName) unavailable("database-mismatch");
  const own = await servedStoreDirectory(options.directory, options.storeReference);
  const storeProfile = await read(own, "internal-test-profile.json");
  const client = await database.connectRenewalDatabase(
    options.envFile,
    options.expectedDatabaseName,
  );
  let result;
  try {
    const role = tax.storeTaxRoleName(options.expectedDatabaseName);
    for (const sql of tax.renderStoreTaxRoleSql(role)) await client.query(sql);
    result = await tax.createInternalTestStoreTax(client, {
      environment: profile.environment,
      database: options.expectedDatabaseName,
      role,
      readRole: installation.roles.api,
      installationProfile: profile,
      installationMenu: await read(options.directory, "internal-test-menu.json"),
      storeProfile,
      menu: await read(own, "internal-test-menu.json"),
      approverActorReference: options.approverActorReference,
      now: () => new Date().toISOString(),
      evidence: {
        operationReference: uuidV7(),
        approvedBy: options.approvedBy,
        approval: options.approval,
        reason: options.reason,
      },
      nextReference: () => uuidV7(),
    });
  } finally {
    await client.end().catch(() => undefined);
  }
  // The Store's services read their tax configuration from its profile.
  if (result.profile !== storeProfile) {
    const file = join(own, "internal-test-profile.json");
    await writeFile(file + ".next", JSON.stringify(result.profile, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(file + ".next", file);
  }
  return Object.freeze({
    status: result.status,
    storeReference: options.storeReference,
    taxConfigurationReference: result.configurationReference,
    versionNumber: result.versionNumber,
  });
}

/** The Store's runtime directory, with its own default stock site read as the services read it. */
async function directory(options) {
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const site = await import("./pilot-internal-test-stock-site.mjs");
  const read = async (name) => JSON.parse(await readFile(join(options.directory, name), "utf8"));
  const installation = await read("installation.json"),
    profile = await read("internal-test-profile.json");
  if (installation.environment !== "InternalTest" || profile.environment !== "InternalTest")
    unavailable("not-internal-test");
  if (installation.database !== options.expectedDatabaseName) unavailable("database-mismatch");
  const client = await database.connectRenewalDatabase(
    options.envFile,
    options.expectedDatabaseName,
  );
  const target = await merchantOf(options);
  let own;
  try {
    own = await site.readStoreDefaultStockSite(client, {
      role: installation.roles.api,
      binding: withMerchant(profile.binding, target),
      storeReference: options.storeReference,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
  return issueStoreDirectoryWithOwnSite(
    options,
    own,
    issueInternalTestStoreDirectory,
    target && {
      ...target,
      owner: {
        selector: "owner-" + options.name,
        actorReference: options.ownerActorReference,
        validUntil: profile.binding.validUntil,
      },
    },
  );
}

/**
 * Pure step of `directory` after the read: never another Store's site; with none yet, refuses and
 * says to run `stock-site` first.
 */
export function issueStoreDirectoryWithOwnSite(
  options,
  own,
  issue = issueInternalTestStoreDirectory,
  merchantFiles,
) {
  if (own === null) unavailable("stock-site-missing-run-stock-site-first");
  if (options.stockSiteReference !== undefined && options.stockSiteReference !== own)
    unavailable("stock-site-not-this-store");
  return issue({
    directory: options.directory,
    name: options.name,
    storeReference: options.storeReference,
    // The Store's own identities derive from the Store: a rerun gives the same ones.
    operationReference: options.storeReference,
    stockSiteReference: own,
    ...(merchantFiles === undefined ? {} : { merchant: merchantFiles }),
  });
}

async function settlement(options) {
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const { createInternalSettlementDays } = await import("./pilot-settlement-window.mjs");
  const { resolveOperatingConfiguration, createBindingAuthorization } =
    await import("./pilot-operating-source.mjs");
  const codes = await import("./pilot-store-publication-codes.mjs");
  const read = async (name) => JSON.parse(await readFile(join(options.directory, name), "utf8"));
  const installation = await read("installation.json"),
    profile = await read("internal-test-profile.json"),
    customer = await read("customer-runtime.json");
  if (installation.environment !== "InternalTest" || profile.environment !== "InternalTest")
    unavailable("not-internal-test");
  if (installation.database !== options.expectedDatabaseName) unavailable("database-mismatch");
  const client = await database.connectRenewalDatabase(
    options.envFile,
    options.expectedDatabaseName,
  );
  try {
    const scope = {
      tenantReference: profile.binding.tenantReference,
      brandReference: profile.binding.brandReference,
      storeReference: profile.binding.storeReference,
    };
    const [store] = (
      await client.query(
        "SELECT time_zone FROM bop_tenant.store WHERE brand_id=$1 AND store_id=$2",
        [scope.brandReference, scope.storeReference],
      )
    ).rows;
    if (store === undefined) unavailable("store-unavailable");
    const operating = {
      ...scope,
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes:
        resolveOperatingConfiguration(profile).liveGateRequirementCodes,
      requiredValidationCheckCodes: codes.storeConfigurationValidationCheckCodes,
      setupSnapshotReferences: codes.storeConfigurationSetupSnapshotReferences,
      authorize: createBindingAuthorization(profile.binding),
      hashContent: codes.storeConfigurationContentHash,
      timeZone: store.time_zone,
    };
    // As the services' api role, in the Store's scope.
    const transactions = {
      async run(work) {
        await client.query("BEGIN");
        try {
          await client.query(`SET LOCAL ROLE "${installation.roles.api}"`);
          await client.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          const value = await work({
            query: (sql, values) => client.query(sql, [...(values ?? [])]),
          });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
    };
    return await recordSettlementCoverage({
      directory: options.directory,
      first: () =>
        createInternalSettlementDays({
          resources: { scope, operating, transactions, now: () => new Date().toISOString() },
          active: async () => true,
        }).first(),
      base: {
        schemaVersion: 1,
        environment: "InternalTest",
        database: installation.database,
        scope: customer.scope,
      },
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * WP-2423 (settlement-coverage): writes the record of the Store's first business day (0600, never
 * over another file). Rerun-safe: the same record answers AlreadyRecorded; a different one is
 * refused and left as it is.
 */
export async function recordSettlementCoverage({ directory, first, base }) {
  const { coverageWindowOf, sameCoverageWindow } =
    await import("./pilot-daily-settlement-coverage.mjs");
  const { writeFile } = await import("node:fs/promises");
  let window;
  try {
    window = await first();
  } catch {
    unavailable("settlement-window-unavailable");
  }
  if (window === null) unavailable("no-closed-business-day");
  const coverage = { ...base, firstWindow: coverageWindowOf(window) };
  const file = join(directory, "daily-settlement-coverage.json");
  const answer = (status) =>
    Object.freeze({ status, firstBusinessDate: coverage.firstWindow.businessDate });
  try {
    await writeFile(file, JSON.stringify(coverage, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return answer("Recorded");
  } catch (error) {
    if (error?.code !== "EEXIST") unavailable("coverage-unwritable");
  }
  let recorded;
  try {
    recorded = JSON.parse(await readFile(file, "utf8"));
  } catch {
    unavailable("coverage-differs");
  }
  const same =
    JSON.stringify({ ...recorded, firstWindow: undefined }) ===
      JSON.stringify({ ...coverage, firstWindow: undefined }) &&
    recorded?.firstWindow !== null &&
    typeof recorded?.firstWindow === "object" &&
    Object.keys(recorded.firstWindow).length === 6 &&
    sameCoverageWindow(recorded.firstWindow, coverage.firstWindow);
  if (!same) unavailable("coverage-differs");
  return answer("AlreadyRecorded");
}

const SCOPE_KEYS = ["tenantReference", "brandReference", "storeReference"];
const SYNTHETIC = /^[0-9a-f]{8}-0000-7000-8000-[0-9a-f]{12}$/u;
const UUID_V7_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * v15 2026-11-06: the file half of a served Store's `renew`, checked before the database is
 * touched. The Store directory must be `stores/<name>` below an InternalTest installation of the
 * same database whose `stores.json` serves it. A Store whose Brand is not the installation's is a
 * TEST merchant's (own UUIDv7 Tenant and Brand; the database half proves its labels and opening).
 * Its staff file (`internal-test-merchant.json`) is renewed with the same proofs as the
 * installation's: every entry is either DEMO staff the installation's staff file also names, or
 * (a TEST merchant's Store only) its single Owner `owner-<name>`, also on the installation's staff
 * file; anyone else refuses. Entries ending at the common expiry move to `until`; a later (or
 * other) own end is kept and reported.
 */
export async function planServedStoreRenewal({ storeDirectory, from, until }) {
  const { rosterActorKind, privateDirectory, readPrivateFile, parseExact } =
    await import("./pilot-internal-test-renew.mjs");
  const own = await realpath(storeDirectory).catch(() => unavailable("store-directory-missing"));
  const name = basename(own);
  const root = dirname(dirname(own));
  if (basename(dirname(own)) !== "stores") return unavailable("store-not-served");
  // Owner-only directories and files in their exact written form, as the installation's renewal.
  for (const directory of [root, dirname(own), own]) await privateDirectory(directory);
  const json = async (base, file) => parseExact(await readPrivateFile(join(base, file))).value;
  const list = await json(root, "stores.json");
  if (
    list?.schemaVersion !== 1 ||
    !Array.isArray(list.stores) ||
    !list.stores.includes("stores/" + name)
  )
    return unavailable("store-not-served");
  const [rootInstallation, rootProfile, rootRoster, installation, profile, roster] =
    await Promise.all([
      json(root, "installation.json"),
      json(root, "internal-test-profile.json"),
      json(root, "internal-test-merchant.json"),
      json(own, "installation.json"),
      json(own, "internal-test-profile.json"),
      json(own, "internal-test-merchant.json"),
    ]);
  for (const value of [rootInstallation, rootProfile, rootRoster, installation, profile, roster])
    if (value?.environment !== "InternalTest") return unavailable("not-internal-test");
  const database = installation.database;
  if (
    [rootInstallation, rootProfile, rootRoster, profile, roster].some(
      (value) => value.database !== database,
    )
  )
    return unavailable("database-mismatch");
  const binding = profile.binding ?? {};
  if (profile.binding?.validUntil !== from) return unavailable("window-mismatch");
  const merchant = binding.brandReference !== rootProfile.binding?.brandReference;
  if (
    merchant &&
    (!UUID_V7_REFERENCE.test(binding.brandReference ?? "") ||
      SYNTHETIC.test(binding.brandReference) ||
      !UUID_V7_REFERENCE.test(binding.tenantReference ?? "") ||
      binding.tenantReference === rootProfile.binding?.tenantReference)
  )
    return unavailable("store-not-own-merchant");
  if (
    roster.schemaVersion !== 2 ||
    !Array.isArray(roster.actors) ||
    roster.actors.length < 1 ||
    roster.actors.length > 16 ||
    SCOPE_KEYS.some((key) => roster.scope?.[key] !== binding[key])
  )
    return unavailable("roster-invalid");
  const listed = (entry) =>
    Array.isArray(rootRoster.actors) &&
    rootRoster.actors.some(
      (value) =>
        value?.selector === entry.selector && value?.actorReference === entry.actorReference,
    );
  const changes = [],
    retained = [];
  const actors = roster.actors.map((entry, index) => {
    const kind = rosterActorKind(entry);
    const proven =
      listed(entry) &&
      (kind === "Demo" ||
        (kind === "TestMerchantOwner" &&
          merchant &&
          entry.selector === "owner-" + name &&
          roster.actors.length === 1));
    if (!proven) return unavailable("identity-not-synthetic");
    if (entry.validUntil === from) {
      changes.push({
        path: `actors[${index}].validUntil`,
        selector: entry.selector,
        from,
        to: until,
      });
      return { ...entry, validUntil: until };
    }
    if (entry.validUntil !== until)
      retained.push({ selector: entry.selector, kind, validUntil: entry.validUntil });
    return entry;
  });
  return Object.freeze({
    store: "stores/" + name,
    testMerchant: merchant,
    // The database half proves this is the Owner the merchant opening placed.
    ownerActorReference: merchant ? roster.actors[0].actorReference : undefined,
    roster: changes.length === 0 ? null : { ...roster, actors },
    rosterChanges: changes,
    retainedRosterEntries: retained,
  });
}

async function renew(options) {
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const store = await import("./pilot-internal-test-store-setup.mjs");
  const { rename, writeFile } = await import("node:fs/promises");
  const read = async (name) => JSON.parse(await readFile(join(options.directory, name), "utf8"));
  const installation = await read("installation.json"),
    profile = await read("internal-test-profile.json"),
    queue = await read("internal-test-task-queue.json");
  if (installation.environment !== "InternalTest" || profile.environment !== "InternalTest")
    unavailable("not-internal-test");
  if (installation.database !== options.expectedDatabaseName) unavailable("database-mismatch");
  const from = profile.binding.validUntil;
  // The files are proven before the database is touched.
  const plan = await planServedStoreRenewal({
    storeDirectory: options.directory,
    from,
    until: options.until,
  });
  const client = await database.connectRenewalDatabase(
    options.envFile,
    options.expectedDatabaseName,
  );
  let result, taxRenewal;
  try {
    const setupRole = store.storeSetupRoleName(options.expectedDatabaseName);
    for (const sql of store.renderStoreSetupRoleSql(setupRole)) await client.query(sql);
    result = await store.renewInternalTestStore(client, {
      environment: profile.environment,
      database: options.expectedDatabaseName,
      setupRole,
      readRole: installation.roles.api,
      binding: profile.binding,
      from,
      to: options.until,
      now: () => new Date().toISOString(),
      evidence: {
        renewalReference: uuidV7(),
        approvedBy: options.approvedBy,
        approval: options.approval,
        reason: options.reason,
        operatorAccount: "uid:" + process.getuid?.(),
      },
      dryRun: options.dryRun,
      nextReference: () => uuidV7(),
      servedTestMerchant: plan.testMerchant,
      ownerActorReference: plan.ownerActorReference,
    });
    // Its own tax evidence (`tax`), when it has its own configuration.
    const tax = await import("./pilot-internal-test-store-tax.mjs");
    const taxRole = tax.storeTaxRoleName(options.expectedDatabaseName);
    if (profile.storeTaxConfiguration !== undefined)
      for (const sql of tax.renderStoreTaxRoleSql(taxRole)) await client.query(sql);
    taxRenewal = await tax.renewInternalTestStoreTax(client, {
      database: options.expectedDatabaseName,
      role: taxRole,
      readRole: installation.roles.api,
      profile,
      menu: await read("internal-test-menu.json"),
      from,
      to: options.until,
      now: () => new Date().toISOString(),
      evidence: {
        renewalReference: uuidV7(),
        approvedBy: options.approvedBy,
        approval: options.approval,
        reason: options.reason,
        operatorAccount: "uid:" + process.getuid?.(),
      },
      dryRun: options.dryRun,
      nextReference: () => uuidV7(),
      servedTestMerchant: plan.testMerchant,
      ownerActorReference: plan.ownerActorReference,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
  result = {
    ...result,
    tax: taxRenewal.status,
    store: plan.store,
    rosterChanges: plan.rosterChanges,
    retainedRosterEntries: plan.retainedRosterEntries,
  };
  if (options.dryRun) return { ...result, from, to: options.until };
  // Files, the profile last: only the common expiry moves.
  const move = (value) => (value === from ? options.until : value);
  const nextQueue = {
    ...queue,
    effectiveUntil: move(queue.effectiveUntil),
    ...(queue.exceptionTaskPolicy
      ? {
          exceptionTaskPolicy: {
            ...queue.exceptionTaskPolicy,
            effectiveUntil: move(queue.exceptionTaskPolicy.effectiveUntil),
          },
        }
      : {}),
  };
  const nextProfile = {
    ...profile,
    binding: { ...profile.binding, validUntil: options.until },
    ...(taxRenewal.status === "Renewed"
      ? { taxConfigurationVersion: taxRenewal.taxConfigurationVersion }
      : {}),
  };
  for (const [name, value] of [
    ["internal-test-task-queue.json", nextQueue],
    // Its staff sign-in follows the window too (only the entries at the common expiry).
    ...(plan.roster === null ? [] : [["internal-test-merchant.json", plan.roster]]),
    ["internal-test-profile.json", nextProfile],
  ]) {
    const file = join(options.directory, name);
    await writeFile(file + ".next", JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(file + ".next", file);
  }
  return Object.freeze({ ...result, from, to: options.until });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseStoreOpenArguments(process.argv.slice(2));
    if (process.env.NODE_ENV !== "development") unavailable("not-development-mode");
    const result =
      options.command === "merchant"
        ? await merchant(options)
        : options.command === "setup"
          ? await setup(options)
          : options.command === "settlement"
            ? await settlement(options)
            : options.command === "renew"
              ? await renew(options)
              : options.command === "stock-site"
                ? await stockSite(options)
                : options.command === "tax"
                  ? await storeTax(options)
                  : options.command === "kitchen"
                    ? await kitchen(options)
                    : options.command === "provider"
                      ? await provisionStoreSimulator(options.directory)
                      : await directory(options);
    console.log(JSON.stringify(result));
  } catch (error) {
    const reason = typeof error?.reason === "string" ? error.reason : "unexpected-error";
    console.error(
      "PILOT_INTERNAL_TEST_STORE_OPEN_UNAVAILABLE (" +
        reason +
        "): InternalTest only; the Store must be opened on the Stores page, named '… – not production', and not set up yet. Nothing was changed.",
    );
    process.exitCode = 1;
  }
}
