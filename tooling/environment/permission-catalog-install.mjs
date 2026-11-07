import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/index.ts";
import { synchronizePermissionCatalog } from "../../packages/bop/permission/src/index.ts";

/**
 * WP-2423 / DEC-PERM-CATALOG release step, run by the release operator right after `db:migrate apply`
 * with the same migration authority file:
 *
 *   node --import ./tooling/environment/register-workspace-typescript.mjs \
 *     tooling/environment/permission-catalog-install.mjs --env-file <path>
 *     --confirm-target <environment>:<database> --operator <uuid> --approved-by <uuid>
 *     --approval-evidence <uuid>
 *
 * `--operator` is the Platform release operator, `--approved-by` the independent Platform approver of
 * this release (never the operator) and `--approval-evidence` the release approval record. Prints
 * only the catalog version, digest and counts; never connection details.
 */
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const pg = require("pg");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const usage =
  "usage: permission-catalog-install --env-file <path> --confirm-target <environment>:<database> --operator <uuid> --approved-by <uuid> --approval-evidence <uuid>";

export function uuidV7(now = Date.now(), random = randomBytes(10)) {
  const time = now.toString(16).padStart(12, "0"),
    hex = random.toString("hex");
  const variant = ((parseInt(hex.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex.slice(0, 3)}-${variant}${hex.slice(4, 7)}-${hex.slice(7, 19)}`;
}

export function parseArguments(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (
      ![
        "--env-file",
        "--confirm-target",
        "--operator",
        "--approved-by",
        "--approval-evidence",
      ].includes(flag) ||
      typeof value !== "string" ||
      value.startsWith("--") ||
      flags.has(flag)
    )
      throw new Error(usage);
    flags.set(flag, value);
  }
  if (flags.size !== 5) throw new Error(usage);
  return {
    envFile: flags.get("--env-file"),
    confirmTarget: flags.get("--confirm-target"),
    operatorReference: flags.get("--operator"),
    approvedByReference: flags.get("--approved-by"),
    approvalEvidenceReference: flags.get("--approval-evidence"),
  };
}

export async function installPermissionCatalog(args, now = () => Date.now()) {
  const options = parseArguments(args);
  const config = await loadMigrationConnectionConfig(root, options.envFile);
  if (options.confirmTarget !== `${config.environment}:${config.database}`)
    throw new Error("PERMISSION_CATALOG_TARGET_NOT_CONFIRMED");
  const client = new pg.Client({
    application_name: "bop-rms-permission-catalog",
    connectionTimeoutMillis: 10_000,
    database: config.database,
    host: config.host,
    password: config.password,
    port: config.port,
    ssl: config.ssl,
    user: config.user,
  });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const occurredAt = new Date(now()).toISOString();
    const result = await synchronizePermissionCatalog(client, {
      operationReference: uuidV7(now()),
      operatorReference: options.operatorReference,
      approvedByReference: options.approvedByReference,
      approvalEvidenceReference: options.approvalEvidenceReference,
      auditReference: uuidV7(now()),
      occurredAt,
      nextPermissionReference: () => uuidV7(now()),
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  installPermissionCatalog(process.argv.slice(2)).then(
    (result) => process.stdout.write(JSON.stringify(result) + "\n"),
    (error) => {
      process.stderr.write(
        (typeof error?.code === "string" ? error.code : error?.message || "FAILED") + "\n",
      );
      process.exitCode = 1;
    },
  );
}
