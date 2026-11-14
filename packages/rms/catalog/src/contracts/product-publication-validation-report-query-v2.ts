import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogHash,
} from "./product.js";
import { parseCatalogProductEditorSnapshot } from "./product-editor-snapshot.js";
import { parseCatalogProductRetirementCoverage } from "./product-publication-source-v2.js";
import {
  bindCatalogProductPublicationValidationReportToPublication,
  parseCatalogProductPublicationValidationReport,
  type CatalogProductPublicationValidationReport,
} from "./product-publication-validation-report.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
// Only inspect the envelope here. Full reports/editor/history each retain their
// owning parser's independent byte/node budgets; never copy all of them together.
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
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
function integer(value: unknown, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 2147483647
  )
    return fail();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
export interface CatalogProductPublicationValidationReportReadRequestV1 {
  readonly productReference: string;
  readonly versionReference: string;
  readonly expectedAggregateVersion: number;
  readonly expectedPublicationVersion: number;
}
export function parseCatalogProductPublicationValidationReportReadRequest(
  value: unknown,
): CatalogProductPublicationValidationReportReadRequestV1 {
  const r = closed(value, [
    "productReference",
    "versionReference",
    "expectedAggregateVersion",
    "expectedPublicationVersion",
  ]);
  return Object.freeze({
    productReference: parseCatalogReference(r.productReference),
    versionReference: parseCatalogReference(r.versionReference),
    expectedAggregateVersion: integer(r.expectedAggregateVersion, 1),
    expectedPublicationVersion: integer(r.expectedPublicationVersion, 0),
  });
}
export const productPublicationValidationReportReadFields = Object.freeze([
  "productReference",
  "versionReference",
  "aggregateVersion",
  "publicationVersion",
  "publicationHistory",
  "validationReport",
  "validationReportDetails",
  "contentDigest",
  "configurationDigest",
  "scopeDigest",
  "periodDigest",
  "replacementIntentDigest",
  "policyReference",
  "policyVersion",
  "currentDraft",
] as const);
export interface CatalogProductPublicationValidationReportViewV1 {
  readonly profile: "CatalogProductPublicationValidationReportViewV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly aggregateVersion: number;
  readonly publicationVersion: number;
  readonly selectedPublicationOperationReference: string | null;
  readonly selectedPublicationDigest: string | null;
  readonly currentDraft: {
    readonly versionReference: string;
    readonly contentDigest: string;
    readonly configurationDigest: string;
    readonly contentStatus: "Present" | "Unavailable";
  };
  readonly status: "Recorded" | "NotValidated" | "NotRecorded";
  readonly applicability:
    "CurrentDraftContent" | "ChangedDraftContent" | "HistoricalVersion" | "NotValidated";
  readonly report: CatalogProductPublicationValidationReport | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
const viewFields = [
  "profile",
  "tenantReference",
  "brandReference",
  "storeReference",
  "productReference",
  "versionReference",
  "aggregateVersion",
  "publicationVersion",
  "selectedPublicationOperationReference",
  "selectedPublicationDigest",
  "currentDraft",
  "status",
  "applicability",
  "report",
  "observedAt",
  "validUntil",
  "eligibility",
  "digest",
] as const;
export function parseCatalogProductPublicationValidationReportView(
  value: unknown,
): CatalogProductPublicationValidationReportViewV1 {
  const r = closed(value, viewFields),
    d = closed(r.currentDraft, [
      "versionReference",
      "contentDigest",
      "configurationDigest",
      "contentStatus",
    ]);
  if (
    r.profile !== "CatalogProductPublicationValidationReportViewV1" ||
    r.eligibility !== "NotEvaluated" ||
    (d.contentStatus !== "Present" && d.contentStatus !== "Unavailable")
  )
    return fail();
  const currentDraft = Object.freeze({
    versionReference: parseCatalogReference(d.versionReference),
    contentDigest: digest(d.contentDigest),
    configurationDigest: digest(d.configurationDigest),
    contentStatus: d.contentStatus,
  });
  const tenantReference = parseCatalogReference(r.tenantReference),
    brandReference = parseCatalogReference(r.brandReference),
    storeReference = parseCatalogReference(r.storeReference),
    productReference = parseCatalogReference(r.productReference),
    versionReference = parseCatalogReference(r.versionReference),
    aggregateVersion = integer(r.aggregateVersion, 1),
    publicationVersion = integer(r.publicationVersion, 0),
    observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil),
    selectedPublicationOperationReference =
      r.selectedPublicationOperationReference === null
        ? null
        : parseCatalogReference(r.selectedPublicationOperationReference),
    selectedPublicationDigest =
      r.selectedPublicationDigest === null ? null : digest(r.selectedPublicationDigest),
    report = r.report === null ? null : parseCatalogProductPublicationValidationReport(r.report);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  const status = r.status,
    applicability = r.applicability;
  if (status !== "Recorded" && status !== "NotValidated" && status !== "NotRecorded") return fail();
  if (
    typeof applicability !== "string" ||
    !["CurrentDraftContent", "ChangedDraftContent", "HistoricalVersion", "NotValidated"].includes(
      applicability,
    )
  )
    return fail();
  if (status === "NotValidated") {
    if (
      publicationVersion !== 0 ||
      versionReference !== currentDraft.versionReference ||
      selectedPublicationOperationReference !== null ||
      selectedPublicationDigest !== null ||
      report !== null ||
      applicability !== "NotValidated"
    )
      return fail();
  } else {
    if (
      publicationVersion === 0 ||
      selectedPublicationOperationReference === null ||
      selectedPublicationDigest === null ||
      applicability === "NotValidated"
    )
      return fail();
    if (
      versionReference !== currentDraft.versionReference
        ? applicability !== "HistoricalVersion"
        : currentDraft.contentStatus !== "Present" ||
          !["CurrentDraftContent", "ChangedDraftContent"].includes(applicability)
    )
      return fail();
    if (status === "NotRecorded") {
      if (report !== null) return fail();
    } else {
      if (
        report === null ||
        report.binding.tenantReference !== tenantReference ||
        report.binding.brandReference !== brandReference ||
        report.binding.productReference !== productReference ||
        report.binding.versionReference !== versionReference ||
        report.publicationVersion !== publicationVersion ||
        report.operationReference !== selectedPublicationOperationReference ||
        report.publicationSnapshotDigest !== selectedPublicationDigest ||
        report.resultAggregateVersion > aggregateVersion ||
        report.recordedAt > observedAt
      )
        return fail();
      if (
        versionReference === currentDraft.versionReference &&
        applicability !==
          (report.binding.contentDigest === currentDraft.contentDigest &&
          report.binding.configurationDigest === currentDraft.configurationDigest
            ? "CurrentDraftContent"
            : "ChangedDraftContent")
      )
        return fail();
    }
  }
  const body = Object.freeze({
    profile: "CatalogProductPublicationValidationReportViewV1" as const,
    tenantReference,
    brandReference,
    storeReference,
    productReference,
    versionReference,
    aggregateVersion,
    publicationVersion,
    selectedPublicationOperationReference,
    selectedPublicationDigest,
    currentDraft,
    status,
    applicability:
      applicability as CatalogProductPublicationValidationReportViewV1["applicability"],
    report,
    observedAt,
    validUntil,
    eligibility: "NotEvaluated" as const,
  });
  if (r.digest !== hash(body)) return fail();
  return Object.freeze({ ...body, digest: hash(body) });
}

