import { CatalogError } from "./product.js";
import type {
  ProductPublicationCommand,
  ProductPublicationCheckCode,
  ProductPublicationValidation,
  ProductPublicationVersion,
  ProductPublicationFacts,
} from "./product-publication.js";

/** Parsed V2 lifecycle fields. The explicit V2 contract owns profile and target binding. */
type ProductPublicationValidationStateV2 = Omit<ProductPublicationValidation, "checks"> & {
  readonly checks: readonly {
    readonly code: ProductPublicationCheckCode;
    readonly outcome: "Pass" | "HardError" | "Warning" | "Pending";
  }[];
};
type ProductPublicationVersionStateV2 = Omit<ProductPublicationVersion, "validationDecision"> & {
  readonly validationDecision: ProductPublicationVersion["validationDecision"] | "ApprovalPending";
};
type ProductPublicationFactsStateV2 = Omit<
  ProductPublicationFacts,
  "validation" | "replacement"
> & {
  readonly validation: ProductPublicationValidationStateV2;
  readonly replacement: null;
};

function conflict(): never {
  throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
}
function fresh(checkedAt: string, validUntil: string, now: string) {
  if (checkedAt > now || validUntil <= now) conflict();
}
function validationDecision(
  v: ProductPublicationValidationStateV2,
): ProductPublicationVersionStateV2["validationDecision"] {
  if (v.checks.some((c) => c.outcome === "HardError")) return "HardError";
  const warnings = v.checks
    .filter((c) => c.outcome === "Warning")
    .map((c) => c.code)
    .sort();
  if (
    warnings.length > 0 &&
    (v.warningAcknowledgement === null ||
      v.warningAcknowledgement.warningCodes.length !== warnings.length ||
      warnings.some((code, i) => v.warningAcknowledgement?.warningCodes[i] !== code))
  )
    return "WarningAcknowledgementRequired";
  return v.checks.some((check) => check.outcome === "Pending") ? "ApprovalPending" : "Pass";
}
/** Application supplies parsed current owning facts under real authority/source leases.
 * This pure plan neither supplies permission nor persists an operation. */
