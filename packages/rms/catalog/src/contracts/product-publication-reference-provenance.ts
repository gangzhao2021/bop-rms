import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogHash,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  buildVerifiedProductVariantIdentityHistory,
  parseProductVariantIdentityHistorySnapshot,
  productVariantHistoryFields,
  type ProductVariantIdentityHistorySnapshot,
} from "./product-variant-identity-history.js";
import { deriveCatalogProductPublicationContentIdentity } from "./product-publication-content.js";
import { parseProductReferenceConfiguration } from "./product-pricing-binding-source.js";
import type { RecordedProductReferenceConfiguration } from "./product-reference-history-source.js";
import {
  parseCatalogProductPublicationReferenceRequestV2,
  type CatalogProductPublicationReferenceRequestV2,
} from "./product-publication-reference-request-v2.js";
import {
  parseCatalogProductWarningAcknowledgementReferenceRequest,
  productWarningAcknowledgementReferenceRequestFields,
  type CatalogProductWarningAcknowledgementReferenceRequest,
} from "./product-warning-acknowledgement-reference-request.js";
import { parseProductPublicationVersion } from "./product-publication.js";
import { parseProductPublicationVersionV2 } from "./product-publication-v2.js";

type Request =
  | CatalogProductPublicationReferenceRequestV2
  | CatalogProductWarningAcknowledgementReferenceRequest;
