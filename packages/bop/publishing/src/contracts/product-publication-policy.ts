import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  PublishingContractError,
  parsePublishingReference,
  parsePublishingInstant,
  parsePublishingVersion,
} from "./publishing.js";
export const productPolicyConfigurationType = "PRODUCT_PUBLICATION_POLICY" as const;
export const productPolicyScopeLevels = Object.freeze([
  "Store",
  "StoreGroup",
  "Region",
  "Brand",
  "Channel",
  "OrderType",
] as const);
const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
function record(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const d = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((k) => !Object.hasOwn(d, k)) ||
    keys.some(
      (k) =>
        typeof k !== "string" || !fields.includes(k) || !d[k]?.enumerable || !("value" in d[k]),
    )
  )
    return fail();
  return Object.fromEntries(fields.map((k) => [k, d[k]?.value]));
}
function array(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return fail();
  const d = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((k) => typeof k !== "string" || (k !== "length" && !/^(0|[1-9][0-9]*)$/.test(k)))
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const v = d[String(i)];
    if (!v || !("value" in v) || !v.enumerable) return fail();
    return v.value;
  });
}
export function parsePublishingProductPublicationPolicy(value: unknown) {
  const r = record(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "familyReference",
    "policyReference",
    "policyVersion",
    "scopeOrder",
    "approvalPolicy",
    "warningOverrideAllowed",
    "requiredLocales",
    "mediaRequirement",
    "effectiveFrom",
    "effectiveUntil",
  ]);
  if (
    r.profile !== "PublishingProductPublicationPolicyV1" ||
    typeof r.approvalPolicy !== "string" ||
    !["Required", "NotRequired"].includes(r.approvalPolicy) ||
    typeof r.warningOverrideAllowed !== "boolean" ||
    typeof r.mediaRequirement !== "string" ||
    !["Optional", "Required"].includes(r.mediaRequirement)
  )
    return fail();
  const scopeOrder = array(r.scopeOrder, 6);
  if (
    scopeOrder.length !== 6 ||
    new Set(scopeOrder).size !== 6 ||
    productPolicyScopeLevels.some((l) => !scopeOrder.includes(l)) ||
    scopeOrder.indexOf("Store") >= scopeOrder.indexOf("Brand")
  )
    return fail();
  const requiredLocales = array(r.requiredLocales, 32)
    .map((v) => {
      if (
        typeof v !== "string" ||
        v.length > 35 ||
        !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/.test(v)
      )
        return fail();
      try {
        if (Intl.getCanonicalLocales(v)[0] !== v) return fail();
      } catch {
        return fail();
      }
      return v;
    })
    .sort();
  if (new Set(requiredLocales).size !== requiredLocales.length) return fail();
  const effectiveFrom = parsePublishingInstant(r.effectiveFrom),
    effectiveUntil = r.effectiveUntil === null ? null : parsePublishingInstant(r.effectiveUntil);
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) return fail();
  return Object.freeze({
    profile: "PublishingProductPublicationPolicyV1" as const,
    tenantReference: parsePublishingReference(r.tenantReference),
    brandReference: parsePublishingReference(r.brandReference),
    familyReference: parsePublishingReference(r.familyReference),
    policyReference: parsePublishingReference(r.policyReference),
    policyVersion: parsePublishingVersion(r.policyVersion),
    scopeOrder: Object.freeze(scopeOrder) as readonly (typeof productPolicyScopeLevels)[number][],
    approvalPolicy: r.approvalPolicy as "Required" | "NotRequired",
    warningOverrideAllowed: r.warningOverrideAllowed,
    requiredLocales: Object.freeze(requiredLocales),
    mediaRequirement: r.mediaRequirement as "Optional" | "Required",
    effectiveFrom,
    effectiveUntil,
  });
}
export type PublishingProductPublicationPolicy = ReturnType<
  typeof parsePublishingProductPublicationPolicy
>;
export const publishingProductPublicationPolicyDigest = (value: unknown) =>
  "sha256:" + sha256Hex(canonicalizeRfc8785(parsePublishingProductPublicationPolicy(value)));
