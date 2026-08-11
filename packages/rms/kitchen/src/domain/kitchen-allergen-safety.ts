import type { KitchenStartAdmissionDecision } from "./kitchen-work-lifecycle.js";
import {
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
  type KitchenDigest,
  type KitchenInstant,
  type KitchenReference,
} from "./kitchen-ticket.js";

export const kitchenAllergenSafetyPermission = "kitchen.operate" as const;
export const kitchenAllergenSafetyClassification = "Restricted" as const;
export const kitchenAllergenSafetyRetentionMonths = 24 as const;

export const kitchenAllergenSafetyErrorCodes = [
  "KITCHEN_ALLERGEN_INPUT_INVALID",
  "KITCHEN_ALLERGEN_REVIEW_REQUIRED",
  "KITCHEN_ALLERGEN_REVIEW_EXPIRED",
  "KITCHEN_ALLERGEN_CONFIGURATION_CHANGED",
  "KITCHEN_ALLERGEN_ACCOMMODATION_DENIED",
  "KITCHEN_ALLERGEN_ACKNOWLEDGEMENT_REQUIRED",
  "KITCHEN_ALLERGEN_INCIDENT_LINK_INCOMPLETE",
] as const;

export type KitchenAllergenSafetyErrorCode = (typeof kitchenAllergenSafetyErrorCodes)[number];

export class KitchenAllergenSafetyError extends Error {
  constructor(readonly code: KitchenAllergenSafetyErrorCode) {
    super("kitchen allergen safety gate is unavailable");
    this.name = "KitchenAllergenSafetyError";
  }
}

export interface KitchenAllergenReview {
  readonly reviewReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly configurationDigest: KitchenDigest;
  readonly allergenReferences: readonly [KitchenReference, ...KitchenReference[]];
  readonly policyVersionReference: KitchenReference;
  readonly recipeVersionReferences: readonly [KitchenReference, ...KitchenReference[]];
  readonly reviewerActorReference: KitchenReference;
  readonly outcome: "Accepted" | "CannotSafelyAccommodate";
  readonly reviewedAt: KitchenInstant;
  readonly validUntil: KitchenInstant;
  readonly retainUntil: KitchenInstant;
  readonly classification: "Restricted";
}

export interface KitchenAllergenAcknowledgement {
  readonly acknowledgementReference: KitchenReference;
  readonly reviewReference: KitchenReference;
  readonly reviewDigest: KitchenDigest;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly workItemReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly configurationDigest: KitchenDigest;
  readonly stage: "BeforeStart" | "BeforeHandoff";
  readonly operatorActorReference: KitchenReference;
  readonly acknowledgedAt: KitchenInstant;
  readonly classification: "Restricted";
}

export interface KitchenAllergenIncidentLink {
  readonly incidentLinkReference: KitchenReference;
  readonly reviewReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly ticketReference: KitchenReference;
  readonly orderItemReference: KitchenReference;
  readonly incidentType: "AllergenMismatch" | "UnapprovedSubstitution" | "AllergenExposure";
  readonly configurationSnapshotDigest: KitchenDigest;
  readonly recipeSnapshotDigest: KitchenDigest;
  readonly handlingSnapshotDigest: KitchenDigest;
  readonly complianceCaseReference: KitchenReference;
  readonly availabilityKillSwitchActionReference: KitchenReference;
  readonly reporterActorReference: KitchenReference;
  readonly reportedAt: KitchenInstant;
  readonly classification: "Restricted";
}

export interface KitchenAllergenKdsCue {
  readonly cueCode: "ALLERGEN_ASSISTANCE";
  readonly priority: "High";
  readonly textToken: "KITCHEN_ALLERGEN_ASSISTANCE";
  readonly iconToken: "warning-triangle";
  readonly nonColorIndicator: true;
  readonly reviewReference: KitchenReference;
  readonly allergenReferences: readonly [KitchenReference, ...KitchenReference[]];
  readonly reviewOutcome: "Accepted" | "CannotSafelyAccommodate";
  readonly configurationStatus: "Current" | "Changed";
  readonly reviewStatus: "Current" | "Expired";
  readonly startAcknowledgementRequired: boolean;
  readonly handoffAcknowledgementRequired: boolean;
  readonly executionBlocked: boolean;
}

