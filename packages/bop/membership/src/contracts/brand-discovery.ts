import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import { parseBrandReference } from "@bop/tenant";
import { MembershipContractError, parseMembershipInstant } from "../domain/membership.js";

export const membershipBrandDiscoveryPurpose = "BRAND_DISCOVERY";
export function membershipBrandDiscoveryInvalid(): never {
  throw new MembershipContractError("MEMBERSHIP_INPUT_INVALID");
}
export function parseBrandDiscoveryInstant(value: unknown): string {
  const instant = String(parseMembershipInstant(value));
  if (instant.startsWith("0000-")) return membershipBrandDiscoveryInvalid();
  return instant;
}
export function parseMembershipBrandDiscoveryRequest(value: unknown) {
  try {
    const r = readClosedRecord(value, ["afterBrandReference", "limit"]);
    if (typeof r.limit !== "number" || !Number.isInteger(r.limit) || r.limit < 1 || r.limit > 20)
      return membershipBrandDiscoveryInvalid();
    return Object.freeze({
      afterBrandReference:
        r.afterBrandReference === null ? null : String(parseBrandReference(r.afterBrandReference)),
      limit: r.limit,
    });
  } catch {
    return membershipBrandDiscoveryInvalid();
  }
}
export type MembershipBrandDiscoveryRequest = ReturnType<
  typeof parseMembershipBrandDiscoveryRequest
>;
/** Candidate IDs only. This packet neither grants permission nor selects a Brand. */
export function parseMembershipBrandDiscoveryPage(value: unknown) {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "actorReference",
      "purposeCode",
      "afterBrandReference",
      "limit",
      "brandReferences",
      "hasMore",
      "nextAfterBrandReference",
      "observedAt",
      "validUntil",
    ]);
    const request = parseMembershipBrandDiscoveryRequest({
      afterBrandReference: r.afterBrandReference,
      limit: r.limit,
    });
    const observedAt = parseBrandDiscoveryInstant(r.observedAt),
      validUntil = parseBrandDiscoveryInstant(r.validUntil);
    if (
      r.profile !== "MembershipBrandDiscoveryPageV1" ||
      r.purposeCode !== membershipBrandDiscoveryPurpose ||
      typeof r.hasMore !== "boolean" ||
      !Array.isArray(r.brandReferences) ||
      Object.getPrototypeOf(r.brandReferences) !== Array.prototype ||
      r.brandReferences.length > request.limit ||
      Reflect.ownKeys(r.brandReferences).length !== r.brandReferences.length + 1 ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return membershipBrandDiscoveryInvalid();
    let previous = request.afterBrandReference;
    const brandReferences = Array.from({ length: r.brandReferences.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(r.brandReferences, String(i));
      if (!d?.enumerable || !("value" in d)) return membershipBrandDiscoveryInvalid();
      const ref = String(parseBrandReference(d.value));
      if (previous !== null && ref <= previous) return membershipBrandDiscoveryInvalid();
      previous = ref;
      return ref;
    });
    const nextAfterBrandReference =
      r.nextAfterBrandReference === null
        ? null
        : String(parseBrandReference(r.nextAfterBrandReference));
    if (
      r.hasMore
        ? brandReferences.length !== request.limit || nextAfterBrandReference !== previous
        : nextAfterBrandReference !== null
    )
      return membershipBrandDiscoveryInvalid();
    return Object.freeze({
      profile: "MembershipBrandDiscoveryPageV1" as const,
      actorReference: String(parseOpaqueUuidV7(r.actorReference, "ACTOR_REFERENCE_INVALID")),
      purposeCode: membershipBrandDiscoveryPurpose,
      ...request,
      brandReferences: Object.freeze(brandReferences),
      hasMore: r.hasMore,
      nextAfterBrandReference,
      observedAt,
      validUntil,
    });
  } catch {
    return membershipBrandDiscoveryInvalid();
  }
}
export type MembershipBrandDiscoveryPage = ReturnType<typeof parseMembershipBrandDiscoveryPage>;
