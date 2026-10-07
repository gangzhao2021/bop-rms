import { Buffer } from "node:buffer";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/config.ts";
import {
  buildStoreRoleProvisioningPlan,
  parseStoreRoleProvisioningPlan,
  permissionCatalogDigest,
  provisionStoreRoles,
  readStoreTemplateRoles,
  storePermissionCatalogVersion,
  storeRoleProvisioningPlanDigest,
  storeRoleProvisioningSigningBytes,
  storeRoleTemplateCodes,
} from "../../packages/bop/permission/src/index.ts";
import { confirmStoreOpeningScope } from "../../packages/bop/tenant/src/index.ts";
import { confirmStoreMemberScope } from "../../packages/bop/membership/src/index.ts";
import { uuidV7 } from "./permission-catalog-install.mjs";

/**
 * WP-2423 / DEC-PERM-CATALOG Store opening role provisioning, four steps by two Platform people:
 *
 *   keygen   (approver, once)  --private-key <out.pem>  → prints the trust key entry to publish
 *   prepare  (operator)        --environment --operator --tenant --brand --store
 *                              --effective-from <ISO> --templates owner,store-manager,... --out <plan.json>
 *                              [--owner-actor --owner-membership --owner-store-assignment]
 *   prepare-upgrade (operator) the prepare flags plus --env-file: upgrades the Store's template roles
 *                              from its latest provisioned catalog version
 *   Owner flags assign an Owner, accepted only while the Store has no active Owner.
 *   sign     (approver)        --plan --private-key --approved-by --approval-evidence --key
 *                              --valid-hours <1..72> --out <approval.json>
 *   apply    (operator)        --env-file --confirm-target <environment>:<database>
 *                              --plan --approval --trust
 *
 * Run with `node --import ./tooling/environment/register-workspace-typescript.mjs`. Private keys never
 * leave the approver's file; output contains references, digests and counts only.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const pg = require("pg");

const ownerFlags = ["--owner-actor", "--owner-membership", "--owner-store-assignment"];
const optional = { prepare: ownerFlags, "prepare-upgrade": ownerFlags };
const commands = {
  keygen: ["--private-key"],
  "prepare-upgrade": [
    "--env-file",
    "--environment",
    "--operator",
    "--tenant",
    "--brand",
    "--store",
    "--effective-from",
    "--templates",
    "--out",
  ],
  prepare: [
    "--environment",
    "--operator",
    "--tenant",
    "--brand",
    "--store",
    "--effective-from",
    "--templates",
    "--out",
  ],
  sign: [
    "--plan",
    "--private-key",
    "--approved-by",
    "--approval-evidence",
    "--key",
    "--valid-hours",
    "--out",
  ],
  apply: ["--env-file", "--confirm-target", "--plan", "--approval", "--trust"],
};
export function parseCommand(args) {
  const [command, ...rest] = args;
  const flags = commands[command];
  if (!flags)
    throw new Error("usage: store-role-provisioning keygen|prepare|prepare-upgrade|sign|apply …");
  const allowed = [...flags, ...(optional[command] ?? [])];
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (
      !allowed.includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.startsWith("--")
    )
      throw new Error(`usage: store-role-provisioning ${command} ${flags.join(" ")}`);
    values.set(flag, value);
  }
  const optionalGiven = (optional[command] ?? []).filter((flag) => values.has(flag)).length;
  if (
    flags.some((flag) => !values.has(flag)) ||
    (optionalGiven !== 0 && optionalGiven !== (optional[command] ?? []).length)
  )
    throw new Error(`usage: store-role-provisioning ${command} ${allowed.join(" ")}`);
  return { command, get: (flag) => values.get(flag) };
}
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const writeNew = (file, text, mode = 0o600) => writeFile(file, text, { flag: "wx", mode });

export async function keygen(get) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeNew(get("--private-key"), privateKey.export({ format: "pem", type: "pkcs8" }));
  return {
    publicKeySpki: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}
function templatesOf(get) {
  const templates = get("--templates").split(",");
  if (templates.some((template) => !storeRoleTemplateCodes.includes(template)))
    throw new Error("unknown template; expected " + storeRoleTemplateCodes.join(","));
  return templates;
}
async function writePlan(get, input, nextReference) {
  const plan = buildStoreRoleProvisioningPlan({
    environmentReference: get("--environment"),
    operationReference: nextReference(),
    operatorReference: get("--operator"),
    tenantReference: get("--tenant"),
    brandReference: get("--brand"),
    storeReference: get("--store"),
    catalogVersion: storePermissionCatalogVersion,
    catalogDigest: permissionCatalogDigest(),
    effectiveFrom: get("--effective-from"),
    templates: templatesOf(get),
    nextReference,
    ...input,
  });
  await writeNew(get("--out"), JSON.stringify(plan, null, 2) + "\n", 0o644);
  return summary(plan);
}
const ownerOf = (get) =>
  get("--owner-actor") === undefined
    ? null
    : {
        actorReference: get("--owner-actor"),
        membershipReference: get("--owner-membership"),
        storeAssignmentReference: get("--owner-store-assignment"),
      };
export async function prepare(get, nextReference = () => uuidV7()) {
  return writePlan(
    get,
    { reasonCode: "STORE_OPENING", ownerAssignment: ownerOf(get) },
    nextReference,
  );
}
export async function prepareUpgrade(get, nextReference = () => uuidV7()) {
  const current = await withClient(
    get,
    async (client) => {
      await client.query("BEGIN READ ONLY");
      try {
        return await readStoreTemplateRoles(client, {
          tenantReference: get("--tenant"),
          brandReference: get("--brand"),
          storeReference: get("--store"),
        });
      } finally {
        await client.query("ROLLBACK");
      }
    },
    false,
  );
  if (current.latestCatalogVersion === null)
    throw new Error("the Store has not been opened; use prepare");
  return writePlan(
    get,
    {
      reasonCode: "STORE_ROLE_TEMPLATE_UPGRADE",
      ownerAssignment: ownerOf(get),
      previousCatalogVersion: current.latestCatalogVersion,
      existingRoles: current.roles,
    },
    nextReference,
  );
}
function summary(plan) {
  return {
    planDigest: storeRoleProvisioningPlanDigest(plan),
    operationReference: plan.operationReference,
    storeReference: plan.storeReference,
    catalogVersion: plan.catalogVersion,
    previousCatalogVersion: plan.previousCatalogVersion,
    ownerAssignment: plan.ownerAssignment?.actorReference ?? null,
    roles: plan.roles.map((role) => ({ roleCode: role.roleCode, actions: role.actions.length })),
  };
}
export async function signPlan(get, now = () => Date.now()) {
  const plan = parseStoreRoleProvisioningPlan(await readJson(get("--plan")));
  const hours = Number(get("--valid-hours"));
  if (!Number.isInteger(hours) || hours < 1 || hours > 72)
    throw new Error("--valid-hours must be 1..72");
  const start = Math.floor(now() / 1000) * 1000;
  const unsigned = {
    profile: "StoreRoleProvisioningApprovalV1",
    purposeCode: "STORE_ROLE_PROVISIONING",
    environmentReference: plan.environmentReference,
    operationReference: plan.operationReference,
    storeReference: plan.storeReference,
    planDigest: storeRoleProvisioningPlanDigest(plan),
    operatorReference: plan.operatorReference,
    approvedByReference: get("--approved-by"),
    approvalEvidenceReference: get("--approval-evidence"),
    notBefore: new Date(start).toISOString(),
    validUntil: new Date(start + hours * 3_600_000).toISOString(),
    keyReference: get("--key"),
  };
  if (unsigned.approvedByReference === unsigned.operatorReference)
    throw new Error("the approver must not be the operator");
  const privateKey = createPrivateKey(await readFile(get("--private-key")));
  const signature = sign(
    null,
    Buffer.from(storeRoleProvisioningSigningBytes(unsigned), "utf8"),
    privateKey,
  ).toString("base64url");
  await writeNew(get("--out"), JSON.stringify({ ...unsigned, signature }, null, 2) + "\n", 0o644);
  return { ...summary(plan), validUntil: unsigned.validUntil };
}
/** Serialization or deadlock aborts are retried a bounded number of times; nothing is committed. */
export async function apply(get, attempts = 3) {
  for (let attempt = 1; ; attempt += 1)
    try {
      return await applyOnce(get);
    } catch (error) {
      if (attempt >= attempts || !["40001", "40P01"].includes(error?.code)) throw error;
    }
}
async function withClient(get, work, confirm = true) {
  const config = await loadMigrationConnectionConfig(root, get("--env-file"));
  if (confirm && get("--confirm-target") !== `${config.environment}:${config.database}`)
    throw new Error("STORE_ROLE_PROVISIONING_TARGET_NOT_CONFIRMED");
  const client = new pg.Client({
    application_name: "bop-rms-store-role-provisioning",
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
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
async function applyOnce(get) {
  const plan = await readJson(get("--plan"));
  return withClient(get, async (client) => {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      let latest = 0;
      const result = await provisionStoreRoles(client, plan, {
        clock: {
          now: () => {
            latest = Math.max(latest, Date.now());
            return new Date(latest).toISOString();
          },
        },
        // Files are reread before COMMIT so a revocation published meanwhile is honoured.
        readApprovalMaterial: async () => ({
          approval: await readJson(get("--approval")),
          trust: await readJson(get("--trust")),
        }),
        storeScope: { confirm: confirmStoreOpeningScope },
        memberScope: { confirm: confirmStoreMemberScope },
        nextReference: () => uuidV7(),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

export async function run(args) {
  const { command, get } = parseCommand(args);
  if (command === "keygen") return keygen(get);
  if (command === "prepare") return prepare(get);
  if (command === "prepare-upgrade") return prepareUpgrade(get);
  if (command === "sign") return signPlan(get);
  return apply(get);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2)).then(
    (result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"),
    (error) => {
      process.stderr.write(
        (typeof error?.code === "string" ? error.code : error?.message || "FAILED") + "\n",
      );
      process.exitCode = 1;
    },
  );
}