export interface KitchenAllergenDigestPort {
  sha256(canonicalValue: string): string;
}

function invalid(): never {
  throw new KitchenAllergenSafetyError("KITCHEN_ALLERGEN_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenAllergenSafetyError) throw error;
    return invalid();
  }
}

function reference(value: unknown): KitchenReference {
  try {
    return parseKitchenTicketReference(value);
  } catch {
    return invalid();
  }
}

function digest(value: unknown): KitchenDigest {
  try {
    return parseKitchenTicketDigest(value);
  } catch {
    return invalid();
  }
}

function instant(value: unknown): KitchenInstant {
  try {
    return parseKitchenTicketInstant(value);
  } catch {
    return invalid();
  }
}

function references(value: unknown): readonly [KitchenReference, ...KitchenReference[]] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return invalid();
  const parsed = value.map(reference);
  if (
    new Set(parsed).size !== parsed.length ||
    parsed.some((item, index) => index > 0 && item <= (parsed[index - 1] ?? item))
  )
    return invalid();
  return Object.freeze(parsed) as unknown as readonly [KitchenReference, ...KitchenReference[]];
}

function reviewFields(): readonly string[] {
  return [
    "reviewReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "ticketReference",
    "orderItemReference",
    "configurationDigest",
    "allergenReferences",
    "policyVersionReference",
    "recipeVersionReferences",
    "reviewerActorReference",
    "outcome",
    "reviewedAt",
    "validUntil",
    "retainUntil",
    "classification",
  ];
}

export function parseKitchenAllergenReview(value: unknown): KitchenAllergenReview {
  const raw = exact(value, reviewFields());
  if (
    (raw.outcome !== "Accepted" && raw.outcome !== "CannotSafelyAccommodate") ||
    raw.classification !== kitchenAllergenSafetyClassification
  )
    return invalid();
  const reviewedAt = instant(raw.reviewedAt);
  const validUntil = instant(raw.validUntil);
  const retainUntil = instant(raw.retainUntil);
  if (
    Date.parse(reviewedAt) >= Date.parse(validUntil) ||
    Date.parse(validUntil) > Date.parse(retainUntil) ||
    Date.parse(retainUntil) > Date.parse(reviewedAt) + 732 * 86_400_000
  )
    return invalid();
  return Object.freeze({
    reviewReference: reference(raw.reviewReference),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    orderReference: reference(raw.orderReference),
    ticketReference: reference(raw.ticketReference),
    orderItemReference: reference(raw.orderItemReference),
    configurationDigest: digest(raw.configurationDigest),
    allergenReferences: references(raw.allergenReferences),
    policyVersionReference: reference(raw.policyVersionReference),
    recipeVersionReferences: references(raw.recipeVersionReferences),
    reviewerActorReference: reference(raw.reviewerActorReference),
    outcome: raw.outcome,
    reviewedAt,
    validUntil,
    retainUntil,
    classification: kitchenAllergenSafetyClassification,
  });
}

function acknowledgementMatches(
  value: KitchenAllergenAcknowledgement | null,
  review: KitchenAllergenReview,
  stage: KitchenAllergenAcknowledgement["stage"],
  digests: KitchenAllergenDigestPort,
): boolean {
  if (value === null) return false;
  const acknowledgement = parseKitchenAllergenAcknowledgement(value);
  return (
    acknowledgement.stage === stage &&
    acknowledgement.reviewReference === review.reviewReference &&
    acknowledgement.reviewDigest ===
      digest(digests.sha256(createKitchenAllergenReviewDigestBinding(review))) &&
    acknowledgement.brandReference === review.brandReference &&
    acknowledgement.storeReference === review.storeReference &&
    acknowledgement.ticketReference === review.ticketReference &&
    acknowledgement.orderItemReference === review.orderItemReference &&
    acknowledgement.configurationDigest === review.configurationDigest
  );
}

