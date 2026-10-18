/** Synthetic wire fixtures only. No owning approval, current policy or publication authority. */
import { createHash } from "node:crypto";
import { canonicalPublicationValue } from "./product-publication-command-client-v2.js";
import type { ProductPublicationWarningAcknowledgementCommand } from "./product-publication-warning-acknowledgement-client.js";
export const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export const at = "2026-10-01T12:00:00.000Z",
  csrf = "c".repeat(43),
  hash = "sha256:" + "a".repeat(64);
export const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  productReference: id(4),
};
export const request = { ...scope, expectedAggregateVersion: 7 };
export const digest = (v: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalPublicationValue(v)).digest("hex");
export function seal<T extends Record<string, unknown>>(v: T) {
  const { digest: discarded, ...body } = v;
  void discarded;
  return { ...body, digest: digest(body) };
}
export const none = () => seal({ profile: "CatalogProductNoReplacementIntentV1", mode: "None" });
export const selector = () => ({
  level: "Store",
  reference: id(3),
  channelCodes: ["DELIVERY"],
  orderTypeCodes: ["TAKEAWAY"],
});
export const period = () => ({
  timeZone: "UTC",
  effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
  effectiveUntil: null,
});
export function command(action = "Validate") {
  const replacementIntent = none();
  return {
    operationReference: id(8),
    productReference: id(4),
    versionReference: id(6),
    expectedProductAggregateVersion: 7,
    expectedPublicationVersion: 0,
    action,
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet: [selector()],
    effectivePeriod: period(),
    scheduleReference: ["SchedulePublish", "ReschedulePublish", "CancelScheduledPublish"].includes(
      action,
    )
      ? id(9)
      : null,
    replacementVersionReference: null,
    successorDraftVersionReference: action === "Publish" ? id(10) : null,
    occurredAt: at,
    reasonCode: "USER_REQUEST",
    profile: "CatalogProductPublicationCommandV2",
    replacementIntent,
    replacementIntentDigest: replacementIntent.digest,
  };
}
export function oldPublication() {
  const effectivePeriod = period(),
    scopeSet = [selector()];
  return {
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    versionReference: id(5),
    publicationVersion: 1,
    productAggregateVersion: 3,
    state: "Published",
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet,
    scopeDigest: digest(scopeSet),
    effectivePeriod,
    periodDigest: digest(effectivePeriod),
    validationEvidenceReference: id(11),
    validationDecision: "Pass",
    policyReference: id(12),
    policyVersion: 1,
    approvalPolicy: "NotRequired",
    reviewReference: id(13),
    reviewVersion: 1,
    submittedByActorReference: id(14),
    approvalEvidenceReference: null,
    scheduleReference: null,
    scheduleVersion: 0,
    publishedAt: at,
    supersededAt: null,
    supersededByVersionReference: null,
    successorDraftVersionReference: id(6),
    operationReference: id(15),
    intentDigest: hash,
    actorReference: id(14),
    actorKind: "User",
    occurredAt: at,
    reasonCode: "USER_REQUEST",
  };
}
export function exact(previous = oldPublication()) {
  return seal({
    profile: "CatalogProductExactStoreSelectorReplacementV1",
    mode: "PermanentSelectorRetirement",
    previousVersionReference: previous.versionReference,
    previousPublicationOperationReference: previous.operationReference,
    expectedPreviousPublicationVersion: previous.publicationVersion,
    previousIntentDigest: previous.intentDigest,
    previousScopeDigest: previous.scopeDigest,
    previousPeriodDigest: previous.periodDigest,
    previousSelectorIndex: 0,
    previousSelectorDigest: digest(previous.scopeSet[0]),
  });
}
export function management(
  observation = at,
  previous: ReturnType<typeof oldPublication> | null = null,
) {
  const versions = previous ? [previous] : [],
    history = previous ? [{ publicationAction: "Publish", publication: previous }] : [],
    scopeRetirementHeaders: unknown[] = [];
  const coverage = {
    profile: "CatalogProductRetirementCoverageV1",
    coverage: "CompleteRecordedPublicationRetirements",
    sourceAuthority: "NotEvaluated",
    eligibility: "NotEvaluated",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    aggregateVersion: 7,
    sourceRevision: "1",
    observedAt: observation,
    history,
    headers: scopeRetirementHeaders,
    latest: versions,
  };
  return seal({
    profile: "CatalogProductPublicationManagementV2",
    ...scope,
    aggregateVersion: 7,
    observedAt: observation,
    validUntil: new Date(Date.parse(observation) + 5000).toISOString(),
    editorObservedAt: observation,
    sourceObservedAt: observation,
    sourceRevision: "1",
    sourceDigest: digest(coverage),
    coverage: "CompleteRecordedPublicationManagement",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    draft: {
      versionReference: id(6),
      contentDigest: hash,
      configurationDigest: hash,
      contentStatus: "Present",
    },
    versions,
    history,
    scopeRetirementHeaders,
    noReplacementIntent: none(),
    replacementTargets: previous
      ? [{ selector: previous.scopeSet[0], replacementIntent: exact(previous) }]
      : [],
  });
}
export function resealManagement(raw: ReturnType<typeof management>) {
  return seal({
    ...raw,
    sourceDigest: digest({
      profile: "CatalogProductRetirementCoverageV1",
      coverage: "CompleteRecordedPublicationRetirements",
      sourceAuthority: "NotEvaluated",
      eligibility: "NotEvaluated",
      tenantReference: raw.tenantReference,
      brandReference: raw.brandReference,
      productReference: raw.productReference,
      aggregateVersion: raw.aggregateVersion,
      sourceRevision: raw.sourceRevision,
      observedAt: raw.sourceObservedAt,
      history: raw.history,
      headers: raw.scopeRetirementHeaders,
      latest: raw.versions,
    }),
  });
}
export function receipt(c: ReturnType<typeof command>, status = "Applied") {
  return {
    profile: "CatalogProductPublicationCommandResultV2",
    replacementIntentDigest: c.replacementIntentDigest,
    status,
    operationReference: c.operationReference,
    productReference: c.productReference,
    versionReference: c.versionReference,
    aggregateVersion: c.expectedProductAggregateVersion + 1,
    publicationVersion: c.expectedPublicationVersion + 1,
    state: (
      {
        Validate: "Draft",
        SubmitReview: "InReview",
        Approve: "Approved",
        Reject: "Draft",
        Publish: "Published",
        SchedulePublish: "Scheduled",
        ReschedulePublish: "Scheduled",
        CancelScheduledPublish: "Draft",
      } as Record<string, string>
    )[c.action],
    scheduleVersion: c.scheduleReference ? 1 : 0,
    effectiveFrom: c.effectivePeriod.effectiveFrom.instant,
    successorDraftVersionReference: c.successorDraftVersionReference,
  };
}
export const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
export function validatedManagement() {
  const raw = management(),
    replacementIntent = none();
  const publication = {
    ...oldPublication(),
    versionReference: id(6),
    productAggregateVersion: 6,
    state: "Draft",
    approvalPolicy: "Required",
    validationDecision: "ApprovalPending",
    reviewReference: null,
    reviewVersion: null,
    submittedByActorReference: null,
    publishedAt: null,
    successorDraftVersionReference: null,
    profile: "CatalogProductPublicationVersionV2",
    replacementIntent,
    replacementIntentDigest: replacementIntent.digest,
  };
  const header = seal({
    profile: "CatalogProductScopeRetirementHeaderV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    operationReference: publication.operationReference,
    versionReference: publication.versionReference,
    publicationVersion: 1,
    publicationAction: "Validate",
    sourceAggregateVersion: 6,
    resultAggregateVersion: 7,
    publicationIntentDigest: publication.intentDigest,
    publicationSnapshotDigest: digest(publication),
    observedSourceRevision: "1",
    observedSourceHeadDigest: hash,
    recordedAt: at,
    retirements: [],
  });
  // Wire fixture intentionally includes nullable Draft review fields; production parsers remain real.
  return seal({
    ...raw,
    versions: [publication],
    history: [{ publicationAction: "Validate", publication }],
    scopeRetirementHeaders: [header],
    sourceDigest: digest({
      profile: "CatalogProductRetirementCoverageV1",
      coverage: "CompleteRecordedPublicationRetirements",
      sourceAuthority: "NotEvaluated",
      eligibility: "NotEvaluated",
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(4),
      aggregateVersion: 7,
      sourceRevision: "1",
      observedAt: at,
      history: [{ publicationAction: "Validate", publication }],
      headers: [header],
      latest: [publication],
    }),
  });
}

