import { readClosedRecord } from "@bop/identity";
import {
  parseMembershipInstant,
  parseMembershipReference,
  parseWorkforceRelationshipReference,
} from "../domain/membership.js";

export const workforceRelationshipQualificationPurpose = "WORKFORCE_RELATIONSHIP_QUALIFICATION";
export interface WorkforceRelationshipQualificationExpected {
  readonly environmentReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly workforceRelationshipReference: string;
  readonly relationshipEvidenceReference: string;
}
export interface WorkforceRelationshipQualification extends WorkforceRelationshipQualificationExpected {
  readonly profile: "WorkforceRelationshipQualificationV1";
  readonly purposeCode: typeof workforceRelationshipQualificationPurpose;
  readonly issuerReference: string;
  readonly keyReference: string;
  readonly revision: number;
  readonly status: "Current" | "Withdrawn";
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly verifiedAt: string;
  readonly validUntil: string;
  readonly signature: string;
}
export interface WorkforceRelationshipQualificationTrustKey {
  readonly keyReference: string;
  readonly issuerReference: string;
  readonly environmentReference: string;
  readonly purposeCode: typeof workforceRelationshipQualificationPurpose;
  readonly brandReferences: readonly string[];
  readonly notBefore: string;
  readonly validUntil: string;
  readonly publicKeySpki: string;
}
export interface WorkforceRelationshipQualificationTrust {
  readonly profile: "WorkforceRelationshipQualificationTrustV1";
  readonly keys: readonly WorkforceRelationshipQualificationTrustKey[];
  readonly withdrawnEvidenceReferences: readonly string[];
}
export class WorkforceRelationshipQualificationError extends Error {
  readonly code = "WORKFORCE_RELATIONSHIP_QUALIFICATION_UNAVAILABLE";
  constructor() {
    super("Workforce relationship qualification is unavailable");
    this.name = "WorkforceRelationshipQualificationError";
  }
}
const fail = (): never => {
  throw new WorkforceRelationshipQualificationError();
};
export function parseWorkforceRelationshipQualificationInstant(value: unknown): string {
  try {
    const instant = parseMembershipInstant(value);
    if (instant.startsWith("0000-")) return fail();
    return instant;
  } catch {
    return fail();
  }
}
function base64url(value: unknown, bytes: number): string {
  if (
    typeof value !== "string" ||
    value.length !== Math.ceil((bytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return fail();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const trailingBits = (6 - ((bytes * 8) % 6)) % 6;
  if ((alphabet.indexOf(value.charAt(value.length - 1)) & ((1 << trailingBits) - 1)) !== 0)
    return fail();
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
const expectedKeys = [
  "environmentReference",
  "actorReference",
  "brandReference",
  "workforceRelationshipReference",
  "relationshipEvidenceReference",
];
function expected(
  r: Readonly<Record<string, unknown>>,
): WorkforceRelationshipQualificationExpected {
  return Object.freeze({
    environmentReference: parseMembershipReference(r.environmentReference),
    actorReference: parseMembershipReference(r.actorReference),
    brandReference: parseMembershipReference(r.brandReference),
    workforceRelationshipReference: parseWorkforceRelationshipReference(
      r.workforceRelationshipReference,
    ),
    relationshipEvidenceReference: parseMembershipReference(r.relationshipEvidenceReference),
  });
}
export function parseWorkforceRelationshipQualificationExpected(
  value: unknown,
): WorkforceRelationshipQualificationExpected {
  try {
    return expected(readClosedRecord(value, expectedKeys));
  } catch {
    return fail();
  }
}
export function parseWorkforceRelationshipQualification(
  value: unknown,
): WorkforceRelationshipQualification {
  try {
    const r = readClosedRecord(value, [
      ...expectedKeys,
      "profile",
      "purposeCode",
      "issuerReference",
      "keyReference",
      "revision",
      "status",
      "effectiveFrom",
      "effectiveUntil",
      "verifiedAt",
      "validUntil",
      "signature",
    ]);
    const effectiveFrom = parseWorkforceRelationshipQualificationInstant(r.effectiveFrom),
      effectiveUntil =
        r.effectiveUntil === null
          ? null
          : parseWorkforceRelationshipQualificationInstant(r.effectiveUntil),
      verifiedAt = parseWorkforceRelationshipQualificationInstant(r.verifiedAt),
      validUntil = parseWorkforceRelationshipQualificationInstant(r.validUntil);
    if (
      r.profile !== "WorkforceRelationshipQualificationV1" ||
      r.purposeCode !== workforceRelationshipQualificationPurpose ||
      (r.status !== "Current" && r.status !== "Withdrawn") ||
      typeof r.revision !== "number" ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 1 ||
      (effectiveUntil !== null && effectiveUntil <= effectiveFrom) ||
      validUntil <= verifiedAt
    )
      return fail();
    // This exact property order is part of the versioned signing protocol.
    return Object.freeze({
      profile: "WorkforceRelationshipQualificationV1",
      purposeCode: workforceRelationshipQualificationPurpose,
      ...expected(r),
      issuerReference: parseMembershipReference(r.issuerReference),
      keyReference: parseMembershipReference(r.keyReference),
      revision: r.revision,
      status: r.status,
      effectiveFrom,
      effectiveUntil,
      verifiedAt,
      validUntil,
      signature: base64url(r.signature, 64),
    });
  } catch {
    return fail();
  }
}
export function parseWorkforceRelationshipQualificationTrust(
  value: unknown,
): WorkforceRelationshipQualificationTrust {
  try {
    const r = readClosedRecord(value, ["profile", "keys", "withdrawnEvidenceReferences"]);
    if (r.profile !== "WorkforceRelationshipQualificationTrustV1") return fail();
    const keys = array(r.keys, 32).map((value): WorkforceRelationshipQualificationTrustKey => {
        const key = readClosedRecord(value, [
            "keyReference",
            "issuerReference",
            "environmentReference",
            "purposeCode",
            "brandReferences",
            "notBefore",
            "validUntil",
            "publicKeySpki",
          ]),
          brandReferences = array(key.brandReferences, 128).map(parseMembershipReference),
          notBefore = parseWorkforceRelationshipQualificationInstant(key.notBefore),
          validUntil = parseWorkforceRelationshipQualificationInstant(key.validUntil);
        if (
          key.purposeCode !== workforceRelationshipQualificationPurpose ||
          brandReferences.length < 1 ||
          new Set(brandReferences).size !== brandReferences.length ||
          validUntil <= notBefore
        )
          return fail();
        return Object.freeze({
          keyReference: parseMembershipReference(key.keyReference),
          issuerReference: parseMembershipReference(key.issuerReference),
          environmentReference: parseMembershipReference(key.environmentReference),
          purposeCode: workforceRelationshipQualificationPurpose,
          brandReferences: Object.freeze(brandReferences),
          notBefore,
          validUntil,
          publicKeySpki: base64url(key.publicKeySpki, 44),
        });
      }),
      withdrawnEvidenceReferences = array(r.withdrawnEvidenceReferences, 256).map(
        parseMembershipReference,
      );
    if (
      new Set(keys.map((key) => key.keyReference)).size !== keys.length ||
      new Set(withdrawnEvidenceReferences).size !== withdrawnEvidenceReferences.length
    )
      return fail();
    return Object.freeze({
      profile: "WorkforceRelationshipQualificationTrustV1",
      keys: Object.freeze(keys),
      withdrawnEvidenceReferences: Object.freeze(withdrawnEvidenceReferences),
    });
  } catch {
    return fail();
  }
}
/** UTF-8 signature message, independent of the initialization-plan signature.
 * The complete parsed statement may carry a canonical 64-byte zero placeholder
 * signature while its real signature is being produced outside this reader. */
export function workforceRelationshipQualificationSigningBytes(value: unknown): string {
  const { signature, ...payload } = parseWorkforceRelationshipQualification(value);
  void signature;
  return "BOP-RMS:WorkforceRelationshipQualificationV1\n" + JSON.stringify(payload);
}
