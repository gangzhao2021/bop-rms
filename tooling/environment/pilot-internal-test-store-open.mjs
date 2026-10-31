#!/usr/bin/env node
import console from "node:console";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { issueInternalTestStoreDirectory } from "./pilot-internal-test-store-directory.mjs";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segments 3b/3d — InternalTest only, a
 * test-environment-only shortcut (coordinator 2026-10-30). After the Owner opened a TEST Store on
 * the Stores page ("… – not production"):
 *
 *   setup     — its first published configuration and synthetic launch gate (database, one
 *               audited transaction; `--dry-run` rolls it back);
 *   directory — its runtime directory `stores/<name>/`, listed in `stores.json`, so the next
 *               planned restart serves it;
 *   settlement — once the Store's first business day has closed, its day-end settlement
 *               coverage (that day), read as the services do; its settlement worker starts at the
 *               next restart. The directory given is the Store's (`…/stores/<name>`);
 *   renew     — after the installation's own renewal: the Store's synthetic launch gate (database)
 *               and its files' common expiry move to the same `--until` (the Store's directory).
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
  setup: {
    "--database": "expectedDatabaseName",
    "--migration-env": "envFile",
    "--store": "storeReference",
    "--approver": "approverActorReference",
    "--reason": "reason",
    "--approved-by": "approvedBy",
    "--approval": "approval",
  },
  directory: { "--store": "storeReference", "--name": "name" },
  settlement: { "--database": "expectedDatabaseName", "--migration-env": "envFile" },
  renew: {
    "--database": "expectedDatabaseName",
    "--migration-env": "envFile",
    "--until": "until",
    "--reason": "reason",
    "--approved-by": "approvedBy",
    "--approval": "approval",
  },
};
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
  if (Object.values(known).some((name) => !Object.hasOwn(options, name)))
    return unavailable("arguments-invalid");
  delete options.dryRunSeen;
  return Object.freeze(options);
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
    const setupRole = store.storeSetupRoleName(options.expectedDatabaseName);
    for (const sql of store.renderStoreSetupRoleSql(setupRole)) await client.query(sql);
    return await store.setUpInternalTestStore(client, {
      environment: profile.environment,
      database: options.expectedDatabaseName,
      setupRole,
      readRole: installation.roles.api,
      binding: profile.binding,
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

async function settlement(options) {
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const { createInternalSettlementDays } = await import("./pilot-settlement-window.mjs");
  const { resolveOperatingConfiguration, createBindingAuthorization } =
    await import("./pilot-operating-source.mjs");
  const codes = await import("./pilot-store-publication-codes.mjs");
  const { writeFile } = await import("node:fs/promises");
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
    let window;
    try {
      window = await createInternalSettlementDays({
        resources: { scope, operating, transactions, now: () => new Date().toISOString() },
        active: async () => true,
      }).window();
    } catch {
      unavailable("no-closed-business-day");
    }
    const coverage = {
      schemaVersion: 1,
      environment: "InternalTest",
      database: installation.database,
      scope: customer.scope,
      firstWindow: {
        businessDate: window.businessDate,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        configurationReference: String(window.configurationReference),
        configurationVersion: window.configurationVersion,
        contentDigest: window.contentDigest,
      },
    };
    await writeFile(
      join(options.directory, "daily-settlement-coverage.json"),
      JSON.stringify(coverage, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    ).catch(() => unavailable("coverage-already-recorded"));
    return Object.freeze({ status: "Recorded", firstBusinessDate: window.businessDate });
  } finally {
    await client.end().catch(() => undefined);
  }
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
  const client = await database.connectRenewalDatabase(
    options.envFile,
    options.expectedDatabaseName,
  );
  let result;
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
    });
  } finally {
    await client.end().catch(() => undefined);
  }
  if (options.dryRun) return result;
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
  const nextProfile = { ...profile, binding: { ...profile.binding, validUntil: options.until } };
  for (const [name, value] of [
    ["internal-test-task-queue.json", nextQueue],
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
      options.command === "setup"
        ? await setup(options)
        : options.command === "settlement"
          ? await settlement(options)
          : options.command === "renew"
            ? await renew(options)
            : await issueInternalTestStoreDirectory({
                directory: options.directory,
                name: options.name,
                storeReference: options.storeReference,
                operationReference: uuidV7(),
              });
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
