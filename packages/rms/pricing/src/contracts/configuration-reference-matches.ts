import {
  parsePricingProductPublicationReferenceRequestV2,
  type PricingProductPublicationReferenceRequestV2,
} from "./product-publication-reference-request-v2.js";
import { parseProductPublicationPriceBookReferenceSourceSnapshotV2 } from "./price-book-reference-source.js";
import { parseProductPublicationOptionPriceReferenceSourceSnapshotV2 } from "./option-price-reference-source.js";
import { parseProductPublicationPromotionReferenceSourceSnapshotV2 } from "./promotion-reference-source.js";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import { parseConfigurationReferenceSourceSnapshot } from "./configuration-reference-source.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
} from "../domain/money-tax-contract.js";
import {
  parsePriceBookReferenceSourceRequest,
  parsePriceBookReferenceSourceSnapshot,
  type PriceBookReferenceSourceRequest,
  type PriceBookReference,
  type PriceBookReferenceSourceSnapshot,
} from "./price-book-reference-source.js";
import {
  parseOptionPriceReferenceSourceSnapshot,
  type OptionPriceRootReference,
  type OptionPriceVersionReference,
  type OptionPriceReferenceSourceSnapshot,
} from "./option-price-reference-source.js";
import {
  parsePromotionReferenceSourceSnapshot,
  type PromotionVersionReference,
  type PromotionReferenceSourceSnapshot,
} from "./promotion-reference-source.js";
export class PricingReferenceMatchError extends Error {
  readonly code = "PRICING_REFERENCE_MATCH_UNAVAILABLE";
  constructor() {
    super("pricing reference match is unavailable");
    this.name = "PricingReferenceMatchError";
  }
}
const fail = (): never => {
  throw new PricingReferenceMatchError();
};
function exact(v: unknown, keys: readonly string[]) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[k] = d.value;
  }
  return result;
}
function items(v: unknown): readonly unknown[] {
  if (
    !Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Array.prototype ||
    v.length > 1000 ||
    Reflect.ownKeys(v).length !== v.length + 1
  )
    return fail();
  return Array.from({ length: v.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
function references(v: unknown, parse: (v: unknown) => string = parsePricingReference) {
  const raw = items(v),
    values = raw.map(parse);
  if (new Set(values).size !== values.length || values.some((value, i) => value !== raw[i]))
    return fail();
  return Object.freeze(values.sort());
}
export interface PricingReferenceTarget {
  readonly mappingProfile: "CurrentDraftBindings";
  readonly catalogSourceDigest: string;
  readonly productReference: string;
  readonly skuReference: string | null;
  readonly skuReferences: readonly string[];
  readonly categoryReferences: readonly string[] | null;
  readonly bindings: readonly {
    readonly bindingReference: string;
    readonly enabledOptionReferences: readonly string[];
    readonly includedSkuReferences: readonly string[];
    readonly excludedSkuReferences: readonly string[];
    readonly channelCodes: readonly string[];
  }[];
}
export interface PricingConfigurationReferenceMatches {
  readonly request: PriceBookReferenceSourceRequest;
  readonly coverage: "CurrentDraftOnly";
  readonly historicalMembershipCoverage: "Unavailable";
  readonly catalogSourceDigest: string;
  readonly sourceDigests: Readonly<{
    priceBooks: string;
    optionPrices: string;
    promotions: string;
  }>;
  readonly digest: string;
  readonly priceEntries: readonly PriceBookReference[];
  readonly optionRoots: readonly OptionPriceRootReference[];
  readonly optionVersions: readonly {
    readonly reference: OptionPriceVersionReference;
    readonly matchedSkuReferences: readonly string[];
    readonly bindingChannelCodes: readonly string[];
  }[];
  readonly unresolvedOptionRoots: readonly {
    readonly reference: OptionPriceRootReference;
    readonly versions: readonly OptionPriceVersionReference[];
    readonly reason: "BindingNotInCurrentDraft" | "OptionNotEnabledInCurrentDraft";
  }[];
  readonly unresolvedOptionVersions: readonly {
    readonly reference: OptionPriceVersionReference;
    readonly reason: "SkuNotInCurrentDraft";
  }[];
  readonly promotions: readonly {
    readonly reference: PromotionVersionReference;
    readonly matchedBy: readonly ("Sellable" | "Category" | "AllSellables" | "OrderSubtotal")[];
  }[];
}
function parseTarget(value: unknown): PricingReferenceTarget {
  const raw = exact(value, [
    "mappingProfile",
    "catalogSourceDigest",
    "productReference",
    "skuReference",
    "skuReferences",
    "categoryReferences",
    "bindings",
  ]);
  if (raw.mappingProfile !== "CurrentDraftBindings") return fail();
  const productReference = parsePricingReference(raw.productReference),
    skuReference = raw.skuReference === null ? null : parsePricingReference(raw.skuReference),
    skuReferences = references(raw.skuReferences),
    categoryReferences =
      raw.categoryReferences === null ? null : references(raw.categoryReferences),
    catalogSourceDigest = parsePricingDigest(raw.catalogSourceDigest);
  if (skuReference !== null && !skuReferences.includes(skuReference)) return fail();
  const bindings = items(raw.bindings).map((v) => {
    const b = exact(v, [
        "bindingReference",
        "enabledOptionReferences",
        "includedSkuReferences",
        "excludedSkuReferences",
        "channelCodes",
      ]),
      includedSkuReferences = references(b.includedSkuReferences),
      excludedSkuReferences = references(b.excludedSkuReferences);
    if (
      [...includedSkuReferences, ...excludedSkuReferences].some(
        (s) => !skuReferences.includes(s),
      ) ||
      includedSkuReferences.some((s) => excludedSkuReferences.includes(s))
    )
      return fail();
    return Object.freeze({
      bindingReference: parsePricingReference(b.bindingReference),
      enabledOptionReferences: references(b.enabledOptionReferences),
      includedSkuReferences,
      excludedSkuReferences,
      channelCodes: references(b.channelCodes, parsePricingCode),
    });
  });
  if (new Set(bindings.map((b) => b.bindingReference)).size !== bindings.length) return fail();
  return Object.freeze({
    mappingProfile: "CurrentDraftBindings" as const,
    catalogSourceDigest,
    productReference,
    skuReference,
    skuReferences,
    categoryReferences,
    bindings: Object.freeze(bindings),
  });
}
type ReferenceFacts = Pick<
  PricingConfigurationReferenceMatches,
  | "priceEntries"
  | "optionRoots"
  | "optionVersions"
  | "unresolvedOptionRoots"
  | "unresolvedOptionVersions"
  | "promotions"
>;
function matchConfiguration(
  target: PricingReferenceTarget,
  priceBooks: Pick<PriceBookReferenceSourceSnapshot, "references">,
  optionPrices: Pick<OptionPriceReferenceSourceSnapshot, "roots" | "versions">,
  promotions: Pick<PromotionReferenceSourceSnapshot, "versions">,
): ReferenceFacts {
  const { productReference, skuReference, skuReferences, categoryReferences, bindings } = target;
  const targetSkus = skuReference === null ? skuReferences : [skuReference],
    sellables = new Set([productReference, ...targetSkus]);
  const priceEntries = Object.freeze(
    priceBooks.references.filter((r) => sellables.has(r.sellableReference)),
  );
  const optionRoots: OptionPriceRootReference[] = [],
    optionVersions: PricingConfigurationReferenceMatches["optionVersions"][number][] = [],
    unresolvedOptionRoots: PricingConfigurationReferenceMatches["unresolvedOptionRoots"][number][] =
      [],
    unresolvedOptionVersions: PricingConfigurationReferenceMatches["unresolvedOptionVersions"][number][] =
      [];
  for (const root of optionPrices.roots) {
    const binding = bindings.find((b) => b.bindingReference === root.bindingReference);
    if (!binding || !binding.enabledOptionReferences.includes(root.optionReference)) {
      unresolvedOptionRoots.push(
        Object.freeze({
          reference: root,
          versions: Object.freeze(
            optionPrices.versions.filter((v) => v.ruleReference === root.ruleReference),
          ),
          reason: binding ? "OptionNotEnabledInCurrentDraft" : "BindingNotInCurrentDraft",
        }),
      );
      continue;
    }
    optionRoots.push(root);
    for (const version of optionPrices.versions.filter(
      (v) => v.ruleReference === root.ruleReference,
    )) {
      if (version.skuReference !== null && !skuReferences.includes(version.skuReference)) {
        unresolvedOptionVersions.push(
          Object.freeze({ reference: version, reason: "SkuNotInCurrentDraft" }),
        );
        continue;
      }
      const matchedSkuReferences = targetSkus.filter(
        (s) =>
          (version.skuReference === null || s === version.skuReference) &&
          (binding.includedSkuReferences.length === 0 ||
            binding.includedSkuReferences.includes(s)) &&
          !binding.excludedSkuReferences.includes(s),
      );
      if (
        matchedSkuReferences.length > 0 ||
        (targetSkus.length === 0 && version.skuReference === null)
      )
        optionVersions.push(
          Object.freeze({
            reference: version,
            matchedSkuReferences: Object.freeze(matchedSkuReferences),
            bindingChannelCodes: binding.channelCodes,
          }),
        );
    }
  }
  const promotionMatches: PricingConfigurationReferenceMatches["promotions"][number][] = [];
  for (const version of promotions.versions) {
    const matchedBy: PricingConfigurationReferenceMatches["promotions"][number]["matchedBy"][number][] =
      [];
    if (version.catalogReferenceMode === "OrderSubtotal") matchedBy.push("OrderSubtotal");
    else if (version.catalogReferenceMode === "AllSellables") matchedBy.push("AllSellables");
    else {
      if (
        categoryReferences === null &&
        version.eligibility.some((e) => e.referenceKind === "Category")
      )
        return fail();
      if (
        version.eligibility.some(
          (e) => e.referenceKind === "Sellable" && sellables.has(e.publicReference),
        )
      )
        matchedBy.push("Sellable");
      if (
        version.eligibility.some(
          (e) => e.referenceKind === "Category" && categoryReferences?.includes(e.publicReference),
        )
      )
        matchedBy.push("Category");
    }
    if (matchedBy.length)
      promotionMatches.push(
        Object.freeze({ reference: version, matchedBy: Object.freeze(matchedBy) }),
      );
  }
  return {
    priceEntries,
    optionRoots: Object.freeze(optionRoots),
    optionVersions: Object.freeze(optionVersions),
    unresolvedOptionRoots: Object.freeze(unresolvedOptionRoots),
    unresolvedOptionVersions: Object.freeze(unresolvedOptionVersions),
    promotions: Object.freeze(promotionMatches),
  };
}
/** Pricing reference semantics over public neutral Catalog facts. Caller must hold actual owner sources.
 * Current matches never establish historical absence, eligibility, approval or a complete impact review. */
export function matchPricingConfigurationReferences(input: {
  readonly request: PriceBookReferenceSourceRequest;
  readonly target: PricingReferenceTarget;
  readonly priceBooks: unknown;
  readonly optionPrices: unknown;
  readonly promotions: unknown;
  readonly now: string;
}): PricingConfigurationReferenceMatches {
  try {
    const request = parsePriceBookReferenceSourceRequest(input.request),
      target = parseTarget(input.target),
      catalogSourceDigest = target.catalogSourceDigest;
    const priceBooks = parsePriceBookReferenceSourceSnapshot(input.priceBooks, request, input.now),
      optionPrices = parseOptionPriceReferenceSourceSnapshot(
        input.optionPrices,
        request,
        input.now,
      ),
      promotions = parsePromotionReferenceSourceSnapshot(input.promotions, request, input.now);
    const facts = matchConfiguration(target, priceBooks, optionPrices, promotions);
    const matches = {
      request,
      coverage: "CurrentDraftOnly" as const,
      historicalMembershipCoverage: "Unavailable" as const,
      catalogSourceDigest,
      sourceDigests: Object.freeze({
        priceBooks: priceBooks.digest,
        optionPrices: optionPrices.digest,
        promotions: promotions.digest,
      }),
      ...facts,
    };
    return Object.freeze({
      ...matches,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(matches)),
    });
  } catch {
    return fail();
  }
}

export interface RecordedPricingReferenceTarget {
  readonly mappingProfile: "RecordedDraftConfigurations";
  readonly catalogSourceDigest: string;
  readonly productReference: string;
  readonly skuReference: string | null;
  readonly configurations: readonly {
    readonly catalogConfigurationDigest: string;
    readonly versionReference: string;
    readonly skuReferences: readonly string[];
    readonly categoryReferences: readonly string[] | null;
    readonly bindings: PricingReferenceTarget["bindings"];
  }[];
}
type RecordedReferenceFacts = Omit<
  ReferenceFacts,
  "unresolvedOptionRoots" | "unresolvedOptionVersions"
> & {
  readonly unresolvedOptionRoots: readonly {
    readonly reference: OptionPriceRootReference;
    readonly versions: readonly OptionPriceVersionReference[];
    readonly reason:
      "BindingNotInRecordedConfiguration" | "OptionNotEnabledInRecordedConfiguration";
  }[];
  readonly unresolvedOptionVersions: readonly {
    readonly reference: OptionPriceVersionReference;
    readonly reason: "SkuNotInRecordedConfiguration";
  }[];
};
export interface RecordedPricingConfigurationReferenceMatches {
  readonly request: PriceBookReferenceSourceRequest;
  readonly coverage: "RecordedDraftHistoryOnly";
  readonly publicationCoverage: "Unavailable";
  readonly futureScheduleCoverage: "Unavailable";
  readonly catalogSourceDigest: string;
  readonly sourceDigests: PricingConfigurationReferenceMatches["sourceDigests"];
  readonly configurations: readonly {
    readonly catalogConfigurationDigest: string;
    readonly versionReference: string;
    readonly membership: "Included" | "SkuAbsent";
    readonly matches: RecordedReferenceFacts | null;
  }[];
  readonly digest: string;
}
/** Keep original recorded memberships separate; no inferred publication, future schedule, eligibility or approval. */
function matchRecordedConfiguration<
  R extends PriceBookReferenceSourceRequest | PricingProductPublicationReferenceRequestV2,
>(
  request: R,
  targetValue: unknown,
  priceBooks: Pick<PriceBookReferenceSourceSnapshot, "references" | "digest">,
  optionPrices: Pick<OptionPriceReferenceSourceSnapshot, "roots" | "versions" | "digest">,
  promotions: Pick<PromotionReferenceSourceSnapshot, "versions" | "digest">,
) {
  const raw = exact(targetValue, [
    "mappingProfile",
    "catalogSourceDigest",
    "productReference",
    "skuReference",
    "configurations",
  ]);
  if (raw.mappingProfile !== "RecordedDraftConfigurations") return fail();
  const catalogSourceDigest = parsePricingDigest(raw.catalogSourceDigest),
    productReference = parsePricingReference(raw.productReference),
    skuReference = raw.skuReference === null ? null : parsePricingReference(raw.skuReference);
  let inputBudget = 100000;
  const configurations = items(raw.configurations).map((v) => {
    const c = exact(v, [
        "catalogConfigurationDigest",
        "versionReference",
        "skuReferences",
        "categoryReferences",
        "bindings",
      ]),
      catalogConfigurationDigest = parsePricingDigest(c.catalogConfigurationDigest),
      versionReference = parsePricingReference(c.versionReference);
    const target = parseTarget({
      mappingProfile: "CurrentDraftBindings",
      catalogSourceDigest,
      productReference,
      skuReference: null,
      skuReferences: c.skuReferences,
      categoryReferences: c.categoryReferences,
      bindings: c.bindings,
    });
    inputBudget -=
      1 +
      target.skuReferences.length +
      (target.categoryReferences?.length ?? 0) +
      target.bindings.reduce(
        (n, b) =>
          n +
          1 +
          b.enabledOptionReferences.length +
          b.includedSkuReferences.length +
          b.excludedSkuReferences.length +
          b.channelCodes.length,
        0,
      );
    if (inputBudget < 0) return fail();
    return { catalogConfigurationDigest, versionReference, target };
  });
  if (
    configurations.length === 0 ||
    new Set(configurations.map((c) => c.catalogConfigurationDigest)).size !==
      configurations.length ||
    (skuReference !== null &&
      !configurations.some((c) => c.target.skuReferences.includes(skuReference)))
  )
    return fail();
  let outputBudget = 10000;
  const matched = Object.freeze(
    configurations
      .sort((a, b) => a.catalogConfigurationDigest.localeCompare(b.catalogConfigurationDigest))
      .map((c) => {
        if (skuReference !== null && !c.target.skuReferences.includes(skuReference))
          return Object.freeze({
            catalogConfigurationDigest: c.catalogConfigurationDigest,
            versionReference: c.versionReference,
            membership: "SkuAbsent" as const,
            matches: null,
          });
        const facts = matchConfiguration(
          { ...c.target, skuReference },
          priceBooks,
          optionPrices,
          promotions,
        );
        outputBudget -=
          facts.priceEntries.length +
          facts.optionRoots.length +
          facts.optionVersions.reduce(
            (n, r) => n + 1 + r.matchedSkuReferences.length + r.bindingChannelCodes.length,
            0,
          ) +
          facts.promotions.reduce(
            (n, r) => n + 1 + r.reference.eligibility.length + r.matchedBy.length,
            0,
          ) +
          facts.unresolvedOptionRoots.reduce((n, r) => n + 1 + r.versions.length, 0) +
          facts.unresolvedOptionVersions.length;
        if (outputBudget < 0) return fail();
        const matches: RecordedReferenceFacts = Object.freeze({
          ...facts,
          unresolvedOptionRoots: Object.freeze(
            facts.unresolvedOptionRoots.map((r) =>
              Object.freeze({
                ...r,
                reason:
                  r.reason === "BindingNotInCurrentDraft"
                    ? ("BindingNotInRecordedConfiguration" as const)
                    : ("OptionNotEnabledInRecordedConfiguration" as const),
              }),
            ),
          ),
          unresolvedOptionVersions: Object.freeze(
            facts.unresolvedOptionVersions.map((r) =>
              Object.freeze({ ...r, reason: "SkuNotInRecordedConfiguration" as const }),
            ),
          ),
        });
        return Object.freeze({
          catalogConfigurationDigest: c.catalogConfigurationDigest,
          versionReference: c.versionReference,
          membership: "Included" as const,
          matches,
        });
      }),
  );
  const result = {
    request,
    coverage: "RecordedDraftHistoryOnly" as const,
    publicationCoverage: "Unavailable" as const,
    futureScheduleCoverage: "Unavailable" as const,
    catalogSourceDigest,
    sourceDigests: Object.freeze({
      priceBooks: priceBooks.digest,
      optionPrices: optionPrices.digest,
      promotions: promotions.digest,
    }),
    configurations: matched,
  };
  return Object.freeze({ ...result, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(result)) });
}
export function matchRecordedPricingConfigurationReferences(input: {
  readonly request: PriceBookReferenceSourceRequest;
  readonly target: RecordedPricingReferenceTarget;
  readonly priceBooks: unknown;
  readonly optionPrices: unknown;
  readonly promotions: unknown;
  readonly now: string;
}): RecordedPricingConfigurationReferenceMatches {
  try {
    const request = parsePriceBookReferenceSourceRequest(input.request);
    return matchRecordedConfiguration(
      request,
      input.target,
      parsePriceBookReferenceSourceSnapshot(input.priceBooks, request, input.now),
      parseOptionPriceReferenceSourceSnapshot(input.optionPrices, request, input.now),
      parsePromotionReferenceSourceSnapshot(input.promotions, request, input.now),
    );
  } catch {
    return fail();
  }
}

/** Metadata only: exact Option identities/pins are supplied by the owning current
 * Catalog source. Binding/SKU/scope membership, price amounts and qualification
 * are deliberately not inferred from a stored Published label. */
/** Original Option publication observation only; current source/effective checks
 * still use the actual supplied current instant. Never a general backdate. */
function optionPublicationClock(
  value: unknown,
  request: PriceBookReferenceSourceRequest,
  now: string,
) {
  const r = exact(value, [
      "profile",
      "operationReference",
      "catalogIntentDigest",
      "observedAt",
      "validUntil",
    ]),
    observedAt = parseEffectivePeriodInstant(r.observedAt),
    validUntil = parseEffectivePeriodInstant(r.validUntil),
    operationReference = parsePricingReference(r.operationReference),
    catalogIntentDigest = parsePricingDigest(r.catalogIntentDigest);
  if (
    r.profile !== "OptionPublicationOriginalClockV1" ||
    operationReference !== request.operationReference ||
    catalogIntentDigest !== request.catalogIntentDigest ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    now < observedAt ||
    now >= validUntil
  )
    return fail();
  return Object.freeze({
    profile: "OptionPublicationOriginalClockV1" as const,
    operationReference,
    catalogIntentDigest,
    observedAt,
    validUntil,
  });
}
export function matchOptionDraftPriceReferenceMetadata(
  targetValue: unknown,
  sourceValue: unknown,
  requestValue: PriceBookReferenceSourceRequest,
  nowValue: string,
  activationValue: string,
  originalPublicationClockInput?: unknown,
) {
  try {
    const request = parsePriceBookReferenceSourceRequest(requestValue),
      source = parseConfigurationReferenceSourceSnapshot(sourceValue, request, nowValue),
      target = exact(targetValue, [
        "profile",
        "brandReference",
        "optionSetReference",
        "versionReference",
        "sourceDigest",
        "contentDigest",
        "configurationDigest",
        "optionPins",
      ]),
      activationAt = parseEffectivePeriodInstant(activationValue),
      now = parseEffectivePeriodInstant(nowValue),
      originalPublicationClock =
        originalPublicationClockInput === undefined
          ? undefined
          : optionPublicationClock(originalPublicationClockInput, request, now);
    if (
      target.profile !== "CurrentFullOptionDraftPricePinsV1" ||
      target.brandReference !== request.brandReference ||
      activationAt < (originalPublicationClock?.observedAt ?? now)
    )
      return fail();
    const pins = items(target.optionPins);
    if (pins.length > 100) return fail();
    const seen = new Set<string>();
    const references = pins
      .map((value) => {
        const pin = exact(value, ["optionReference", "ruleReference", "versionReference"]),
          optionReference = parsePricingReference(pin.optionReference),
          ruleReference = parsePricingReference(pin.ruleReference),
          versionReference = parsePricingReference(pin.versionReference);
        if (seen.has(optionReference)) return fail();
        seen.add(optionReference);
        const root = source.optionPrices.roots.find((r) => r.ruleReference === ruleReference),
          version = source.optionPrices.versions.find(
            (v) => v.ruleReference === ruleReference && v.versionReference === versionReference,
          );
        const status = !root
          ? "MissingRule"
          : root.optionReference !== optionReference
            ? "WrongOption"
            : !version
              ? "MissingVersion"
              : root.currentVersionReference !== versionReference
                ? "NotCurrent"
                : version.lifecycle !== "Published"
                  ? "NotPublished"
                  : version.effectiveFrom > now ||
                      (version.effectiveUntil !== null && version.effectiveUntil <= now)
                    ? "NotEffective"
                    : version.effectiveFrom > activationAt ||
                        (version.effectiveUntil !== null && version.effectiveUntil <= activationAt)
                      ? "ActivationOutsidePeriod"
                      : "CurrentPublishedMetadata";
        return Object.freeze({ optionReference, ruleReference, versionReference, status });
      })
      .sort((a, b) => a.optionReference.localeCompare(b.optionReference));
    const result = {
      profile: "OptionDraftPriceReferenceMetadataV1" as const,
      ...(originalPublicationClock ? { originalPublicationClock } : {}),
      request,
      brandReference: parsePricingReference(target.brandReference),
      optionSetReference: parsePricingReference(target.optionSetReference),
      versionReference: parsePricingReference(target.versionReference),
      sourceDigest: parsePricingDigest(target.sourceDigest),
      contentDigest: parsePricingDigest(target.contentDigest),
      configurationDigest: parsePricingDigest(target.configurationDigest),
      pricingGeneration: source.generation,
      pricingSourceDigest: source.digest,
      optionPriceSourceDigest: source.optionPrices.digest,
      observedAt: source.observedAt,
      activationAt,
      references: Object.freeze(references),
      decision: references.some((r) => r.status !== "CurrentPublishedMetadata")
        ? ("HardError" as const)
        : ("PassForMetadata" as const),
      bindingMembership: "NotEvaluated" as const,
      skuMembership: "NotEvaluated" as const,
      scopeApplicability: "NotEvaluated" as const,
      priceAmounts: "NotEvaluated" as const,
      referenceEligibility: "NotEvaluated" as const,
      publishValidation: "Incomplete" as const,
      eligibility: "NotEvaluated" as const,
    };
    return Object.freeze({ ...result, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(result)) });
  } catch {
    return fail();
  }
}

