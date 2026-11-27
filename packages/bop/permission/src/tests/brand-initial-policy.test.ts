import { describe, expect, it } from "vitest";
import {
  hashBrandInitialPolicyRequest,
  parseBrandInitialPolicyRequest,
} from "../contracts/brand-initial-policy.js";
import { brandAdministrationPermissionActions } from "../contracts/brand-administration-permission.js";
import * as f from "./current-policy.fixture.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing controlled fixture value");
  return value;
}
function input() {
  return {
    profile: "BrandInitialPolicyV1",
    operationReference: f.uuid("51"),
    brandReference: f.BRAND,
    planDigest: `sha256:${"1".repeat(64)}`,
    approvalEvidenceReference: f.uuid("52"),
    operatorReference: f.uuid("53"),
    approvedByReference: f.uuid("54"),
    policySnapshotReference: f.SNAPSHOT,
    auditReference: f.uuid("55"),
    occurredAt: f.AT,
    recipients: [
      {
        actorReference: f.ACTOR,
        membershipReference: f.MEMBERSHIP,
        roleReference: f.BRAND_ROLE,
        roleCode: "initial_brand_admin",
        assignmentReference: f.BRAND_ASSIGNMENT,
        effectiveFrom: f.FROM,
        effectiveUntil: f.UNTIL,
        grants: [
          {
            grantReference: f.BRAND_GRANT,
            permissionReference: f.PERMISSION,
            action: "organization.manage",
          },
        ],
      },
    ],
  };
}
describe("initialize-only Brand policy request", () => {
  it("copies the exact approved recipients and references without adding any default grant", () => {
    const raw = input(),
      request = parseBrandInitialPolicyRequest(raw);
    expect(request).toEqual(raw);
    expect(request).not.toBe(raw);
    expect(Object.isFrozen(request.recipients[0]?.grants)).toBe(true);
    expect(hashBrandInitialPolicyRequest(request)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(hashBrandInitialPolicyRequest(Object.fromEntries(Object.entries(raw).reverse()))).toBe(
      hashBrandInitialPolicyRequest(raw),
    );
    required(raw.recipients[0]).roleCode = "changed_after_parse";
    expect(request.recipients[0]?.roleCode).toBe("initial_brand_admin");
  });
  it("binds the complete request, independently of the claimed whole-plan digest", () => {
    const raw = input(),
      original = hashBrandInitialPolicyRequest(raw);
    for (const changed of [
      { ...raw, operationReference: f.uuid("60") },
      { ...raw, approvalEvidenceReference: f.uuid("60") },
      { ...raw, occurredAt: f.LATER },
      { ...raw, recipients: [{ ...raw.recipients[0], effectiveUntil: f.LATER }] },
      { ...raw, recipients: [{ ...raw.recipients[0], roleCode: "another_role" }] },
    ])
      expect(hashBrandInitialPolicyRequest(changed)).not.toBe(original);
  });
  it("allows an explicit subset of only the six administrative actions", () => {
    const raw = input();
    required(raw.recipients[0]).grants = brandAdministrationPermissionActions.map((action, i) => ({
      action,
      grantReference: f.uuid(String(100 + i)),
      permissionReference: f.uuid(String(200 + i)),
    }));
    expect(parseBrandInitialPolicyRequest(raw).recipients[0]?.grants).toHaveLength(6);
    for (const action of ["catalog.manage", "identity.role.change", "publishing.*", "brand.create"])
      expect(() =>
        parseBrandInitialPolicyRequest({
          ...input(),
          recipients: [
            {
              ...input().recipients[0],
              grants: [{ ...required(input().recipients[0]).grants[0], action }],
            },
          ],
        }),
      ).toThrow();
    expect(() =>
      parseBrandInitialPolicyRequest({
        ...input(),
        recipients: [
          {
            ...input().recipients[0],
            grants: [
              { ...required(input().recipients[0]).grants[0], action: "publishing.review.submit" },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it.each([
    "selfApproval",
    "duplicateActor",
    "duplicateMember",
    "duplicateRole",
    "duplicateGrant",
    "empty",
    "tooMany",
    "period",
    "scope",
    "extra",
  ])("rejects %s without inventing a replacement", (mode) => {
    const raw = input();
    if (mode === "selfApproval") raw.approvedByReference = raw.operatorReference;
    if (mode.startsWith("duplicate")) {
      const first = required(raw.recipients[0]);
      const second = {
        ...first,
        actorReference: f.uuid("70"),
        membershipReference: f.uuid("71"),
        roleReference: f.uuid("72"),
        roleCode: "second_admin",
        assignmentReference: f.uuid("73"),
        grants: [{ ...required(first.grants[0]), grantReference: f.uuid("74") }],
      };
      if (mode === "duplicateActor") second.actorReference = first.actorReference;
      if (mode === "duplicateMember") second.membershipReference = first.membershipReference;
      if (mode === "duplicateRole") second.roleReference = first.roleReference;
      if (mode === "duplicateGrant") second.grants = first.grants;
      raw.recipients.push(second);
    }
    if (mode === "empty") raw.recipients = [];
    if (mode === "tooMany")
      raw.recipients = Array.from({ length: 21 }, () => required(raw.recipients[0]));
    if (mode === "period") required(raw.recipients[0]).effectiveUntil = f.FROM;
    const candidate =
      mode === "scope"
        ? { ...raw, storeReference: f.STORE }
        : mode === "extra"
          ? { ...raw, defaultGrant: true }
          : raw;
    expect(() => parseBrandInitialPolicyRequest(candidate)).toThrow();
  });
  it("refuses getters, sparse arrays and nested extra authority without invoking accessors", () => {
    let invoked = false;
    const raw = input();
    Object.defineProperty(raw, "planDigest", {
      enumerable: true,
      get() {
        invoked = true;
        return `sha256:${"1".repeat(64)}`;
      },
    });
    expect(() => parseBrandInitialPolicyRequest(raw)).toThrow();
    expect(invoked).toBe(false);
    const sparse = input();
    sparse.recipients.length = 2;
    expect(() => parseBrandInitialPolicyRequest(sparse)).toThrow();
    const accessor = input();
    Object.defineProperty(accessor.recipients, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return input().recipients[0];
      },
    });
    expect(() => parseBrandInitialPolicyRequest(accessor)).toThrow();
    expect(invoked).toBe(false);
    expect(() =>
      parseBrandInitialPolicyRequest({
        ...input(),
        recipients: [{ ...input().recipients[0], storeReference: null }],
      }),
    ).toThrow();
  });
});
