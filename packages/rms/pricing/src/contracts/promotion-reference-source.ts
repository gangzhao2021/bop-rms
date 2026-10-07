import {
  parsePricingProductPublicationReferenceRequestV2,
  pricingProductPublicationReferenceRequestFieldsV2,
  type PricingProductPublicationReferenceRequestV2,
} from "./product-publication-reference-request-v2.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import { parsePricingReference, parsePricingDigest } from "../domain/money-tax-contract.js";
import {
  parsePriceBookReferenceSourceRequest,
  type PriceBookReferenceSourceRequest,
} from "./price-book-reference-source.js";
export const promotionReferenceSourceMaximumRows = 1000;
export const promotionReferenceSourceFields = Object.freeze([
  "promotionReference",
  "brandReference",
  "aggregateVersion",
  "currentVersionReference",
  "rootCreatedAt",
  "updatedAt",
  "versionReference",
  "versionNumber",
  "snapshotDigest",
  "lifecycle",
  "promotionType",
  "benefitScope",
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
  "createdAt",
  "eligibilityReference",
  "referenceKind",
  "publicReference",
] as const);
export class PromotionReferenceSourceError extends Error {
  readonly code = "PROMOTION_REFERENCE_SOURCE_UNAVAILABLE";
  constructor() {
    super("promotion references are unavailable");
    this.name = "PromotionReferenceSourceError";
  }
}
const fail = (): never => {
  throw new PromotionReferenceSourceError();
};
function copy(value: unknown): unknown {
  let budget = 100000;
  const run = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 8) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v.length > 256) return fail();
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return fail();
      return v;
    }
    if (!v || typeof v !== "object") return fail();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > promotionReferenceSourceMaximumRows ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      return Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d?.enumerable || !("value" in d)) return fail();
        return run(d.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 32)
      return fail();
    return Object.fromEntries(
      Reflect.ownKeys(v).map((k) => {
        if (typeof k !== "string") return fail();
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d?.enumerable || !("value" in d)) return fail();
        return [k, run(d.value, depth + 1)];
      }),
    );
  };
  return run(value, 0);
}
function exact(v: unknown, keys: readonly string[]) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Reflect.ownKeys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    return fail();
  return v as Record<string, unknown>;
}

