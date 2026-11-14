import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
} from "./product.js";
import {
  productPublicationActions,
  productPublicationCheckCodes,
  type ProductPublicationAction,
} from "./product-publication.js";
import type { ProductPublicationCheckCode } from "../domain/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  parseProductPublicationVersionV2,
  type ProductPublicationValidationV2,
} from "./product-publication-v2.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = copyCategoryPersistenceValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(r, key))
  )
    return fail();
  return r as Record<string, unknown>;
}
function digest(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(v.slice(7));
}
function code(v: unknown): string {
  const c = parseCatalogCode(v);
  return c === v ? c : fail();
}
function integer(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 2147483647) return fail();
  return v;
}
function enumeration<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== "string" || !values.includes(v as T)) return fail();
  return v as T;
}
function list<T>(v: unknown, parser: (item: unknown) => T, maximum: number): readonly T[] {
  if (!Array.isArray(v) || v.length > maximum) return fail();
  const result = v
    .map(parser)
    .sort((a, b) => canonicalizeRfc8785(a).localeCompare(canonicalizeRfc8785(b), "en"));
  if (new Set(result.map(canonicalizeRfc8785)).size !== result.length) return fail();
  return Object.freeze(result);
}
// PostgreSQL jsonb::text inserts one space after each comma/colon. All parsed
// report strings are closed ASCII identifiers/codes/instants/digests; key ordering
// cannot alter this byte count. Match the persistence CHECK, not compact JSON.
function persistedBytes(value: unknown): number {
  if (Array.isArray(value))
    return 2 + Math.max(0, value.length - 1) * 2 + value.reduce((n, v) => n + persistedBytes(v), 0);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      2 +
      Math.max(0, entries.length - 1) * 2 +
      entries.reduce((n, [key, v]) => n + persistedBytes(key) + 2 + persistedBytes(v), 0)
    );
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return fail();
  return new TextEncoder().encode(serialized).length;
}

export interface CatalogProductPublicationWarningBinding {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly scopeDigest: string;
  readonly periodDigest: string;
  readonly replacementIntentDigest: string;
  readonly policyReference: string;
  readonly policyVersion: number;
}
const bindingFields = [
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "contentDigest",
  "configurationDigest",
  "scopeDigest",
  "periodDigest",
  "replacementIntentDigest",
  "policyReference",
  "policyVersion",
] as const;
export function parseCatalogProductPublicationWarningBinding(
  value: unknown,
): CatalogProductPublicationWarningBinding {
  const r = closed(value, bindingFields);
  return Object.freeze({
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    productReference: parseCatalogReference(r.productReference),
    versionReference: parseCatalogReference(r.versionReference),
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    scopeDigest: digest(r.scopeDigest),
    periodDigest: digest(r.periodDigest),
    replacementIntentDigest: digest(r.replacementIntentDigest),
    policyReference: parseCatalogReference(r.policyReference),
    policyVersion: integer(r.policyVersion),
  });
}
export interface CatalogProductPublicationValidationSourceEvidence {
  readonly sourceCode: string;
  readonly sourceDigest: string;
  readonly generation: string | null;
  /** The trusted producer hashes the relevant immutable reference facts, excluding
   * request/root/time and unrelated owner-generation changes. Never inferred here. */
  readonly relevantReferenceDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface CatalogProductPublicationValidationFinding {
  readonly checkCode: ProductPublicationCheckCode;
  readonly ruleCode: string;
  readonly outcome: "Warning" | "HardError";
  readonly subjectReference: string | null;
  readonly reasonCode: string;
  readonly references: readonly {
    readonly sourceCode: string;
    readonly resourceReference: string;
    readonly versionReference: string | null;
    readonly referenceDigest: string;
  }[];
}
export type CatalogProductPublicationValidationDetails =
  | { readonly coverage: "ChecksOnly"; readonly impact: "NotRecorded" }
  | {
      readonly coverage: "Complete";
      readonly impact: "Recorded";
      readonly findings: readonly CatalogProductPublicationValidationFinding[];
      readonly sources: readonly CatalogProductPublicationValidationSourceEvidence[];
    };
function source(value: unknown): CatalogProductPublicationValidationSourceEvidence {
  const r = closed(value, [
    "sourceCode",
    "sourceDigest",
    "generation",
    "relevantReferenceDigest",
    "observedAt",
    "validUntil",
  ]);
  const observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    (r.generation !== null &&
      (typeof r.generation !== "string" ||
        !/^(0|[1-9][0-9]{0,18})$/.test(r.generation) ||
        BigInt(r.generation) > 9223372036854775807n))
  )
    return fail();
  return Object.freeze({
    sourceCode: code(r.sourceCode),
    sourceDigest: digest(r.sourceDigest),
    generation: r.generation as string | null,
    relevantReferenceDigest: digest(r.relevantReferenceDigest),
    observedAt,
    validUntil,
  });
}
function finding(value: unknown): CatalogProductPublicationValidationFinding {
  const r = closed(value, [
    "checkCode",
    "ruleCode",
    "outcome",
    "subjectReference",
    "reasonCode",
    "references",
  ]);
  return Object.freeze({
    checkCode: enumeration(r.checkCode, productPublicationCheckCodes),
    ruleCode: code(r.ruleCode),
    outcome: enumeration(r.outcome, ["Warning", "HardError"] as const),
    subjectReference:
      r.subjectReference === null ? null : parseCatalogReference(r.subjectReference),
    reasonCode: code(r.reasonCode),
    references: list(
      r.references,
      (value) => {
        const ref = closed(value, [
          "sourceCode",
          "resourceReference",
          "versionReference",
          "referenceDigest",
        ]);
        return Object.freeze({
          sourceCode: code(ref.sourceCode),
          resourceReference: parseCatalogReference(ref.resourceReference),
          versionReference:
            ref.versionReference === null ? null : parseCatalogReference(ref.versionReference),
          referenceDigest: digest(ref.referenceDigest),
        });
      },
      1000,
    ),
  });
}
/** This parser establishes closed structure only. Only the held complete producer
 * may supply Complete; missing details never become an empty complete report. */
