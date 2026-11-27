import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePublishingProductPublicationPolicy,
  type PublishingProductPublicationPolicy,
} from "@bop/publishing";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "../contracts/product.js";
import { copyCategoryPersistenceValue } from "../contracts/category-persistence.js";
import {
  bindCatalogProductPublicationQualificationContext,
  bindCatalogProductWarningAcknowledgementQualificationContext,
  type CatalogProductQualificationContext,
} from "../contracts/product-publication-qualification-context.js";
import {
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationValidationReport,
  calculateCatalogProductPublicationWarningBindingDigest,
  type CatalogProductPublicationValidationDetails,
  type CatalogProductPublicationValidationFinding,
  type CatalogProductPublicationWarningBinding,
} from "../contracts/product-publication-validation-report.js";
import { parseProductPublicationValidationV2 } from "../contracts/product-publication-v2.js";

export const productPublicationCompositionCheckCodes = Object.freeze([
  "DefaultLocaleName",
  "PublishableSku",
  "VariantMapping",
  "OptionSelection",
  "MediaReady",
  "TaxResolution",
  "UniqueScope",
  "EffectivePeriod",
  "ChangeImpact",
] as const);
type SourceCheckCode = (typeof productPublicationCompositionCheckCodes)[number];
type CompleteDetails = Extract<
  CatalogProductPublicationValidationDetails,
  { coverage: "Complete" }
>;
export interface CatalogProductPublicationValidationCompositionInput {
  readonly context: CatalogProductQualificationContext;
  readonly policy: {
    readonly content: PublishingProductPublicationPolicy;
    readonly currentPublicationReference: string;
    readonly observedAt: string;
    readonly validUntil: string;
  };
  readonly evidenceReference: string;
  /** Exact nine independently evaluated checks. EffectivePeriod includes an
   * explicit held backdate-policy assessment, never an implicit default. */
  readonly checks: readonly {
    readonly code: SourceCheckCode;
    readonly outcome: "Pass" | "Warning" | "HardError";
  }[];
  readonly details: CompleteDetails;
  readonly assessedAt: string;
}
const localSourceCode = "CATALOG_PRODUCT_PUBLICATION_INPUT";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
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
function context(value: unknown): CatalogProductQualificationContext {
  const raw = closed(value, [
    "kind",
    "command",
    "aggregate",
    "current",
    "report",
    "tenantReference",
    "brandReference",
    "actorReference",
    "actorKind",
    "productReference",
    "versionReference",
    "aggregateVersion",
    "contentDigest",
    "configurationDigest",
    "scopeSet",
    "scopeDigest",
    "effectivePeriod",
    "periodDigest",
    "replacementIntent",
    "replacementIntentDigest",
    "recordedPolicy",
    "originalIntentDigest",
    "aggregateSnapshotDigest",
    "currentPublicationDigest",
    "observedAt",
    "validUntil",
  ]);
  const safe = Object.fromEntries(
    Object.entries(raw).map(([key, v]) => [
      key,
      key === "report" && v !== null
        ? parseCatalogProductPublicationValidationReport(v)
        : copyCategoryPersistenceValue(v),
    ]),
  );
  const bound =
    safe.kind === "Publication"
      ? bindCatalogProductPublicationQualificationContext(
          {
            command: safe.command,
            aggregate: safe.aggregate,
            current: safe.current,
            content: null,
            observedAt: safe.observedAt,
          } as Parameters<typeof bindCatalogProductPublicationQualificationContext>[0],
          safe.validUntil as string,
        )
      : safe.kind === "WarningAcknowledgement"
        ? bindCatalogProductWarningAcknowledgementQualificationContext({
            command: safe.command,
            aggregate: safe.aggregate,
            current: safe.current,
            report: safe.report,
            observedAt: safe.observedAt,
            validUntil: safe.validUntil,
          } as Parameters<typeof bindCatalogProductWarningAcknowledgementQualificationContext>[0])
        : fail();
  if (!equal(safe, bound) || bound.aggregate.draft.editorContent === undefined) return fail();
  return bound;
}

/** Pure composition inside the actual writer/owner callbacks. This does not
 * acquire authority, establish source completeness, classify SKU-008 policy or
 * select a backdate allowance. Its caller must hold the real source proofs.
 * InternalCode is already parsed from the writer-locked owning Product row and
 * protected by product_brand_code_unique; a detached supplied aggregate alone
 * cannot establish that database fact. */
