import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import { parseProductPublicationVersion } from "./product-publication.js";
import { buildCatalogProductScopeOverlapPlan } from "./product-scope-overlap.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
/** Owning recorded provenance, not a sale decision or a public content projection.
 * Current policy provenance must be held by the configured server source. */
export function buildCatalogProductScopeJournal(value: unknown) {
  const v = copyCategoryPersistenceValue(value);
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const r = v as Record<string, unknown>;
  const fields = [
    "incoming",
    "latest",
    "sourceAggregateVersion",
    "sourceRevision",
    "scopeOrder",
    "policyEvidenceReference",
    "observedAt",
    "validUntil",
  ];
  if (
    Object.keys(r).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(r, k)) ||
    !Array.isArray(r.latest) ||
    r.latest.length > 1000 ||
    typeof r.sourceRevision !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(r.sourceRevision) ||
    BigInt(r.sourceRevision) > 9223372036854775807n ||
    !Number.isSafeInteger(r.sourceAggregateVersion) ||
    (r.sourceAggregateVersion as number) < 1
  )
    return fail();
  const incoming = parseProductPublicationVersion(r.incoming);
  const observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (validUntil <= observedAt || incoming.productAggregateVersion !== r.sourceAggregateVersion)
    return fail();
  const latest = r.latest
    .map(parseProductPublicationVersion)
    .sort((a, b) =>
      a.versionReference < b.versionReference
        ? -1
        : a.versionReference > b.versionReference
          ? 1
          : 0,
    );
  if (
    new Set(latest.map((p) => p.versionReference)).size !== latest.length ||
    latest.some(
      (p) =>
        p.tenantReference !== incoming.tenantReference ||
        p.brandReference !== incoming.brandReference ||
        p.productReference !== incoming.productReference ||
        p.productAggregateVersion >= incoming.productAggregateVersion ||
        p.occurredAt > observedAt ||
        p.scopeDigest !== hash(p.scopeSet) ||
        p.periodDigest !== hash(p.effectivePeriod),
    )
  )
    return fail();
  const existing = latest.filter(
    (p) =>
      p.versionReference !== incoming.versionReference &&
      (p.state === "Published" || p.state === "Superseded"),
  );
  const plan = buildCatalogProductScopeOverlapPlan({
    incoming,
    existing,
    scopeOrder: r.scopeOrder,
    observedAt,
  });
  if (plan.analysis !== "CompleteSelectorAnalysis") return fail();
  const body = Object.freeze({
    profile: "CatalogProductScopeJournalV1" as const,
    coverage: "CompleteLatestOwningPublicationHeads" as const,
    sourceAggregateVersion: r.sourceAggregateVersion as number,
    sourceRevision: r.sourceRevision,
    sourceHeadDigest: hash({
      sourceAggregateVersion: r.sourceAggregateVersion,
      sourceRevision: r.sourceRevision,
      latest,
    }),
    policyEvidenceReference: parseCatalogReference(r.policyEvidenceReference),
    validUntil,
    incoming,
    latest: Object.freeze(latest),
    plan,
    eligibility: "NotEvaluated" as const,
    wholeVersionSupersession: "NotEvaluated" as const,
  });
  if (canonicalizeRfc8785(body).length > 1_000_000) return fail();
  return Object.freeze({ ...body, digest: hash(body) });
}
export type CatalogProductScopeJournal = ReturnType<typeof buildCatalogProductScopeJournal>;
/** Rebuild from the originally recorded heads, never today's source state. */
export function parseCatalogProductScopeJournal(value: unknown): CatalogProductScopeJournal {
  const v = copyCategoryPersistenceValue(value);
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const r = v as Record<string, unknown>,
    plan = r.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return fail();
  const p = plan as Record<string, unknown>;
  const rebuilt = buildCatalogProductScopeJournal({
    incoming: r.incoming,
    latest: r.latest,
    sourceAggregateVersion: r.sourceAggregateVersion,
    sourceRevision: r.sourceRevision,
    scopeOrder: p.scopeOrder,
    policyEvidenceReference: r.policyEvidenceReference,
    observedAt: p.observedAt,
    validUntil: r.validUntil,
  });
  if (canonicalizeRfc8785(rebuilt) !== canonicalizeRfc8785(r)) return fail();
  return rebuilt;
}