export interface ProductPublicationPricingConfigurationReferenceMatchesV2 extends Omit<
  PricingConfigurationReferenceMatches,
  "request"
> {
  readonly profile: "ProductPublicationPricingConfigurationReferenceMatchesV2";
  readonly request: PricingProductPublicationReferenceRequestV2;
  readonly validUntil: string;
}
export interface ProductPublicationRecordedPricingConfigurationReferenceMatchesV2 extends Omit<
  RecordedPricingConfigurationReferenceMatches,
  "request"
> {
  readonly profile: "ProductPublicationRecordedPricingConfigurationReferenceMatchesV2";
  readonly request: PricingProductPublicationReferenceRequestV2;
  readonly validUntil: string;
}
/** Source matching only. Full context authenticity and publication/schedule coverage remain with their owners. */
export function matchProductPublicationPricingConfigurationReferencesV2(input: {
  readonly request: PricingProductPublicationReferenceRequestV2;
  readonly target: PricingReferenceTarget;
  readonly priceBooks: unknown;
  readonly optionPrices: unknown;
  readonly promotions: unknown;
  readonly now: string;
}): ProductPublicationPricingConfigurationReferenceMatchesV2 {
  try {
    const raw = exact(input, [
        "request",
        "target",
        "priceBooks",
        "optionPrices",
        "promotions",
        "now",
      ]),
      request = parsePricingProductPublicationReferenceRequestV2(raw.request),
      target = parseTarget(raw.target),
      now = parseEffectivePeriodInstant(raw.now),
      priceBooks = parseProductPublicationPriceBookReferenceSourceSnapshotV2(
        raw.priceBooks,
        request,
        now,
      ),
      optionPrices = parseProductPublicationOptionPriceReferenceSourceSnapshotV2(
        raw.optionPrices,
        request,
        now,
      ),
      promotions = parseProductPublicationPromotionReferenceSourceSnapshotV2(
        raw.promotions,
        request,
        now,
      );
    if (target.productReference !== request.productReference) return fail();
    const result = {
      profile: "ProductPublicationPricingConfigurationReferenceMatchesV2" as const,
      request,
      coverage: "CurrentDraftOnly" as const,
      historicalMembershipCoverage: "Unavailable" as const,
      catalogSourceDigest: target.catalogSourceDigest,
      sourceDigests: Object.freeze({
        priceBooks: priceBooks.digest,
        optionPrices: optionPrices.digest,
        promotions: promotions.digest,
      }),
      ...matchConfiguration(target, priceBooks, optionPrices, promotions),
      validUntil: request.validUntil,
    };
    return Object.freeze({ ...result, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(result)) });
  } catch {
    return fail();
  }
}
export function matchProductPublicationRecordedPricingConfigurationReferencesV2(input: {
  readonly request: PricingProductPublicationReferenceRequestV2;
  readonly target: RecordedPricingReferenceTarget;
  readonly priceBooks: unknown;
  readonly optionPrices: unknown;
  readonly promotions: unknown;
  readonly now: string;
}): ProductPublicationRecordedPricingConfigurationReferenceMatchesV2 {
  try {
    const raw = exact(input, [
        "request",
        "target",
        "priceBooks",
        "optionPrices",
        "promotions",
        "now",
      ]),
      request = parsePricingProductPublicationReferenceRequestV2(raw.request),
      now = parseEffectivePeriodInstant(raw.now),
      target = exact(raw.target, [
        "mappingProfile",
        "catalogSourceDigest",
        "productReference",
        "skuReference",
        "configurations",
      ]);
    if (target.productReference !== request.productReference) return fail();
    const matched = matchRecordedConfiguration(
      request,
      target,
      parseProductPublicationPriceBookReferenceSourceSnapshotV2(raw.priceBooks, request, now),
      parseProductPublicationOptionPriceReferenceSourceSnapshotV2(raw.optionPrices, request, now),
      parseProductPublicationPromotionReferenceSourceSnapshotV2(raw.promotions, request, now),
    );
    if (!matched.configurations.some((c) => c.versionReference === request.versionReference))
      return fail();
    const result = {
      profile: "ProductPublicationRecordedPricingConfigurationReferenceMatchesV2" as const,
      request,
      coverage: matched.coverage,
      publicationCoverage: matched.publicationCoverage,
      futureScheduleCoverage: matched.futureScheduleCoverage,
      catalogSourceDigest: matched.catalogSourceDigest,
      sourceDigests: matched.sourceDigests,
      configurations: matched.configurations,
      validUntil: request.validUntil,
    };
    return Object.freeze({ ...result, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(result)) });
  } catch {
    return fail();
  }
}