export function composeCatalogProductPublicationValidation(
  value: CatalogProductPublicationValidationCompositionInput,
) {
  try {
    const r = closed(value, [
        "context",
        "policy",
        "evidenceReference",
        "checks",
        "details",
        "assessedAt",
      ]),
      c = context(r.context),
      p = closed(copyCategoryPersistenceValue(r.policy), [
        "content",
        "currentPublicationReference",
        "observedAt",
        "validUntil",
      ]),
      policy = parsePublishingProductPublicationPolicy(p.content),
      policyAt = parseCatalogInstant(p.observedAt),
      policyUntil = parseCatalogInstant(p.validUntil),
      assessedAt = parseCatalogInstant(r.assessedAt),
      evidenceReference = parseCatalogReference(r.evidenceReference),
      details = parseCatalogProductPublicationValidationDetails(r.details);
    parseCatalogReference(p.currentPublicationReference);
    if (
      details.coverage !== "Complete" ||
      policy.tenantReference !== c.tenantReference ||
      policy.brandReference !== c.brandReference ||
      policyAt !== c.observedAt ||
      policyUntil <= policyAt ||
      Date.parse(policyUntil) - Date.parse(policyAt) > 30000 ||
      parseCatalogInstant(policy.effectiveFrom) > policyAt ||
      assessedAt < c.observedAt ||
      ((c.kind !== "Publication" || c.command.action !== "Validate") &&
        (c.recordedPolicy === null ||
          policy.policyReference !== c.recordedPolicy.policyReference ||
          policy.policyVersion !== c.recordedPolicy.policyVersion))
    )
      return fail();
    const rawChecks = copyCategoryPersistenceValue(r.checks);
    if (
      !Array.isArray(rawChecks) ||
      rawChecks.length !== productPublicationCompositionCheckCodes.length
    )
      return fail();
    const checks = rawChecks.map((value) => {
      const item = closed(value, ["code", "outcome"]);
      if (
        typeof item.code !== "string" ||
        !productPublicationCompositionCheckCodes.some((code) => code === item.code) ||
        (item.outcome !== "Pass" && item.outcome !== "Warning" && item.outcome !== "HardError") ||
        (item.code === "EffectivePeriod" && item.outcome === "Warning")
      )
        return fail();
      return { code: item.code as SourceCheckCode, outcome: item.outcome };
    });
    if (
      new Set(checks.map((c) => c.code)).size !== checks.length ||
      details.sources.some(
        (source) =>
          source.sourceCode === localSourceCode ||
          source.observedAt < c.observedAt ||
          source.observedAt > assessedAt ||
          source.validUntil <= assessedAt,
      ) ||
      details.findings.some(
        (f) => !productPublicationCompositionCheckCodes.some((code) => code === f.checkCode),
      )
    )
      return fail();
    for (const check of checks) {
      const findings = details.findings.filter((f) => f.checkCode === check.code),
        outcome = findings.some((f) => f.outcome === "HardError")
          ? "HardError"
          : findings.length
            ? "Warning"
            : "Pass";
      if (check.outcome !== outcome) return fail();
    }
    const validUntil =
      [
        c.validUntil,
        policyUntil,
        ...details.sources.map((s) => s.validUntil),
        ...(policy.effectiveUntil === null ? [] : [policy.effectiveUntil]),
      ].sort()[0] ?? fail();
    if (assessedAt >= validUntil) return fail();
    const relevantInput = Object.freeze({
        tenantReference: c.tenantReference,
        brandReference: c.brandReference,
        productReference: c.productReference,
        versionReference: c.versionReference,
        internalCode: c.aggregate.internalCode,
        scopeDigest: c.scopeDigest,
        periodDigest: c.periodDigest,
      }),
      inputDigest = hash(relevantInput);
    const findings: CatalogProductPublicationValidationFinding[] = [...details.findings];
    // Business expiry is a negative result, not a renewed or already-expired
    // source lease; Reject/Cancel may still record this actual negative check.
    if (
      c.effectivePeriod.effectiveUntil !== null &&
      c.effectivePeriod.effectiveUntil.instant <= assessedAt
    ) {
      const check = checks.find((check) => check.code === "EffectivePeriod");
      if (!check) return fail();
      check.outcome = "HardError";
      findings.push(
        Object.freeze({
          checkCode: "EffectivePeriod",
          ruleCode: "PRODUCT_EFFECTIVE_PERIOD",
          outcome: "HardError",
          subjectReference: c.versionReference,
          reasonCode: "PRODUCT_EFFECTIVE_PERIOD_ENDED",
          references: Object.freeze([
            {
              sourceCode: localSourceCode,
              resourceReference: c.productReference,
              versionReference: c.versionReference,
              referenceDigest: inputDigest,
            },
          ]),
        }),
      );
    }
    const hard = checks.some((check) => check.outcome === "HardError"),
      validation = parseProductPublicationValidationV2({
        profile: "CatalogProductPublicationValidationV2",
        replacementIntentDigest: c.replacementIntentDigest,
        evidenceReference,
        productAggregateVersion: c.aggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: c.scopeDigest,
        periodDigest: c.periodDigest,
        policyReference: policy.policyReference,
        policyVersion: policy.policyVersion,
        approvalPolicy: policy.approvalPolicy,
        checks: [
          ...checks,
          { code: "InternalCode", outcome: "Pass" },
          {
            code: "ApprovalPolicy",
            outcome: policy.approvalPolicy === "Required" ? "Pending" : "Pass",
          },
          { code: "HardErrorsCleared", outcome: hard ? "HardError" : "Pass" },
        ],
        warningAcknowledgement: null,
        checkedAt: c.observedAt,
        validUntil,
      });
    const complete = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings,
      sources: [
        ...details.sources,
        {
          sourceCode: localSourceCode,
          sourceDigest: hash({
            aggregateSnapshotDigest: c.aggregateSnapshotDigest,
            originalIntentDigest: c.originalIntentDigest,
            relevantInput,
          }),
          generation: String(c.aggregateVersion),
          relevantReferenceDigest: inputDigest,
          observedAt: c.observedAt,
          validUntil,
        },
      ],
    });
    if (complete.coverage !== "Complete") return fail();
    const binding: CatalogProductPublicationWarningBinding = Object.freeze({
      tenantReference: c.tenantReference,
      brandReference: c.brandReference,
      productReference: c.productReference,
      versionReference: c.versionReference,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: c.scopeDigest,
      periodDigest: c.periodDigest,
      replacementIntentDigest: c.replacementIntentDigest,
      policyReference: policy.policyReference,
      policyVersion: policy.policyVersion,
    });
    // Reuse the owning check-to-finding/lease consistency rules even when there
    // are no warnings. A fingerprint is data, never a receipt or consent.
    calculateCatalogProductPublicationWarningBindingDigest(binding, validation, complete);
    return Object.freeze({ validation, details: complete, binding });
  } catch {
    return fail();
  }
}
