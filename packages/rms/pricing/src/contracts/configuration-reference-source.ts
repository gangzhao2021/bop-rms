import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  parsePriceBookReferenceSourceRequest,
  parsePriceBookReferenceSourceSnapshot,
  type PriceBookReferenceSourceRequest,
  type PriceBookReferenceSourceSnapshot,
} from "./price-book-reference-source.js";
import {
  parseOptionPriceReferenceSourceSnapshot,
  type OptionPriceReferenceSourceSnapshot,
} from "./option-price-reference-source.js";
import {
  parsePromotionReferenceSourceSnapshot,
  type PromotionReferenceSourceSnapshot,
} from "./promotion-reference-source.js";
export const configurationReferenceSourceFields = Object.freeze([
  "generation",
  "sourceDigests",
] as const);
export class ConfigurationReferenceSourceError extends Error {
  readonly code = "CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE";
  constructor() {
    super("configuration references are unavailable");
    this.name = "ConfigurationReferenceSourceError";
  }
}
const fail = (): never => {
  throw new ConfigurationReferenceSourceError();
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
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    fields[key] = d.value;
  }
  return fields;
}
export interface ConfigurationReferenceSourceSnapshot {
  readonly profile: "PriceBookOptionPromotionReferencesV1";
  readonly request: PriceBookReferenceSourceRequest;
  readonly coverage: "CompleteStoredReferences";
  readonly taxCoverage: "Unavailable";
  readonly consistency: "StatementSnapshots";
  readonly generation: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly priceBooks: PriceBookReferenceSourceSnapshot;
  readonly optionPrices: OptionPriceReferenceSourceSnapshot;
  readonly promotions: PromotionReferenceSourceSnapshot;
}
/** Closed public facts, never authority, pricing applicability, Tax defaults or lifecycle approval. */
export function buildConfigurationReferenceSourceSnapshot(
  value: unknown,
  input: PriceBookReferenceSourceRequest,
  now: string,
): ConfigurationReferenceSourceSnapshot {
  try {
    const request = parsePriceBookReferenceSourceRequest(input),
      r = exact(value, ["generation", "priceBooks", "optionPrices", "promotions"]);
    if (
      typeof r.generation !== "string" ||
      !/^(0|[1-9][0-9]{0,18})$/.test(r.generation) ||
      BigInt(r.generation) > 9223372036854775807n
    )
      return fail();
    const priceBooks = parsePriceBookReferenceSourceSnapshot(r.priceBooks, request, now),
      optionPrices = parseOptionPriceReferenceSourceSnapshot(r.optionPrices, request, now),
      promotions = parsePromotionReferenceSourceSnapshot(r.promotions, request, now);
    const rows =
      priceBooks.references.length +
      optionPrices.roots.length +
      optionPrices.versions.length +
      promotions.roots.length +
      promotions.versions.length +
      promotions.versions.reduce((n, v) => n + v.eligibility.length, 0);
    if (rows > 10000) return fail();
    const source = {
        profile: "PriceBookOptionPromotionReferencesV1" as const,
        request,
        generation: r.generation,
        priceBooks,
        optionPrices,
        promotions,
      },
      observedAt = [
        priceBooks.observedAt,
        optionPrices.observedAt,
        promotions.observedAt,
      ].sort()[0];
    if (!observedAt) return fail();
    parseEffectivePeriodInstant(observedAt);
    return Object.freeze({
      ...source,
      coverage: "CompleteStoredReferences",
      taxCoverage: "Unavailable",
      consistency: "StatementSnapshots",
      observedAt,
      digest:
        "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            profile: source.profile,
            request,
            generation: source.generation,
            sourceDigests: {
              priceBooks: priceBooks.digest,
              optionPrices: optionPrices.digest,
              promotions: promotions.digest,
            },
          }),
        ),
    });
  } catch {
    return fail();
  }
}
export function parseConfigurationReferenceSourceSnapshot(
  value: unknown,
  input: PriceBookReferenceSourceRequest,
  now: string,
): ConfigurationReferenceSourceSnapshot {
  try {
    const r = exact(value, [
        "profile",
        "request",
        "coverage",
        "taxCoverage",
        "consistency",
        "generation",
        "observedAt",
        "digest",
        "priceBooks",
        "optionPrices",
        "promotions",
      ]),
      parsed = buildConfigurationReferenceSourceSnapshot(
        {
          generation: r.generation,
          priceBooks: r.priceBooks,
          optionPrices: r.optionPrices,
          promotions: r.promotions,
        },
        input,
        now,
      );
    if (
      r.profile !== parsed.profile ||
      r.coverage !== parsed.coverage ||
      r.taxCoverage !== parsed.taxCoverage ||
      r.consistency !== parsed.consistency ||
      r.observedAt !== parsed.observedAt ||
      r.digest !== parsed.digest ||
      canonicalizeRfc8785(parsePriceBookReferenceSourceRequest(r.request)) !==
        canonicalizeRfc8785(parsed.request)
    )
      return fail();
    return parsed;
  } catch {
    return fail();
  }
}
