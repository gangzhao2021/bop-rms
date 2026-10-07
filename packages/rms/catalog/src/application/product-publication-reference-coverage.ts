import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogInstant } from "../contracts/product.js";
import { parseCatalogProductPublicationReferenceRequestV2 } from "../contracts/product-publication-reference-request-v2.js";
import { parseCatalogProductWarningAcknowledgementReferenceRequest } from "../contracts/product-warning-acknowledgement-reference-request.js";
import {
  bindCatalogProductPublicationReferenceProvenanceToPublication,
  parseCatalogProductPublicationReferenceProvenance,
  type CatalogProductOperationReferenceProvenance,
} from "../contracts/product-publication-reference-provenance.js";
import { parseCatalogProductRetirementCoverage } from "../contracts/product-publication-source-v2.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function request(value: unknown) {
  const descriptor =
    value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "profile")
      : undefined;
  if (!descriptor || !("value" in descriptor)) return fail();
  return descriptor.value === "CatalogProductPublicationReferenceRequestV2"
    ? parseCatalogProductPublicationReferenceRequestV2(value)
    : parseCatalogProductWarningAcknowledgementReferenceRequest(value);
}
function operation(entry: CatalogProductOperationReferenceProvenance) {
  return Object.freeze({
    operationReference: entry.operationReference,
    resultAggregateVersion: entry.resultAggregateVersion,
    aggregateSnapshotDigest: entry.aggregateSnapshotDigest,
    recordedAt: entry.recordedAt,
    versionReference: entry.versionReference,
  });
}

/** Join two already-held owning sources. Version identity alone is insufficient:
 * publication content comes from the exact pre-operation root, while its result
 * root can already contain a different successor Draft. No source acquisition,
 * severity, applicability or completed ChangeImpact decision is granted here. */
export function projectCatalogProductPublicationReferenceCoverage(
  requestValue: unknown,
  provenanceValue: unknown,
  coverageValue: unknown,
  nowValue: unknown,
) {
  try {
    const input = request(requestValue),
      provenance = parseCatalogProductPublicationReferenceProvenance(provenanceValue),
      coverage = parseCatalogProductRetirementCoverage(coverageValue),
      now = parseCatalogInstant(nowValue),
      c = input.command,
      root = provenance.operationProvenance.at(-1),
      current =
        coverage.latest.find((head) => head.versionReference === c.versionReference) ?? null;
    if (
      !equal(input, provenance.request) ||
      !root ||
      root.resultAggregateVersion !== c.expectedProductAggregateVersion ||
      root.aggregateSnapshotDigest !== input.aggregateSnapshotDigest ||
      root.versionReference !== c.versionReference ||
      root.fullIdentity.coverage !== "FullEditorContent" ||
      coverage.tenantReference !== c.tenantReference ||
      coverage.brandReference !== c.brandReference ||
      coverage.productReference !== c.productReference ||
      coverage.aggregateVersion !== c.expectedProductAggregateVersion ||
      coverage.observedAt < input.observedAt ||
      coverage.observedAt > now ||
      provenance.observedAt > now ||
      now < input.observedAt ||
      now >= input.validUntil ||
      (current === null ? null : hash(current)) !== input.currentPublicationDigest
    )
      return fail();
    if (input.profile === "CatalogProductPublicationReferenceRequestV2") {
      if (
        input.command.expectedPublicationVersion !== (current?.publicationVersion ?? 0) ||
        root.fullIdentity.contentDigest !== input.command.contentDigest ||
        root.fullIdentity.configurationDigest !== input.command.configurationDigest
      )
        return fail();
    } else if (
      !current ||
      current.publicationVersion !== input.publicationVersion ||
      root.fullIdentity.contentDigest !== input.contentDigest ||
      root.fullIdentity.configurationDigest !== input.configurationDigest ||
      current.contentDigest !== input.contentDigest ||
      current.configurationDigest !== input.configurationDigest ||
      current.scopeDigest !== input.scopeDigest ||
      current.periodDigest !== input.periodDigest ||
      !("replacementIntentDigest" in current) ||
      current.replacementIntentDigest !== input.replacementIntentDigest ||
      current.policyReference !== input.policyReference ||
      current.policyVersion !== input.policyVersion
    )
      return fail();
    const entries = Object.freeze(
      coverage.latest
        .filter(
          (head) =>
            head.state === "Published" || head.state === "Superseded" || head.state === "Scheduled",
        )
        .map((publication) => {
          // Coverage owns chain/header coherence. Supersede retains the original
          // Published content, not the unrelated editable Draft at its own pre-root.
          const original =
            publication.state === "Superseded"
              ? coverage.history.find(
                  (entry) =>
                    entry.publication.versionReference === publication.versionReference &&
                    entry.publication.state === "Published",
                )?.publication
              : publication;
          if (
            !original ||
            original.productAggregateVersion > publication.productAggregateVersion ||
            original.contentDigest !== publication.contentDigest ||
            original.configurationDigest !== publication.configurationDigest ||
            original.scopeDigest !== publication.scopeDigest ||
            original.periodDigest !== publication.periodDigest ||
            original.publishedAt !== publication.publishedAt
          )
            return fail();
          const source = bindCatalogProductPublicationReferenceProvenanceToPublication(
              provenance,
              original,
            ),
            result = provenance.operationProvenance[publication.productAggregateVersion];
          if (
            source.fullIdentity.coverage !== "FullEditorContent" ||
            !result ||
            result.operationReference !== publication.operationReference ||
            result.recordedAt !== publication.occurredAt ||
            (publication.state === "Published" &&
              result.versionReference !== publication.successorDraftVersionReference) ||
            (publication.state === "Scheduled" &&
              (result.versionReference !== publication.versionReference ||
                result.fullIdentity.coverage !== "FullEditorContent" ||
                result.fullIdentity.contentDigest !== publication.contentDigest ||
                result.fullIdentity.configurationDigest !== publication.configurationDigest))
          )
            return fail();
          const retirements = Object.freeze(
            coverage.headers.flatMap((header) =>
              header.retirements
                .filter(
                  (retirement) =>
                    retirement.replacementIntent.previousPublicationOperationReference ===
                    original.operationReference,
                )
                .map((retirement) =>
                  Object.freeze({
                    headerOperationReference: header.operationReference,
                    headerDigest: header.digest,
                    retirement,
                  }),
                ),
            ),
          );
          return Object.freeze({
            publication,
            publicationDigest: hash(publication),
            configurationPublicationOperationReference: original.operationReference,
            configurationPublicationDigest: hash(original),
            sourceOperation: operation(source),
            resultOperation: operation(result),
            referenceConfiguration: source.referenceConfiguration,
            fullIdentity: source.fullIdentity,
            retirements,
          });
        }),
    );
    const body = {
      profile: "CatalogProductPublicationReferenceCoverageV1" as const,
      request: input,
      provenanceDigest: provenance.digest,
      retirementCoverageDigest: coverage.digest,
      aggregateVersion: coverage.aggregateVersion,
      sourceRevision: coverage.sourceRevision,
      currentOperation: operation(root),
      entries,
      observedAt: input.observedAt,
      validUntil: input.validUntil,
      sourceAuthority: "NotEvaluated" as const,
      applicability: "NotEvaluated" as const,
      changeImpact: "NotEvaluated" as const,
      eligibility: "NotEvaluated" as const,
    };
    return Object.freeze({ ...body, digest: hash(body) });
  } catch {
    return fail();
  }
}
export type CatalogProductPublicationReferenceCoverage = ReturnType<
  typeof projectCatalogProductPublicationReferenceCoverage
>;
