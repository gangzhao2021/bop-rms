import { deriveCatalogProductEditorContentIdentity } from "./product-editor-content.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseProductAggregate,
  parseProductVersion,
  parseCatalogReference,
  parseCatalogInstant,
  type ProductAggregate,
  type ProductVersion,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { parseProductPublicationVersion } from "./product-publication.js";
import { parseProductPublicationVersionV2 } from "./product-publication-v2.js";
import { planProductPublicationSuccessor } from "../domain/product-publication-successor.js";
import type { RecordedProductReferenceConfiguration } from "./product-reference-history-source.js";
export interface CatalogProductPublicationContent {
  readonly profile: "CatalogSupportedProductDraftContentV1" | "CatalogFullProductDraftContentV2";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly sourceAggregateVersion: number;
  readonly publicationOperationReference: string;
  readonly sealedAt: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly sourceDraft: ProductVersion;
  readonly referenceConfiguration: RecordedProductReferenceConfiguration;
}
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
/** Seven-field reference identity remains compatible with the current/recorded
 * owning graph. Rich content is never exposed through that minimal graph. */
function configuration(draft: ProductVersion): RecordedProductReferenceConfiguration {
  const classification = draft.categoryClassification;
  return Object.freeze({
    versionReference: draft.versionReference,
    skuReferences: Object.freeze(draft.skus.map((s) => s.skuReference).sort()),
    categoryCoverage: classification === undefined ? "Unavailable" : "Known",
    categoryReferences:
      classification === undefined
        ? null
        : Object.freeze([...classification.categoryReferences].sort()),
    primaryCategoryReference: classification?.primaryCategoryReference ?? null,
    taxClassificationReference: draft.taxClassificationReference,
    bindings: Object.freeze(
      draft.optionBindings
        .map((b) =>
          Object.freeze({
            bindingReference: b.bindingReference,
            optionSetReference: b.optionSetReference,
            optionSetVersionReference: b.optionSetVersionReference,
            enabledOptionReferences: Object.freeze([...b.enabledOptionReferences].sort()),
            includedSkuReferences: Object.freeze([...b.includedSkuReferences].sort()),
            excludedSkuReferences: Object.freeze([...b.excludedSkuReferences].sort()),
            channelCodes: Object.freeze([...b.channelCodes].sort()),
          }),
        )
        .sort((a, b) => a.bindingReference.localeCompare(b.bindingReference)),
    ),
  });
}
/** Private owning preparation: actual application validation/authority/source
 * leases must precede use. This preserves every currently supported Draft field;
 * it does not supply absent full-editor fields or validation/approval evidence. */
export function deriveCatalogProductPublicationContentIdentity(sourceValue: unknown) {
  const source = parseProductAggregate(copyCategoryPersistenceValue(sourceValue)),
    referenceConfiguration = configuration(source.draft);
  const identity =
    source.draft.editorContent === undefined
      ? { contentDigest: hash(source.draft), configurationDigest: hash(referenceConfiguration) }
      : deriveCatalogProductEditorContentIdentity(source.draft, source.draft.editorContent);
  return Object.freeze({
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    referenceConfiguration,
  });
}
export function createCatalogProductPublicationMaterialization(
  sourceValue: unknown,
  publicationValue: unknown,
): { readonly content: CatalogProductPublicationContent; readonly successor: ProductAggregate } {
  return materializePublication(sourceValue, publicationValue, parseProductPublicationVersion);
}
/** Explicit V2 entry; the shared materializer retains the parsed execution time
 * and full operation identity. It never invokes a V1 writer. */
