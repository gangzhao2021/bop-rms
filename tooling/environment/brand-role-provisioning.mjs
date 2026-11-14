import { Buffer } from "node:buffer";
import { createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { loadMigrationConnectionConfig } from "../../packages/database/src/config.ts";
import {
  brandRoleProvisioningPlanDigest,
  brandRoleProvisioningSigningBytes,
  brandRoleTemplateCodes,
  buildBrandRoleProvisioningPlan,
  decideRoleAssignment,
  listStoreRoleAssignments,
  parseBrandRoleProvisioningPlan,
  permissionCatalogDigest,
  provisionBrandRoles,
  readBrandTemplateRoles,
  readRoleAssignmentDecision,
  storePermissionCatalogVersion,
  verifyRoleAssignmentPlatformApproval,
} from "../../packages/bop/permission/src/index.ts";
import { confirmBrandMemberScope } from "../../packages/bop/membership/src/index.ts";
import { uuidV7 } from "./permission-catalog-install.mjs";
import { keygen, signAssignment } from "./store-role-provisioning.mjs";

/**
 * WP-2423 / DEC-PERM-BRAND-ROLES Brand role provisioning, by two Platform people (the approver's
 * key is created with `store-role-provisioning keygen` and published with purpose
 * BRAND_ROLE_PROVISIONING):
 *
 *   prepare  (operator)  --env-file --environment --operator --tenant --brand --effective-from
 *                        --templates brand-owner,recipe-developer,recipe-reviewer --out <plan.json>
 *                        [--owner-actor --owner-membership]   (accepted only while no Brand Owner)
 *                        Upgrades the Brand roles when the Brand was already provisioned.
 *   sign     (approver)  --plan --private-key --approved-by --approval-evidence --key
 *                        --valid-hours <1..72> --out <approval.json>
 *   apply    (operator)  --env-file --confirm-target <environment>:<database> --plan --approval --trust
 *
 * Platform approval of a pending Brand role assignment (no second Brand administrator yet):
 *   prepare-assignment (operator) --env-file --environment --tenant --brand --change --out
 *   sign-assignment    (approver) as for Store role assignments (store-role-provisioning.mjs)
 *   apply-assignment   (operator) --env-file --confirm-target --approval --trust
 *
 * Run with `node --import ./tooling/environment/register-workspace-typescript.mjs`. Output carries
 * references, digests and counts only.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const pg = require("pg");

const ownerFlags = ["--owner-actor", "--owner-membership"];
const commands = {
  prepare: [
    "--env-file",
    "--environment",
    "--operator",
    "--tenant",
    "--brand",
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
  "prepare-assignment": ["--env-file", "--environment", "--tenant", "--brand", "--change", "--out"],
  "sign-assignment": [
    "--request",
    "--private-key",
    "--approved-by",
    "--approval-evidence",
    "--key",
    "--valid-hours",
    "--out",
  ],
  "apply-assignment": ["--env-file", "--confirm-target", "--approval", "--trust"],
  keygen: ["--private-key"],
};
const optional = { prepare: ownerFlags };
export function parseCommand(args) {
  const [command, ...rest] = args;
  const flags = commands[command];
  if (!flags) throw new Error("usage: brand-role-provisioning prepare|sign|apply|…");
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
      throw new Error(`usage: brand-role-provisioning ${command} ${flags.join(" ")}`);
    values.set(flag, value);
  }
  const optionalGiven = (optional[command] ?? []).filter((flag) => values.has(flag)).length;
  if (
    flags.some((flag) => !values.has(flag)) ||
    (optionalGiven !== 0 && optionalGiven !== (optional[command] ?? []).length)
  )
    throw new Error(`usage: brand-role-provisioning ${command} ${allowed.join(" ")}`);
  return { command, get: (flag) => values.get(flag) };
}
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const writeNew = (file, text, mode = 0o600) => writeFile(file, text, { flag: "wx", mode });

async function withClient(get, work, confirm = true) {
  const config = await loadMigrationConnectionConfig(root, get("--env-file"));
  if (confirm && get("--confirm-target") !== `${config.environment}:${config.database}`)
    throw new Error("BRAND_ROLE_PROVISIONING_TARGET_NOT_CONFIRMED");
  const client = new pg.Client({
    application_name: "bop-rms-brand-role-provisioning",
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
async function readOnly(get, work) {
  return withClient(
    get,
    async (client) => {
      await client.query("BEGIN READ ONLY");
      try {
        return await work(client);
      } finally {
        await client.query("ROLLBACK");
      }
    },
    false,
  );
}
function summary(plan) {
  return {
    planDigest: brandRoleProvisioningPlanDigest(plan),
    operationReference: plan.operationReference,
    brandReference: plan.brandReference,
    catalogVersion: plan.catalogVersion,
    previousCatalogVersion: plan.previousCatalogVersion,
    ownerAssignment: plan.ownerAssignment?.actorReference ?? null,
    roles: plan.roles.map((role) => ({ roleCode: role.roleCode, actions: role.actions.length })),
  };
}
const readCurrentRoles = (get) =>
  readOnly(get, (client) =>
    readBrandTemplateRoles(client, {
      tenantReference: get("--tenant"),
      brandReference: get("--brand"),
    }),
  );
export async function prepare(get, nextReference = () => uuidV7(), readCurrent = readCurrentRoles) {
  const templates = get("--templates").split(",");
  if (templates.some((template) => !brandRoleTemplateCodes.includes(template)))
    throw new Error("unknown template; expected " + brandRoleTemplateCodes.join(","));
  const current = await readCurrent(get);
  const plan = buildBrandRoleProvisioningPlan({
    environmentReference: get("--environment"),
    operationReference: nextReference(),
    operatorReference: get("--operator"),
    tenantReference: get("--tenant"),
    brandReference: get("--brand"),
    catalogVersion: storePermissionCatalogVersion,
    catalogDigest: permissionCatalogDigest(),
    previousCatalogVersion: current.latestCatalogVersion,
    existingRoles: current.roles,
    ownerAssignment:
      get("--owner-actor") === undefined
        ? null
        : {
            actorReference: get("--owner-actor"),
            membershipReference: get("--owner-membership"),
          },
    effectiveFrom: get("--effective-from"),
    reasonCode:
      current.latestCatalogVersion === null ? "BRAND_ROLE_OPENING" : "BRAND_ROLE_TEMPLATE_UPGRADE",
    templates,
    nextReference,
  });
  await writeNew(get("--out"), JSON.stringify(plan, null, 2) + "\n", 0o644);
  return summary(plan);
}
export async function signPlan(get, now = () => Date.now()) {
  const plan = parseBrandRoleProvisioningPlan(await readJson(get("--plan")));
  const hours = Number(get("--valid-hours"));
  if (!Number.isInteger(hours) || hours < 1 || hours > 72)
    throw new Error("--valid-hours must be 1..72");
  const start = Math.floor(now() / 1000) * 1000;
  const unsigned = {
    profile: "BrandRoleProvisioningApprovalV1",
    purposeCode: "BRAND_ROLE_PROVISIONING",
    environmentReference: plan.environmentReference,
    operationReference: plan.operationReference,
    brandReference: plan.brandReference,
    planDigest: brandRoleProvisioningPlanDigest(plan),
    operatorReference: plan.operatorReference,
    approvedByReference: get("--approved-by"),
    approvalEvidenceReference: get("--approval-evidence"),
    notBefore: new Date(start).toISOString(),
    validUntil: new Date(start + hours * 3_600_000).toISOString(),
    keyReference: get("--key"),
  };
  if (unsigned.approvedByReference === unsigned.operatorReference)
    throw new Error("the approver must not be the operator");
  const signature = sign(
    null,
    Buffer.from(brandRoleProvisioningSigningBytes(unsigned), "utf8"),
    createPrivateKey(await readFile(get("--private-key"))),
  ).toString("base64url");
  await writeNew(get("--out"), JSON.stringify({ ...unsigned, signature }, null, 2) + "\n", 0o644);
  return { ...summary(plan), validUntil: unsigned.validUntil };
}
export async function apply(get, attempts = 3) {
  for (let attempt = 1; ; attempt += 1)
    try {
      const plan = await readJson(get("--plan"));
      return await withClient(get, async (client) => {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        try {
          let latest = 0;
          const result = await provisionBrandRoles(client, plan, {
            clock: {
              now: () => {
                latest = Math.max(latest, Date.now());
                return new Date(latest).toISOString();
              },
            },
            readApprovalMaterial: async () => ({
              approval: await readJson(get("--approval")),
              trust: await readJson(get("--trust")),
            }),
            memberScope: { confirm: confirmBrandMemberScope },
            nextReference: () => uuidV7(),
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      if (attempt >= attempts || !["40001", "40P01"].includes(error?.code)) throw error;
    }
}

const brandScope = (brand) => ({ brandReference: brand, storeReference: null });
async function readPending(client, brand, changeReference) {
  const { pending } = await listStoreRoleAssignments(
    client,
    brandScope(brand),
    new Date().toISOString(),
  );
  return pending.find((item) => item.changeReference === changeReference) ?? null;
}
export async function prepareAssignment(get) {
  const change = await readOnly(get, (client) =>
    readPending(client, get("--brand"), get("--change")),
  );
  if (change === null) throw new Error("no pending Brand role assignment with that reference");
  const request = {
    profile: "RoleAssignmentApprovalRequestV1",
    environmentReference: get("--environment"),
    tenantReference: get("--tenant"),
    ...brandScope(get("--brand")),
    changeReference: change.changeReference,
    roleReference: change.roleReference,
    roleCode: change.roleCode,
    subjectReference: change.actorReference,
    requestedByReference: change.requestedBy,
    requestedAt: change.requestedAt,
  };
  await writeNew(get("--out"), JSON.stringify(request, null, 2) + "\n", 0o644);
  return request;
}
export async function applyAssignment(get) {
  const approval = await readJson(get("--approval"));
  if (approval.storeReference !== null) throw new Error("not a Brand role assignment approval");
  return withClient(get, async (client) => {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      const scope = brandScope(approval.brandReference);
      const change = await readPending(client, approval.brandReference, approval.changeReference);
      if (change === null) {
        const decided = await readRoleAssignmentDecision(client, scope, approval.changeReference);
        await client.query("ROLLBACK");
        if (decided?.decision === "Approved" && decided.decidedBy === approval.approvedByReference)
          return { status: "AlreadyApplied", policyVersion: decided.policyVersion };
        throw new Error("ROLE_ASSIGNMENT_NOT_PENDING");
      }
      const at = new Date().toISOString();
      const verified = verifyRoleAssignmentPlatformApproval({
        approval,
        trust: await readJson(get("--trust")),
        now: at,
        expected: {
          ...scope,
          changeReference: change.changeReference,
          roleReference: change.roleReference,
          subjectReference: change.actorReference,
          requestedByReference: change.requestedBy,
        },
      });
      const result = await decideRoleAssignment(
        client,
        {
          ...scope,
          changeReference: change.changeReference,
          decision: "Approved",
          decidedBy: verified.approvedByReference,
          at,
          auditReference: uuidV7(),
          snapshotReference: uuidV7(),
          platformApprovalEvidence: verified.approvalEvidenceReference,
        },
        (member) =>
          confirmBrandMemberScope(client, {
            brandReference: approval.brandReference,
            actorReference: member.actorReference,
            membershipReference: member.membershipReference,
            at,
          }),
      );
      await client.query("COMMIT");
      return { ...result, approvalEvidence: verified.approvalEvidenceReference };
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
  if (command === "sign") return signPlan(get);
  if (command === "prepare-assignment") return prepareAssignment(get);
  if (command === "sign-assignment") return signAssignment(get);
  if (command === "apply-assignment") return applyAssignment(get);
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