export function buildKitchenAllergenKdsCue(input: {
  readonly review: KitchenAllergenReview;
  readonly currentConfigurationDigest: string;
  readonly observedAt: string;
  readonly startAcknowledgement: KitchenAllergenAcknowledgement | null;
  readonly handoffAcknowledgement: KitchenAllergenAcknowledgement | null;
  readonly digests: KitchenAllergenDigestPort;
}): KitchenAllergenKdsCue {
  const review = parseKitchenAllergenReview(input.review);
  const observedAt = instant(input.observedAt);
  const configurationStatus =
    digest(input.currentConfigurationDigest) === review.configurationDigest ? "Current" : "Changed";
  const reviewStatus =
    Date.parse(observedAt) < Date.parse(review.validUntil) ? "Current" : "Expired";
  const startAcknowledged = acknowledgementMatches(
    input.startAcknowledgement,
    review,
    "BeforeStart",
    input.digests,
  );
  const handoffAcknowledged = acknowledgementMatches(
    input.handoffAcknowledgement,
    review,
    "BeforeHandoff",
    input.digests,
  );
  return Object.freeze({
    cueCode: "ALLERGEN_ASSISTANCE",
    priority: "High",
    textToken: "KITCHEN_ALLERGEN_ASSISTANCE",
    iconToken: "warning-triangle",
    nonColorIndicator: true,
    reviewReference: review.reviewReference,
    allergenReferences: review.allergenReferences,
    reviewOutcome: review.outcome,
    configurationStatus,
    reviewStatus,
    startAcknowledgementRequired: !startAcknowledged,
    handoffAcknowledgementRequired: !handoffAcknowledged,
    executionBlocked:
      review.outcome !== "Accepted" ||
      configurationStatus !== "Current" ||
      reviewStatus !== "Current",
  });
}

export function createKitchenAllergenReviewDigestBinding(review: KitchenAllergenReview): string {
  const value = parseKitchenAllergenReview(review);
  return [
    "kitchen-allergen-review-v1",
    value.reviewReference,
    value.brandReference,
    value.storeReference,
    value.orderReference,
    value.ticketReference,
    value.orderItemReference,
    value.configurationDigest,
    value.allergenReferences.join(","),
    value.policyVersionReference,
    value.recipeVersionReferences.join(","),
    value.reviewerActorReference,
    value.outcome,
    value.reviewedAt,
    value.validUntil,
    value.retainUntil,
    value.classification,
  ].join("\u001f");
}

export function parseKitchenAllergenAcknowledgement(
  value: unknown,
): KitchenAllergenAcknowledgement {
  const raw = exact(value, [
    "acknowledgementReference",
    "reviewReference",
    "reviewDigest",
    "brandReference",
    "storeReference",
    "ticketReference",
    "workItemReference",
    "orderItemReference",
    "configurationDigest",
    "stage",
    "operatorActorReference",
    "acknowledgedAt",
    "classification",
  ]);
  if (
    (raw.stage !== "BeforeStart" && raw.stage !== "BeforeHandoff") ||
    raw.classification !== kitchenAllergenSafetyClassification
  )
    return invalid();
  return Object.freeze({
    acknowledgementReference: reference(raw.acknowledgementReference),
    reviewReference: reference(raw.reviewReference),
    reviewDigest: digest(raw.reviewDigest),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    ticketReference: reference(raw.ticketReference),
    workItemReference: reference(raw.workItemReference),
    orderItemReference: reference(raw.orderItemReference),
    configurationDigest: digest(raw.configurationDigest),
    stage: raw.stage,
    operatorActorReference: reference(raw.operatorActorReference),
    acknowledgedAt: instant(raw.acknowledgedAt),
    classification: kitchenAllergenSafetyClassification,
  });
}

