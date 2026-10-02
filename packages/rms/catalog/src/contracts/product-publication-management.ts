import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  buildCatalogProductEditorSnapshot,
  type CatalogProductEditorSnapshot,
} from "./product-editor-snapshot.js";
import {
  parseProductPublicationSourceRequest,
  type ProductPublicationSourceSnapshot,
} from "./product-publication-source.js";
import { parseProductPublicationVersion } from "./product-publication.js";

/** Called only inside the original held owning editor/publication source callbacks.
 * Complete recorded metadata is never current permission or publication eligibility. */
export function buildCatalogProductPublicationManagement(
  editor: CatalogProductEditorSnapshot,
  history: ProductPublicationSourceSnapshot,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  input: unknown,
  observation: unknown,
) {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  try {
    const request = parseProductPublicationSourceRequest(input),
      now = parseCatalogInstant(observation),
      storeReference = parseCatalogReference(scope.storeReference),
      safeEditor = copyCategoryPersistenceValue(editor) as CatalogProductEditorSnapshot,
      safeHistory = copyCategoryPersistenceValue(history) as ProductPublicationSourceSnapshot,
      rebuiltEditor = buildCatalogProductEditorSnapshot(
        safeEditor.aggregate,
        scope,
        request,
        safeEditor.observedAt,
      );
    if (canonicalizeRfc8785(safeEditor) !== canonicalizeRfc8785(rebuiltEditor)) return fail();
    const { digest: sourceDigest, ...historyBody } = safeHistory;
    if (
      Object.keys(safeHistory).length !== 11 ||
      safeHistory.profile !== "CatalogProductPublicationSourceV1" ||
      safeHistory.coverage !== "Complete" ||
      safeHistory.eligibility !== "NotEvaluated" ||
      safeHistory.tenantReference !== rebuiltEditor.tenantReference ||
      safeHistory.brandReference !== rebuiltEditor.brandReference ||
      safeHistory.productReference !== request.productReference ||
      safeHistory.aggregateVersion !== request.expectedAggregateVersion ||
      sourceDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(historyBody)) ||
      !Array.isArray(safeHistory.history) ||
      safeHistory.history.length > 1000 ||
      !Array.isArray(safeHistory.latest) ||
      safeHistory.latest.length > 1000
    )
      return fail();
    const historyAt = parseCatalogInstant(safeHistory.observedAt),
      observedAt = historyAt > rebuiltEditor.observedAt ? historyAt : rebuiltEditor.observedAt,
      validUntil = new Date(
        Math.min(Date.parse(historyAt) + 5000, Date.parse(rebuiltEditor.validUntil)),
      ).toISOString();
    if (now < observedAt || now >= validUntil) return fail();
    // Compare only the exact final owning head for each version, in linear time.
    const heads = new Map(
      safeHistory.history.map((h) => {
        const publication = parseProductPublicationVersion(h.publication);
        return [publication.versionReference, canonicalizeRfc8785(publication)] as const;
      }),
    );
    if (heads.size !== safeHistory.latest.length) return fail();
    const versions = safeHistory.latest.map((value) => {
      const v = parseProductPublicationVersion(value);
      if (
        v.tenantReference !== rebuiltEditor.tenantReference ||
        v.brandReference !== rebuiltEditor.brandReference ||
        v.productReference !== request.productReference ||
        v.productAggregateVersion >= request.expectedAggregateVersion ||
        v.occurredAt > historyAt ||
        heads.get(v.versionReference) !== canonicalizeRfc8785(v)
      )
        return fail();
      return Object.freeze({
        versionReference: v.versionReference,
        publicationVersion: v.publicationVersion,
        state: v.state,
        contentDigest: v.contentDigest,
        configurationDigest: v.configurationDigest,
        scopeSet: v.scopeSet,
        effectivePeriod: v.effectivePeriod,
        scheduleReference: v.scheduleReference,
        scheduleVersion: v.scheduleVersion,
        recordedAt: v.occurredAt,
      });
    });
    if (new Set(versions.map((v) => v.versionReference)).size !== versions.length) return fail();
    const body = Object.freeze({
      profile: "CatalogProductPublicationManagementV1" as const,
      tenantReference: rebuiltEditor.tenantReference,
      brandReference: rebuiltEditor.brandReference,
      storeReference,
      productReference: request.productReference,
      aggregateVersion: request.expectedAggregateVersion,
      observedAt,
      validUntil,
      coverage: "CompleteRecordedPublicationManagement" as const,
      eligibility: "NotEvaluated" as const,
      publishValidation: "Incomplete" as const,
      draft: Object.freeze({
        versionReference: rebuiltEditor.aggregate.draft.versionReference,
        contentDigest: rebuiltEditor.contentDigest,
        configurationDigest: rebuiltEditor.configurationDigest,
        contentStatus: rebuiltEditor.contentStatus,
      }),
      versions: Object.freeze(versions),
    });
    const result = Object.freeze({
      ...body,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
    });
    if (new TextEncoder().encode(canonicalizeRfc8785(result)).length > 2 * 1024 * 1024)
      return fail();
    return result;
  } catch {
    return fail();
  }
}
export type CatalogProductPublicationManagement = ReturnType<
  typeof buildCatalogProductPublicationManagement
>;