const rootFields = [
  "promotionReference",
  "brandReference",
  "aggregateVersion",
  "currentVersionReference",
  "rootCreatedAt",
  "updatedAt",
] as const;
const versionFields = [
  "versionReference",
  "versionNumber",
  "snapshotDigest",
  "lifecycle",
  "promotionType",
  "benefitScope",
  "timeZone",
  "effectiveFrom",
  "effectiveUntil",
  "createdAt",
  "eligibility",
] as const;
const types = [
  "ItemPercentage",
  "ItemFixed",
  "OrderPercentage",
  "OrderFixed",
  "Threshold",
  "BuyXGetY",
  "HappyHour",
  "Coupon",
  "ManualDiscount",
] as const;
export interface PromotionRootReference {
  readonly promotionReference: string;
  readonly brandReference: string;
  readonly aggregateVersion: number;
  readonly currentVersionReference: string | null;
  readonly rootCreatedAt: string;
  readonly updatedAt: string;
}
export interface PromotionEligibilityReference {
  readonly eligibilityReference: string;
  readonly referenceKind: "Sellable" | "Category" | "Segment";
  readonly publicReference: string;
}
export interface PromotionVersionReference {
  readonly promotionReference: string;
  readonly versionReference: string;
  readonly versionNumber: number;
  readonly snapshotDigest: string;
  readonly lifecycle: "Draft" | "Published" | "Paused" | "Archived";
  readonly promotionType: (typeof types)[number];
  readonly benefitScope: "Item" | "Order";
  readonly timeZone: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly createdAt: string;
  readonly eligibility: readonly PromotionEligibilityReference[];
  readonly catalogReferenceMode: "OrderSubtotal" | "AllSellables" | "ExplicitSellableOrCategory";
  readonly isCurrentVersion: boolean;
  readonly temporalStatus: "Future" | "Effective" | "Expired";
}
export interface PromotionReferenceSourceSnapshot {
  readonly request: PriceBookReferenceSourceRequest;
  readonly profile: "PromotionEligibility";
  readonly coverage: "Complete";
  readonly consistency: "StatementSnapshot";
  readonly observedAt: string;
  readonly digest: string;
  readonly roots: readonly PromotionRootReference[];
  readonly versions: readonly PromotionVersionReference[];
}
const positive = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) return fail();
  return v as number;
};
const optional = (v: unknown) => (v === null ? null : parsePricingReference(v));
/** Own complete qualifier history; mode describes source targeting, never actual eligibility or foreign membership. */
function parsePromotionReferenceGraph(value: unknown, expectedBrandReference: string, now: string) {
  try {
    const raw = exact(copy(value), ["observedAt", "references"]),
      observedAt = parseEffectivePeriodInstant(raw.observedAt),
      at = parseEffectivePeriodInstant(now);
    if (
      !Array.isArray(raw.references) ||
      observedAt > at ||
      Date.parse(at) - Date.parse(observedAt) > 5000
    )
      return fail();
    const roots = new Map<string, PromotionRootReference>(),
      versions = new Map<string, PromotionVersionReference>(),
      numbers = new Set<string>(),
      noVersion = new Set<string>(),
      eligibilityIds = new Set<string>();
    for (const rowValue of raw.references) {
      const row = exact(rowValue, ["root", "version", "precise"]);
      if (row.precise !== true) return fail();
      const r = exact(row.root, rootFields),
        root: PromotionRootReference = Object.freeze({
          promotionReference: parsePricingReference(r.promotionReference),
          brandReference: parsePricingReference(r.brandReference),
          aggregateVersion: positive(r.aggregateVersion),
          currentVersionReference: optional(r.currentVersionReference),
          rootCreatedAt: parseEffectivePeriodInstant(r.rootCreatedAt),
          updatedAt: parseEffectivePeriodInstant(r.updatedAt),
        });
      if (
        root.brandReference !== expectedBrandReference ||
        root.rootCreatedAt > root.updatedAt ||
        root.updatedAt > observedAt
      )
        return fail();
      const prior = roots.get(root.promotionReference);
      if (prior && canonicalizeRfc8785(prior) !== canonicalizeRfc8785(root)) return fail();
      roots.set(root.promotionReference, root);
      if (row.version === null) {
        if (prior || root.currentVersionReference !== null) return fail();
        noVersion.add(root.promotionReference);
        continue;
      }
      if (noVersion.has(root.promotionReference)) return fail();
      const v = exact(row.version, versionFields),
        versionReference = parsePricingReference(v.versionReference),
        versionNumber = positive(v.versionNumber),
        createdAt = parseEffectivePeriodInstant(v.createdAt),
        effectiveFrom = parseEffectivePeriodInstant(v.effectiveFrom),
        effectiveUntil =
          v.effectiveUntil === null ? null : parseEffectivePeriodInstant(v.effectiveUntil);
      if (
        versions.has(versionReference) ||
        numbers.has(root.promotionReference + ":" + versionNumber) ||
        versionNumber > root.aggregateVersion ||
        createdAt < root.rootCreatedAt ||
        createdAt > root.updatedAt ||
        !["Draft", "Published", "Paused", "Archived"].includes(v.lifecycle as string) ||
        !types.includes(v.promotionType as (typeof types)[number]) ||
        !["Item", "Order"].includes(v.benefitScope as string) ||
        typeof v.timeZone !== "string" ||
        v.timeZone.length < 1 ||
        v.timeZone.length > 100 ||
        (effectiveUntil !== null && effectiveUntil <= effectiveFrom) ||
        !Array.isArray(v.eligibility)
      )
        return fail();
      const zone = new Intl.DateTimeFormat("en-CA", { timeZone: v.timeZone }).resolvedOptions()
        .timeZone;
      if (zone.startsWith("+") || zone.startsWith("-")) return fail();
      const tuples = new Set<string>();
      let segments = 0;
      const eligibility = v.eligibility
        .map((value) => {
          const e = exact(value, ["eligibilityReference", "referenceKind", "publicReference"]),
            eligibilityReference = parsePricingReference(e.eligibilityReference),
            publicReference = parsePricingReference(e.publicReference);
          if (
            !["Sellable", "Category", "Segment"].includes(e.referenceKind as string) ||
            eligibilityIds.has(eligibilityReference) ||
            tuples.has(e.referenceKind + ":" + publicReference)
          )
            return fail();
          if (e.referenceKind === "Segment" && ++segments > 1) return fail();
          eligibilityIds.add(eligibilityReference);
          tuples.add(e.referenceKind + ":" + publicReference);
          return Object.freeze({
            eligibilityReference,
            referenceKind: e.referenceKind as PromotionEligibilityReference["referenceKind"],
            publicReference,
          });
        })
        .sort((a, b) => a.eligibilityReference.localeCompare(b.eligibilityReference));
      numbers.add(root.promotionReference + ":" + versionNumber);
      versions.set(
        versionReference,
        Object.freeze({
          promotionReference: root.promotionReference,
          versionReference,
          versionNumber,
          snapshotDigest: parsePricingDigest(v.snapshotDigest),
          lifecycle: v.lifecycle as PromotionVersionReference["lifecycle"],
          promotionType: v.promotionType as (typeof types)[number],
          benefitScope: v.benefitScope as "Item" | "Order",
          timeZone: v.timeZone,
          effectiveFrom,
          effectiveUntil,
          createdAt,
          eligibility: Object.freeze(eligibility),
          catalogReferenceMode:
            v.benefitScope === "Order"
              ? "OrderSubtotal"
              : eligibility.some((e) => e.referenceKind !== "Segment")
                ? "ExplicitSellableOrCategory"
                : "AllSellables",
          isCurrentVersion: root.currentVersionReference === versionReference,
          temporalStatus:
            effectiveFrom > observedAt
              ? "Future"
              : effectiveUntil !== null && effectiveUntil <= observedAt
                ? "Expired"
                : "Effective",
        }),
      );
    }
    for (const r of roots.values())
      if (
        r.currentVersionReference !== null &&
        versions.get(r.currentVersionReference)?.promotionReference !== r.promotionReference
      )
        return fail();
    return Object.freeze({
      observedAt,
      roots: Object.freeze(
        [...roots.values()].sort((a, b) =>
          a.promotionReference.localeCompare(b.promotionReference),
        ),
      ),
      versions: Object.freeze(
        [...versions.values()].sort((a, b) => a.versionReference.localeCompare(b.versionReference)),
      ),
    });
  } catch {
    return fail();
  }
}
export function buildPromotionReferenceSourceSnapshot(
  value: unknown,
  input: PriceBookReferenceSourceRequest,
  now: string,
): PromotionReferenceSourceSnapshot {
  try {
    const request = parsePriceBookReferenceSourceRequest(input),
      { observedAt, roots, versions } = parsePromotionReferenceGraph(
        value,
        request.brandReference,
        now,
      );
    const source = { request, profile: "PromotionEligibility" as const, roots, versions };
    return Object.freeze({
      ...source,
      coverage: "Complete",
      consistency: "StatementSnapshot",
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(source)),
    });
  } catch {
    return fail();
  }
}