export function createKitchenAllergenAcknowledgement(input: {
  readonly acknowledgementReference: string;
  readonly review: KitchenAllergenReview;
  readonly workItemReference: string;
  readonly stage: "BeforeStart" | "BeforeHandoff";
  readonly operatorActorReference: string;
  readonly acknowledgedAt: string;
  readonly configurationDigest: string;
  readonly digests: KitchenAllergenDigestPort;
}): KitchenAllergenAcknowledgement {
  const review = parseKitchenAllergenReview(input.review);
  if (review.outcome !== "Accepted")
    throw new KitchenAllergenSafetyError("KITCHEN_ALLERGEN_ACCOMMODATION_DENIED");
  const acknowledgedAt = instant(input.acknowledgedAt);
  if (Date.parse(acknowledgedAt) >= Date.parse(review.validUntil))
    throw new KitchenAllergenSafetyError("KITCHEN_ALLERGEN_REVIEW_EXPIRED");
  if (digest(input.configurationDigest) !== review.configurationDigest)
    throw new KitchenAllergenSafetyError("KITCHEN_ALLERGEN_CONFIGURATION_CHANGED");
  return parseKitchenAllergenAcknowledgement({
    acknowledgementReference: input.acknowledgementReference,
    reviewReference: review.reviewReference,
    reviewDigest: digest(input.digests.sha256(createKitchenAllergenReviewDigestBinding(review))),
    brandReference: review.brandReference,
    storeReference: review.storeReference,
    ticketReference: review.ticketReference,
    workItemReference: input.workItemReference,
    orderItemReference: review.orderItemReference,
    configurationDigest: review.configurationDigest,
    stage: input.stage,
    operatorActorReference: input.operatorActorReference,
    acknowledgedAt,
    classification: kitchenAllergenSafetyClassification,
  });
}

export function createKitchenAllergenStartAdmission(input: {
  readonly review: KitchenAllergenReview;
  readonly acknowledgement: KitchenAllergenAcknowledgement;
  readonly decisionReference: string;
  readonly decisionVersion: number;
  readonly acceptedOperationReference: string;
  readonly ticketVersion: bigint;
  readonly workItemVersion: bigint;
  readonly evaluatedAt: string;
  readonly validUntil: string;
  readonly digests: KitchenAllergenDigestPort;
}): KitchenStartAdmissionDecision {
  const review = parseKitchenAllergenReview(input.review);
  const acknowledgement = parseKitchenAllergenAcknowledgement(input.acknowledgement);
  const evaluatedAt = instant(input.evaluatedAt);
  const validUntil = instant(input.validUntil);
  const expectedReviewDigest = digest(
    input.digests.sha256(createKitchenAllergenReviewDigestBinding(review)),
  );
  if (review.outcome !== "Accepted")
    throw new KitchenAllergenSafetyError("KITCHEN_ALLERGEN_ACCOMMODATION_DENIED");
  if (
    acknowledgement.stage !== "BeforeStart" ||
    acknowledgement.reviewReference !== review.reviewReference ||
    acknowledgement.reviewDigest !== expectedReviewDigest ||
    acknowledgement.configurationDigest !== review.configurationDigest ||
    acknowledgement.brandReference !== review.brandReference ||
    acknowledgement.storeReference !== review.storeReference ||
    acknowledgement.ticketReference !== review.ticketReference ||
    acknowledgement.orderItemReference !== review.orderItemReference ||
    Date.parse(acknowledgement.acknowledgedAt) > Date.parse(evaluatedAt)
  )
    throw new KitchenAllergenSafetyError("KITCHEN_ALLERGEN_ACKNOWLEDGEMENT_REQUIRED");
  if (Date.parse(evaluatedAt) >= Date.parse(review.validUntil))
    throw new KitchenAllergenSafetyError("KITCHEN_ALLERGEN_REVIEW_EXPIRED");
  if (
    Date.parse(evaluatedAt) >= Date.parse(validUntil) ||
    Date.parse(validUntil) > Date.parse(review.validUntil)
  )
    return invalid();
  const decisionDigest = digest(
    input.digests.sha256(
      [
        "kitchen-allergen-start-admission-v1",
        review.reviewReference,
        expectedReviewDigest,
        acknowledgement.acknowledgementReference,
        acknowledgement.operatorActorReference,
        input.acceptedOperationReference,
        String(input.ticketVersion),
        String(input.workItemVersion),
        evaluatedAt,
        validUntil,
      ].join("\u001f"),
    ),
  );
  return Object.freeze({
    decisionReference: reference(input.decisionReference),
    decisionVersion: input.decisionVersion,
    decisionDigest,
    producerContractVersion: 1,
    actorReference: acknowledgement.operatorActorReference,
    brandReference: review.brandReference,
    storeReference: review.storeReference,
    ticketReference: review.ticketReference,
    workItemReference: acknowledgement.workItemReference,
    acceptedOperationReference: reference(input.acceptedOperationReference),
    ticketVersion: input.ticketVersion,
    workItemVersion: input.workItemVersion,
    action: "StartKitchenWorkItem",
    purpose: "KitchenWorkExecution",
    outcome: "Allowed",
    evaluatedAt,
    validUntil,
  });
}

