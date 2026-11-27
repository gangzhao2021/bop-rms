import {
  parseCatalogProductWarningAcknowledgementReferenceRequest,
  productWarningAcknowledgementReferenceRequestFields,
  type CatalogProductWarningAcknowledgementReferenceRequest,
} from "./product-warning-acknowledgement-reference-request.js";
import {
  parseCatalogProductPublicationReferenceRequestV2,
  type CatalogProductPublicationReferenceRequestV2,
} from "./product-publication-reference-request-v2.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogHash,
} from "./product.js";
export const bundleReferenceSourceMaximumRows = 10000;
export const bundleReferenceSourceFields = Object.freeze([
  "generation",
  "bundleReference",
  "brandReference",
  "aggregateVersion",
  "lifecycle",
  "currentVersionReference",
  "updatedAt",
  "bundleVersionReference",
  "versionStatus",
  "versionUpdatedAt",
  "publishedAt",
  "validationDigest",
  "groupReference",
  "sellableType",
  "sellableReference",
] as const);
export interface BundleReferenceSourceRequest {
  readonly purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ";
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly catalogIntentDigest: string;
}
export interface BundleRootReference {
  readonly bundleReference: string;
  readonly brandReference: string;
  readonly aggregateVersion: number;
  readonly lifecycle: "Draft" | "Published" | "Suspended" | "Discontinued" | "Archived";
  readonly currentVersionReference: string;
  readonly updatedAt: string;
}
export interface BundleVersionReference {
  readonly bundleVersionReference: string;
  readonly bundleReference: string;
  readonly brandReference: string;
  readonly versionStatus: "Draft" | "Published";
  readonly versionUpdatedAt: string;
  readonly publishedAt: string | null;
  readonly validationDigest: string | null;
}
export interface BundleGroupReference {
  readonly groupReference: string;
  readonly bundleVersionReference: string;
  readonly bundleReference: string;
  readonly brandReference: string;
}
export interface BundleMemberReference extends BundleGroupReference {
  readonly sellableType: "Product" | "Sku";
  readonly sellableReference: string;
}
export interface BundleReferenceSourceSnapshot {
  readonly request: BundleReferenceSourceRequest;
  readonly profile: "BrandBundleStoredReferencesV1";
  readonly coverage: "CompleteStoredReferences";
  readonly consistency: "StatementSnapshot";
  readonly applicability: "Unavailable";
  readonly generation: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly bundles: readonly BundleRootReference[];
  readonly versions: readonly BundleVersionReference[];
  readonly groups: readonly BundleGroupReference[];
  readonly members: readonly BundleMemberReference[];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function array(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > bundleReferenceSourceMaximumRows ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
const hash = (value: unknown) =>
  typeof value === "string" && value.startsWith("sha256:")
    ? "sha256:" + parseCatalogHash(value.slice(7))
    : fail();
export function parseBundleReferenceSourceRequest(value: unknown): BundleReferenceSourceRequest {
  try {
    const r = exact(value, [
      "purposeCode",
      "brandReference",
      "actorReference",
      "operationReference",
      "catalogIntentDigest",
    ]);
    if (r.purposeCode !== "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ") return fail();
    return Object.freeze({
      purposeCode: r.purposeCode,
      brandReference: parseCatalogReference(r.brandReference),
      actorReference: parseCatalogReference(r.actorReference),
      operationReference: parseCatalogReference(r.operationReference),
      catalogIntentDigest: hash(r.catalogIntentDigest),
    });
  } catch {
    return fail();
  }
}
const rootFields = [
  "bundleReference",
  "brandReference",
  "aggregateVersion",
  "lifecycle",
  "currentVersionReference",
  "updatedAt",
] as const;
const versionFields = [
  "bundleVersionReference",
  "bundleReference",
  "brandReference",
  "versionStatus",
  "versionUpdatedAt",
  "publishedAt",
  "validationDigest",
] as const;
const groupFields = [
  "groupReference",
  "bundleVersionReference",
  "bundleReference",
  "brandReference",
] as const;
const memberFields = [...groupFields, "sellableType", "sellableReference"] as const;
/** Complete owning stored graph, including empty roots and all historical versions.
 * Validation of IDs/status/pointers never supplies current authority or sale approval. */
function parseBundleStoredGraph(value: unknown, brandReference: string, now: string) {
  try {
    const r = exact(value, [
        "generation",
        "counts",
        "observedAt",
        "bundles",
        "versions",
        "groups",
        "members",
      ]),
      counts = exact(r.counts, ["bundles", "versions", "groups", "members"]),
      observedAt = parseCatalogInstant(r.observedAt),
      at = Date.parse(parseCatalogInstant(now));
    const raw = {
      bundles: array(r.bundles),
      versions: array(r.versions),
      groups: array(r.groups),
      members: array(r.members),
    };
    const total = Object.values(raw).reduce((sum, items) => sum + items.length, 0);
    if (
      total > bundleReferenceSourceMaximumRows ||
      at < Date.parse(observedAt) ||
      at - Date.parse(observedAt) > 5000 ||
      Object.entries(raw).some(([key, items]) => counts[key] !== String(items.length))
    )
      return fail();
    const generation = r.generation === null && total === 0 ? "0" : r.generation;
    if (
      typeof generation !== "string" ||
      generation.length > 19 ||
      !/^(0|[1-9][0-9]*)$/.test(generation) ||
      BigInt(generation) > 9223372036854775807n
    )
      return fail();
    const roots = new Map<string, BundleRootReference>(),
      versionMap = new Map<string, BundleVersionReference>(),
      groupMap = new Map<string, BundleGroupReference>(),
      memberIds = new Set<string>();
    const brand = (v: unknown) => {
      const id = parseCatalogReference(v);
      if (id !== brandReference) return fail();
      return id;
    };
    const bundles = raw.bundles
      .map((value) => {
        const v = exact(value, [...rootFields, "precise"]),
          bundleReference = parseCatalogReference(v.bundleReference),
          updatedAt = parseCatalogInstant(v.updatedAt);
        if (
          roots.has(bundleReference) ||
          v.precise !== true ||
          updatedAt > observedAt ||
          !Number.isSafeInteger(v.aggregateVersion) ||
          (v.aggregateVersion as number) < 1 ||
          (v.aggregateVersion as number) > 2147483647 ||
          (v.lifecycle !== "Draft" &&
            v.lifecycle !== "Published" &&
            v.lifecycle !== "Suspended" &&
            v.lifecycle !== "Discontinued" &&
            v.lifecycle !== "Archived")
        )
          return fail();
        const root = Object.freeze({
          bundleReference,
          brandReference: brand(v.brandReference),
          aggregateVersion: v.aggregateVersion as number,
          lifecycle: v.lifecycle,
          currentVersionReference: parseCatalogReference(v.currentVersionReference),
          updatedAt,
        });
        roots.set(bundleReference, root);
        return root;
      })
      .sort((a, b) => a.bundleReference.localeCompare(b.bundleReference));
    const versions = raw.versions
      .map((value) => {
        const v = exact(value, [...versionFields, "precise"]),
          bundleVersionReference = parseCatalogReference(v.bundleVersionReference),
          bundleReference = parseCatalogReference(v.bundleReference),
          versionUpdatedAt = parseCatalogInstant(v.versionUpdatedAt),
          publishedAt = v.publishedAt === null ? null : parseCatalogInstant(v.publishedAt),
          validationDigest = v.validationDigest === null ? null : hash(v.validationDigest);
        if (
          versionMap.has(bundleVersionReference) ||
          !roots.has(bundleReference) ||
          v.precise !== true ||
          versionUpdatedAt > observedAt ||
          (publishedAt !== null && publishedAt > observedAt) ||
          (v.versionStatus !== "Draft" && v.versionStatus !== "Published") ||
          (v.versionStatus === "Draft"
            ? publishedAt !== null || validationDigest !== null
            : publishedAt === null || validationDigest === null)
        )
          return fail();
        const version = Object.freeze({
          bundleVersionReference,
          bundleReference,
          brandReference: brand(v.brandReference),
          versionStatus: v.versionStatus,
          versionUpdatedAt,
          publishedAt,
          validationDigest,
        });
        versionMap.set(bundleVersionReference, version);
        return version;
      })
      .sort((a, b) => a.bundleVersionReference.localeCompare(b.bundleVersionReference));
    for (const bundle of bundles) {
      const version = versionMap.get(bundle.currentVersionReference);
      if (
        !version ||
        version.bundleReference !== bundle.bundleReference ||
        (bundle.lifecycle !== "Draft" &&
          bundle.lifecycle !== "Archived" &&
          version.versionStatus !== "Published")
      )
        return fail();
    }
    const parseGroup = (v: Record<string, unknown>) => {
      const bundleVersionReference = parseCatalogReference(v.bundleVersionReference),
        bundleReference = parseCatalogReference(v.bundleReference),
        version = versionMap.get(bundleVersionReference);
      if (!version || version.bundleReference !== bundleReference) return fail();
      return {
        groupReference: parseCatalogReference(v.groupReference),
        bundleVersionReference,
        bundleReference,
        brandReference: brand(v.brandReference),
      };
    };
    const groups = raw.groups
      .map((value) => {
        const group = Object.freeze(parseGroup(exact(value, groupFields)));
        if (groupMap.has(group.groupReference)) return fail();
        groupMap.set(group.groupReference, group);
        return group;
      })
      .sort((a, b) => a.groupReference.localeCompare(b.groupReference));
    const members = raw.members
      .map((value) => {
        const v = exact(value, memberFields),
          group = parseGroup(v),
          parent = groupMap.get(group.groupReference),
          sellableReference = parseCatalogReference(v.sellableReference),
          key = group.groupReference + ":" + sellableReference;
        if (
          !parent ||
          canonicalizeRfc8785(group) !== canonicalizeRfc8785(parent) ||
          memberIds.has(key) ||
          (v.sellableType !== "Product" && v.sellableType !== "Sku")
        )
          return fail();
        memberIds.add(key);
        return Object.freeze({ ...group, sellableType: v.sellableType, sellableReference });
      })
      .sort(
        (a, b) =>
          a.groupReference.localeCompare(b.groupReference) ||
          a.sellableReference.localeCompare(b.sellableReference),
      );
    const body = {
      generation,
      bundles: Object.freeze(bundles),
      versions: Object.freeze(versions),
      groups: Object.freeze(groups),
      members: Object.freeze(members),
    };
    return Object.freeze({
      ...body,
      observedAt,
    });
  } catch {
    return fail();
  }
}
export function buildBundleReferenceSourceSnapshot(
  value: unknown,
  input: BundleReferenceSourceRequest,
  now: string,
): BundleReferenceSourceSnapshot {
  const request = parseBundleReferenceSourceRequest(input),
    { observedAt, ...graph } = parseBundleStoredGraph(value, request.brandReference, now),
    body = { request, ...graph };
  return Object.freeze({
    ...body,
    profile: "BrandBundleStoredReferencesV1",
    coverage: "CompleteStoredReferences",
    consistency: "StatementSnapshot",
    applicability: "Unavailable",
    observedAt,
    digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
  });
}
export function parseBundleReferenceSourceSnapshot(
  value: unknown,
  input: BundleReferenceSourceRequest,
  now: string,
): BundleReferenceSourceSnapshot {
  try {
    const r = exact(value, [
        "request",
        "generation",
        "bundles",
        "versions",
        "groups",
        "members",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "observedAt",
        "digest",
      ]),
      request = parseBundleReferenceSourceRequest(r.request),
      expected = parseBundleReferenceSourceRequest(input);
    if (
      canonicalizeRfc8785(request) !== canonicalizeRfc8785(expected) ||
      typeof r.generation !== "string" ||
      r.profile !== "BrandBundleStoredReferencesV1" ||
      r.coverage !== "CompleteStoredReferences" ||
      r.consistency !== "StatementSnapshot" ||
      r.applicability !== "Unavailable"
    )
      return fail();
    const bundles = array(r.bundles).map((v) => ({ ...exact(v, rootFields), precise: true })),
      versions = array(r.versions).map((v) => ({ ...exact(v, versionFields), precise: true })),
      groups = array(r.groups).map((v) => exact(v, groupFields)),
      members = array(r.members).map((v) => exact(v, memberFields));
    const result = buildBundleReferenceSourceSnapshot(
      {
        generation: r.generation,
        observedAt: r.observedAt,
        counts: {
          bundles: String(bundles.length),
          versions: String(versions.length),
          groups: String(groups.length),
          members: String(members.length),
        },
        bundles,
        versions,
        groups,
        members,
      },
      expected,
      now,
    );
    if (result.digest !== hash(r.digest)) return fail();
    return result;
  } catch {
    return fail();
  }
}

export const productPublicationBundleReferenceSourceFieldsV2 = Object.freeze([
  ...bundleReferenceSourceFields,
  "command",
  "originalIntentDigest",
  "replacementIntentDigest",
  "aggregateSnapshotDigest",
  "currentPublicationDigest",
  "observedAt",
  "validUntil",
] as const);
/** The fixed publication entry shares only the stored graph parser with V1.
 * The complete request and original lease are hashed; no lifecycle request,
 * current sale eligibility, or publication approval is manufactured. */
export function buildProductPublicationBundleReferenceSourceSnapshotV2(
  value: unknown,
  input: CatalogProductPublicationReferenceRequestV2,
  now: string,
) {
  try {
    const request = parseCatalogProductPublicationReferenceRequestV2(input),
      graph = parseBundleStoredGraph(value, request.command.brandReference, now),
      at = parseCatalogInstant(now);
    if (
      graph.observedAt < request.observedAt ||
      graph.observedAt >= request.validUntil ||
      at >= request.validUntil
    )
      return fail();
    const body = Object.freeze({
      request,
      profile: "BrandBundlePublicationReferencesV2" as const,
      coverage: "CompleteStoredReferences" as const,
      consistency: "StatementSnapshot" as const,
      applicability: "Unavailable" as const,
      ...graph,
      validUntil: request.validUntil,
    });
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    return fail();
  }
}
export type ProductPublicationBundleReferenceSourceSnapshotV2 = ReturnType<
  typeof buildProductPublicationBundleReferenceSourceSnapshotV2
>;
export function parseProductPublicationBundleReferenceSourceSnapshotV2(
  value: unknown,
  input: CatalogProductPublicationReferenceRequestV2,
  now: string,
): ProductPublicationBundleReferenceSourceSnapshotV2 {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "generation",
        "observedAt",
        "validUntil",
        "digest",
        "bundles",
        "versions",
        "groups",
        "members",
      ]),
      request = parseCatalogProductPublicationReferenceRequestV2(input),
      actual = parseCatalogProductPublicationReferenceRequestV2(r.request);
    if (
      canonicalizeRfc8785(request) !== canonicalizeRfc8785(actual) ||
      r.profile !== "BrandBundlePublicationReferencesV2" ||
      r.coverage !== "CompleteStoredReferences" ||
      r.consistency !== "StatementSnapshot" ||
      r.applicability !== "Unavailable" ||
      typeof r.generation !== "string" ||
      r.validUntil !== request.validUntil
    )
      return fail();
    const bundles = array(r.bundles).map((value) => ({
        ...exact(value, rootFields),
        precise: true,
      })),
      versions = array(r.versions).map((value) => ({
        ...exact(value, versionFields),
        precise: true,
      })),
      groups = array(r.groups).map((value) => exact(value, groupFields)),
      members = array(r.members).map((value) => exact(value, memberFields));
    const raw = {
      generation: r.generation,
      observedAt: r.observedAt,
      counts: {
        bundles: String(bundles.length),
        versions: String(versions.length),
        groups: String(groups.length),
        members: String(members.length),
      },
      bundles,
      versions,
      groups,
      members,
    };
    const rebuilt = buildProductPublicationBundleReferenceSourceSnapshotV2(raw, request, now);
    if (canonicalizeRfc8785(rebuilt) !== canonicalizeRfc8785(r)) return fail();
    return rebuilt;
  } catch {
    return fail();
  }
}

