import { readClosedRecord } from "@bop/identity";
import {
  BrandConfigurationOperationError,
  parseCanonicalInstant,
  parseOrganizationVersion,
  parsePlatformBrandTemplateContent,
  platformBrandTemplateContentFields,
  type BrandConfigurationActorScope,
} from "@bop/tenant";
import {
  parsePublishingDigest,
  parsePublishingReference,
  type PlatformTemplateBrandReferenceList,
} from "@bop/publishing";

const unavailable = (): never => {
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
};
const reference = (value: unknown) => String(parsePublishingReference(value));
const pageReference = (value: unknown) => (value === null ? null : reference(value));
const scopeFields = ["tenantReference", "brandReference", "actorReference"] as const;
const itemFields = [
  "templateReference",
  "templateVersionReference",
  "revision",
  "contentDigest",
  ...platformBrandTemplateContentFields,
] as const;

/** Transport projection only. Publishing's held source owns current eligibility;
 * this packet never authorizes a command or replaces fresh reference acquisition. */
export function parseMerchantBrandTemplateCandidates(
  value: unknown,
  expected: BrandConfigurationActorScope,
  now: string,
  requestedAfter: string | null,
) {
  try {
    const r = readClosedRecord(value, [
      "profile",
      ...scopeFields,
      "afterTemplateReference",
      "items",
      "hasMore",
      "nextAfterTemplateReference",
      "observedAt",
      "validUntil",
    ]);
    readClosedRecord(expected, scopeFields);
    const scope = {
      tenantReference: reference(r.tenantReference),
      brandReference: reference(r.brandReference),
      actorReference: reference(r.actorReference),
    };
    const afterTemplateReference = pageReference(r.afterTemplateReference),
      nextAfterTemplateReference = pageReference(r.nextAfterTemplateReference),
      observedAt = String(parseCanonicalInstant(r.observedAt)),
      validUntil = String(parseCanonicalInstant(r.validUntil)),
      at = String(parseCanonicalInstant(now));
    if (
      r.profile !== "MerchantBrandTemplateCandidatesV1" ||
      scope.tenantReference !== scope.brandReference ||
      scopeFields.some((key) => scope[key] !== reference(expected[key])) ||
      afterTemplateReference !== pageReference(requestedAfter) ||
      observedAt > at ||
      validUntil <= at ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      typeof r.hasMore !== "boolean" ||
      r.hasMore !== (nextAfterTemplateReference !== null) ||
      (nextAfterTemplateReference !== null &&
        afterTemplateReference !== null &&
        nextAfterTemplateReference <= afterTemplateReference) ||
      !Array.isArray(r.items) ||
      r.items.length > 20 ||
      Object.getPrototypeOf(r.items) !== Array.prototype ||
      Reflect.ownKeys(r.items).length !== r.items.length + 1
    )
      return unavailable();
    let previous = afterTemplateReference;
    const versions = new Set<string>();
    const items = Array.from({ length: r.items.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(r.items, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
      const item = readClosedRecord(descriptor.value, itemFields),
        templateReference = reference(item.templateReference),
        templateVersionReference = reference(item.templateVersionReference),
        content = parsePlatformBrandTemplateContent(
          Object.fromEntries(platformBrandTemplateContentFields.map((key) => [key, item[key]])),
        );
      if (
        (previous !== null && templateReference <= previous) ||
        (nextAfterTemplateReference !== null && templateReference > nextAfterTemplateReference) ||
        versions.has(templateVersionReference) ||
        content.effectiveFrom > observedAt ||
        (content.effectiveUntil !== null &&
          (content.effectiveUntil <= observedAt || content.effectiveUntil < validUntil))
      )
        return unavailable();
      previous = templateReference;
      versions.add(templateVersionReference);
      return Object.freeze({
        templateReference,
        templateVersionReference,
        revision: parseOrganizationVersion(item.revision),
        contentDigest: String(parsePublishingDigest(item.contentDigest)),
        ...content,
      });
    });
    return Object.freeze({
      profile: "MerchantBrandTemplateCandidatesV1" as const,
      ...scope,
      afterTemplateReference,
      items: Object.freeze(items),
      hasMore: r.hasMore,
      nextAfterTemplateReference,
      observedAt,
      validUntil,
    });
  } catch {
    return unavailable();
  }
}

export function projectMerchantBrandTemplateCandidates(
  source: PlatformTemplateBrandReferenceList,
  afterTemplateReference: string | null,
) {
  if (source.profile !== "PlatformTemplateBrandReferenceListV1") return unavailable();
  return parseMerchantBrandTemplateCandidates(
    {
      profile: "MerchantBrandTemplateCandidatesV1",
      ...source.scope,
      afterTemplateReference,
      items: source.items.map(({ template }) => ({
        templateReference: template.templateReference,
        templateVersionReference: template.templateVersionReference,
        revision: template.revision,
        contentDigest: template.contentDigest,
        ...template.content,
      })),
      hasMore: source.hasMore,
      nextAfterTemplateReference: source.nextAfterTemplateReference,
      observedAt: source.observedAt,
      validUntil: source.validUntil,
    },
    source.scope,
    source.observedAt,
    afterTemplateReference,
  );
}

export type MerchantBrandTemplateCandidates = ReturnType<
  typeof parseMerchantBrandTemplateCandidates
>;
