import {
  DeliveryTaskError,
  deliveryInstant,
  deliveryReference,
  type DeliveryInstant,
  type DeliveryReference,
} from "./delivery-task.js";

export type DeliveryRevisionKind = "Ordinary" | "Critical";
export type DeliveryOperationalPhase =
  "Pending" | "Planned" | "Ready" | "InProgress" | "Completed" | "Failed" | "Cancelled";
export interface DeliveryPromiseWindow {
  readonly type: "ASAP" | "Scheduled";
  readonly startUtc: DeliveryInstant;
  readonly endUtc: DeliveryInstant;
  readonly storeTimeZone: string;
}
export interface DeliveryOperationalSnapshot {
  readonly snapshotReference: DeliveryReference;
  readonly stableAddressReference: DeliveryReference;
  readonly validatedAddressEvidenceReference: DeliveryReference;
  readonly addressFingerprint: string;
  readonly geocodeEvidenceReference: DeliveryReference;
  readonly maskedAddress: string;
  readonly contactEvidenceReference: DeliveryReference;
  readonly maskedContact: string;
  readonly instructionEvidenceReference: DeliveryReference;
  readonly requestedWindow: DeliveryPromiseWindow;
  readonly confirmedWindow: DeliveryPromiseWindow;
  readonly capacityAllocationReference: DeliveryReference;
  readonly feeQuoteReference: DeliveryReference;
  readonly taxQuoteReference: DeliveryReference;
  readonly deliveryVerificationMethodReference: DeliveryReference;
  readonly acceptedAt: DeliveryInstant;
}
export interface DeliverySnapshotRevision {
  readonly revisionReference: DeliveryReference;
  readonly version: number;
  readonly kind: DeliveryRevisionKind;
  readonly reasonCode: string;
  readonly actorReference: DeliveryReference;
  readonly requestedAt: DeliveryInstant;
  readonly priorSnapshotReference: DeliveryReference;
  readonly proposedSnapshotReference: DeliveryReference;
  readonly outcome: "Accepted" | "Rejected";
  readonly rejectionCode: string | null;
  readonly validationEvidenceReferences: readonly DeliveryReference[];
}
export interface DeliveryDetail {
  readonly taskReference: DeliveryReference;
  readonly tenantReference: DeliveryReference;
  readonly brandReference: DeliveryReference;
  readonly storeReference: DeliveryReference;
  readonly originalSnapshot: DeliveryOperationalSnapshot;
  readonly currentSnapshot: DeliveryOperationalSnapshot;
  readonly revisions: readonly DeliverySnapshotRevision[];
  readonly aggregateVersion: number;
  readonly updatedAt: DeliveryInstant;
}
const fail = (code: DeliveryTaskError["code"] = "INVALID"): never => {
  throw new DeliveryTaskError(code);
};
const safeText = (value: unknown, pattern: RegExp, max: number) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length <= max &&
  pattern.test(value) &&
  !/[<>{}$\p{Cc}\p{Cf}]/u.test(value)
    ? value
    : fail();
const reason = (value: unknown) => safeText(value, /^[A-Z][A-Z0-9_]{1,63}$/u, 64);
const fingerprint = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : fail();
const timeZone = (value: unknown) => safeText(value, /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u, 100);
const masked = (value: unknown) => safeText(value, /^[^@]{1,120}$/u, 120);
const refs = (values: readonly unknown[]) =>
  Object.freeze(values.map((value) => deliveryReference(value)));
