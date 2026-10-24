import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  roleAssignmentApprovalSigningBytes,
  verifyRoleAssignmentPlatformApproval,
} from "../contracts/role-assignment-approval.js";

const id = (n: number) => "01909a0d-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const expected = {
  brandReference: id(1),
  storeReference: id(2),
  changeReference: id(3),
  roleReference: id(4),
  subjectReference: id(5),
  requestedByReference: id(6),
};
const unsigned = {
  profile: "RoleAssignmentPlatformApprovalV1" as const,
  purposeCode: "ROLE_ASSIGNMENT_APPROVAL" as const,
  environmentReference: id(7),
  ...expected,
  approvedByReference: id(8),
  approvalEvidenceReference: id(9),
  notBefore: "2026-10-07T00:00:00.000Z",
  validUntil: "2026-10-08T00:00:00.000Z",
  keyReference: id(10),
};
const signed = (body = unsigned) => ({
  ...body,
  signature: sign(
    null,
    Buffer.from(roleAssignmentApprovalSigningBytes(body), "utf8"),
    privateKey,
  ).toString("base64url"),
});
const trust = (purposeCode = "ROLE_ASSIGNMENT_APPROVAL", revoked: string[] = []) => ({
  profile: "StoreRoleProvisioningTrustV1",
  keys: [
    {
      keyReference: id(10),
      approvedByReference: id(8),
      environmentReference: id(7),
      purposeCode,
      notBefore: "2026-10-01T00:00:00.000Z",
      validUntil: "2027-10-01T00:00:00.000Z",
      publicKeySpki: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    },
  ],
  revokedApprovalEvidenceReferences: revoked,
});
const now = "2026-10-07T12:00:00.000Z";

describe("WP-2423 Platform approval of a pending Store role assignment", () => {
  it("accepts the approver's signature over exactly this request", () => {
    expect(
      verifyRoleAssignmentPlatformApproval({ approval: signed(), trust: trust(), now, expected })
        .approvedByReference,
    ).toBe(id(8));
  });
  it.each([
    [
      "another request",
      {
        approval: signed(),
        trust: trust(),
        now,
        expected: { ...expected, changeReference: id(30) },
      },
    ],
    [
      "another subject",
      {
        approval: signed(),
        trust: trust(),
        now,
        expected: { ...expected, subjectReference: id(31) },
      },
    ],
    ["revoked evidence", { approval: signed(), trust: trust(undefined, [id(9)]), now, expected }],
    [
      "expired approval",
      { approval: signed(), trust: trust(), now: "2026-10-08T00:00:00.000Z", expected },
    ],
    [
      "a key for another purpose",
      { approval: signed(), trust: trust("STORE_ROLE_PROVISIONING"), now, expected },
    ],
    [
      "the requester approving",
      {
        approval: signed({ ...unsigned, approvedByReference: id(6) }),
        trust: trust(),
        now,
        expected,
      },
    ],
    [
      "the subject approving",
      {
        approval: signed({ ...unsigned, approvedByReference: id(5) }),
        trust: trust(),
        now,
        expected,
      },
    ],
    [
      "a tampered signature",
      {
        approval: { ...signed(), roleReference: id(32) },
        trust: trust(),
        now,
        expected: { ...expected, roleReference: id(32) },
      },
    ],
  ])("refuses %s", (_label, input) => {
    expect(() => verifyRoleAssignmentPlatformApproval(input)).toThrow(/unavailable/u);
  });
});
