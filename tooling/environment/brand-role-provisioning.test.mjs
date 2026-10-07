import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, it } from "vitest";
import {
  parseBrandRoleProvisioningPlan,
  verifyBrandRoleProvisioningApproval,
} from "../../packages/bop/permission/src/index.ts";
import { parseCommand, prepare, signPlan } from "./brand-role-provisioning.mjs";
import { keygen } from "./store-role-provisioning.mjs";

const id = (n) => "01909a0d-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const getter = (record) => (flag) => record[flag];

it("prepares a Brand plan the approver signs; an upgrade keeps existing role references", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "brand-roles-"));
  dirs.push(dir);
  const file = (name) => path.join(dir, name);
  const { publicKeySpki } = await keygen(getter({ "--private-key": file("approver.pem") }));
  let sequence = 100;
  const args = {
    "--env-file": file("unused.env"),
    "--environment": id(1),
    "--operator": id(2),
    "--tenant": id(3),
    "--brand": id(4),
    "--effective-from": "2026-10-07T00:00:00.000Z",
    "--templates": "brand-owner,recipe-developer,recipe-reviewer",
    "--owner-actor": id(9),
    "--owner-membership": id(10),
    "--out": file("plan.json"),
  };
  const prepared = await prepare(
    getter(args),
    () => id(++sequence),
    async () => ({ latestCatalogVersion: null, roles: {} }),
  );
  assert.deepEqual(
    prepared.roles.map((role) => role.roleCode),
    ["brand_owner", "recipe_developer", "recipe_reviewer"],
  );
  assert.equal(prepared.ownerAssignment, id(9));
  await signPlan(
    getter({
      "--plan": file("plan.json"),
      "--private-key": file("approver.pem"),
      "--approved-by": id(6),
      "--approval-evidence": id(7),
      "--key": id(8),
      "--valid-hours": "24",
      "--out": file("approval.json"),
    }),
    () => Date.parse("2026-10-07T09:00:00.000Z"),
  );
  const plan = parseBrandRoleProvisioningPlan(
    JSON.parse(await readFile(file("plan.json"), "utf8")),
  );
  const verified = verifyBrandRoleProvisioningApproval({
    plan,
    approval: JSON.parse(await readFile(file("approval.json"), "utf8")),
    trust: {
      profile: "StoreRoleProvisioningTrustV1",
      keys: [
        {
          keyReference: id(8),
          approvedByReference: id(6),
          environmentReference: id(1),
          purposeCode: "BRAND_ROLE_PROVISIONING",
          notBefore: "2026-10-01T00:00:00.000Z",
          validUntil: "2027-10-01T00:00:00.000Z",
          publicKeySpki,
        },
      ],
      revokedApprovalEvidenceReferences: [],
    },
    now: "2026-10-07T10:00:00.000Z",
  });
  assert.equal(verified.approvedByReference, id(6));
  // A Store provisioning key never approves a Brand plan.
  assert.throws(() =>
    verifyBrandRoleProvisioningApproval({
      plan,
      approval: JSON.parse("{}"),
      trust: {
        profile: "StoreRoleProvisioningTrustV1",
        keys: [],
        revokedApprovalEvidenceReferences: [],
      },
      now: "2026-10-07T10:00:00.000Z",
    }),
  );
  const existing = plan.roles[0];
  const upgrade = await prepare(
    getter({
      ...args,
      "--owner-actor": undefined,
      "--owner-membership": undefined,
      "--out": file("upgrade.json"),
    }),
    () => id(++sequence),
    async () => ({
      latestCatalogVersion: 2,
      roles: {
        "brand-owner": {
          roleReference: existing.roleReference,
          administrationReference: existing.administrationReference,
        },
      },
    }),
  );
  assert.equal(upgrade.previousCatalogVersion, 2);
  const upgraded = parseBrandRoleProvisioningPlan(
    JSON.parse(await readFile(file("upgrade.json"), "utf8")),
  );
  assert.equal(upgraded.roles[0].roleReference, existing.roleReference);
  assert.equal(upgraded.reasonCode, "BRAND_ROLE_TEMPLATE_UPGRADE");
});

it("accepts owner flags only together", () => {
  assert.throws(() =>
    parseCommand([
      "prepare",
      "--env-file",
      "x",
      "--environment",
      id(1),
      "--operator",
      id(2),
      "--tenant",
      id(3),
      "--brand",
      id(4),
      "--effective-from",
      "2026-10-07T00:00:00.000Z",
      "--templates",
      "brand-owner",
      "--out",
      "p.json",
      "--owner-actor",
      id(5),
    ]),
  );
});