export function deliveryPromiseWindow(value: {
  type: "ASAP" | "Scheduled";
  startUtc: unknown;
  endUtc: unknown;
  storeTimeZone: unknown;
}): DeliveryPromiseWindow {
  const startUtc = deliveryInstant(value.startUtc),
    endUtc = deliveryInstant(value.endUtc);
  if (startUtc >= endUtc) fail();
  return Object.freeze({
    type: value.type,
    startUtc,
    endUtc,
    storeTimeZone: timeZone(value.storeTimeZone),
  });
}
export function deliveryOperationalSnapshot(input: {
  snapshotReference: unknown;
  stableAddressReference: unknown;
  validatedAddressEvidenceReference: unknown;
  addressFingerprint: unknown;
  geocodeEvidenceReference: unknown;
  maskedAddress: unknown;
  contactEvidenceReference: unknown;
  maskedContact: unknown;
  instructionEvidenceReference: unknown;
  requestedWindow: Parameters<typeof deliveryPromiseWindow>[0];
  confirmedWindow: Parameters<typeof deliveryPromiseWindow>[0];
  capacityAllocationReference: unknown;
  feeQuoteReference: unknown;
  taxQuoteReference: unknown;
  deliveryVerificationMethodReference: unknown;
  acceptedAt: unknown;
}): DeliveryOperationalSnapshot {
  return Object.freeze({
    snapshotReference: deliveryReference(input.snapshotReference),
    stableAddressReference: deliveryReference(input.stableAddressReference),
    validatedAddressEvidenceReference: deliveryReference(input.validatedAddressEvidenceReference),
    addressFingerprint: fingerprint(input.addressFingerprint),
    geocodeEvidenceReference: deliveryReference(input.geocodeEvidenceReference),
    maskedAddress: masked(input.maskedAddress),
    contactEvidenceReference: deliveryReference(input.contactEvidenceReference),
    maskedContact: masked(input.maskedContact),
    instructionEvidenceReference: deliveryReference(input.instructionEvidenceReference),
    requestedWindow: deliveryPromiseWindow(input.requestedWindow),
    confirmedWindow: deliveryPromiseWindow(input.confirmedWindow),
    capacityAllocationReference: deliveryReference(input.capacityAllocationReference),
    feeQuoteReference: deliveryReference(input.feeQuoteReference),
    taxQuoteReference: deliveryReference(input.taxQuoteReference),
    deliveryVerificationMethodReference: deliveryReference(
      input.deliveryVerificationMethodReference,
    ),
    acceptedAt: deliveryInstant(input.acceptedAt),
  });
}
export function createDeliveryDetail(input: {
  taskReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  storeReference: unknown;
  snapshot: DeliveryOperationalSnapshot;
}): DeliveryDetail {
  return Object.freeze({
    taskReference: deliveryReference(input.taskReference),
    tenantReference: deliveryReference(input.tenantReference),
    brandReference: deliveryReference(input.brandReference),
    storeReference: deliveryReference(input.storeReference),
    originalSnapshot: input.snapshot,
    currentSnapshot: input.snapshot,
    revisions: Object.freeze([]),
    aggregateVersion: 1,
    updatedAt: input.snapshot.acceptedAt,
  });
}
export function reviseDeliverySnapshot(
  detail: DeliveryDetail,
  input: {
    expectedVersion: number;
    revisionReference: unknown;
    kind: DeliveryRevisionKind;
    reasonCode: unknown;
    actorReference: unknown;
    requestedAt: unknown;
    revisionCutoff: unknown;
    operationalPhase: DeliveryOperationalPhase;
    proposedSnapshot: DeliveryOperationalSnapshot;
    validation: {
      addressValidated: boolean;
      serviceAreaEligible: boolean;
      etaAccepted: boolean;
      pricingAccepted: boolean;
      capacityAccepted: boolean;
      orderAmendmentAccepted: boolean;
      providerAccepted: boolean;
      managerAuthorized: boolean;
      hardBlocked: boolean;
      evidenceReferences: readonly unknown[];
    };
  },
): DeliveryDetail {
  if (detail.aggregateVersion !== input.expectedVersion) fail("CONFLICT");
  const requestedAt = deliveryInstant(input.requestedAt),
    cutoff = deliveryInstant(input.revisionCutoff);
  if (
    requestedAt >= cutoff ||
    ["Completed", "Failed", "Cancelled"].includes(input.operationalPhase)
  )
    fail("DEADLINE_EXCEEDED");
  const critical = input.kind === "Critical";
  const valid =
    !input.validation.hardBlocked &&
    input.validation.evidenceReferences.length > 0 &&
    (!critical ||
      (input.validation.addressValidated &&
        input.validation.serviceAreaEligible &&
        input.validation.etaAccepted &&
        input.validation.pricingAccepted &&
        input.validation.capacityAccepted &&
        input.validation.orderAmendmentAccepted &&
        (input.operationalPhase !== "InProgress" ||
          (input.validation.managerAuthorized && input.validation.providerAccepted))));
  const revision: DeliverySnapshotRevision = Object.freeze({
    revisionReference: deliveryReference(input.revisionReference),
    version: detail.revisions.length + 1,
    kind: input.kind,
    reasonCode: reason(input.reasonCode),
    actorReference: deliveryReference(input.actorReference),
    requestedAt,
    priorSnapshotReference: detail.currentSnapshot.snapshotReference,
    proposedSnapshotReference: input.proposedSnapshot.snapshotReference,
    outcome: valid ? "Accepted" : "Rejected",
    rejectionCode: valid ? null : input.validation.hardBlocked ? "HARD_BLOCK" : "PROOF_REQUIRED",
    validationEvidenceReferences: refs(input.validation.evidenceReferences),
  });
  return Object.freeze({
    ...detail,
    currentSnapshot: valid ? input.proposedSnapshot : detail.currentSnapshot,
    revisions: Object.freeze([...detail.revisions, revision]),
    aggregateVersion: detail.aggregateVersion + 1,
    updatedAt: requestedAt,
  });
}