export const productWarningAcknowledgementBundleReferenceSourceFields = Object.freeze([
  ...bundleReferenceSourceFields,
  ...productWarningAcknowledgementReferenceRequestFields,
] as const);
/** The fixed warning acknowledgement entry shares only the stored graph parser with V1.
 * The actual Ack request and original lease are hashed; no lifecycle request,
 * current sale eligibility, or publication approval is manufactured. */
export function buildProductWarningAcknowledgementBundleReferenceSourceSnapshot(
  value: unknown,
  input: CatalogProductWarningAcknowledgementReferenceRequest,
  now: string,
) {
  try {
    const request = parseCatalogProductWarningAcknowledgementReferenceRequest(input),
      graph = parseBundleStoredGraph(value, request.command.brandReference, now),
      at = parseCatalogInstant(now);
    if (
      graph.observedAt < request.observedAt ||
      graph.observedAt >= request.validUntil ||
      at >= request.validUntil
    )
      return fail();
    const body = Object.freeze({
      request,
      profile: "BrandBundleWarningAcknowledgementReferencesV1" as const,
      coverage: "CompleteStoredReferences" as const,
      consistency: "StatementSnapshot" as const,
      applicability: "Unavailable" as const,
      ...graph,
      validUntil: request.validUntil,
    });
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    return fail();
  }
}
export type ProductWarningAcknowledgementBundleReferenceSourceSnapshot = ReturnType<
  typeof buildProductWarningAcknowledgementBundleReferenceSourceSnapshot
