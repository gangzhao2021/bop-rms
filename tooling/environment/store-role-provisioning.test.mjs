import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, it } from "vitest";
import {
  parseStoreRoleProvisioningPlan,
  verifyStoreRoleProvisioningApproval,
} from "../../packages/bop/permission/src/index.ts";
import { keygen, parseCommand, prepare, signPlan } from "./store-role-provisioning.mjs";

const id = (n) => "01909a08-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const getter = (record) => (flag) => record[flag];

it("prepares a plan the approver signs with a private key file that stays private", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "store-roles-"));
  dirs.push(dir);
  const file = (name) => path.join(dir, name);
  const { publicKeySpki } = await keygen(getter({ "--private-key": file("approver.pem") }));
  assert.equal((await stat(file("approver.pem"))).mode & 0o777, 0o600);
  let sequence = 100;
  const prepared = await prepare(
    getter({
      "--environment": id(1),
      "--operator": id(2),
      "--tenant": id(3),
      "--brand": id(4),
      "--store": id(5),
      "--effective-from": "2026-10-07T00:00:00.000Z",
      "--templates": "owner,store-manager,front-of-house,kitchen",
      "--out": file("plan.json"),
    }),
    () => id(++sequence),
  );
  assert.deepEqual(
    prepared.roles.map((role) => role.roleCode),
    ["store_owner", "store_manager", "front_of_house", "kitchen"],
  );
  const signArgs = {
    "--plan": file("plan.json"),
    "--private-key": file("approver.pem"),
    "--approved-by": id(6),
    "--approval-evidence": id(7),
    "--key": id(8),
    "--valid-hours": "24",
    "--out": file("approval.json"),
  };
  await signPlan(getter(signArgs), () => Date.parse("2026-10-07T09:00:00.000Z"));
  const plan = parseStoreRoleProvisioningPlan(
    JSON.parse(await readFile(file("plan.json"), "utf8")),
  );
  const approval = JSON.parse(await readFile(file("approval.json"), "utf8"));
  const verified = verifyStoreRoleProvisioningApproval({
    plan,
    approval,
    trust: {
      profile: "StoreRoleProvisioningTrustV1",
      keys: [
        {
          keyReference: id(8),
          approvedByReference: id(6),
          environmentReference: id(1),
          purposeCode: "STORE_ROLE_PROVISIONING",
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
  // The operator cannot approve their own plan, and an existing output file is never overwritten.
  await assert.rejects(
    signPlan(getter({ ...signArgs, "--approved-by": id(2), "--out": file("self.json") })),
    /must not be the operator/u,
  );
  await assert.rejects(signPlan(getter(signArgs)), /EEXIST/u);
});

it("requires every flag of a command exactly once", () => {
  assert.throws(() => parseCommand(["apply", "--plan", "p"]), /usage/u);
  assert.throws(() => parseCommand(["delete"]), /usage/u);
  assert.equal(parseCommand(["keygen", "--private-key", "k.pem"]).get("--private-key"), "k.pem");
});