/** Validate public roots/history and all computed fields against exact original opaque intent. */
export function parsePromotionReferenceSourceSnapshot(
  value: unknown,
  input: PriceBookReferenceSourceRequest,
  now: string,
): PromotionReferenceSourceSnapshot {
  try {
    const raw = exact(copy(value), [
      "request",
      "profile",
      "coverage",
      "consistency",
      "observedAt",
      "digest",
      "roots",
      "versions",
    ]);
    if (!Array.isArray(raw.roots) || !Array.isArray(raw.versions)) return fail();
    const roots = raw.roots.map((v) => exact(v, rootFields)),
      versions = raw.versions.map((v) =>
        exact(v, [
          "promotionReference",
          ...versionFields,
          "catalogReferenceMode",
          "isCurrentVersion",
          "temporalStatus",
        ]),
      );
    if (versions.some((v) => !roots.some((r) => r.promotionReference === v.promotionReference)))
      return fail();
    const references = roots.flatMap<unknown>((root) => {
      const owned = versions.filter((v) => v.promotionReference === root.promotionReference);
      return owned.length
        ? owned.map((v) => ({
            root,
            version: Object.fromEntries(versionFields.map((k) => [k, v[k]])),
            precise: true,
          }))
        : [{ root, version: null, precise: true }];
    });
    const parsed = buildPromotionReferenceSourceSnapshot(
      { observedAt: raw.observedAt, references },
      input,
      now,
    );
    if (canonicalizeRfc8785(parsed) !== canonicalizeRfc8785(raw)) return fail();
    return parsed;
  } catch {
    return fail();
  }
}

