import { CatalogError } from "./product.js";
export const productPublicationActions = [
  "Validate",
  "SubmitReview",
  "Approve",
  "Reject",
  "Publish",
  "SchedulePublish",
  "ReschedulePublish",
  "CancelScheduledPublish",
  "ActivateScheduled",
  "Supersede",
] as const;
export type ProductPublicationAction = (typeof productPublicationActions)[number];
export const productPublicationCheckCodes = [
  "DefaultLocaleName",
  "InternalCode",
  "PublishableSku",
  "VariantMapping",
  "OptionSelection",
  "MediaReady",
  "TaxResolution",
  "UniqueScope",
  "EffectivePeriod",
  "ChangeImpact",
  "ApprovalPolicy",
  "HardErrorsCleared",
] as const;
export type ProductPublicationCheckCode = (typeof productPublicationCheckCodes)[number];
export const productPublicationScopeLevels = [
  "Store",
  "StoreGroup",
  "Region",
  "Channel",
  "OrderType",
  "Brand",
] as const;
export type ProductPublicationScopeLevel = (typeof productPublicationScopeLevels)[number];
export interface ProductPublicationScope {
  readonly level: ProductPublicationScopeLevel;
  readonly reference: string | null;
  readonly channelCodes: readonly string[];
  readonly orderTypeCodes: readonly string[];
}
export interface ProductPublicationBoundary {
  readonly instant: string;
  readonly localDateTime: string;
  readonly utcOffsetMinutes: number;
}
export interface ProductPublicationPeriod {
  readonly timeZone: string;
  readonly effectiveFrom: ProductPublicationBoundary;
  readonly effectiveUntil: ProductPublicationBoundary | null;
}
export interface ProductPublicationCommand {
  readonly purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly operationReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly expectedProductAggregateVersion: number;
  readonly expectedPublicationVersion: number;
  readonly action: ProductPublicationAction;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly scopeSet: readonly ProductPublicationScope[];
  readonly effectivePeriod: ProductPublicationPeriod;
  readonly scheduleReference: string | null;
  readonly replacementVersionReference: string | null;
  readonly successorDraftVersionReference: string | null;
  readonly occurredAt: string;
  readonly reasonCode: string;
}
export interface ProductPublicationValidation {
  readonly evidenceReference: string;
  readonly productAggregateVersion: number;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly scopeDigest: string;
  readonly periodDigest: string;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly approvalPolicy: "Required" | "NotRequired";
  readonly checks: readonly {
    readonly code: ProductPublicationCheckCode;
    readonly outcome: "Pass" | "HardError" | "Warning";
  }[];
  readonly warningAcknowledgement: null | {
    readonly actorReference: string;
    readonly reasonCode: string;
    readonly warningCodes: readonly ProductPublicationCheckCode[];
  };
  readonly checkedAt: string;
  readonly validUntil: string;
}
export interface ProductPublicationApproval {
  readonly evidenceReference: string;
  readonly reviewReference: string;
  readonly reviewVersion: number;
  readonly requestedByActorReference: string;
  readonly approvedByActorReference: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly scopeDigest: string;
  readonly periodDigest: string;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly approvedAt: string;
  readonly validUntil: string;
}
export interface ProductPublicationVersion {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly publicationVersion: number;
  readonly productAggregateVersion: number;
  readonly state: "Draft" | "InReview" | "Approved" | "Scheduled" | "Published" | "Superseded";
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly scopeSet: readonly ProductPublicationScope[];
  readonly scopeDigest: string;
  readonly effectivePeriod: ProductPublicationPeriod;
  readonly periodDigest: string;
  readonly validationEvidenceReference: string;
  readonly validationDecision: "Pass" | "HardError" | "WarningAcknowledgementRequired";
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly approvalPolicy: "Required" | "NotRequired";
  readonly reviewReference: string | null;
  readonly reviewVersion: number | null;
  readonly submittedByActorReference: string | null;
  readonly approvalEvidenceReference: string | null;
  readonly scheduleReference: string | null;
  readonly scheduleVersion: number;
  readonly publishedAt: string | null;
  readonly supersededAt: string | null;
  readonly supersededByVersionReference: string | null;
  readonly successorDraftVersionReference: string | null;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly occurredAt: string;
  readonly reasonCode: string;
}
export interface ProductPublicationFacts {
  readonly now: string;
  readonly productAggregateVersion: number;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly scopeDigest: string;
  readonly periodDigest: string;
  readonly validation: ProductPublicationValidation;
  readonly approval: ProductPublicationApproval | null;
  readonly reviewReference: string | null;
  readonly replacement: null | {
    readonly productReference: string;
    readonly versionReference: string;
    readonly scopeDigest: string;
    readonly state: "Published";
    readonly publishedAt: string;
  };
}
function conflict(): never {
  throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
}
function fresh(checkedAt: string, validUntil: string, now: string) {
  if (checkedAt > now || validUntil <= now) conflict();
}
function validationDecision(
  v: ProductPublicationValidation,
): ProductPublicationVersion["validationDecision"] {
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
  return "Pass";
}
/** Application supplies parsed current owning facts under real authority/source leases.
 * This pure plan neither supplies permission nor persists an operation. */