export const productScopeJournalManagementFields = Object.freeze([
  "productReference",
  "aggregateVersion",
  "publicationHistory",
  "scopeSet",
  "effectivePeriod",
  "scopeJournal",
  "scopeJournalCoverage",
  "scopeJournalPolicyProvenance",
  "scopeJournalRelations",
] as const);
/** Recorded relations only. The supplied typed publication source is not itself
 * current authority; the owning read acquires it before this deterministic map. */
export function buildCatalogProductScopeJournalManagement(
  snapshot: import("./product-publication-source.js").ProductPublicationSourceSnapshot,
  value: unknown,
) {
  const raw = copyCategoryPersistenceValue(value);
  if (
    !Array.isArray(raw) ||
    raw.length > 1000 ||
    new TextEncoder().encode(canonicalizeRfc8785(raw)).byteLength > 1_048_576
  )
    return fail();
  const recorded = new Map<string, CatalogProductScopeJournal>();
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const row = value as Record<string, unknown>,
      keys = ["operationReference", "digest", "journal", "coherent"];
    if (
      Object.keys(row).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(row, key)) ||
      row.coherent !== true
    )
      return fail();
    const journal = parseCatalogProductScopeJournal(row.journal),
      p = journal.incoming;
    const original = snapshot.history.filter(
      (h) => h.publication.operationReference === p.operationReference,
    );
    if (
      row.operationReference !== p.operationReference ||
      row.digest !== journal.digest ||
      p.tenantReference !== snapshot.tenantReference ||
      p.brandReference !== snapshot.brandReference ||
      p.productReference !== snapshot.productReference ||
      journal.plan.observedAt > snapshot.observedAt ||
      original.length !== 1 ||
      original[0]?.publication.state !== "Published" ||
      !["Publish", "ActivateScheduled"].includes(original[0]?.action ?? "") ||
      canonicalizeRfc8785(original[0]?.publication) !== canonicalizeRfc8785(p) ||
      recorded.has(p.versionReference)
    )
      return fail();
    recorded.set(p.versionReference, journal);
  }
  const versions = [...snapshot.latest]
    .sort((a, b) => a.versionReference.localeCompare(b.versionReference))
    .map((latest) => {
      const original = snapshot.history.filter(
        (h) =>
          h.publication.versionReference === latest.versionReference &&
          h.publication.state === "Published" &&
          ["Publish", "ActivateScheduled"].includes(h.action),
      );
      if (original.length > 1) return fail();
      const publication = original[0]?.publication,
        journal = recorded.get(latest.versionReference);
      if (journal && !publication) return fail();
      if (
        publication &&
        (publication.contentDigest !== latest.contentDigest ||
          publication.configurationDigest !== latest.configurationDigest ||
          publication.scopeDigest !== latest.scopeDigest ||
          publication.periodDigest !== latest.periodDigest)
      )
        return fail();
      return Object.freeze({
        versionReference: latest.versionReference,
        currentPublicationVersion: latest.publicationVersion,
        currentState: latest.state,
        originalPublicationOperationReference: publication?.operationReference ?? null,
        recordStatus: journal
          ? ("Recorded" as const)
          : publication
            ? ("NotRecorded" as const)
            : ("NotApplicable" as const),
        journal: journal
          ? Object.freeze({
              digest: journal.digest,
              sourceHeadDigest: journal.sourceHeadDigest,
              sourceAggregateVersion: journal.sourceAggregateVersion,
              policyReference: journal.plan.policyReference,
              policyVersion: journal.plan.policyVersion,
              policyEvidenceReference: journal.policyEvidenceReference,
              recordedAt: journal.plan.observedAt,
              originalEvidenceValidUntil: journal.validUntil,
              relations: Object.freeze(
                journal.plan.overlaps.map((relation) => Object.freeze({ ...relation })),
              ),
            })
          : null,
      });
    });
  if (recorded.size !== versions.filter((v) => v.recordStatus === "Recorded").length) return fail();
  const body = Object.freeze({
    profile: "CatalogProductScopeJournalManagementV1" as const,
    tenantReference: snapshot.tenantReference,
    brandReference: snapshot.brandReference,
    productReference: snapshot.productReference,
    aggregateVersion: snapshot.aggregateVersion,
    sourceDigest: snapshot.digest,
    observedAt: snapshot.observedAt,
    validUntil: new Date(Date.parse(snapshot.observedAt) + 5000).toISOString(),
    coverage: "CompleteRecordedScopeJournalCoverage" as const,
    versions: Object.freeze(versions),
    eligibility: "NotEvaluated" as const,
    currentDisposition: "NotEvaluated" as const,
  });
  return Object.freeze({ ...body, digest: hash(body) });
}