/** Called only from the actual held editor/history/report owners. Structural
 * parsing supplies no authority, current admission or renewed report evidence. */
export function buildCatalogProductPublicationValidationReportView(input: {
  readonly request: unknown;
  readonly editor: unknown;
  readonly coverage: unknown;
  readonly reportCoverage: unknown;
  readonly context: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly observedAt: unknown;
  readonly validUntil: unknown;
}): CatalogProductPublicationValidationReportViewV1 {
  const r = closed(input, [
      "request",
      "editor",
      "coverage",
      "reportCoverage",
      "context",
      "observedAt",
      "validUntil",
    ]),
    request = parseCatalogProductPublicationValidationReportReadRequest(r.request),
    editor = parseCatalogProductEditorSnapshot(r.editor),
    coverage = parseCatalogProductRetirementCoverage(r.coverage),
    context = closed(r.context, ["tenantReference", "brandReference", "storeReference"]),
    tenantReference = parseCatalogReference(context.tenantReference),
    brandReference = parseCatalogReference(context.brandReference),
    storeReference = parseCatalogReference(context.storeReference),
    observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (
    editor.tenantReference !== tenantReference ||
    editor.brandReference !== brandReference ||
    editor.productReference !== request.productReference ||
    editor.aggregateVersion !== request.expectedAggregateVersion ||
    coverage.tenantReference !== tenantReference ||
    coverage.brandReference !== brandReference ||
    coverage.productReference !== request.productReference ||
    coverage.aggregateVersion !== request.expectedAggregateVersion ||
    observedAt < editor.observedAt ||
    observedAt < coverage.observedAt ||
    validUntil > editor.validUntil ||
    Date.parse(validUntil) > Date.parse(coverage.observedAt) + 5000
  )
    return fail();
  const selected = coverage.latest.find((p) => p.versionReference === request.versionReference);
  let status: CatalogProductPublicationValidationReportViewV1["status"],
    report: CatalogProductPublicationValidationReport | null = null;
  let applicability: CatalogProductPublicationValidationReportViewV1["applicability"];
  if (!selected) {
    if (
      request.versionReference !== editor.aggregate.draft.versionReference ||
      request.expectedPublicationVersion !== 0 ||
      r.reportCoverage !== null
    )
      return fail();
    status = "NotValidated";
    applicability = "NotValidated";
  } else {
    if (
      selected.publicationVersion !== request.expectedPublicationVersion ||
      selected.occurredAt > observedAt
    )
      return fail();
    const stored = closed(r.reportCoverage, ["status", "report"]);
    if (stored.status === "Recorded") {
      report = bindCatalogProductPublicationValidationReportToPublication(stored.report, selected);
      status = "Recorded";
    } else if (stored.status === "NotRecorded" && stored.report === null) status = "NotRecorded";
    else return fail();
    applicability =
      selected.versionReference !== editor.aggregate.draft.versionReference
        ? "HistoricalVersion"
        : selected.contentDigest === editor.contentDigest &&
            selected.configurationDigest === editor.configurationDigest
          ? "CurrentDraftContent"
          : "ChangedDraftContent";
  }
  const body = {
    profile: "CatalogProductPublicationValidationReportViewV1" as const,
    tenantReference,
    brandReference,
    storeReference,
    productReference: request.productReference,
    versionReference: request.versionReference,
    aggregateVersion: request.expectedAggregateVersion,
    publicationVersion: selected?.publicationVersion ?? 0,
    selectedPublicationOperationReference: selected?.operationReference ?? null,
    selectedPublicationDigest: selected ? hash(selected) : null,
    currentDraft: {
      versionReference: editor.aggregate.draft.versionReference,
      contentDigest: editor.contentDigest,
      configurationDigest: editor.configurationDigest,
      contentStatus: editor.contentStatus,
    },
    status,
    applicability,
    report,
    observedAt,
    validUntil,
    eligibility: "NotEvaluated" as const,
  };
  return parseCatalogProductPublicationValidationReportView({ ...body, digest: hash(body) });
}
