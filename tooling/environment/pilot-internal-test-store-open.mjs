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
 *               planned restart serves it.
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
};
export function parseStoreOpenArguments(args) {
  const [command, directory, ...rest] = args;
  const known = flags[command];
  if (!known || typeof directory !== "string" || directory.startsWith("--"))
    return unavailable("arguments-invalid");
  const options = { command, directory, dryRun: false };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--dry-run" && command === "setup" && !options.dryRunSeen) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseStoreOpenArguments(process.argv.slice(2));
    if (process.env.NODE_ENV !== "development") unavailable("not-development-mode");
    const result =
      options.command === "setup"
        ? await setup(options)
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