export function parseCatalogProductPublicationValidationDetails(
  value: unknown,
): CatalogProductPublicationValidationDetails {
  const safe = copyCategoryPersistenceValue(value);
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) return fail();
  if ("coverage" in safe && safe.coverage === "ChecksOnly") {
    const r = closed(safe, ["coverage", "impact"]);
    if (r.impact !== "NotRecorded") return fail();
    return Object.freeze({ coverage: "ChecksOnly", impact: "NotRecorded" });
  }
  const r = closed(safe, ["coverage", "impact", "findings", "sources"]);
  if (r.coverage !== "Complete" || r.impact !== "Recorded") return fail();
  const findings = list(r.findings, finding, 1000),
    sources = list(r.sources, source, 100);
  if (
    sources.length === 0 ||
    new Set(sources.map((s) => s.sourceCode)).size !== sources.length ||
    findings.some((f) =>
      f.references.some((ref) => !sources.some((s) => s.sourceCode === ref.sourceCode)),
    )
  )
    return fail();
  return Object.freeze({ coverage: "Complete", impact: "Recorded", findings, sources });
}

function validationBinding(
  binding: CatalogProductPublicationWarningBinding,
  validation: ProductPublicationValidationV2,
) {
  for (const key of [
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "replacementIntentDigest",
    "policyReference",
    "policyVersion",
  ] as const)
    if (binding[key] !== validation[key]) return fail();
}
function detailedChecks(
  validation: ProductPublicationValidationV2,
  details: CatalogProductPublicationValidationDetails,
) {
  if (details.coverage !== "Complete") return;
  for (const check of validation.checks) {
    const findings = details.findings.filter((f) => f.checkCode === check.code);
    if (check.code === "HardErrorsCleared") {
      if (findings.length > 0) return fail();
      continue;
    }
    const outcome = findings.some((f) => f.outcome === "HardError")
      ? "HardError"
      : findings.length > 0
        ? "Warning"
        : null;
    if (
      outcome !== null
        ? check.outcome !== outcome
        : check.outcome === "Warning" || check.outcome === "HardError"
    )
      return fail();
  }
  if (details.sources.some((s) => s.validUntil < validation.validUntil)) return fail();
}
/** Stable human consent identity. Workflow approval promotion, root/revision,
 * command identity, source observation leases and coarse generations stay in the
 * immutable report, but are deliberately absent from this semantic fingerprint. */