export const productPublicationPromotionReferenceSourceFieldsV2 = Object.freeze([
  ...new Set([
    ...promotionReferenceSourceFields,
    ...pricingProductPublicationReferenceRequestFieldsV2,
  ]),
] as const);
export interface ProductPublicationPromotionReferenceSourceSnapshotV2 extends Omit<
  PromotionReferenceSourceSnapshot,
  "request" | "profile"
> {
  readonly request: PricingProductPublicationReferenceRequestV2;
  readonly profile: "ProductPublicationPromotionEligibilityV2";
  readonly validUntil: string;
}
/** Complete stored graph only; neither sale eligibility nor publication approval. */
export function buildProductPublicationPromotionReferenceSourceSnapshotV2(
  value: unknown,
  input: PricingProductPublicationReferenceRequestV2,
  now: string,
): ProductPublicationPromotionReferenceSourceSnapshotV2 {
  try {
    const request = parsePricingProductPublicationReferenceRequestV2(input),
      graph = parsePromotionReferenceGraph(value, request.brandReference, now),
      at = parseEffectivePeriodInstant(now);
    if (graph.observedAt < request.observedAt || at >= request.validUntil) return fail();
    const source = {
      request,
      profile: "ProductPublicationPromotionEligibilityV2" as const,
      ...graph,
      coverage: "Complete" as const,
      consistency: "StatementSnapshot" as const,
      validUntil: request.validUntil,
    };
    return Object.freeze({ ...source, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(source)) });
  } catch {
    return fail();
  }
}
export function parseProductPublicationPromotionReferenceSourceSnapshotV2(
  value: unknown,
  input: PricingProductPublicationReferenceRequestV2,
  now: string,
): ProductPublicationPromotionReferenceSourceSnapshotV2 {
  try {
    const raw = exact(copy(value), [
      "request",
      "profile",
      "coverage",
      "consistency",
      "observedAt",
      "digest",
      "validUntil",
      "roots",
      "versions",
    ]);
    if (!Array.isArray(raw.roots) || !Array.isArray(raw.versions)) return fail();
    const roots = raw.roots.map((v) => exact(v, rootFields)),
      versions = raw.versions.map((v) =>
        exact(v, [
          "promotionReference",
          ...versionFields,
          "catalogReferenceMode",
          "isCurrentVersion",
          "temporalStatus",
        ]),
      );
    if (versions.some((v) => !roots.some((r) => r.promotionReference === v.promotionReference)))
      return fail();
    const references = roots.flatMap<unknown>((root) => {
      const owned = versions.filter((v) => v.promotionReference === root.promotionReference);
      return owned.length
        ? owned.map((v) => ({
            root,
            version: Object.fromEntries(versionFields.map((k) => [k, v[k]])),
            precise: true,
          }))
        : [{ root, version: null, precise: true }];
    });
    const parsed = buildProductPublicationPromotionReferenceSourceSnapshotV2(
      { observedAt: raw.observedAt, references },
      input,
      now,
    );
    if (canonicalizeRfc8785(parsed) !== canonicalizeRfc8785(raw)) return fail();
    return parsed;
  } catch {
    return fail();
  }
}