interface ReportFixturePublication {
  tenantReference: string;
  brandReference: string;
  productReference: string;
  versionReference: string;
  operationReference: string;
  publicationVersion: number;
  productAggregateVersion: number;
  contentDigest: string;
  configurationDigest: string;
  scopeDigest: string;
  periodDigest: string;
  validationEvidenceReference: string;
  policyReference: string;
  policyVersion: number;
  approvalPolicy: string;
  validationDecision: string;
  intentDigest: string;
  occurredAt: string;
  replacementIntentDigest?: string;
}
/** Synthetic report transport fixture. No owning validation/source authority. */
export function validationReportView(
  publication: ReportFixturePublication | null = null,
  options: {
    observedAt?: string;
    aggregateVersion?: number;
    draftReference?: string;
    versionReference?: string;
    draftContentDigest?: string;
    draftConfigurationDigest?: string;
    complete?: boolean;
    notRecorded?: boolean;
    publicationAction?: string;
  } = {},
) {
  const observedAt = options.observedAt ?? at,
    draftReference = options.draftReference ?? id(6),
    currentDraft = {
      versionReference: draftReference,
      contentDigest: options.draftContentDigest ?? hash,
      configurationDigest: options.draftConfigurationDigest ?? hash,
      contentStatus: "Present",
    },
    versionReference = publication?.versionReference ?? options.versionReference ?? draftReference,
    status =
      publication === null
        ? "NotValidated"
        : options.notRecorded || !publication.replacementIntentDigest
          ? "NotRecorded"
          : "Recorded";
  let report: Record<string, unknown> | null = null;
  if (status === "Recorded" && publication) {
    const binding = {
        tenantReference: publication.tenantReference,
        brandReference: publication.brandReference,
        productReference: publication.productReference,
        versionReference: publication.versionReference,
        contentDigest: publication.contentDigest,
        configurationDigest: publication.configurationDigest,
        scopeDigest: publication.scopeDigest,
        periodDigest: publication.periodDigest,
        replacementIntentDigest: publication.replacementIntentDigest,
        policyReference: publication.policyReference,
        policyVersion: publication.policyVersion,
      },
      warning = publication.validationDecision === "WarningAcknowledgementRequired",
      hardError = publication.validationDecision === "HardError",
      checkedAt = publication.occurredAt,
      validUntil = new Date(Date.parse(checkedAt) + 5000).toISOString(),
      validation = {
        profile: "CatalogProductPublicationValidationV2",
        replacementIntentDigest: publication.replacementIntentDigest,
        evidenceReference: publication.validationEvidenceReference,
        productAggregateVersion: publication.productAggregateVersion,
        contentDigest: publication.contentDigest,
        configurationDigest: publication.configurationDigest,
        scopeDigest: publication.scopeDigest,
        periodDigest: publication.periodDigest,
        policyReference: publication.policyReference,
        policyVersion: publication.policyVersion,
        approvalPolicy: publication.approvalPolicy,
        checks: [
          "ApprovalPolicy",
          "ChangeImpact",
          "DefaultLocaleName",
          "EffectivePeriod",
          "HardErrorsCleared",
          "InternalCode",
          "MediaReady",
          "OptionSelection",
          "PublishableSku",
          "TaxResolution",
          "UniqueScope",
          "VariantMapping",
        ].map((code) => ({
          code,
          outcome:
            (code === "ChangeImpact" || code === "HardErrorsCleared") && hardError
              ? "HardError"
              : code === "ChangeImpact" && warning
                ? "Warning"
                : code === "ApprovalPolicy" &&
                    publication.approvalPolicy === "Required" &&
                    publication.validationDecision !== "Pass"
                  ? "Pending"
                  : "Pass",
        })),
        warningAcknowledgement: null,
        checkedAt,
        validUntil,
      },
      findings =
        warning || hardError
          ? [
              {
                checkCode: "ChangeImpact",
                ruleCode: "SYNTHETIC_REFERENCE_" + "R".repeat(44),
                outcome: hardError ? "HardError" : "Warning",
                subjectReference: id(81),
                reasonCode: "SYNTHETIC_REVIEW_" + "N".repeat(47),
                references: [
                  {
                    sourceCode: "SYNTHETIC_VALIDATION",
                    resourceReference: id(82),
                    versionReference: id(83),
                    referenceDigest: digest("synthetic report reference"),
                  },
                ],
              },
              ...[84, 85].map((n) => ({
                checkCode: "ChangeImpact",
                ruleCode: "SYNTHETIC_REFERENCE_" + "R".repeat(44),
                outcome: hardError ? "HardError" : "Warning",
                subjectReference: id(n),
                reasonCode: "SYNTHETIC_REVIEW_" + "N".repeat(47),
                references: [],
              })),
            ].sort((a, b) =>
              canonicalPublicationValue(a).localeCompare(canonicalPublicationValue(b), "en"),
            )
          : [],
      sources = [
        {
          sourceCode: "SYNTHETIC_VALIDATION",
          sourceDigest: digest("synthetic report source"),
          generation: "1",
          relevantReferenceDigest: digest("synthetic relevant references"),
          observedAt: checkedAt,
          validUntil,
        },
      ],
      details = options.complete
        ? { coverage: "Complete", impact: "Recorded", findings, sources }
        : { coverage: "ChecksOnly", impact: "NotRecorded" };
    report = seal({
      profile: "CatalogProductPublicationValidationReportV1",
      operationReference: publication.operationReference,
      publicationAction: options.publicationAction ?? "Validate",
      originalIntentDigest: publication.intentDigest,
      publicationSnapshotDigest: digest(publication),
      sourceAggregateVersion: publication.productAggregateVersion,
      resultAggregateVersion: publication.productAggregateVersion + 1,
      publicationVersion: publication.publicationVersion,
      validationEvidenceReference: publication.validationEvidenceReference,
      recordedAt: publication.occurredAt,
      binding,
      validation,
      details,
      warningBindingDigest: options.complete
        ? digest({
            binding,
            warningCodes: validation.checks
              .filter((c) => c.outcome === "Warning")
              .map((c) => c.code),
            findings,
            references: sources.map((s) => ({
              sourceCode: s.sourceCode,
              relevantReferenceDigest: s.relevantReferenceDigest,
            })),
          })
        : null,
    });
  }
  return seal({
    profile: "CatalogProductPublicationValidationReportViewV1",
    ...scope,
    versionReference,
    aggregateVersion: options.aggregateVersion ?? 7,
    publicationVersion: publication?.publicationVersion ?? 0,
    selectedPublicationOperationReference: publication?.operationReference ?? null,
    selectedPublicationDigest: publication ? digest(publication) : null,
    currentDraft,
    status,
    applicability:
      publication === null
        ? "NotValidated"
        : versionReference !== draftReference
          ? "HistoricalVersion"
          : publication.contentDigest === currentDraft.contentDigest &&
              publication.configurationDigest === currentDraft.configurationDigest
            ? "CurrentDraftContent"
            : "ChangedDraftContent",
    report,
    observedAt,
    validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
    eligibility: "NotEvaluated",
  });
}

/** Browser transport only; no persisted acknowledgement or current source proof. */
export function warningAcknowledgementResult(
  command: ProductPublicationWarningAcknowledgementCommand,
  recordedAt = command.occurredAt,
  status: "Applied" | "Replayed" = "Applied",
) {
  return {
    profile: "CatalogProductPublicationWarningAcknowledgementResultV1" as const,
    status,
    operationReference: command.operationReference,
    productReference: command.productReference,
    versionReference: command.versionReference,
    aggregateVersion: command.expectedProductAggregateVersion,
    reportOperationReference: command.reportOperationReference,
    reportDigest: command.reportDigest,
    warningBindingDigest: command.warningBindingDigest,
    warningCodes: command.warningCodes,
    reasonCode: command.reasonCode,
    occurredAt: command.occurredAt,
    recordedAt,
    receiptDigest: digest({ syntheticAcknowledgement: command, recordedAt }),
  };
}
