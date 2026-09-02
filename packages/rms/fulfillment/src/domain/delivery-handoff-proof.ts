import {
  DeliveryTaskError,
  deliveryInstant,
  deliveryReference,
  type DeliveryInstant,
  type DeliveryReference,
} from "./delivery-task.js";
export type DeliveryProofMethod =
  | "OTP"
  | "Signature"
  | "Photo"
  | "QR"
  | "RecipientConfirmation"
  | "ProviderAttestation"
  | "ManagerOverride";
export type DeliveryEvidenceStatus = "Pending" | "Validated" | "NeedsReview" | "Rejected";
export interface CourierPickupHandoff {
  readonly handoffReference: DeliveryReference;
  readonly taskReference: DeliveryReference;
  readonly assignmentAttemptReference: DeliveryReference;
  readonly assignmentVersion: number;
  readonly staffActorReference: DeliveryReference;
  readonly courierOrProviderReference: DeliveryReference;
  readonly packageReferences: readonly DeliveryReference[];
  readonly itemResultReferences: readonly DeliveryReference[];
  readonly sealEvidenceReference: DeliveryReference;
  readonly occurredAt: DeliveryInstant;
  readonly status: DeliveryEvidenceStatus;
  readonly custodyExceptionRequired: boolean;
}
export interface DeliveryProof {
  readonly proofReference: DeliveryReference;
  readonly revision: number;
  readonly taskReference: DeliveryReference;
  readonly assignmentReference: DeliveryReference;
  readonly policyVersionReference: DeliveryReference;
  readonly methods: readonly DeliveryProofMethod[];
  readonly recipientType: "Customer" | "AuthorizedRecipient" | "LeaveAtDoor";
  readonly assetReferences: readonly DeliveryReference[];
  readonly integrityHashes: readonly string[];
  readonly deliveredAt: DeliveryInstant;
  readonly createdAt: DeliveryInstant;
  readonly status: DeliveryEvidenceStatus;
  readonly riskFlag: boolean;
}
const fail = (code: DeliveryTaskError["code"] = "INVALID"): never => {
  throw new DeliveryTaskError(code);
};
const refs = (values: readonly unknown[]) => Object.freeze(values.map(deliveryReference));
const hashes = (values: readonly unknown[]) =>
  Object.freeze(
    values.map((value) =>
      typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : fail(),
    ),
  );
export function recordCourierPickupHandoff(input: {
  handoffReference: unknown;
  taskReference: unknown;
  assignmentAttemptReference: unknown;
  assignmentVersion: number;
  currentAssignmentVersion: number;
  assignmentStatus: string;
  staffActorReference: unknown;
  courierOrProviderReference: unknown;
  packageReferences: readonly unknown[];
  expectedPackageCount: number;
  itemResultReferences: readonly unknown[];
  allItemsReadyAndComplete: boolean;
  sealEvidenceReference: unknown;
  staffConfirmed: boolean;
  courierOrProviderConfirmed: boolean;
  itemsMayHaveLeftStore: boolean;
  technicalFailure: boolean;
  occurredAt: unknown;
}): CourierPickupHandoff {
  if (
    !Number.isSafeInteger(input.assignmentVersion) ||
    input.assignmentVersion !== input.currentAssignmentVersion ||
    input.assignmentStatus !== "Accepted"
  )
    fail("CONFLICT");
  if (
    !Number.isSafeInteger(input.expectedPackageCount) ||
    input.expectedPackageCount <= 0 ||
    input.packageReferences.length === 0
  )
    fail("PROOF_REQUIRED");
  const complete =
    input.packageReferences.length === input.expectedPackageCount &&
    input.itemResultReferences.length > 0 &&
    input.allItemsReadyAndComplete &&
    input.staffConfirmed &&
    input.courierOrProviderConfirmed;
  const uncertain = input.technicalFailure || (input.itemsMayHaveLeftStore && !complete);
  return Object.freeze({
    handoffReference: deliveryReference(input.handoffReference),
    taskReference: deliveryReference(input.taskReference),
    assignmentAttemptReference: deliveryReference(input.assignmentAttemptReference),
    assignmentVersion: input.assignmentVersion,
    staffActorReference: deliveryReference(input.staffActorReference),
    courierOrProviderReference: deliveryReference(input.courierOrProviderReference),
    packageReferences: refs(input.packageReferences),
    itemResultReferences: refs(input.itemResultReferences),
    sealEvidenceReference: deliveryReference(input.sealEvidenceReference),
    occurredAt: deliveryInstant(input.occurredAt),
    status: complete ? "Validated" : uncertain ? "NeedsReview" : "Rejected",
    custodyExceptionRequired: uncertain,
  });
}
export function recordDeliveryProof(input: {
  proofReference: unknown;
  revision: number;
  taskReference: unknown;
  assignmentReference: unknown;
  policyVersionReference: unknown;
  requiredMethodGroups: readonly (readonly DeliveryProofMethod[])[];
  methods: readonly DeliveryProofMethod[];
  recipientType: DeliveryProof["recipientType"];
  assetReferences: readonly unknown[];
  integrityHashes: readonly unknown[];
  deliveredAt: unknown;
  createdAt: unknown;
  locationAccepted: boolean;
  quantitiesAccepted: boolean;
  recipientAccepted: boolean;
  providerEvidenceAccepted: boolean;
  technicalIndeterminate: boolean;
  managerOverride: {
    managerReference: unknown;
    executorReference: unknown;
    secondApproverReference: unknown | null;
    hardRequirement: boolean;
    highRisk: boolean;
  } | null;
}): DeliveryProof {
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.assetReferences.length !== input.integrityHashes.length
  )
    fail("PROOF_REQUIRED");
  const methodsSatisfied = input.requiredMethodGroups.every((group) =>
    group.some((method) => input.methods.includes(method)),
  );
  let overrideAccepted = false;
  if (input.managerOverride) {
    const manager = deliveryReference(input.managerOverride.managerReference),
      executor = deliveryReference(input.managerOverride.executorReference);
    overrideAccepted =
      !input.managerOverride.hardRequirement &&
      manager !== executor &&
      (!input.managerOverride.highRisk || input.managerOverride.secondApproverReference !== null);
  }
  const valid =
    (methodsSatisfied || overrideAccepted) &&
    input.locationAccepted &&
    input.quantitiesAccepted &&
    input.recipientAccepted &&
    input.providerEvidenceAccepted;
  const status: DeliveryEvidenceStatus = input.technicalIndeterminate
    ? "NeedsReview"
    : valid
      ? "Validated"
      : "Rejected";
  return Object.freeze({
    proofReference: deliveryReference(input.proofReference),
    revision: input.revision,
    taskReference: deliveryReference(input.taskReference),
    assignmentReference: deliveryReference(input.assignmentReference),
    policyVersionReference: deliveryReference(input.policyVersionReference),
    methods: Object.freeze([...input.methods]),
    recipientType: input.recipientType,
    assetReferences: refs(input.assetReferences),
    integrityHashes: hashes(input.integrityHashes),
    deliveredAt: deliveryInstant(input.deliveredAt),
    createdAt: deliveryInstant(input.createdAt),
    status,
    riskFlag: input.managerOverride !== null,
  });
}
export function authorizeDeliveryCompleted(proof: DeliveryProof) {
  if (proof.status !== "Validated") fail("PROOF_REQUIRED");
  return Object.freeze({
    taskReference: proof.taskReference,
    proofReference: proof.proofReference,
    executionStatus: "Delivered" as const,
  });
}