export function createCatalogProductPublicationMaterializationV2(
  sourceValue: unknown,
  publicationValue: unknown,
): { readonly content: CatalogProductPublicationContent; readonly successor: ProductAggregate } {
  return materializePublication(sourceValue, publicationValue, parseProductPublicationVersionV2);
}
function materializePublication(
  sourceValue: unknown,
  publicationValue: unknown,
  parsePublication: typeof parseProductPublicationVersion | typeof parseProductPublicationVersionV2,
): { readonly content: CatalogProductPublicationContent; readonly successor: ProductAggregate } {
  const source = parseProductAggregate(copyCategoryPersistenceValue(sourceValue)),
    publication = parsePublication(publicationValue),
    identity = deriveCatalogProductPublicationContentIdentity(source);
  if (
    publication.contentDigest !== identity.contentDigest ||
    publication.configurationDigest !== identity.configurationDigest
  )
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  const successor = parseProductAggregate(planProductPublicationSuccessor(source, publication));
  if (publication.publishedAt === null) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  const content: CatalogProductPublicationContent = Object.freeze({
    profile:
      source.draft.editorContent === undefined
        ? "CatalogSupportedProductDraftContentV1"
        : "CatalogFullProductDraftContentV2",
    tenantReference: publication.tenantReference,
    brandReference: publication.brandReference,
    productReference: publication.productReference,
    versionReference: publication.versionReference,
    sourceAggregateVersion: source.aggregateVersion,
    publicationOperationReference: publication.operationReference,
    sealedAt: publication.publishedAt,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    sourceDraft: source.draft,
    referenceConfiguration: identity.referenceConfiguration,
  });
  return Object.freeze({ content, successor });
}

/** Stored owning snapshot recovery verifies its actual content and minimal graph;
 * no current mutable Draft is substituted for a committed snapshot. */
function parseStoredContent(value: unknown): CatalogProductPublicationContent {
  const copied = copyCategoryPersistenceValue(value);
  if (!copied || typeof copied !== "object" || Array.isArray(copied))
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const r = copied as Record<string, unknown>,
    keys = [
      "profile",
      "tenantReference",
      "brandReference",
      "productReference",
      "versionReference",
      "sourceAggregateVersion",
      "publicationOperationReference",
      "sealedAt",
      "contentDigest",
      "configurationDigest",
      "sourceDraft",
      "referenceConfiguration",
    ];
  if (
    Object.keys(r).length !== keys.length ||
    Object.keys(r).some((k) => !keys.includes(k)) ||
    (r.profile !== "CatalogSupportedProductDraftContentV1" &&
      r.profile !== "CatalogFullProductDraftContentV2") ||
    typeof r.sourceAggregateVersion !== "number" ||
    !Number.isInteger(r.sourceAggregateVersion) ||
    r.sourceAggregateVersion < 1 ||
    r.sourceAggregateVersion >= 2147483647
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const draft = parseProductVersion(r.sourceDraft),
    referenceConfiguration = configuration(draft),
    tenantReference = parseCatalogReference(r.tenantReference),
    brandReference = parseCatalogReference(r.brandReference),
    productReference = parseCatalogReference(r.productReference),
    versionReference = parseCatalogReference(r.versionReference),
    sealedAt = parseCatalogInstant(r.sealedAt);
  const identity =
    draft.editorContent === undefined
      ? { contentDigest: hash(draft), configurationDigest: hash(referenceConfiguration) }
      : deriveCatalogProductEditorContentIdentity(draft, draft.editorContent);
  if ((r.profile === "CatalogFullProductDraftContentV2") !== (draft.editorContent !== undefined))
    throw new CatalogError("CATALOG_INPUT_INVALID");
  if (
    versionReference !== draft.versionReference ||
    draft.skus.some(
      (s) => s.brandReference !== brandReference || s.productReference !== productReference,
    ) ||
    sealedAt < draft.updatedAt ||
    r.contentDigest !== identity.contentDigest ||
    r.configurationDigest !== identity.configurationDigest ||
    canonicalizeRfc8785(r.referenceConfiguration) !== canonicalizeRfc8785(referenceConfiguration)
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  return Object.freeze({
    profile: r.profile as CatalogProductPublicationContent["profile"],
    tenantReference,
    brandReference,
    productReference,
    versionReference,
    sourceAggregateVersion: r.sourceAggregateVersion,
    publicationOperationReference: parseCatalogReference(r.publicationOperationReference),
    sealedAt,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    sourceDraft: draft,
    referenceConfiguration,
  });
}

export function parseCatalogProductPublicationContent(
  value: unknown,
): CatalogProductPublicationContent {
  try {
    return parseStoredContent(value);
  } catch {
    throw new CatalogError("CATALOG_INPUT_INVALID");
  }
}
