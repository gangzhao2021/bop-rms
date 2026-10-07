import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildStoreRoleProvisioningPlan,
  parseStoreRoleProvisioningPlan,
  storeRoleProvisioningPlanDigest,
  storeRoleProvisioningSigningBytes,
  verifyStoreRoleProvisioningApproval,
} from "../contracts/store-role-provisioning.js";
import { storeRoleTemplateActions } from "../catalog/store-permission-catalog.js";

const id = (n: number) => "01909a06-0000-7000-8000-" + n.toString(16).padStart(12, "0");
let sequence = 100;
const plan = buildStoreRoleProvisioningPlan({
  environmentReference: id(1),
  operationReference: id(2),
  operatorReference: id(3),
  tenantReference: id(4),
  brandReference: id(5),
  storeReference: id(6),
  catalogVersion: 1,
  catalogDigest: "sha256:" + "a".repeat(64),
  effectiveFrom: "2026-10-07T00:00:00.000Z",
  reasonCode: "STORE_OPENING",
  templates: ["owner", "store-manager", "front-of-house", "kitchen"],
  nextReference: () => id(++sequence),
});
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const unsigned = {
  profile: "StoreRoleProvisioningApprovalV1" as const,
  purposeCode: "STORE_ROLE_PROVISIONING" as const,
  environmentReference: id(1),
  operationReference: id(2),
  storeReference: id(6),
  planDigest: storeRoleProvisioningPlanDigest(plan),
  operatorReference: id(3),
  approvedByReference: id(7),
  approvalEvidenceReference: id(8),
  notBefore: "2026-10-07T00:00:00.000Z",
  validUntil: "2026-10-08T00:00:00.000Z",
  keyReference: id(9),
};
const approval = {
  ...unsigned,
  signature: sign(
    null,
    Buffer.from(storeRoleProvisioningSigningBytes(unsigned), "utf8"),
    privateKey,
  ).toString("base64url"),
};
const trust = (overrides: Record<string, unknown> = {}) => ({
  profile: "StoreRoleProvisioningTrustV1",
  keys: [
    {
      keyReference: id(9),
      approvedByReference: id(7),
      environmentReference: id(1),
      purposeCode: "STORE_ROLE_PROVISIONING",
      notBefore: "2026-10-01T00:00:00.000Z",
      validUntil: "2027-10-01T00:00:00.000Z",
      publicKeySpki: spki,
    },
  ],
  revokedApprovalEvidenceReferences: [],
  ...overrides,
});
const now = "2026-10-07T12:00:00.000Z";

describe("Store role provisioning plan", () => {
  it("lists every template role with its exact released actions", () => {
    expect(plan.roles.map((role) => role.roleCode)).toEqual([
      "store_owner",
      "store_manager",
      "front_of_house",
      "kitchen",
    ]);
    expect(plan.roles[3]?.actions).toEqual(storeRoleTemplateActions("kitchen"));
    // The kitchen role holds every replacement of kitchen.operate, so it keeps the legacy code.
    expect(plan.roles[3]?.actions).toContain("kitchen.operate");
    // Front of house holds only part of the kitchen replacements and must not gain kitchen.operate.
    expect(plan.roles[2]?.actions).not.toContain("kitchen.operate");
  });
  it("refuses edited actions, missing owner, duplicates and unknown templates", () => {
    const edit = (change: (roles: Record<string, unknown>[]) => unknown) =>
      parseStoreRoleProvisioningPlan({
        ...plan,
        roles: change(plan.roles.map((role) => ({ ...role, actions: [...role.actions] }))),
      });
    expect(() =>
      edit((roles) =>
        roles.map((r, i) =>
          i === 2
            ? { ...r, actions: [...(r.actions as string[]), "payment.refund.approve"].sort() }
            : r,
        ),
      ),
    ).toThrow(/PLAN_INVALID/u);
    expect(() => edit((roles) => roles.slice(1))).toThrow(/PLAN_INVALID/u);
    expect(() => edit((roles) => [...roles, roles[1]])).toThrow(/PLAN_INVALID/u);
    expect(() =>
      edit((roles) => roles.map((r, i) => (i === 1 ? { ...r, template: "auditor" } : r))),
    ).toThrow(/PLAN_INVALID/u);
  });
});

describe("Store role provisioning approval", () => {
  it("accepts the approver's signature over the exact plan", () => {
    expect(
      verifyStoreRoleProvisioningApproval({ plan, approval, trust: trust(), now })
        .approvedByReference,
    ).toBe(id(7));
  });
  it("refuses a changed plan, revoked or expired approval, self approval and a foreign key", () => {
    const changed = parseStoreRoleProvisioningPlan({ ...plan, reasonCode: "OTHER_REASON" });
    const refuse = (input: Parameters<typeof verifyStoreRoleProvisioningApproval>[0]) =>
      expect(() => verifyStoreRoleProvisioningApproval(input)).toThrow(/APPROVAL_UNAVAILABLE/u);
    refuse({ plan: changed, approval, trust: trust(), now });
    refuse({
      plan,
      approval,
      trust: trust({ revokedApprovalEvidenceReferences: [id(8)] }),
      now,
    });
    refuse({ plan, approval, trust: trust(), now: "2026-10-08T00:00:00.000Z" });
    refuse({ plan, approval: { ...approval, approvedByReference: id(3) }, trust: trust(), now });
    const other = generateKeyPairSync("ed25519").publicKey;
    refuse({
      plan,
      approval,
      trust: trust({
        keys: [
          {
            ...trust().keys[0],
            publicKeySpki: other.export({ format: "der", type: "spki" }).toString("base64url"),
          },
        ],
      }),
      now,
    });
  });
});
