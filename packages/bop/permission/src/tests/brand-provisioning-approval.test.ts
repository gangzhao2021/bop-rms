import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import {
  BrandProvisioningApprovalError,
  brandProvisioningApprovalSigningBytes,
  brandProvisioningApprovalSignatureDomain,
  parseBrandProvisioningApproval,
  parseBrandProvisioningApprovalExpected,
  parseBrandProvisioningApprovalTrust,
} from "../contracts/brand-provisioning-approval.js";

const id = (n: number) => `01902421-0001-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T13:00:00.000Z";
function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const raw = {
    profile: "BrandInitialProvisioningApprovalV1",
    purposeCode: "BRAND_INITIAL_PROVISIONING",
    environmentReference: id(1),
    operationReference: id(2),
    brandReference: id(3),
    planDigest: "sha256:" + "a".repeat(64),
    operatorReference: id(4),
    approvedByReference: id(5),
    approvalEvidenceReference: id(6),
    notBefore: at,
    validUntil: until,
    keyReference: id(7),
    signature: Buffer.alloc(64).toString("base64url"),
  };
  const approval = parseBrandProvisioningApproval({
    ...raw,
    signature: sign(
      null,
      Buffer.from(brandProvisioningApprovalSigningBytes(raw)),
      keys.privateKey,
    ).toString("base64url"),
  });
  const trust = parseBrandProvisioningApprovalTrust({
    profile: "BrandInitialProvisioningTrustV1",
    keys: [
      {
        keyReference: id(7),
        approvedByReference: id(5),
        environmentReference: id(1),
        purposeCode: "BRAND_INITIAL_PROVISIONING",
        notBefore: at,
        validUntil: until,
        publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      },
    ],
    revokedApprovalEvidenceReferences: [],
  });
  return { approval, trust };
}
it("captures a closed independent approval and configured trust without supplying facts or a default key", () => {
  const { approval, trust } = fixture();
  expect(Object.isFrozen(approval)).toBe(true);
  expect(Object.isFrozen(trust.keys[0])).toBe(true);
  expect(parseBrandProvisioningApproval(approval)).toEqual(approval);
  expect(brandProvisioningApprovalSigningBytes(approval)).toContain(
    brandProvisioningApprovalSignatureDomain,
  );
  expect(brandProvisioningApprovalSigningBytes(approval)).not.toContain('"signature"');
  expect(
    parseBrandProvisioningApprovalTrust({
      profile: "BrandInitialProvisioningTrustV1",
      keys: [],
      revokedApprovalEvidenceReferences: [],
    }).keys,
  ).toEqual([]);
});
it.each([
  { profile: "Other" },
  { purposeCode: "PLATFORM_BRAND_TEMPLATE" },
  { environmentReference: "01902421-0001-7000-8000-00000000000A" },
  { planDigest: "sha256:" + "A".repeat(64) },
  { approvedByReference: id(4) },
  { notBefore: until },
  { validUntil: "infinity" },
  { notBefore: "0000-01-01T00:00:00.000Z" },
  { notBefore: "2026-10-06T12:00:00Z" },
  { validUntil: "2026-10-06T24:00:00.000Z" },
  { signature: "A" },
  { signature: Buffer.alloc(64).toString("base64") },
  { allow: true },
])("rejects invalid or expanded approval %j", (change) => {
  expect(() => parseBrandProvisioningApproval({ ...fixture().approval, ...change })).toThrow(
    BrandProvisioningApprovalError,
  );
});
it("rejects noncanonical base64url trailing bits and a changed expected binding grammar", () => {
  const { approval } = fixture();
  const signature = Buffer.alloc(64).toString("base64url");
  expect(() =>
    parseBrandProvisioningApproval({ ...approval, signature: signature.slice(0, -1) + "B" }),
  ).toThrow();
  const expected = {
    environmentReference: id(1),
    operationReference: id(2),
    brandReference: id(3),
    planDigest: approval.planDigest,
    operatorReference: id(4),
  };
  expect(parseBrandProvisioningApprovalExpected(expected)).toEqual(expected);
  expect(() => parseBrandProvisioningApprovalExpected({ ...expected, approved: true })).toThrow();
  expect(() =>
    parseBrandProvisioningApprovalExpected({ ...expected, operationReference: "unknown" }),
  ).toThrow();
});
it("rejects duplicate trust identities, malformed keys, revocation references and unbounded arrays", () => {
  const { trust } = fixture(),
    key = trust.keys[0];
  if (!key) throw new Error("fixture key missing");
  for (const change of [
    { keys: [key, key] },
    { keys: Array.from({ length: 33 }, (_, i) => ({ ...key, keyReference: id(i + 100) })) },
    { keys: [{ ...key, publicKeySpki: "private material" }] },
    { keys: [{ ...key, purposeCode: "BRAND_ADMINISTRATION" }] },
    { keys: [{ ...key, validUntil: at }] },
    { revokedApprovalEvidenceReferences: [id(6), id(6)] },
    { revokedApprovalEvidenceReferences: Array.from({ length: 257 }, (_, i) => id(i + 100)) },
    { revokedApprovalEvidenceReferences: [null] },
    { defaultAllow: true },
  ])
    expect(() => parseBrandProvisioningApprovalTrust({ ...trust, ...change })).toThrow(
      BrandProvisioningApprovalError,
    );
});
it("never invokes approval or array accessors and rejects sparse or decorated arrays", () => {
  const { approval, trust } = fixture();
  let touched = false;
  const accessor = { ...approval };
  Object.defineProperty(accessor, "signature", {
    enumerable: true,
    get() {
      touched = true;
      return approval.signature;
    },
  });
  expect(() => parseBrandProvisioningApproval(accessor)).toThrow();
  const keys = [...trust.keys];
  Object.defineProperty(keys, "0", {
    enumerable: true,
    get() {
      touched = true;
      return trust.keys[0];
    },
  });
  expect(() => parseBrandProvisioningApprovalTrust({ ...trust, keys })).toThrow();
  expect(touched).toBe(false);
  expect(() => parseBrandProvisioningApprovalTrust({ ...trust, keys: new Array(1) })).toThrow();
  expect(() =>
    parseBrandProvisioningApprovalTrust({
      ...trust,
      keys: Object.assign([...trust.keys], { extra: true }),
    }),
  ).toThrow();
});
