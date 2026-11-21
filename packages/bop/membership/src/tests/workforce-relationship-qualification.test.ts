import { describe, expect, it, vi } from "vitest";
import {
  parseWorkforceRelationshipQualification,
  parseWorkforceRelationshipQualificationExpected,
  parseWorkforceRelationshipQualificationTrust,
  workforceRelationshipQualificationSigningBytes,
} from "../contracts/workforce-relationship-qualification.js";

const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const expected = {
  environmentReference: id(1),
  actorReference: id(2),
  brandReference: id(3),
  workforceRelationshipReference: id(4),
  relationshipEvidenceReference: id(5),
};
const statement = () => ({
  profile: "WorkforceRelationshipQualificationV1",
  purposeCode: "WORKFORCE_RELATIONSHIP_QUALIFICATION",
  ...expected,
  issuerReference: id(6),
  keyReference: id(7),
  revision: 1,
  status: "Current",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveUntil: "2027-01-01T00:00:00.000Z",
  verifiedAt: "2026-10-06T11:00:00.000Z",
  validUntil: "2026-10-06T13:00:00.000Z",
  signature: "A".repeat(86),
});
const key = () => ({
  keyReference: id(7),
  issuerReference: id(6),
  environmentReference: id(1),
  purposeCode: "WORKFORCE_RELATIONSHIP_QUALIFICATION",
  brandReferences: [id(3)],
  notBefore: "2026-01-01T00:00:00.000Z",
  validUntil: "2027-01-01T00:00:00.000Z",
  publicKeySpki: "A".repeat(59),
});
const trust = () => ({
  profile: "WorkforceRelationshipQualificationTrustV1",
  keys: [key()],
  withdrawnEvidenceReferences: [],
});

describe("external Workforce relationship qualification contract", () => {
  it("preserves only closed scope, evidence and business facts with immutable output", () => {
    const parsed = parseWorkforceRelationshipQualification(statement());
    expect(parsed).toEqual(statement());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseWorkforceRelationshipQualificationExpected(expected)).toEqual(expected);
    expect(
      parseWorkforceRelationshipQualification({
        ...statement(),
        effectiveUntil: null,
        status: "Withdrawn",
      }).effectiveUntil,
    ).toBeNull();
    const parsedTrust = parseWorkforceRelationshipQualificationTrust(trust());
    expect(Object.isFrozen(parsedTrust.keys)).toBe(true);
    expect(Object.isFrozen(parsedTrust.keys[0]?.brandReferences)).toBe(true);
  });

  it("uses fixed parsed key order and a distinct signature domain regardless of input order", () => {
    const input = statement();
    const reverse = Object.fromEntries(Object.entries(input).reverse());
    const message = workforceRelationshipQualificationSigningBytes(input);
    expect(workforceRelationshipQualificationSigningBytes(reverse)).toBe(message);
    expect(message).toBe(
      "BOP-RMS:WorkforceRelationshipQualificationV1\n" +
        JSON.stringify({
          profile: "WorkforceRelationshipQualificationV1",
          purposeCode: "WORKFORCE_RELATIONSHIP_QUALIFICATION",
          ...expected,
          issuerReference: id(6),
          keyReference: id(7),
          revision: 1,
          status: "Current",
          effectiveFrom: input.effectiveFrom,
          effectiveUntil: input.effectiveUntil,
          verifiedAt: input.verifiedAt,
          validUntil: input.validUntil,
        }),
    );
    expect(message).not.toContain('"signature"');
    expect(
      workforceRelationshipQualificationSigningBytes({ ...input, brandReference: id(10) }),
    ).not.toBe(message);
  });

  it.each([
    { profile: "BrandInitialProvisioningApprovalV1" },
    { purposeCode: "BRAND_INITIAL_PROVISIONING" },
    { actorReference: null },
    { brandReference: "*" },
    { environmentReference: "production" },
    { workforceRelationshipReference: "unverified" },
    { relationshipEvidenceReference: null },
    { issuerReference: "email@example.invalid" },
    { keyReference: null },
    { revision: 0 },
    { revision: 1.5 },
    { revision: "1" },
    { status: "Approved" },
    { effectiveUntil: "2026-01-01T00:00:00.000Z" },
    { verifiedAt: "2026-10-06T13:00:00.000Z" },
    { effectiveFrom: "0000-01-01T00:00:00.000Z" },
    { verifiedAt: "2026-10-06T11:00:00Z" },
    { validUntil: "infinity" },
    { signature: "A".repeat(85) },
    { signature: "A".repeat(85) + "B" },
    { signature: "A".repeat(86) + "==" },
    { employeeType: "Employee" },
    { planDigest: "not-qualification" },
  ])("refuses malformed, permissive or unrelated statement fields: %j", (patch) => {
    expect(() => parseWorkforceRelationshipQualification({ ...statement(), ...patch })).toThrow();
  });

  it.each([
    { brandReferences: [] },
    { brandReferences: ["*"] },
    { brandReferences: [id(3), id(3)] },
    { brandReferences: Array.from({ length: 129 }, (_, n) => id(n + 100)) },
    { purposeCode: "BRAND_INITIAL_PROVISIONING" },
    { issuerReference: null },
    { validUntil: "2026-01-01T00:00:00.000Z" },
    { publicKeySpki: "A".repeat(58) + "B" },
    { approvedByReference: id(40) },
  ])("trust requires exact qualification scope and finite Brand lists: %j", (patch) => {
    expect(() =>
      parseWorkforceRelationshipQualificationTrust({ ...trust(), keys: [{ ...key(), ...patch }] }),
    ).toThrow();
  });

  it("refuses duplicate keys, unbounded withdrawals and sparse or accessor arrays", () => {
    const getter = vi.fn(() => key());
    const accessed = Object.defineProperty([], "0", { enumerable: true, get: getter });
    for (const keys of [
      [key(), key()],
      new Array(1),
      accessed,
      Array.from({ length: 33 }, (_, n) => ({ ...key(), keyReference: id(n + 100) })),
    ])
      expect(() => parseWorkforceRelationshipQualificationTrust({ ...trust(), keys })).toThrow();
    for (const refs of [[id(5), id(5)], Array.from({ length: 257 }, (_, n) => id(n + 100))])
      expect(() =>
        parseWorkforceRelationshipQualificationTrust({
          ...trust(),
          withdrawnEvidenceReferences: refs,
        }),
      ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not evaluate statement or expected-scope accessors", () => {
    const getter = vi.fn(() => id(2));
    expect(() =>
      parseWorkforceRelationshipQualification(
        Object.defineProperty(statement(), "actorReference", { enumerable: true, get: getter }),
      ),
    ).toThrow();
    expect(() =>
      parseWorkforceRelationshipQualificationExpected(
        Object.defineProperty({ ...expected }, "actorReference", { enumerable: true, get: getter }),
      ),
    ).toThrow();
    expect(() =>
      parseWorkforceRelationshipQualificationExpected({ ...expected, operationReference: id(9) }),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