>;
export function parseProductWarningAcknowledgementBundleReferenceSourceSnapshot(
  value: unknown,
  input: CatalogProductWarningAcknowledgementReferenceRequest,
  now: string,
): ProductWarningAcknowledgementBundleReferenceSourceSnapshot {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "generation",
        "observedAt",
        "validUntil",
        "digest",
        "bundles",
        "versions",
        "groups",
        "members",
      ]),
      request = parseCatalogProductWarningAcknowledgementReferenceRequest(input),
      actual = parseCatalogProductWarningAcknowledgementReferenceRequest(r.request);
    if (
      canonicalizeRfc8785(request) !== canonicalizeRfc8785(actual) ||
      r.profile !== "BrandBundleWarningAcknowledgementReferencesV1" ||
      r.coverage !== "CompleteStoredReferences" ||
      r.consistency !== "StatementSnapshot" ||
      r.applicability !== "Unavailable" ||
      typeof r.generation !== "string" ||
      r.validUntil !== request.validUntil
    )
      return fail();
    const bundles = array(r.bundles).map((value) => ({
        ...exact(value, rootFields),
        precise: true,
      })),
      versions = array(r.versions).map((value) => ({
        ...exact(value, versionFields),
        precise: true,
      })),
      groups = array(r.groups).map((value) => exact(value, groupFields)),
      members = array(r.members).map((value) => exact(value, memberFields));
    const raw = {
      generation: r.generation,
      observedAt: r.observedAt,
      counts: {
        bundles: String(bundles.length),
        versions: String(versions.length),
        groups: String(groups.length),
        members: String(members.length),
      },
      bundles,
      versions,
      groups,
      members,
    };
    const rebuilt = buildProductWarningAcknowledgementBundleReferenceSourceSnapshot(
      raw,
      request,
      now,
    );
    if (canonicalizeRfc8785(rebuilt) !== canonicalizeRfc8785(r)) return fail();
    return rebuilt;
  } catch {
    return fail();
  }
}