export function planProductPublicationVersion(
  command: ProductPublicationCommand,
  current: ProductPublicationVersion | null,
  facts: ProductPublicationFacts,
  intentDigest: string,
): ProductPublicationVersion {
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
  const decision = validationDecision(v);
  if (
    command.action !== "Validate" &&
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
  let state: ProductPublicationVersion["state"] = current?.state ?? "Draft",
    reviewReference = current?.reviewReference ?? null,
    reviewVersion = current?.reviewVersion ?? null,
    submittedByActorReference = current?.submittedByActorReference ?? null,
    approvalEvidenceReference = current?.approvalEvidenceReference ?? null,
    scheduleReference = current?.scheduleReference ?? null,
    scheduleVersion = current?.scheduleVersion ?? 0,
    publishedAt = current?.publishedAt ?? null,
    supersededAt = current?.supersededAt ?? null,
    supersededByVersionReference = current?.supersededByVersionReference ?? null,
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
      if (current?.state !== "Draft" || facts.reviewReference === null) conflict();
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
    case "Supersede": {
      const replacement = facts.replacement;
      if (
        current?.state !== "Published" ||
        command.replacementVersionReference === null ||
        command.replacementVersionReference === command.versionReference ||
        !replacement ||
        replacement.productReference !== command.productReference ||
        replacement.versionReference !== command.replacementVersionReference ||
        replacement.scopeDigest !== current.scopeDigest ||
        replacement.publishedAt > now
      )
        conflict();
      state = "Superseded";
      supersededAt = command.occurredAt;
      supersededByVersionReference = command.replacementVersionReference;
      break;
    }
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
    supersededAt,
    supersededByVersionReference,
    successorDraftVersionReference,
    operationReference: command.operationReference,
    intentDigest,
    actorReference: command.actorReference,
    actorKind: command.actorKind,
    occurredAt: command.occurredAt,
    reasonCode: command.reasonCode,
  });
}
export interface ProductPublicationContext {
  readonly storeReference: string;
  readonly storeGroupReferences: readonly string[];
  readonly regionReferences: readonly string[];
  readonly channelCode: string;
  readonly orderTypeCode: string;
  readonly at: string;
}
/** Current policy supplies an explicit complete level order. Effective period filters
 * candidates; it never silently breaks ties. Version scopes are a union of selectors. */
export function resolveProductPublicationVersion(
  candidates: readonly Omit<ProductPublicationVersion, "validationDecision">[],
  context: ProductPublicationContext,
  scopeOrder: readonly ProductPublicationScopeLevel[],
) {
  if (
    scopeOrder.length !== productPublicationScopeLevels.length ||
    new Set(scopeOrder).size !== scopeOrder.length ||
    productPublicationScopeLevels.some((l) => !scopeOrder.includes(l))
  )
    conflict();
  const selected = candidates
    .filter(
      (c) =>
        (c.state === "Published" || c.state === "Superseded") &&
        c.publishedAt !== null &&
        c.publishedAt <= context.at &&
        (c.supersededAt === null || context.at < c.supersededAt) &&
        c.effectivePeriod.effectiveFrom.instant <= context.at &&
        (c.effectivePeriod.effectiveUntil === null ||
          context.at < c.effectivePeriod.effectiveUntil.instant),
    )
    .map((c) => {
      const ranks = c.scopeSet
        .filter(
          (s) =>
            (s.channelCodes.length === 0 || s.channelCodes.includes(context.channelCode)) &&
            (s.orderTypeCodes.length === 0 || s.orderTypeCodes.includes(context.orderTypeCode)) &&
            (s.level === "Brand" ||
              (s.level === "Store" && s.reference === context.storeReference) ||
              (s.level === "StoreGroup" &&
                s.reference !== null &&
                context.storeGroupReferences.includes(s.reference)) ||
              (s.level === "Region" &&
                s.reference !== null &&
                context.regionReferences.includes(s.reference)) ||
              (s.level === "Channel" && s.reference === context.channelCode) ||
              (s.level === "OrderType" && s.reference === context.orderTypeCode)),
        )
        .map((s) => scopeOrder.indexOf(s.level));
      return { c, rank: ranks.length === 0 ? Infinity : Math.min(...ranks) };
    })
    .filter((c) => c.rank !== Infinity);
  if (selected.length === 0)
    return Object.freeze({
      outcome: "Unavailable" as const,
      reason: "NO_EFFECTIVE_PRODUCT_VERSION" as const,
    });
  const rank = Math.min(...selected.map((s) => s.rank)),
    matches = selected.filter((s) => s.rank === rank),
    versions = [...new Set(matches.map((s) => s.c.versionReference))].sort();
  if (versions.length !== 1)
    return Object.freeze({
      outcome: "Conflict" as const,
      reason: "AMBIGUOUS_PRODUCT_VERSION_SCOPE" as const,
      versionReferences: Object.freeze(versions),
    });
  const match = matches[0];
  if (!match) conflict();
  return Object.freeze({
    outcome: "Selected" as const,
    versionReference: match.c.versionReference,
    contentDigest: match.c.contentDigest,
    configurationDigest: match.c.configurationDigest,
  });
}