export const productPublicationQualificationHistoryFields = Object.freeze([
  ...productVariantHistoryFields,
  "command",
  "originalIntentDigest",
  "replacementIntentDigest",
  "aggregateSnapshotDigest",
  "currentPublicationDigest",
  "observedAt",
  "validUntil",
  "operationReference",
  "resultAggregateVersion",
  "recordedAt",
  "versionReference",
  "referenceConfiguration",
  "fullIdentity.contentDigest",
  "fullIdentity.configurationDigest",
  "fullIdentity.coverage",
] as const);
export const productWarningAcknowledgementQualificationHistoryFields = Object.freeze([
  ...productPublicationQualificationHistoryFields,
  ...productWarningAcknowledgementReferenceRequestFields.filter(
    (field) => !(productPublicationQualificationHistoryFields as readonly string[]).includes(field),
  ),
] as const);
export interface CatalogProductOperationReferenceProvenance {
  readonly operationReference: string;
  readonly resultAggregateVersion: number;
  readonly aggregateSnapshotDigest: string;
  readonly recordedAt: string;
  readonly versionReference: string;
  readonly referenceConfiguration: RecordedProductReferenceConfiguration;
  readonly fullIdentity:
    | {
        readonly coverage: "FullEditorContent";
        readonly contentDigest: string;
        readonly configurationDigest: string;
      }
    | { readonly coverage: "Unavailable"; readonly reason: "LegacyEditorContentAbsent" };
}
export interface CatalogProductPublicationReferenceProvenance {
  readonly profile: "CatalogProductPublicationReferenceProvenanceV1";
  readonly request: Request;
  readonly observedAt: string;
  readonly variantHistory: ProductVariantIdentityHistorySnapshot;
  readonly operationProvenance: readonly CatalogProductOperationReferenceProvenance[];
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
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
function digest(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
function request(value: unknown): Request {
  const profile =
    value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "profile")
      : undefined;
  if (!profile || !("value" in profile)) return fail();
  return profile.value === "CatalogProductPublicationReferenceRequestV2"
    ? parseCatalogProductPublicationReferenceRequestV2(value)
    : parseCatalogProductWarningAcknowledgementReferenceRequest(value);
}
function configuration(value: unknown): RecordedProductReferenceConfiguration {
  const r = exact(copyCategoryPersistenceValue(value), [
    "versionReference",
    "skuReferences",
    "categoryCoverage",
    "categoryReferences",
    "primaryCategoryReference",
    "taxClassificationReference",
    "bindings",
  ]);
  if (r.categoryCoverage !== "Known" && r.categoryCoverage !== "Unavailable") return fail();
  const { categoryCoverage: coverage, ...rest } = r;
  const graph = parseProductReferenceConfiguration({
    ...rest,
    categoryClassificationKnown: coverage === "Known",
  });
  const result = Object.freeze({
    versionReference: graph.versionReference,
    skuReferences: graph.skuReferences,
    categoryCoverage: graph.categoryCoverage,
    categoryReferences: graph.categoryReferences,
    primaryCategoryReference: graph.primaryCategoryReference,
    taxClassificationReference: graph.taxClassificationReference,
    bindings: graph.bindings,
  });
  if (!equal(result, value)) return fail();
  return result;
}
function entries(value: unknown, input: Request, observedAt: string) {
  if (
    !Array.isArray(value) ||
    value.length !== input.command.expectedProductAggregateVersion ||
    value.length > 1000 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  let previousTime = "",
    bytes = 0;
  const operations = new Set<string>();
  const result: CatalogProductOperationReferenceProvenance[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    const r = exact(d.value, [
      "operationReference",
      "resultAggregateVersion",
      "aggregateSnapshotDigest",
      "recordedAt",
      "versionReference",
      "referenceConfiguration",
      "fullIdentity",
    ]);
    const operationReference = parseCatalogReference(r.operationReference),
      recordedAt = parseCatalogInstant(r.recordedAt),
      versionReference = parseCatalogReference(r.versionReference),
      graph = configuration(r.referenceConfiguration);
    const identity = exact(
      r.fullIdentity,
      Object.getOwnPropertyDescriptor(r.fullIdentity ?? {}, "coverage")?.value ===
        "FullEditorContent"
        ? ["coverage", "contentDigest", "configurationDigest"]
        : ["coverage", "reason"],
    );
    const fullIdentity: CatalogProductOperationReferenceProvenance["fullIdentity"] =
      identity.coverage === "FullEditorContent"
        ? Object.freeze({
            coverage: "FullEditorContent",
            contentDigest: digest(identity.contentDigest),
            configurationDigest: digest(identity.configurationDigest),
          })
        : identity.coverage === "Unavailable" && identity.reason === "LegacyEditorContentAbsent"
          ? Object.freeze({ coverage: "Unavailable", reason: "LegacyEditorContentAbsent" })
          : fail();
    if (
      operations.has(operationReference) ||
      r.resultAggregateVersion !== i + 1 ||
      recordedAt < previousTime ||
      recordedAt > observedAt ||
      graph.versionReference !== versionReference
    )
      return fail();
    operations.add(operationReference);
    previousTime = recordedAt;
    const entry = Object.freeze({
      operationReference,
      resultAggregateVersion: i + 1,
      aggregateSnapshotDigest: digest(r.aggregateSnapshotDigest),
      recordedAt,
      versionReference,
      referenceConfiguration: graph,
      fullIdentity,
    });
    bytes += canonicalizeRfc8785(entry).length;
    if (bytes > 8388608) return fail();
    result.push(entry);
  }
  const last = result.at(-1);
  if (
    !last ||
    last.aggregateSnapshotDigest !== input.aggregateSnapshotDigest ||
    last.recordedAt > input.observedAt ||
    last.versionReference !== input.command.versionReference
  )
    return fail();
  const target =
    input.profile === "CatalogProductPublicationReferenceRequestV2" ? input.command : input;
  if (
    last.fullIdentity.coverage === "FullEditorContent" &&
    (last.fullIdentity.contentDigest !== target.contentDigest ||
      last.fullIdentity.configurationDigest !== target.configurationDigest)
  )
    return fail();
  return Object.freeze(result);
}
/** A single owner-verified operation history supplies both views. This does not
 * independently acquire a publication head; the caller holds coverage separately. */
export function buildCatalogProductPublicationReferenceProvenance(
  value: unknown,
  requestValue: Request,
  now: string,
): CatalogProductPublicationReferenceProvenance {
  const input = request(requestValue),
    verified = buildVerifiedProductVariantIdentityHistory(value, input.command.brandReference, {
      productReference: input.command.productReference,
      expectedAggregateVersion: input.command.expectedProductAggregateVersion,
      originalIntentDigest: input.originalIntentDigest,
    });
  const operationProvenance = verified.operations.map(
    ({ aggregate, operationReference, snapshotDigest }) => {
      const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
      return Object.freeze({
        operationReference,
        resultAggregateVersion: aggregate.aggregateVersion,
        aggregateSnapshotDigest: snapshotDigest,
        recordedAt: aggregate.updatedAt,
        versionReference: aggregate.draft.versionReference,
        referenceConfiguration: identity.referenceConfiguration,
        fullIdentity:
          aggregate.draft.editorContent === undefined
            ? Object.freeze({
                coverage: "Unavailable" as const,
                reason: "LegacyEditorContentAbsent" as const,
              })
            : Object.freeze({
                coverage: "FullEditorContent" as const,
                contentDigest: identity.contentDigest,
                configurationDigest: identity.configurationDigest,
              }),
      });
    },
  );
  const body = {
    profile: "CatalogProductPublicationReferenceProvenanceV1" as const,
    request: input,
    observedAt: verified.variantHistory.observedAt,
    variantHistory: verified.variantHistory,
    operationProvenance: Object.freeze(operationProvenance),
  };
  const parsed = parseCatalogProductPublicationReferenceProvenance({ ...body, digest: hash(body) }),
    at = parseCatalogInstant(now);
  if (at < parsed.observedAt || at >= input.validUntil) return fail();
  return parsed;
}
export function parseCatalogProductPublicationReferenceProvenance(
  value: unknown,
): CatalogProductPublicationReferenceProvenance {
  try {
    const r = exact(value, [
        "profile",
        "request",
        "observedAt",
        "variantHistory",
        "operationProvenance",
        "digest",
      ]),
      input = request(r.request),
      observedAt = parseCatalogInstant(r.observedAt),
      variantHistory = parseProductVariantIdentityHistorySnapshot(r.variantHistory);
    if (
      r.profile !== "CatalogProductPublicationReferenceProvenanceV1" ||
      observedAt < input.observedAt ||
      observedAt >= input.validUntil ||
      variantHistory.observedAt !== observedAt ||
      variantHistory.brandReference !== input.command.brandReference ||
      variantHistory.productReference !== input.command.productReference ||
      variantHistory.aggregateVersion !== input.command.expectedProductAggregateVersion ||
      variantHistory.originalIntentDigest !== input.originalIntentDigest
    )
      return fail();
    const body = {
      profile: "CatalogProductPublicationReferenceProvenanceV1" as const,
      request: input,
      observedAt,
      variantHistory,
      operationProvenance: entries(r.operationProvenance, input, observedAt),
    };
    if (r.digest !== hash(body)) return fail();
    return Object.freeze({ ...body, digest: r.digest });
  } catch {
    return fail();
  }
}
/** The supplied revision must come from separately held complete publication
 * coverage. A matching version alone never proves published/scheduled content. */
export function bindCatalogProductPublicationReferenceProvenanceToPublication(
  snapshotValue: unknown,
  publicationValue: unknown,
): CatalogProductOperationReferenceProvenance {
  const snapshot = parseCatalogProductPublicationReferenceProvenance(snapshotValue);
  const raw = copyCategoryPersistenceValue(publicationValue),
    publication =
      raw && typeof raw === "object" && Object.hasOwn(raw, "profile")
        ? parseProductPublicationVersionV2(raw)
        : parseProductPublicationVersion(raw);
  if (
    !equal(raw, publication) ||
    (publication.state !== "Published" && publication.state !== "Scheduled") ||
    publication.tenantReference !== snapshot.request.command.tenantReference ||
    publication.brandReference !== snapshot.request.command.brandReference ||
    publication.productReference !== snapshot.request.command.productReference
  )
    return fail();
  const source = snapshot.operationProvenance[publication.productAggregateVersion - 1],
    result = snapshot.operationProvenance[publication.productAggregateVersion];
  if (
    !source ||
    !result ||
    result.operationReference !== publication.operationReference ||
    result.recordedAt !== publication.occurredAt ||
    source.versionReference !== publication.versionReference ||
    (source.fullIdentity.coverage === "FullEditorContent" &&
      (source.fullIdentity.contentDigest !== publication.contentDigest ||
        source.fullIdentity.configurationDigest !== publication.configurationDigest))
  )
    return fail();
  return source;
}