export function calculateCatalogProductPublicationWarningBindingDigest(
  bindingValue: unknown,
  validationValue: unknown,
  detailsValue: unknown,
): string | null {
  const binding = parseCatalogProductPublicationWarningBinding(bindingValue),
    validation = parseProductPublicationValidationV2(validationValue),
    details = parseCatalogProductPublicationValidationDetails(detailsValue);
  validationBinding(binding, validation);
  detailedChecks(validation, details);
  if (details.coverage === "ChecksOnly") return null;
  return hash({
    binding,
    warningCodes: validation.checks.filter((c) => c.outcome === "Warning").map((c) => c.code),
    findings: details.findings,
    references: details.sources
      .map((s) => ({
        sourceCode: s.sourceCode,
        relevantReferenceDigest: s.relevantReferenceDigest,
      }))
      .sort((a, b) => a.sourceCode.localeCompare(b.sourceCode, "en")),
  });
}
export interface CatalogProductPublicationValidationReport {
  readonly profile: "CatalogProductPublicationValidationReportV1";
  readonly operationReference: string;
  readonly publicationAction: Exclude<ProductPublicationAction, "Supersede">;
  readonly originalIntentDigest: string;
  readonly publicationSnapshotDigest: string;
  readonly sourceAggregateVersion: number;
  readonly resultAggregateVersion: number;
  readonly publicationVersion: number;
  readonly validationEvidenceReference: string;
  readonly recordedAt: string;
  readonly binding: CatalogProductPublicationWarningBinding;
  readonly validation: ProductPublicationValidationV2;
  readonly details: CatalogProductPublicationValidationDetails;
  readonly warningBindingDigest: string | null;
  readonly digest: string;
}
const reportFields = [
  "profile",
  "operationReference",
  "publicationAction",
  "originalIntentDigest",
  "publicationSnapshotDigest",
  "sourceAggregateVersion",
  "resultAggregateVersion",
  "publicationVersion",
  "validationEvidenceReference",
  "recordedAt",
  "binding",
  "validation",
  "details",
  "warningBindingDigest",
  "digest",
] as const;
export function parseCatalogProductPublicationValidationReport(
  value: unknown,
): CatalogProductPublicationValidationReport {
  const r = closed(value, reportFields);
  const binding = parseCatalogProductPublicationWarningBinding(r.binding),
    validation = parseProductPublicationValidationV2(r.validation),
    details = parseCatalogProductPublicationValidationDetails(r.details),
    sourceAggregateVersion = integer(r.sourceAggregateVersion),
    resultAggregateVersion = integer(r.resultAggregateVersion),
    recordedAt = parseCatalogInstant(r.recordedAt),
    warningBindingDigest = calculateCatalogProductPublicationWarningBindingDigest(
      binding,
      validation,
      details,
    ),
    publicationAction = enumeration(r.publicationAction, productPublicationActions);
  if (
    r.profile !== "CatalogProductPublicationValidationReportV1" ||
    publicationAction === "Supersede" ||
    resultAggregateVersion !== sourceAggregateVersion + 1 ||
    validation.productAggregateVersion !== sourceAggregateVersion ||
    r.validationEvidenceReference !== validation.evidenceReference ||
    r.warningBindingDigest !== warningBindingDigest ||
    validation.checkedAt > recordedAt ||
    validation.validUntil <= recordedAt ||
    (details.coverage === "Complete" && details.sources.some((s) => s.observedAt > recordedAt))
  )
    return fail();
  const body = Object.freeze({
    profile: "CatalogProductPublicationValidationReportV1" as const,
    operationReference: parseCatalogReference(r.operationReference),
    publicationAction,
    originalIntentDigest: digest(r.originalIntentDigest),
    publicationSnapshotDigest: digest(r.publicationSnapshotDigest),
    sourceAggregateVersion,
    resultAggregateVersion,
    publicationVersion: integer(r.publicationVersion),
    validationEvidenceReference: validation.evidenceReference,
    recordedAt,
    binding,
    validation,
    details,
    warningBindingDigest,
  });
  if (digest(r.digest) !== hash(body)) return fail();
  const report = Object.freeze({ ...body, digest: hash(body) });
  if (persistedBytes(report) > 1048576) return fail();
  return report;
}
/** Immutable historical binding; deliberately no check against the current clock. */
export function bindCatalogProductPublicationValidationReportToPublication(
  reportValue: unknown,
  publicationValue: unknown,
): CatalogProductPublicationValidationReport {
  const report = parseCatalogProductPublicationValidationReport(reportValue),
    publication = parseProductPublicationVersionV2(publicationValue),
    binding = parseCatalogProductPublicationWarningBinding(
      Object.fromEntries(bindingFields.map((key) => [key, publication[key]])),
    );
  const validation = report.validation;
  const decision = validation.checks.some((c) => c.outcome === "HardError")
    ? "HardError"
    : validation.checks.some((c) => c.outcome === "Warning") &&
        validation.warningAcknowledgement === null
      ? "WarningAcknowledgementRequired"
      : validation.checks.some((c) => c.outcome === "Pending")
        ? "ApprovalPending"
        : "Pass";
  if (
    !equal(binding, report.binding) ||
    report.publicationSnapshotDigest !== hash(publication) ||
    report.operationReference !== publication.operationReference ||
    report.originalIntentDigest !== publication.intentDigest ||
    report.sourceAggregateVersion !== publication.productAggregateVersion ||
    report.publicationVersion !== publication.publicationVersion ||
    report.validationEvidenceReference !== publication.validationEvidenceReference ||
    report.recordedAt < publication.occurredAt ||
    validation.approvalPolicy !== publication.approvalPolicy ||
    decision !== publication.validationDecision
  )
    return fail();
  return report;
}
/** The owning writer supplies its final validation after real approval resolution.
 * Neither this constructor nor supplied detailed findings grant current authority. */
