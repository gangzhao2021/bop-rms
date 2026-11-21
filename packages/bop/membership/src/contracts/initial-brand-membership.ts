import {
  createIdentityActor,
  parseCurrentWorkforceAccount,
  type CurrentWorkforceAccount,
  parseOpaqueUuidV7,
  readClosedRecord,
  type IdentityActor,
} from "@bop/identity";
import { createBrand, parseBrandReference, type Brand } from "@bop/tenant";
import {
  MembershipContractError,
  parseMembershipReference,
  parseMembershipInstant,
  parseWorkforceRelationshipReference,
} from "../domain/membership.js";

export const initialBrandMembershipPurpose = "BRAND_INITIAL_PROVISIONING";
export function initialMembershipInvalid(): never {
  throw new MembershipContractError("MEMBERSHIP_INPUT_INVALID");
}
const reference = (value: unknown) => parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID");
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    return initialMembershipInvalid();
  return value;
};
export function initialMembershipList(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 20 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return initialMembershipInvalid();
  return Object.freeze(
    Array.from({ length: value.length }, (_, index) => {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry?.enumerable || !("value" in entry)) return initialMembershipInvalid();
      return entry.value;
    }),
  );
}
export function parseInitialBrandMembershipRequest(value: unknown) {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "operationReference",
      "brandReference",
      "planDigest",
      "approvalEvidenceReference",
      "operatorReference",
      "approvedByReference",
      "members",
    ]);
    if (r.profile !== "InitialBrandMembershipRequestV1") return initialMembershipInvalid();
    const members = initialMembershipList(r.members).map((value) => {
      const m = readClosedRecord(value, [
        "membershipReference",
        "actorReference",
        "workforceRelationshipReference",
        "effectiveUntil",
      ]);
      return Object.freeze({
        membershipReference: parseMembershipReference(m.membershipReference),
        actorReference: reference(m.actorReference),
        workforceRelationshipReference: parseWorkforceRelationshipReference(
          m.workforceRelationshipReference,
        ),
        effectiveUntil: parseMembershipInstant(m.effectiveUntil),
      });
    });
    if (
      new Set(members.map((m) => m.membershipReference)).size !== members.length ||
      new Set(members.map((m) => m.actorReference)).size !== members.length
    )
      return initialMembershipInvalid();
    const operatorReference = reference(r.operatorReference),
      approvedByReference = reference(r.approvedByReference);
    if (operatorReference === approvedByReference) return initialMembershipInvalid();
    return Object.freeze({
      profile: "InitialBrandMembershipRequestV1" as const,
      operationReference: reference(r.operationReference),
      brandReference: parseBrandReference(r.brandReference),
      planDigest: digest(r.planDigest),
      approvalEvidenceReference: reference(r.approvalEvidenceReference),
      operatorReference,
      approvedByReference,
      members: Object.freeze(members),
    });
  } catch {
    return initialMembershipInvalid();
  }
}
export type InitialBrandMembershipRequest = ReturnType<typeof parseInitialBrandMembershipRequest>;

export interface InitialBrandMembershipQualifiedMember {
  readonly membershipReference: string;
  readonly account: CurrentWorkforceAccount;
  readonly workforceRelationshipReference: string;
  readonly relationshipEvidenceReference: string;
  readonly invitationEvidenceReference: string;
  readonly invitationQualified: true;
  readonly relationshipEffectiveFrom: string;
  readonly relationshipEffectiveUntil: string | null;
}
export interface InitialBrandMembershipAuthority {
  readonly brand: Brand;
  readonly operator: IdentityActor;
  readonly operationReference: string;
  readonly brandReference: string;
  readonly planDigest: string;
  readonly requestDigest: string;
  readonly approvalEvidenceReference: string;
  readonly approvedByReference: string;
  readonly members: readonly InitialBrandMembershipQualifiedMember[];
  readonly observedAt: string;
  readonly validUntil: string;
}

/** Validates the owning holder's binding, not employment/legal truth. Only a
 * required actual source can supply these relationship and invitation facts. */