export function parseKitchenAllergenIncidentLink(value: unknown): KitchenAllergenIncidentLink {
  const raw = exact(value, [
    "incidentLinkReference",
    "reviewReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "ticketReference",
    "orderItemReference",
    "incidentType",
    "configurationSnapshotDigest",
    "recipeSnapshotDigest",
    "handlingSnapshotDigest",
    "complianceCaseReference",
    "availabilityKillSwitchActionReference",
    "reporterActorReference",
    "reportedAt",
    "classification",
  ]);
  if (
    !["AllergenMismatch", "UnapprovedSubstitution", "AllergenExposure"].includes(
      raw.incidentType as string,
    ) ||
    raw.classification !== kitchenAllergenSafetyClassification
  )
    throw new KitchenAllergenSafetyError("KITCHEN_ALLERGEN_INCIDENT_LINK_INCOMPLETE");
  return Object.freeze({
    incidentLinkReference: reference(raw.incidentLinkReference),
    reviewReference: reference(raw.reviewReference),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    orderReference: reference(raw.orderReference),
    ticketReference: reference(raw.ticketReference),
    orderItemReference: reference(raw.orderItemReference),
    incidentType: raw.incidentType as KitchenAllergenIncidentLink["incidentType"],
    configurationSnapshotDigest: digest(raw.configurationSnapshotDigest),
    recipeSnapshotDigest: digest(raw.recipeSnapshotDigest),
    handlingSnapshotDigest: digest(raw.handlingSnapshotDigest),
    complianceCaseReference: reference(raw.complianceCaseReference),
    availabilityKillSwitchActionReference: reference(raw.availabilityKillSwitchActionReference),
    reporterActorReference: reference(raw.reporterActorReference),
    reportedAt: instant(raw.reportedAt),
    classification: kitchenAllergenSafetyClassification,
  });
}

export function createKitchenAllergenIncidentLink(input: {
  readonly incidentLinkReference: string;
  readonly review: KitchenAllergenReview;
  readonly incidentType: KitchenAllergenIncidentLink["incidentType"];
  readonly configurationSnapshotDigest: string;
  readonly recipeSnapshotDigest: string;
  readonly handlingSnapshotDigest: string;
  readonly complianceCaseReference: string;
  readonly availabilityKillSwitchActionReference: string;
  readonly reporterActorReference: string;
  readonly reportedAt: string;
}): KitchenAllergenIncidentLink {
  const review = parseKitchenAllergenReview(input.review);
  if (digest(input.configurationSnapshotDigest) !== review.configurationDigest)
    throw new KitchenAllergenSafetyError("KITCHEN_ALLERGEN_CONFIGURATION_CHANGED");
  return parseKitchenAllergenIncidentLink({
    incidentLinkReference: input.incidentLinkReference,
    reviewReference: review.reviewReference,
    brandReference: review.brandReference,
    storeReference: review.storeReference,
    orderReference: review.orderReference,
    ticketReference: review.ticketReference,
    orderItemReference: review.orderItemReference,
    incidentType: input.incidentType,
    configurationSnapshotDigest: input.configurationSnapshotDigest,
    recipeSnapshotDigest: input.recipeSnapshotDigest,
    handlingSnapshotDigest: input.handlingSnapshotDigest,
    complianceCaseReference: input.complianceCaseReference,
    availabilityKillSwitchActionReference: input.availabilityKillSwitchActionReference,
    reporterActorReference: input.reporterActorReference,
    reportedAt: input.reportedAt,
    classification: kitchenAllergenSafetyClassification,
  });
}
