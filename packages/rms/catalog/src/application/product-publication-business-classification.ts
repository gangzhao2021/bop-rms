import {
  CatalogError,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
} from "../contracts/product.js";
import type { CatalogProductPublicationValidationFinding } from "../contracts/product-publication-validation-report.js";

export const catalogProductPublicationBusinessDomains = Object.freeze([
  "Pricing",
  "Recipe",
  "Inventory",
  "Menu",
] as const);
type Domain = (typeof catalogProductPublicationBusinessDomains)[number];
export type CatalogProductPublicationReferenceRequirement =
  "NotRequired" | "RequiredWarning" | "RequiredError";
export type CatalogProductPublicationBusinessTimeRule =
  | { readonly earliestPermittedEffectiveFrom: string }
  | {
      readonly backdateAnchor: "ServerObservation";
      readonly backdateMaximumMilliseconds: 604800000;
    };
export type CatalogProductPublicationBusinessRules = {
  readonly matchingBasis: "RecordedConfigurationReferences";
  readonly requirements: readonly ({ readonly skuReference: string } & Readonly<
    Record<Domain, CatalogProductPublicationReferenceRequirement>
  >)[];
} & CatalogProductPublicationBusinessTimeRule;
export const catalogProductPublicationBusinessSourceCode = "PRODUCT_PUBLICATION_BUSINESS_RULES";
export const catalogProductPublicationReferenceSourceCodes = Object.freeze({
  Pricing: "PRICING_PRODUCT_REFERENCES",
  Recipe: "RECIPE_PRODUCT_REFERENCES",
  Inventory: "INVENTORY_PRODUCT_REFERENCES",
  Menu: "MENU_PRODUCT_REFERENCES",
});
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail();
      return [key, d.value];
    }),
  );
}
function list(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 1000 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
function skus(value: unknown): readonly string[] {
  const result = list(value).map(parseCatalogReference).sort();
  if (new Set(result).size !== result.length) return fail();
  return Object.freeze(result);
}
function digest(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
export function parseCatalogProductPublicationBusinessRules(
  value: unknown,
  activeSkuReferences: readonly string[],
): CatalogProductPublicationBusinessRules {
  try {
    const relative =
        value !== null && typeof value === "object" && Object.hasOwn(value, "backdateAnchor"),
      r = closed(value, [
        "matchingBasis",
        "requirements",
        ...(relative
          ? ["backdateAnchor", "backdateMaximumMilliseconds"]
          : ["earliestPermittedEffectiveFrom"]),
      ]),
      active = skus(activeSkuReferences);
    if (r.matchingBasis !== "RecordedConfigurationReferences") return fail();
    const timeRule = relative
      ? r.backdateAnchor === "ServerObservation" && r.backdateMaximumMilliseconds === 604800000
        ? {
            backdateAnchor: "ServerObservation" as const,
            backdateMaximumMilliseconds: 604800000 as const,
          }
        : fail()
      : { earliestPermittedEffectiveFrom: parseCatalogInstant(r.earliestPermittedEffectiveFrom) };
    const requirements = list(r.requirements)
      .map((value) => {
        const row = closed(value, ["skuReference", ...catalogProductPublicationBusinessDomains]);
        function requirement(domain: Domain): CatalogProductPublicationReferenceRequirement {
          const value = row[domain];
          if (value !== "NotRequired" && value !== "RequiredWarning" && value !== "RequiredError")
            return fail();
          return value;
        }
        return Object.freeze({
          skuReference: parseCatalogReference(row.skuReference),
          Pricing: requirement("Pricing"),
          Recipe: requirement("Recipe"),
          Inventory: requirement("Inventory"),
          Menu: requirement("Menu"),
        });
      })
      .sort((a, b) => a.skuReference.localeCompare(b.skuReference));
    if (
      requirements.length !== active.length ||
      requirements.some((row, i) => row.skuReference !== active[i])
    )
      return fail();
    return Object.freeze({
      matchingBasis: "RecordedConfigurationReferences",
      ...timeRule,
      requirements: Object.freeze(requirements),
    });
  } catch {
    return fail();
  }
}
/** Owner-selected ordinary Product policy. The server observation belongs to
 * the held qualification, not client command time. No authority is granted. */
export function buildCatalogProductPublicationBusinessRules(
  activeSkuReferences: readonly string[],
): CatalogProductPublicationBusinessRules {
  const active = skus(activeSkuReferences);
  return parseCatalogProductPublicationBusinessRules(
    {
      matchingBasis: "RecordedConfigurationReferences",
      backdateAnchor: "ServerObservation",
      backdateMaximumMilliseconds: 604800000,
      requirements: active.map((skuReference) => ({
        skuReference,
        Pricing: "RequiredWarning",
        Recipe: "RequiredWarning",
        Inventory: "RequiredWarning",
        Menu: "RequiredWarning",
      })),
    },
    active,
  );
}
export interface CatalogProductPublicationBusinessClassificationInput {
  readonly activeSkuReferences: readonly string[];
  readonly presentReferences: Readonly<Record<Domain, readonly string[]>>;
  readonly rules: CatalogProductPublicationBusinessRules;
  readonly observedAt: string;
  readonly effectiveFrom: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly configurationReference: string;
  readonly ruleDigest: string;
  readonly referenceDigests: Readonly<Record<Domain, string>>;
}
/** Pure business classification over already-held exact presence sets. Source
 * completeness, authority, relationship resolution and sale readiness are not
 * supplied by this function. Unknown references must never be passed as empty. */
export function classifyCatalogProductPublicationBusinessRules(
  value: CatalogProductPublicationBusinessClassificationInput,
) {
  try {
    const r = closed(value, [
        "activeSkuReferences",
        "presentReferences",
        "rules",
        "observedAt",
        "effectiveFrom",
        "productReference",
        "versionReference",
        "configurationReference",
        "ruleDigest",
        "referenceDigests",
      ]),
      active = skus(r.activeSkuReferences),
      rules = parseCatalogProductPublicationBusinessRules(r.rules, active),
      observedAt = parseCatalogInstant(r.observedAt),
      effectiveFrom = parseCatalogInstant(r.effectiveFrom),
      productReference = parseCatalogReference(r.productReference),
      versionReference = parseCatalogReference(r.versionReference),
      configurationReference = parseCatalogReference(r.configurationReference),
      ruleDigest = digest(r.ruleDigest),
      rawPresence = closed(r.presentReferences, catalogProductPublicationBusinessDomains),
      rawDigests = closed(r.referenceDigests, catalogProductPublicationBusinessDomains);
    const presence = new Map<Domain, ReadonlySet<string>>(),
      referenceDigests = new Map<Domain, string>();
    for (const domain of catalogProductPublicationBusinessDomains) {
      const values = skus(rawPresence[domain]);
      if (values.some((sku) => !active.includes(sku))) return fail();
      presence.set(domain, new Set(values));
      referenceDigests.set(domain, digest(rawDigests[domain]));
    }
    const earliest =
        "earliestPermittedEffectiveFrom" in rules
          ? rules.earliestPermittedEffectiveFrom
          : new Date(Date.parse(observedAt) - rules.backdateMaximumMilliseconds).toISOString(),
      periodError = effectiveFrom < earliest,
      businessReference = Object.freeze({
        sourceCode: catalogProductPublicationBusinessSourceCode,
        resourceReference: configurationReference,
        versionReference: null,
        referenceDigest: ruleDigest,
      }),
      findings: CatalogProductPublicationValidationFinding[] = [];
    if (periodError)
      findings.push(
        Object.freeze({
          checkCode: "EffectivePeriod",
          ruleCode: "PRODUCT_EFFECTIVE_PERIOD",
          outcome: "HardError",
          subjectReference: versionReference,
          reasonCode: "BEFORE_CONFIGURED_EFFECTIVE_FROM",
          references: Object.freeze([businessReference]),
        }),
      );
    for (const requirement of rules.requirements)
      for (const domain of catalogProductPublicationBusinessDomains) {
        const rule = requirement[domain];
        if (rule === "NotRequired" || presence.get(domain)?.has(requirement.skuReference)) continue;
        findings.push(
          Object.freeze({
            checkCode: "ChangeImpact",
            ruleCode: "SKU_008",
            outcome: rule === "RequiredError" ? "HardError" : "Warning",
            subjectReference: requirement.skuReference,
            reasonCode: `REQUIRED_${domain.toUpperCase()}_REFERENCE_MISSING`,
            references: Object.freeze([
              businessReference,
              Object.freeze({
                sourceCode: catalogProductPublicationReferenceSourceCodes[domain],
                resourceReference: productReference,
                versionReference,
                referenceDigest: referenceDigests.get(domain) ?? fail(),
              }),
            ]),
          }),
        );
      }
    return Object.freeze({
      checks: Object.freeze([
        { code: "EffectivePeriod", outcome: periodError ? "HardError" : "Pass" } as const,
        {
          code: "ChangeImpact",
          outcome: findings.some((f) => f.checkCode === "ChangeImpact" && f.outcome === "HardError")
            ? "HardError"
            : findings.some((f) => f.checkCode === "ChangeImpact")
              ? "Warning"
              : "Pass",
        } as const,
      ]),
      findings: Object.freeze(findings),
    });
  } catch {
    return fail();
  }
}