export function planProductPublicationVersionV2(
  command: ProductPublicationCommand,
  current: ProductPublicationVersionStateV2 | null,
  facts: ProductPublicationFactsStateV2,
  intentDigest: string,
): ProductPublicationVersionStateV2 {
  const v = facts.validation,
    now = facts.now;
  if (
    command.occurredAt > now ||
    facts.productAggregateVersion !== command.expectedProductAggregateVersion ||
    facts.contentDigest !== command.contentDigest ||
    facts.configurationDigest !== command.configurationDigest ||
    v.productAggregateVersion !== facts.productAggregateVersion ||
    v.contentDigest !== facts.contentDigest ||
    v.configurationDigest !== facts.configurationDigest ||
    v.scopeDigest !== facts.scopeDigest ||
    v.periodDigest !== facts.periodDigest
  )
    conflict();
  fresh(v.checkedAt, v.validUntil, now);
  if (current === null) {
    if (command.expectedPublicationVersion !== 0 || command.action !== "Validate") conflict();
  } else if (
    current.tenantReference !== command.tenantReference ||
    current.brandReference !== command.brandReference ||
    current.productReference !== command.productReference ||
    current.versionReference !== command.versionReference ||
    current.publicationVersion !== command.expectedPublicationVersion ||
    current.productAggregateVersion > facts.productAggregateVersion ||
    current.occurredAt > command.occurredAt
  )
    conflict();
  if (command.expectedPublicationVersion >= 2147483647) conflict();
  if (
    command.actorKind === "System" &&
    command.action !== "ActivateScheduled" &&
    command.action !== "Supersede"
  )
    conflict();
  if (
    command.actorKind === "User" &&
    (command.action === "ActivateScheduled" || command.action === "Supersede")
  )
    conflict();
  const rawDecision = validationDecision(v);
  const returningToDraft =
    command.action === "Reject" || command.action === "CancelScheduledPublish";
  const decision =
    returningToDraft && v.approvalPolicy === "Required" && rawDecision === "Pass"
      ? "ApprovalPending"
      : rawDecision;
  const approvalOutcome = v.checks.find((check) => check.code === "ApprovalPolicy")?.outcome;
  if (v.approvalPolicy === "Required") {
    if (command.action === "Validate" || command.action === "SubmitReview") {
      if (approvalOutcome !== "Pending" || facts.approval !== null) conflict();
    } else if (!returningToDraft && (approvalOutcome !== "Pass" || facts.approval === null)) {
      conflict();
    }
  }
  if (
    command.action !== "Validate" &&
    command.action !== "SubmitReview" &&
    command.action !== "Reject" &&
    command.action !== "CancelScheduledPublish" &&
    decision !== "Pass"
  )
    conflict();
  if (
    v.warningAcknowledgement !== null &&
    command.action !== "Reject" &&
    command.action !== "CancelScheduledPublish"
  ) {
    const expectedActor =
      command.actorKind === "User" ? command.actorReference : current?.submittedByActorReference;
    if (v.warningAcknowledgement.actorReference !== expectedActor) conflict();
  }
  const changedContent =
    current !== null &&
    (current.contentDigest !== command.contentDigest ||
      current.configurationDigest !== command.configurationDigest ||
      current.scopeDigest !== facts.scopeDigest);
  if (current !== null && command.action !== "Validate" && changedContent) conflict();
  const periodChanged = current !== null && current.periodDigest !== facts.periodDigest;
  if (periodChanged && command.action !== "Validate" && command.action !== "ReschedulePublish")
    conflict();
  let state: ProductPublicationVersionStateV2["state"] = current?.state ?? "Draft",
    reviewReference = current?.reviewReference ?? null,
    reviewVersion = current?.reviewVersion ?? null,
    submittedByActorReference = current?.submittedByActorReference ?? null,
    approvalEvidenceReference = current?.approvalEvidenceReference ?? null,
    scheduleReference = current?.scheduleReference ?? null,
    scheduleVersion = current?.scheduleVersion ?? 0,
    publishedAt = current?.publishedAt ?? null,
    successorDraftVersionReference = current?.successorDraftVersionReference ?? null;
  const requireApproval = (timingChange = false) => {
    if (v.approvalPolicy === "NotRequired") return;
    const a = facts.approval;
    if (!a) conflict();
    if (a.approvedAt > now || a.validUntil <= now) conflict();
    if (
      a.contentDigest !== command.contentDigest ||
      a.configurationDigest !== command.configurationDigest ||
      a.scopeDigest !== facts.scopeDigest ||
      a.periodDigest !== facts.periodDigest ||
      a.policyReference !== v.policyReference ||
      a.policyVersion !== v.policyVersion ||
      a.approvedByActorReference === a.requestedByActorReference
    )
      conflict();
    if (timingChange) {
      if (
        a.reviewVersion !== current?.publicationVersion ||
        a.requestedByActorReference !== command.actorReference
      )
        conflict();
      reviewReference = a.reviewReference;
      reviewVersion = a.reviewVersion;
      submittedByActorReference = a.requestedByActorReference;
    } else if (
      a.reviewReference !== reviewReference ||
      a.reviewVersion !== reviewVersion ||
      a.requestedByActorReference !== submittedByActorReference
    )
      conflict();
    if (command.action === "Approve" && a.approvedByActorReference !== command.actorReference)
      conflict();
    if (
      command.action !== "Approve" &&
      !timingChange &&
      a.evidenceReference !== approvalEvidenceReference
    )
      conflict();
    approvalEvidenceReference = a.evidenceReference;
  };
  switch (command.action) {
    case "Validate":
      if (current !== null && current.state !== "Draft") conflict();
      state = "Draft";
      reviewReference =
        reviewVersion =
        submittedByActorReference =
        approvalEvidenceReference =
          null;
      break;
    case "SubmitReview":
      if (
        current?.state !== "Draft" ||
        facts.reviewReference === null ||
        decision !== (v.approvalPolicy === "Required" ? "ApprovalPending" : "Pass")
      )
        conflict();
      state = "InReview";
      reviewReference = facts.reviewReference;
      reviewVersion = current.publicationVersion + 1;
      submittedByActorReference = command.actorReference;
      approvalEvidenceReference = null;
      break;
    case "Approve":
      if (
        current?.state !== "InReview" ||
        current.submittedByActorReference === command.actorReference ||
        (current.validationDecision !== "ApprovalPending" &&
          current.validationDecision !== "Pass") ||
        v.approvalPolicy !== "Required"
      )
        conflict();
      requireApproval();
      state = "Approved";
      break;
    case "Reject":
      if (
        current?.state !== "InReview" ||
        current.submittedByActorReference === command.actorReference
      )
        conflict();
      state = "Draft";
      reviewReference =
        reviewVersion =
        submittedByActorReference =
        approvalEvidenceReference =
          null;
      break;
    case "SchedulePublish":
      if (
        (current?.state !== "Approved" &&
          !(current?.state === "InReview" && v.approvalPolicy === "NotRequired")) ||
        command.scheduleReference === null ||
        command.effectivePeriod.effectiveFrom.instant <= now
      )
        conflict();
      requireApproval();
      state = "Scheduled";
      scheduleReference = command.scheduleReference;
      scheduleVersion++;
      break;
    case "ReschedulePublish":
      if (
        current?.state !== "Scheduled" ||
        current.scheduleReference !== command.scheduleReference ||
        command.effectivePeriod.effectiveFrom.instant <= now
      )
        conflict();
      requireApproval(true);
      scheduleVersion++;
      break;
    case "CancelScheduledPublish":
      if (current?.state !== "Scheduled" || current.scheduleReference !== command.scheduleReference)
        conflict();
      state = "Draft";
      reviewReference =
        reviewVersion =
        submittedByActorReference =
        approvalEvidenceReference =
          null;
      scheduleVersion++;
      break;
    case "Publish":
    case "ActivateScheduled":
      if (
        command.action === "Publish" &&
        current?.state !== "Approved" &&
        !(current?.state === "InReview" && v.approvalPolicy === "NotRequired")
      )
        conflict();
      if (
        command.action === "ActivateScheduled" &&
        (current?.state !== "Scheduled" || current.scheduleReference !== command.scheduleReference)
      )
        conflict();
      if (
        command.effectivePeriod.effectiveFrom.instant > now ||
        (command.effectivePeriod.effectiveUntil !== null &&
          command.effectivePeriod.effectiveUntil.instant <= now) ||
        command.successorDraftVersionReference === null ||
        command.successorDraftVersionReference === command.versionReference
      )
        conflict();
      requireApproval();
      state = "Published";
      publishedAt = command.occurredAt;
      successorDraftVersionReference = command.successorDraftVersionReference;
      if (command.action === "ActivateScheduled") scheduleVersion++;
      break;
    case "Supersede":
      conflict();
  }
  return Object.freeze({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    productReference: command.productReference,
    versionReference: command.versionReference,
    publicationVersion: command.expectedPublicationVersion + 1,
    productAggregateVersion: facts.productAggregateVersion,
    state,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    scopeSet: command.scopeSet,
    scopeDigest: facts.scopeDigest,
    effectivePeriod: command.effectivePeriod,
    periodDigest: facts.periodDigest,
    validationEvidenceReference: v.evidenceReference,
    validationDecision: decision,
    policyReference: v.policyReference,
    policyVersion: v.policyVersion,
    approvalPolicy: v.approvalPolicy,
    reviewReference,
    reviewVersion,
    submittedByActorReference,
    approvalEvidenceReference,
    scheduleReference,
    scheduleVersion,
    publishedAt,
    supersededAt: null,
    supersededByVersionReference: null,
    successorDraftVersionReference,
    operationReference: command.operationReference,
    intentDigest,
    actorReference: command.actorReference,
    actorKind: command.actorKind,
    occurredAt: command.occurredAt,
    reasonCode: command.reasonCode,
  });
}
