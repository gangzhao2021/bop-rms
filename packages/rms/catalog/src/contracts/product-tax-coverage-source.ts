import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "./product.js";
import { parseProductLifecycle, type ProductLifecycle } from "../domain/product.js";
import {
  parseCatalogProductRetirementCoverage,
  type CatalogProductRetirementCoverage,
} from "./product-publication-source-v2.js";
export const productTaxCoverageSourceMaximumRoots = 1000;
export const productTaxCoverageSourceMaximumBytes = 2097152;
export const productTaxCoverageSourceFields = Object.freeze([
  "productReference",
  "aggregateVersion",
  "productLifecycle",
  "draft.versionReference",
  "draft.taxClassificationReference",
  "draft.skus.skuReference",
  "draft.skus.lifecycle",
  "publicationContent",
  "publicationHistory",
  "scopeRetirements",
] as const);
export type ProductTaxCoverageBasis = "SavedDraftPreparation" | "RecordedPublishedGraphInputs";
export interface ProductTaxCoverageClassification {
  readonly versionReference: string;
  readonly sourceDigest: string;
  readonly taxClassificationReference: string | null;
  readonly skus: readonly Readonly<{ skuReference: string; lifecycle: ProductLifecycle }>[];
}
export interface ProductTaxCoverageEntry {
  readonly productReference: string;
  readonly aggregateVersion: number;
  readonly productLifecycle: ProductLifecycle;
  readonly draft: ProductTaxCoverageClassification | null;
  readonly published: readonly ProductTaxCoverageClassification[];
  readonly publicationCoverage: CatalogProductRetirementCoverage | null;
}
export interface ProductTaxCoverageSource {
  readonly profile: "ProductTaxCoverageSourceV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly entries: readonly ProductTaxCoverageEntry[];
  readonly sourceDigest: string;
  readonly completeness: "CompleteRecordedInputs" | "Incomplete";
  readonly missingClassifications: readonly Readonly<{
    productReference: string;
    versionReference: string;
    basis: ProductTaxCoverageBasis;
  }>[];
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
  readonly sellability: "NotEvaluated";
}
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function detachedCoverage(value: unknown): unknown {
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 24) return invalid();
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      return v;
    if (!v || typeof v !== "object") return invalid();
    const keys = Reflect.ownKeys(v),
      descriptors = Object.getOwnPropertyDescriptors(v);
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 10000 ||
        keys.length !== v.length + 1
      )
        return invalid();
      return Object.freeze(
        Array.from({ length: v.length }, (_, i) => {
          const d = descriptors[String(i)];
          if (!d?.enumerable || !("value" in d)) return invalid();
          return visit(d.value, depth + 1);
        }),
      );
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) return invalid();
    return Object.freeze(
      Object.fromEntries(
        keys.map((k) => {
          const d = typeof k === "string" ? descriptors[k] : undefined;
          if (!d?.enumerable || !("value" in d)) return invalid();
          return [k, visit(d.value, depth + 1)];
        }),
      ),
    );
  };
  return visit(value, 0);
}
function closed(v: unknown, keys: readonly string[]) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    return invalid();
  return v as Record<string, unknown>;
}
function array(v: unknown, max = productTaxCoverageSourceMaximumRoots): readonly unknown[] {
  return Array.isArray(v) && v.length <= max ? v : invalid();
}
function hash(v: unknown): string {
  return typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v) ? v : invalid();
}
function classification(value: unknown): ProductTaxCoverageClassification {
  const r = closed(value, [
      "versionReference",
      "sourceDigest",
      "taxClassificationReference",
      "skus",
    ]),
    seen = new Set<string>();
  const skus = Object.freeze(
    array(r.skus, 10000).map((v) => {
      const s = closed(v, ["skuReference", "lifecycle"]),
        skuReference = parseCatalogReference(s.skuReference);
      if (seen.has(skuReference)) return invalid();
      seen.add(skuReference);
      return Object.freeze({ skuReference, lifecycle: parseProductLifecycle(s.lifecycle) });
    }),
  );
  return Object.freeze({
    versionReference: parseCatalogReference(r.versionReference),
    sourceDigest: hash(r.sourceDigest),
    taxClassificationReference:
      r.taxClassificationReference === null
        ? null
        : parseCatalogReference(r.taxClassificationReference),
    skus,
  });
}
function parseSource(value: unknown, build: boolean): ProductTaxCoverageSource {
  try {
    const detached = detachedCoverage(value);
    if (
      new TextEncoder().encode(canonicalizeRfc8785(detached)).length >
      productTaxCoverageSourceMaximumBytes
    )
      return invalid();
    const r = closed(detached, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "entries",
      ...(build ? [] : ["sourceDigest"]),
      "completeness",
      "missingClassifications",
      "observedAt",
      "validUntil",
      "sourceQualification",
      "sellability",
    ]);
    if (
      r.profile !== "ProductTaxCoverageSourceV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      r.sellability !== "NotEvaluated"
    )
      return invalid();
    const tenantReference = parseCatalogReference(r.tenantReference),
      brandReference = parseCatalogReference(r.brandReference),
      storeReference = parseCatalogReference(r.storeReference),
      actorReference = parseCatalogReference(r.actorReference);
    const observedAt = String(parseCatalogInstant(r.observedAt)),
      validUntil = String(parseCatalogInstant(r.validUntil));
    if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
      return invalid();
    let previous = "";
    const entries = Object.freeze(
      array(r.entries).map((value) => {
        const e = closed(value, [
            "productReference",
            "aggregateVersion",
            "productLifecycle",
            "draft",
            "published",
            "publicationCoverage",
          ]),
          productReference = parseCatalogReference(e.productReference);
        if (
          productReference <= previous ||
          typeof e.aggregateVersion !== "number" ||
          !Number.isInteger(e.aggregateVersion) ||
          e.aggregateVersion < 1 ||
          e.aggregateVersion > 2147483647
        )
          return invalid();
        previous = productReference;
        const draft = e.draft === null ? null : classification(e.draft),
          published = Object.freeze(array(e.published).map(classification)),
          coverage =
            e.publicationCoverage === null
              ? null
              : parseCatalogProductRetirementCoverage(e.publicationCoverage);
        if (
          coverage &&
          (coverage.tenantReference !== tenantReference ||
            coverage.brandReference !== brandReference ||
            coverage.productReference !== productReference ||
            coverage.aggregateVersion !== e.aggregateVersion ||
            coverage.observedAt > observedAt)
        )
          return invalid();
        const versions = new Set<string>();
        for (const p of published) {
          if (
            !coverage ||
            versions.has(p.versionReference) ||
            !coverage.history.some(
              (h) =>
                (h.publication.state === "Published" || h.publication.state === "Superseded") &&
                h.publication.versionReference === p.versionReference &&
                h.publication.contentDigest === p.sourceDigest,
            )
          )
            return invalid();
          versions.add(p.versionReference);
        }
        if (
          coverage?.history.some(
            (h) =>
              (h.publication.state === "Published" || h.publication.state === "Superseded") &&
              !versions.has(h.publication.versionReference),
          )
        )
          return invalid();
        return Object.freeze({
          productReference,
          aggregateVersion: e.aggregateVersion,
          productLifecycle: parseProductLifecycle(e.productLifecycle),
          draft,
          published,
          publicationCoverage: coverage,
        });
      }),
    );
    const missingClassifications = Object.freeze(
      entries.flatMap((e) => [
        ...(e.draft && e.draft.taxClassificationReference === null
          ? [
              Object.freeze({
                productReference: e.productReference,
                versionReference: e.draft.versionReference,
                basis: "SavedDraftPreparation" as const,
              }),
            ]
          : []),
        ...e.published
          .filter((p) => p.taxClassificationReference === null)
          .map((p) =>
            Object.freeze({
              productReference: e.productReference,
              versionReference: p.versionReference,
              basis: "RecordedPublishedGraphInputs" as const,
            }),
          ),
      ]),
    );
    const completeness = missingClassifications.length ? "Incomplete" : "CompleteRecordedInputs";
    if (
      r.completeness !== completeness ||
      canonicalizeRfc8785(r.missingClassifications) !== canonicalizeRfc8785(missingClassifications)
    )
      return invalid();
    const sourceDigest =
      "sha256:" +
      sha256Hex(
        canonicalizeRfc8785({
          tenantReference,
          brandReference,
          storeReference,
          entries: entries.map((entry) => {
            if (!entry.publicationCoverage) return entry;
            const {
              observedAt: observation,
              digest: observationDigest,
              ...coverage
            } = entry.publicationCoverage;
            void observation;
            void observationDigest;
            return { ...entry, publicationCoverage: coverage };
          }),
          completeness,
          missingClassifications,
        }),
      );
    if (!build && hash(r.sourceDigest) !== sourceDigest) return invalid();
    const result: ProductTaxCoverageSource = Object.freeze({
      profile: "ProductTaxCoverageSourceV1",
      tenantReference,
      brandReference,
      storeReference,
      actorReference,
      entries,
      sourceDigest,
      completeness,
      missingClassifications,
      observedAt,
      validUntil,
      sourceQualification: "NotEvaluated",
      sellability: "NotEvaluated",
    });
    if (
      new TextEncoder().encode(canonicalizeRfc8785(result)).length >
      productTaxCoverageSourceMaximumBytes
    )
      return invalid();
    return result;
  } catch {
    return invalid();
  }
}
export function parseProductTaxCoverageSource(value: unknown): ProductTaxCoverageSource {
  return parseSource(value, false);
}
/** Structural content builder, not an actual held-source or qualification proof. */
export function buildProductTaxCoverageSource(value: unknown): ProductTaxCoverageSource {
  return parseSource(value, true);
}
export const productTaxCoverageSourceDigest = (value: unknown) =>
  parseProductTaxCoverageSource(value).sourceDigest;
