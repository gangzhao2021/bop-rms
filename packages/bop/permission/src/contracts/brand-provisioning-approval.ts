import { Buffer } from "node:buffer";
import { canonicalizeRfc8785 } from "@bop/audit";

export const brandProvisioningApprovalPurpose = "BRAND_INITIAL_PROVISIONING" as const;
export const brandProvisioningApprovalSignatureDomain =
  "BOP-RMS:BrandInitialProvisioningApprovalV1\n";
export interface BrandProvisioningApprovalExpected {
  readonly environmentReference: string;
  readonly operationReference: string;
  readonly brandReference: string;
  readonly planDigest: string;
  readonly operatorReference: string;
}
export interface BrandProvisioningApproval extends BrandProvisioningApprovalExpected {
  readonly profile: "BrandInitialProvisioningApprovalV1";
  readonly purposeCode: typeof brandProvisioningApprovalPurpose;
  readonly approvedByReference: string;
  readonly approvalEvidenceReference: string;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly keyReference: string;
  readonly signature: string;
}
export interface BrandProvisioningApprovalTrustKey {
  readonly keyReference: string;
  readonly approvedByReference: string;
  readonly environmentReference: string;
  readonly purposeCode: typeof brandProvisioningApprovalPurpose;
  readonly notBefore: string;
  readonly validUntil: string;
  readonly publicKeySpki: string;
}
export interface BrandProvisioningApprovalTrust {
  readonly profile: "BrandInitialProvisioningTrustV1";
  readonly keys: readonly BrandProvisioningApprovalTrustKey[];
  readonly revokedApprovalEvidenceReferences: readonly string[];
}
export class BrandProvisioningApprovalError extends Error {
  readonly code = "BRAND_PROVISIONING_APPROVAL_UNAVAILABLE";
  constructor() {
    super("Brand initialization approval is unavailable");
    this.name = "BrandProvisioningApprovalError";
  }
}
const fail = (): never => {
  throw new BrandProvisioningApprovalError();
};
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
const reference = (value: unknown): string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? value
    : fail();
export function parseBrandProvisioningApprovalInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    value.startsWith("0000-") ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
function base64url(value: unknown, bytes: number): string {
  if (
    typeof value !== "string" ||
    value.length !== Math.ceil((bytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return fail();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) return fail();
  return value;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result.push(descriptor.value);
  }
  return result;
}
const expectedFields = [
  "environmentReference",
  "operationReference",
  "brandReference",
  "planDigest",
  "operatorReference",
];
function expected(row: Record<string, unknown>): BrandProvisioningApprovalExpected {
  if (typeof row.planDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(row.planDigest))
    return fail();
  return Object.freeze({
    environmentReference: reference(row.environmentReference),
    operationReference: reference(row.operationReference),
    brandReference: reference(row.brandReference),
    planDigest: row.planDigest,
    operatorReference: reference(row.operatorReference),
  });
}
export function parseBrandProvisioningApprovalExpected(
  value: unknown,
): BrandProvisioningApprovalExpected {
  return expected(record(value, expectedFields));
}
export function parseBrandProvisioningApproval(value: unknown): BrandProvisioningApproval {
  const row = record(value, [
    ...expectedFields,
    "profile",
    "purposeCode",
    "approvedByReference",
    "approvalEvidenceReference",
    "notBefore",
    "validUntil",
    "keyReference",
    "signature",
  ]);
  const binding = expected(row),
    approvedByReference = reference(row.approvedByReference),
    notBefore = parseBrandProvisioningApprovalInstant(row.notBefore),
    validUntil = parseBrandProvisioningApprovalInstant(row.validUntil);
  if (
    row.profile !== "BrandInitialProvisioningApprovalV1" ||
    row.purposeCode !== brandProvisioningApprovalPurpose ||
    binding.operatorReference === approvedByReference ||
    validUntil <= notBefore
  )
    return fail();
  return Object.freeze({
    ...binding,
    profile: "BrandInitialProvisioningApprovalV1",
    purposeCode: brandProvisioningApprovalPurpose,
    approvedByReference,
    approvalEvidenceReference: reference(row.approvalEvidenceReference),
    notBefore,
    validUntil,
    keyReference: reference(row.keyReference),
    signature: base64url(row.signature, 64),
  });
}
export function parseBrandProvisioningApprovalTrustKey(
  value: unknown,
): BrandProvisioningApprovalTrustKey {
  const row = record(value, [
      "keyReference",
      "approvedByReference",
      "environmentReference",
      "purposeCode",
      "notBefore",
      "validUntil",
      "publicKeySpki",
    ]),
    notBefore = parseBrandProvisioningApprovalInstant(row.notBefore),
    validUntil = parseBrandProvisioningApprovalInstant(row.validUntil);
  if (row.purposeCode !== brandProvisioningApprovalPurpose || validUntil <= notBefore)
    return fail();
  return Object.freeze({
    keyReference: reference(row.keyReference),
    approvedByReference: reference(row.approvedByReference),
    environmentReference: reference(row.environmentReference),
    purposeCode: brandProvisioningApprovalPurpose,
    notBefore,
    validUntil,
    publicKeySpki: base64url(row.publicKeySpki, 44),
  });
}
export function parseBrandProvisioningApprovalTrust(
  value: unknown,
): BrandProvisioningApprovalTrust {
  const row = record(value, ["profile", "keys", "revokedApprovalEvidenceReferences"]);
  if (row.profile !== "BrandInitialProvisioningTrustV1") return fail();
  const keys = array(row.keys, 32).map(parseBrandProvisioningApprovalTrustKey),
    revokedApprovalEvidenceReferences = array(row.revokedApprovalEvidenceReferences, 256).map(
      reference,
    );
  if (
    new Set(keys.map((key) => key.keyReference)).size !== keys.length ||
    new Set(revokedApprovalEvidenceReferences).size !== revokedApprovalEvidenceReferences.length
  )
    return fail();
  return Object.freeze({
    profile: "BrandInitialProvisioningTrustV1",
    keys: Object.freeze(keys),
    revokedApprovalEvidenceReferences: Object.freeze(revokedApprovalEvidenceReferences),
  });
}
/** Exact signature input. Approval validity does not establish legal, relationship
 * or executing-identity facts, which remain independently owned. */
export function brandProvisioningApprovalSigningBytes(value: unknown): string {
  const approval = parseBrandProvisioningApproval(value);
  const { signature, ...payload } = approval;
  void signature;
  return brandProvisioningApprovalSignatureDomain + canonicalizeRfc8785(payload);
}