export function parseInitialBrandMembershipAuthority(
  value: unknown,
  request: InitialBrandMembershipRequest,
  originalObservedAt: string,
  now: string,
  expectedRequestDigest: string,
) {
  try {
    const r = readClosedRecord(value, [
        "brand",
        "operator",
        "operationReference",
        "brandReference",
        "planDigest",
        "requestDigest",
        "approvalEvidenceReference",
        "approvedByReference",
        "members",
        "observedAt",
        "validUntil",
      ]),
      brand = createBrand(r.brand),
      operator = createIdentityActor(r.operator),
      observedAt = parseMembershipInstant(r.observedAt),
      validUntil = parseMembershipInstant(r.validUntil);
    let deadline = String(validUntil);
    if (
      brand.brandReference !== request.brandReference ||
      brand.lifecycle !== "Draft" ||
      brand.version !== 1 ||
      brand.createdAt !== originalObservedAt ||
      brand.updatedAt !== originalObservedAt ||
      operator.actorReference !== request.operatorReference ||
      operator.actorType !== "User" ||
      operator.status !== "Active" ||
      operator.authenticatedAt === null ||
      (operator.accountKind !== "Workforce" && operator.accountKind !== "Platform") ||
      operator.authenticationMethod !== "Oidc" ||
      String(operator.authenticatedAt) > observedAt ||
      (operator.recentMfaAt !== null && String(operator.recentMfaAt) > observedAt) ||
      r.operationReference !== request.operationReference ||
      r.brandReference !== request.brandReference ||
      r.planDigest !== request.planDigest ||
      digest(r.requestDigest) !== digest(expectedRequestDigest) ||
      r.approvalEvidenceReference !== request.approvalEvidenceReference ||
      r.approvedByReference !== request.approvedByReference ||
      observedAt < originalObservedAt ||
      observedAt > now ||
      now >= validUntil ||
      Date.parse(validUntil) > Date.parse(observedAt) + 5000
    )
      return initialMembershipInvalid();
    const members = initialMembershipList(r.members).map((value, index) => {
      const m = readClosedRecord(value, [
          "membershipReference",
          "account",
          "workforceRelationshipReference",
          "relationshipEvidenceReference",
          "invitationEvidenceReference",
          "invitationQualified",
          "relationshipEffectiveFrom",
          "relationshipEffectiveUntil",
        ]),
        account = parseCurrentWorkforceAccount(m.account),
        wanted = request.members[index],
        effectiveFrom = parseMembershipInstant(m.relationshipEffectiveFrom),
        effectiveUntil =
          m.relationshipEffectiveUntil === null
            ? null
            : parseMembershipInstant(m.relationshipEffectiveUntil);
      if (
        !wanted ||
        m.membershipReference !== wanted.membershipReference ||
        account.actorReference !== wanted.actorReference ||
        String(account.observedAt) < originalObservedAt ||
        String(account.observedAt) > now ||
        String(account.validUntil) <= now ||
        m.workforceRelationshipReference !== wanted.workforceRelationshipReference ||
        m.invitationQualified !== true ||
        wanted.effectiveUntil <= originalObservedAt ||
        effectiveFrom > originalObservedAt ||
        (effectiveUntil !== null &&
          (effectiveUntil <= effectiveFrom || effectiveUntil < wanted.effectiveUntil))
      )
        return initialMembershipInvalid();
      if (String(account.validUntil) < deadline) deadline = String(account.validUntil);
      return Object.freeze({
        membershipReference: wanted.membershipReference,
        account,
        workforceRelationshipReference: wanted.workforceRelationshipReference,
        relationshipEvidenceReference: reference(m.relationshipEvidenceReference),
        invitationEvidenceReference: reference(m.invitationEvidenceReference),
        invitationQualified: true as const,
        relationshipEffectiveFrom: effectiveFrom,
        relationshipEffectiveUntil: effectiveUntil,
      });
    });
    if (members.length !== request.members.length) return initialMembershipInvalid();
    return Object.freeze({
      brand,
      operator,
      operationReference: request.operationReference,
      brandReference: request.brandReference,
      planDigest: request.planDigest,
      requestDigest: expectedRequestDigest,
      approvalEvidenceReference: request.approvalEvidenceReference,
      approvedByReference: request.approvedByReference,
      members: Object.freeze(members),
      observedAt,
      validUntil: deadline,
    });
  } catch {
    return initialMembershipInvalid();
  }
}
