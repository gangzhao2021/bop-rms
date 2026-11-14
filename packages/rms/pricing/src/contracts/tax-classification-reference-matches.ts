import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePriceBookReferenceSourceRequest,
  type PriceBookReferenceSourceRequest,
} from "./price-book-reference-source.js";
import { parseBrandTaxReferenceSnapshot } from "./brand-tax-reference-source.js";
import { parsePricingReference, parsePricingDigest } from "../domain/money-tax-contract.js";
import {
  parseTaxConfigurationReferenceSourceRequest,
  parseTaxConfigurationReferenceSourceSnapshot,
  type TaxConfigurationReferenceSourceRequest,
  type TaxConfigurationRuleReference,
  type TaxConfigurationVersionReference,
} from "./tax-configuration-reference-source.js";
export class TaxClassificationReferenceMatchError extends Error {
  readonly code = "TAX_CLASSIFICATION_REFERENCE_MATCH_UNAVAILABLE";
  constructor() {
    super("tax classification reference match is unavailable");
    this.name = "TaxClassificationReferenceMatchError";
  }
}
const fail = (): never => {
  throw new TaxClassificationReferenceMatchError();
};
function exact(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function items(value: unknown): readonly unknown[] {
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
export interface ProductVersionTaxReferenceTarget {
  readonly profile: "CurrentDraftBindings" | "RecordedDraftConfigurations";
  readonly catalogSourceDigest: string;
  readonly productReference: string;
  readonly skuReference: string | null;
  readonly configurations: readonly {
    readonly catalogConfigurationDigest: string;
    readonly versionReference: string;
    readonly skuReferences: readonly string[];
    readonly taxClassificationReference: string | null;
  }[];
}
export interface ProductVersionTaxRuleMatch {
  readonly configurationReference: string;
  readonly versionReference: string;
  readonly lifecycle: TaxConfigurationVersionReference["lifecycle"];
  readonly temporalStatus: TaxConfigurationVersionReference["temporalStatus"];
  readonly isCurrentVersion: boolean;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly rule: TaxConfigurationRuleReference;
}
export interface ProductVersionTaxReferenceMatches {
  readonly productReference: string;
  readonly skuReference: string | null;
  readonly request: TaxConfigurationReferenceSourceRequest;
  readonly profile: "ProductVersionTaxReferences";
  readonly coverage: "CurrentDraftOnly" | "RecordedDraftHistoryOnly";
  readonly scopeCoverage: "SelectedStoreOnly";
  readonly crossStoreCoverage: "Unavailable";
  readonly skuTaxOverrideCoverage: "Unavailable";
  readonly publicationCoverage: "Unavailable";
  readonly futureScheduleCoverage: "Unavailable";
  readonly classificationCoverage: "CompleteExplicit" | "DefaultUnavailable";
  readonly catalogSourceDigest: string;
  readonly taxSourceDigest: string;
  readonly configurations: readonly {
    readonly catalogConfigurationDigest: string;
    readonly versionReference: string;
    readonly membership: "Included" | "SkuAbsent";
    readonly taxClassificationReference: string | null;
    readonly classificationCoverage:
      "Explicit" | "DefaultUnavailable" | "NotApplicableToSelectedSku";
    readonly references: readonly ProductVersionTaxRuleMatch[] | null;
  }[];
  readonly digest: string;
}
/** Product Version classification reference metadata, never resolved default, SKU override, treatment or legal applicability. */
function readTarget(value: unknown) {
  const raw = exact(value, [
    "profile",
    "catalogSourceDigest",
    "productReference",
    "skuReference",
    "configurations",
  ]);
  if (raw.profile !== "CurrentDraftBindings" && raw.profile !== "RecordedDraftConfigurations")
    return fail();
  const catalogSourceDigest = parsePricingDigest(raw.catalogSourceDigest),
    productReference = parsePricingReference(raw.productReference),
    skuReference = raw.skuReference === null ? null : parsePricingReference(raw.skuReference);

  let budget = 100000;
  const configurations = items(raw.configurations).map((value) => {
    const c = exact(value, [
        "catalogConfigurationDigest",
        "versionReference",
        "skuReferences",
        "taxClassificationReference",
      ]),
      catalogConfigurationDigest = parsePricingDigest(c.catalogConfigurationDigest),
      versionReference = parsePricingReference(c.versionReference),
      skuReferences = items(c.skuReferences).map(parsePricingReference);
    if (new Set(skuReferences).size !== skuReferences.length) return fail();
    budget -= skuReferences.length + 1;
    if (budget < 0) return fail();
    return {
      catalogConfigurationDigest,
      versionReference,
      skuReferences,
      taxClassificationReference:
        c.taxClassificationReference === null
          ? null
          : parsePricingReference(c.taxClassificationReference),
    };
  });
  if (
    configurations.length === 0 ||
    (raw.profile === "CurrentDraftBindings" && configurations.length !== 1) ||
    new Set(configurations.map((c) => c.catalogConfigurationDigest)).size !==
      configurations.length ||
    (skuReference !== null && !configurations.some((c) => c.skuReferences.includes(skuReference)))
  )
    return fail();
  return { raw, catalogSourceDigest, productReference, skuReference, configurations };
}
export function matchProductVersionTaxReferences(input: {
  readonly request: TaxConfigurationReferenceSourceRequest;
  readonly target: ProductVersionTaxReferenceTarget;
  readonly taxConfigurations: unknown;
  readonly now: string;
}): ProductVersionTaxReferenceMatches {
  try {
    const request = parseTaxConfigurationReferenceSourceRequest(input.request);
    const { raw, catalogSourceDigest, productReference, skuReference, configurations } = readTarget(
      input.target,
    );
    const tax = parseTaxConfigurationReferenceSourceSnapshot(
      input.taxConfigurations,
      request,
      input.now,
    );
    let remaining = 10000,
      unknown = false;
    const matches = Object.freeze(
      configurations
        .sort((a, b) => a.catalogConfigurationDigest.localeCompare(b.catalogConfigurationDigest))
        .map((c) => {
          const base = {
            catalogConfigurationDigest: c.catalogConfigurationDigest,
            versionReference: c.versionReference,
            taxClassificationReference: c.taxClassificationReference,
          };
          if (skuReference !== null && !c.skuReferences.includes(skuReference))
            return Object.freeze({
              ...base,
              membership: "SkuAbsent" as const,
              classificationCoverage: "NotApplicableToSelectedSku" as const,
              references: null,
            });
          if (c.taxClassificationReference === null) {
            unknown = true;
            return Object.freeze({
              ...base,
              membership: "Included" as const,
              classificationCoverage: "DefaultUnavailable" as const,
              references: null,
            });
          }
          const references = Object.freeze(
            tax.versions.flatMap((v) =>
              v.rules
                .filter((r) => r.taxClassificationReference === c.taxClassificationReference)
                .map((rule) =>
                  Object.freeze({
                    configurationReference: v.configurationReference,
                    versionReference: v.versionReference,
                    lifecycle: v.lifecycle,
                    temporalStatus: v.temporalStatus,
                    isCurrentVersion: v.isCurrentVersion,
                    effectiveFrom: v.effectiveFrom,
                    effectiveUntil: v.effectiveUntil,
                    rule,
                  }),
                ),
            ),
          );
          remaining -= references.length;
          if (remaining < 0) return fail();
          return Object.freeze({
            ...base,
            membership: "Included" as const,
            classificationCoverage: "Explicit" as const,
            references,
          });
        }),
    );
    const result = {
      request,
      productReference,
      skuReference,
      profile: "ProductVersionTaxReferences" as const,
      coverage:
        raw.profile === "CurrentDraftBindings"
          ? ("CurrentDraftOnly" as const)
          : ("RecordedDraftHistoryOnly" as const),
      scopeCoverage: "SelectedStoreOnly" as const,
      crossStoreCoverage: "Unavailable" as const,
      skuTaxOverrideCoverage: "Unavailable" as const,
      publicationCoverage: "Unavailable" as const,
      futureScheduleCoverage: "Unavailable" as const,
      classificationCoverage: unknown
        ? ("DefaultUnavailable" as const)
        : ("CompleteExplicit" as const),
      catalogSourceDigest,
      taxSourceDigest: tax.digest,
      configurations: matches,
    };
    return Object.freeze({ ...result, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(result)) });
  } catch {
    return fail();
  }
}

export interface ProductVersionBrandTaxReferenceMatches {
  readonly productReference: string;
  readonly skuReference: string | null;
  readonly request: PriceBookReferenceSourceRequest;
  readonly profile: "ProductVersionBrandTaxReferences";
  readonly coverage: "CurrentDraftOnly" | "RecordedDraftHistoryOnly";
  readonly scopeCoverage: "AllRegisteredStores";
  readonly crossStoreCoverage: "CompleteRegisteredReferences";
  readonly skuTaxOverrideCoverage: "Unavailable";
  readonly publicationCoverage: "Unavailable";
  readonly futureScheduleCoverage: "Unavailable";
  readonly classificationCoverage: "CompleteExplicit" | "DefaultUnavailable";
  readonly catalogSourceDigest: string;
  readonly taxSourceDigest: string;
  readonly retiredRootReferences: readonly {
    storeReference: string;
    configurationReference: string;
    aggregateVersion: string;
    currentVersionReference: string | null;
  }[];
  readonly unresolvedRoots: readonly { storeReference: string; configurationReference: string }[];
  readonly stores: readonly { storeReference: string; lifecycle: string; sourceDigest: string }[];
  readonly configurations: readonly {
    catalogConfigurationDigest: string;
    versionReference: string;
    taxClassificationReference: string | null;
    membership: "Included" | "SkuAbsent";
    classificationCoverage: "Explicit" | "DefaultUnavailable" | "NotApplicableToSelectedSku";
    references:
      | readonly (ProductVersionTaxRuleMatch & {
          readonly storeReference: string;
          readonly storeLifecycle: string;
          readonly storeSourceDigest: string;
        })[]
      | null;
  }[];
  readonly digest: string;
}
/** Complete stored rule-reference coverage across registered Stores, retaining
 * retired/unresolved roots. It never resolves a default, tax treatment or approval. */
export function matchProductVersionBrandTaxReferences(input: {
  request: PriceBookReferenceSourceRequest;
  target: ProductVersionTaxReferenceTarget;
  taxConfigurations: unknown;
  now: string;
}): ProductVersionBrandTaxReferenceMatches {
  try {
    const request = parsePriceBookReferenceSourceRequest(input.request),
      target = readTarget(input.target);
    const tax = parseBrandTaxReferenceSnapshot(input.taxConfigurations, request, input.now);
    const canonicalTarget: ProductVersionTaxReferenceTarget = {
      profile: target.raw.profile as ProductVersionTaxReferenceTarget["profile"],
      catalogSourceDigest: target.catalogSourceDigest,
      productReference: target.productReference,
      skuReference: target.skuReference,
      configurations: target.configurations,
    };
    const versionIdentities = new Set<string>(),
      ruleIdentities = new Set<string>();
    for (const source of tax.stores)
      for (const version of source.versions) {
        if (versionIdentities.has(version.versionReference)) return fail();
        versionIdentities.add(version.versionReference);
        for (const rule of version.rules) {
          if (ruleIdentities.has(rule.ruleReference)) return fail();
          ruleIdentities.add(rule.ruleReference);
        }
      }
    const targetUnits = target.configurations.reduce((n, c) => n + 1 + c.skuReferences.length, 0);
    const ruleUnits = tax.stores.reduce(
      (n, s) => n + s.versions.reduce((n, v) => n + v.rules.length, 0),
      0,
    );
    if (tax.stores.length * targetUnits + ruleUnits * target.configurations.length > 100_000)
      return fail();
    const perStore = tax.stores.map((source, i) => {
      const store = tax.storeInventory.references[i];
      if (!store) return fail();
      return {
        store,
        result: matchProductVersionTaxReferences({
          request: { ...request, storeReference: store.storeReference },
          target: canonicalTarget,
          taxConfigurations: source,
          now: input.now,
        }),
        source,
      };
    });
    let remaining = 10_000,
      unknown = false;
    const configurations = Object.freeze(
      [...target.configurations]
        .sort((a, b) => a.catalogConfigurationDigest.localeCompare(b.catalogConfigurationDigest))
        .map((c) => {
          const base = {
            catalogConfigurationDigest: c.catalogConfigurationDigest,
            versionReference: c.versionReference,
            taxClassificationReference: c.taxClassificationReference,
          };
          if (target.skuReference !== null && !c.skuReferences.includes(target.skuReference))
            return Object.freeze({
              ...base,
              membership: "SkuAbsent" as const,
              classificationCoverage: "NotApplicableToSelectedSku" as const,
              references: null,
            });
          if (c.taxClassificationReference === null) {
            unknown = true;
            return Object.freeze({
              ...base,
              membership: "Included" as const,
              classificationCoverage: "DefaultUnavailable" as const,
              references: null,
            });
          }
          const references = Object.freeze(
            perStore.flatMap(({ store, result, source }) => {
              const configuration = result.configurations.find(
                (x) => x.catalogConfigurationDigest === c.catalogConfigurationDigest,
              );
              if (!configuration || configuration.references === null) return fail();
              remaining -= configuration.references.length;
              if (remaining < 0) return fail();
              return configuration.references.map((r) =>
                Object.freeze({
                  ...r,
                  storeReference: store.storeReference,
                  storeLifecycle: store.lifecycle,
                  storeSourceDigest: source.digest,
                }),
              );
            }),
          );
          return Object.freeze({
            ...base,
            membership: "Included" as const,
            classificationCoverage: "Explicit" as const,
            references,
          });
        }),
    );
    const result = {
      request,
      productReference: target.productReference,
      skuReference: target.skuReference,
      profile: "ProductVersionBrandTaxReferences" as const,
      coverage:
        target.raw.profile === "CurrentDraftBindings"
          ? ("CurrentDraftOnly" as const)
          : ("RecordedDraftHistoryOnly" as const),
      scopeCoverage: "AllRegisteredStores" as const,
      crossStoreCoverage: "CompleteRegisteredReferences" as const,
      skuTaxOverrideCoverage: "Unavailable" as const,
      publicationCoverage: "Unavailable" as const,
      futureScheduleCoverage: "Unavailable" as const,
      classificationCoverage: unknown
        ? ("DefaultUnavailable" as const)
        : ("CompleteExplicit" as const),
      catalogSourceDigest: target.catalogSourceDigest,
      taxSourceDigest: tax.digest,
      stores: Object.freeze(
        perStore.map(({ store, source }) =>
          Object.freeze({
            storeReference: store.storeReference,
            lifecycle: store.lifecycle,
            sourceDigest: source.digest,
          }),
        ),
      ),
      retiredRootReferences: Object.freeze(
        tax.rootScope
          .filter((r) => !r.present)
          .map((r) =>
            Object.freeze({
              storeReference: r.storeReference,
              configurationReference: r.configurationReference,
              aggregateVersion: r.aggregateVersion,
              currentVersionReference: r.currentVersionReference,
            }),
          ),
      ),
      unresolvedRoots: Object.freeze(
        tax.stores.flatMap((s) =>
          s.roots
            .filter((r) => r.currentVersionReference === null)
            .map((r) =>
              Object.freeze({
                storeReference: s.request.storeReference,
                configurationReference: r.configurationReference,
              }),
            ),
        ),
      ),
      configurations,
    };
    return Object.freeze({ ...result, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(result)) });
  } catch {
    return fail();
  }
}