export function buildCatalogProductPublicationValidationReport(
  value: unknown,
): CatalogProductPublicationValidationReport {
  const r = closed(value, ["command", "publication", "validation", "details", "recordedAt"]),
    command = parseProductPublicationCommandV2(r.command),
    publication = parseProductPublicationVersionV2(r.publication),
    validation = parseProductPublicationValidationV2(r.validation),
    details = parseCatalogProductPublicationValidationDetails(
      r.details === null ? { coverage: "ChecksOnly", impact: "NotRecorded" } : r.details,
    ),
    binding = parseCatalogProductPublicationWarningBinding(
      Object.fromEntries(bindingFields.map((key) => [key, publication[key]])),
    );
  if (
    publication.intentDigest !== hash(command) ||
    publication.operationReference !== command.operationReference ||
    publication.tenantReference !== command.tenantReference ||
    publication.brandReference !== command.brandReference ||
    publication.productReference !== command.productReference ||
    publication.versionReference !== command.versionReference ||
    publication.publicationVersion !== command.expectedPublicationVersion + 1 ||
    publication.productAggregateVersion !== command.expectedProductAggregateVersion ||
    publication.contentDigest !== command.contentDigest ||
    publication.configurationDigest !== command.configurationDigest ||
    publication.scopeDigest !== hash(command.scopeSet) ||
    publication.periodDigest !== hash(command.effectivePeriod) ||
    publication.replacementIntentDigest !== command.replacementIntentDigest ||
    publication.actorReference !== command.actorReference ||
    publication.actorKind !== command.actorKind ||
    publication.reasonCode !== command.reasonCode ||
    publication.occurredAt < command.occurredAt
  )
    return fail();
  const body = {
    profile: "CatalogProductPublicationValidationReportV1" as const,
    operationReference: command.operationReference,
    publicationAction: command.action,
    originalIntentDigest: hash(command),
    publicationSnapshotDigest: hash(publication),
    sourceAggregateVersion: command.expectedProductAggregateVersion,
    resultAggregateVersion: command.expectedProductAggregateVersion + 1,
    publicationVersion: publication.publicationVersion,
    validationEvidenceReference: validation.evidenceReference,
    recordedAt: parseCatalogInstant(r.recordedAt),
    binding,
    validation,
    details,
    warningBindingDigest: calculateCatalogProductPublicationWarningBindingDigest(
      binding,
      validation,
      details,
    ),
  };
  return bindCatalogProductPublicationValidationReportToPublication(
    { ...body, digest: hash(body) },
    publication,
  );
}
