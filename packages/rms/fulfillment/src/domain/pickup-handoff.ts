import type {
  PickupProofInstant,
  PickupProofReference,
  PickupProofVerificationRecord,
} from "./pickup-proof.js";

export type PickupHandoffReference = PickupProofReference;
export type PickupHandoffInstant = PickupProofInstant;

export const completePickupHandoffPermission = "fulfillment.pickup.complete" as const;

export interface PickupHandoffSourceItem {
  readonly fulfillmentItemReference: PickupHandoffReference;
  readonly orderedQuantity: number;
  readonly readyQuantity: number;
  readonly handedOverQuantity: number;
  readonly state: "Ready" | "HandedOver";
}

export interface PickupHandoffSource {
  readonly fulfillmentReference: PickupHandoffReference;
  readonly brandReference: PickupHandoffReference;
  readonly storeReference: PickupHandoffReference;
  readonly fulfillmentType: "Pickup";
  readonly canonicalPhase: "Ready" | "InProgress" | "Completed";
  readonly aggregateVersion: bigint;
  readonly currentProofGeneration: number;
  readonly lockedAt: PickupHandoffInstant;
  readonly items: readonly PickupHandoffSourceItem[];
}

export interface CompletePickupHandoffCommand {
  readonly fulfillmentReference: PickupHandoffReference;
  readonly brandReference: PickupHandoffReference;
  readonly storeReference: PickupHandoffReference;
  readonly expectedAggregateVersion: bigint;
  readonly purpose: "CompletePickupHandoff";
  readonly actorReference: PickupHandoffReference;
  readonly actorPermissions: readonly string[];
  readonly verification: PickupProofVerificationRecord;
  readonly recipientType: "Customer" | "Delegate";
  readonly recipientDisplayMask: string;
  readonly pickupLocationReference: PickupHandoffReference;
  readonly deviceReference: PickupHandoffReference;
  readonly quantities: readonly {
    readonly fulfillmentItemReference: PickupHandoffReference;
    readonly quantity: number;
  }[];
  readonly handoffReference: PickupHandoffReference;
  readonly operationReference: PickupHandoffReference;
  readonly auditReference: PickupHandoffReference;
  readonly idempotencyReference: PickupHandoffReference;
  readonly correlationReference: PickupHandoffReference;
  readonly handedOverAt: PickupHandoffInstant;
}

export interface PickupHandoffEffect {
  readonly record: {
    readonly handoffReference: PickupHandoffReference;
    readonly fulfillmentReference: PickupHandoffReference;
    readonly brandReference: PickupHandoffReference;
    readonly storeReference: PickupHandoffReference;
    readonly pickupLocationReference: PickupHandoffReference;
    readonly verificationReference: PickupHandoffReference;
    readonly verificationMethod: "Opaque" | "HumanCode";
    readonly recipientType: "Customer" | "Delegate";
    readonly recipientDisplayMask: string;
    readonly actorReference: PickupHandoffReference;
    readonly deviceReference: PickupHandoffReference;
    readonly handedOverAt: PickupHandoffInstant;
    readonly validationStatus: "Validated";
  };
  readonly items: readonly {
    readonly fulfillmentItemReference: PickupHandoffReference;
    readonly quantity: number;
    readonly cumulativeHandedOverQuantity: number;
  }[];
  readonly operation: {
    readonly operationReference: PickupHandoffReference;
    readonly idempotencyReference: PickupHandoffReference;
    readonly correlationReference: PickupHandoffReference;
    readonly aggregateVersionBefore: bigint;
    readonly aggregateVersionAfter: bigint;
    readonly phaseBefore: "Ready" | "InProgress";
    readonly phaseAfter: "InProgress" | "Completed";
    readonly occurredAt: PickupHandoffInstant;
  };
  readonly audit: {
    readonly auditReference: PickupHandoffReference;
    readonly actorReference: PickupHandoffReference;
    readonly actionCode: "PICKUP_HANDOFF_COMPLETED";
    readonly permission: "fulfillment.pickup.complete";
    readonly purpose: "CompletePickupHandoff";
    readonly correlationReference: PickupHandoffReference;
    readonly dataClassification: "Confidential";
    readonly occurredAt: PickupHandoffInstant;
  };
  readonly nextPhase: "InProgress" | "Completed";
  readonly nextAggregateVersion: bigint;
}

export const pickupHandoffErrorCodes = [
  "PICKUP_HANDOFF_INPUT_INVALID",
  "PICKUP_HANDOFF_PERMISSION_DENIED",
  "PICKUP_HANDOFF_NOT_READY",
  "PICKUP_HANDOFF_VERIFICATION_FAILED",
  "PICKUP_HANDOFF_ALREADY_COMPLETED",
  "PICKUP_HANDOFF_VERSION_CONFLICT",
] as const;

export class PickupHandoffError extends Error {
  constructor(readonly code: (typeof pickupHandoffErrorCodes)[number]) {
    super("pickup handoff is unavailable");
    this.name = "PickupHandoffError";
  }
}

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const maskPattern = /^[\p{L}\p{N}* ._'()-]{1,64}$/u;
const maximumBigint = 9_223_372_036_854_775_807n;

function fail(code: PickupHandoffError["code"]): never {
  throw new PickupHandoffError(code);
}

function reference(value: unknown): PickupHandoffReference {
  if (typeof value !== "string" || !referencePattern.test(value))
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  return value as PickupHandoffReference;
}

function instant(value: unknown): PickupHandoffInstant {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    new Date(value).toISOString() !== value
  )
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  return value as PickupHandoffInstant;
}

function version(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > maximumBigint)
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  return value;
}

function quantity(value: unknown, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (allowZero ? 0 : 1) ||
    (value as number) > 999
  )
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  return value as number;
}

export function parsePickupHandoffSource(value: PickupHandoffSource): PickupHandoffSource {
  if (
    !value ||
    typeof value !== "object" ||
    value.fulfillmentType !== "Pickup" ||
    !["Ready", "InProgress", "Completed"].includes(value.canonicalPhase)
  )
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  const aggregateVersion = version(value.aggregateVersion);
  if (!Number.isSafeInteger(value.currentProofGeneration) || value.currentProofGeneration < 1)
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100)
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  const items = value.items.map((entry) => {
    const orderedQuantity = quantity(entry.orderedQuantity);
    const readyQuantity = quantity(entry.readyQuantity);
    const handedOverQuantity = quantity(entry.handedOverQuantity, true);
    if (
      readyQuantity !== orderedQuantity ||
      handedOverQuantity > readyQuantity ||
      (entry.state !== "Ready" && entry.state !== "HandedOver") ||
      (entry.state === "Ready" && handedOverQuantity === readyQuantity) ||
      (entry.state === "HandedOver" && handedOverQuantity !== readyQuantity)
    )
      return fail("PICKUP_HANDOFF_INPUT_INVALID");
    return Object.freeze({
      fulfillmentItemReference: reference(entry.fulfillmentItemReference),
      orderedQuantity,
      readyQuantity,
      handedOverQuantity,
      state: entry.state,
    });
  });
  if (new Set(items.map((entry) => entry.fulfillmentItemReference)).size !== items.length)
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  return Object.freeze({
    fulfillmentReference: reference(value.fulfillmentReference),
    brandReference: reference(value.brandReference),
    storeReference: reference(value.storeReference),
    fulfillmentType: "Pickup",
    canonicalPhase: value.canonicalPhase,
    aggregateVersion,
    currentProofGeneration: value.currentProofGeneration,
    lockedAt: instant(value.lockedAt),
    items: Object.freeze(items),
  });
}

export function planCompletePickupHandoff(
  sourceInput: PickupHandoffSource,
  command: CompletePickupHandoffCommand,
): PickupHandoffEffect {
  const source = parsePickupHandoffSource(sourceInput);
  if (source.canonicalPhase === "Completed") return fail("PICKUP_HANDOFF_ALREADY_COMPLETED");
  if (source.canonicalPhase !== "Ready" && source.canonicalPhase !== "InProgress")
    return fail("PICKUP_HANDOFF_NOT_READY");
  if (
    command.purpose !== "CompletePickupHandoff" ||
    !Array.isArray(command.actorPermissions) ||
    !command.actorPermissions.includes(completePickupHandoffPermission)
  )
    return fail("PICKUP_HANDOFF_PERMISSION_DENIED");
  if (
    command.fulfillmentReference !== source.fulfillmentReference ||
    command.brandReference !== source.brandReference ||
    command.storeReference !== source.storeReference
  )
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  if (version(command.expectedAggregateVersion) !== source.aggregateVersion)
    return fail("PICKUP_HANDOFF_VERSION_CONFLICT");
  const verification = command.verification;
  if (
    verification.validationStatus !== "Validated" ||
    verification.fulfillmentReference !== source.fulfillmentReference ||
    verification.brandReference !== source.brandReference ||
    verification.storeReference !== source.storeReference ||
    verification.generation !== source.currentProofGeneration ||
    (verification.verificationMethod !== "Opaque" &&
      verification.verificationMethod !== "HumanCode") ||
    verification.grantsCompletionAuthority !== false ||
    verification.verifiedAt > command.handedOverAt
  )
    return fail("PICKUP_HANDOFF_VERIFICATION_FAILED");
  if (!maskPattern.test(command.recipientDisplayMask)) return fail("PICKUP_HANDOFF_INPUT_INVALID");
  if (command.recipientType !== "Customer" && command.recipientType !== "Delegate")
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  if (!Array.isArray(command.quantities) || command.quantities.length < 1)
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  const requested = new Map<PickupHandoffReference, number>();
  for (const entry of command.quantities) {
    const itemReference = reference(entry.fulfillmentItemReference);
    if (requested.has(itemReference)) return fail("PICKUP_HANDOFF_INPUT_INVALID");
    requested.set(itemReference, quantity(entry.quantity));
  }
  const lines = [...requested].map(([itemReference, handedQuantity]) => {
    const item = source.items.find(
      (candidate) => candidate.fulfillmentItemReference === itemReference,
    );
    if (
      !item ||
      item.state !== "Ready" ||
      handedQuantity > item.readyQuantity - item.handedOverQuantity
    )
      return fail("PICKUP_HANDOFF_NOT_READY");
    return Object.freeze({
      fulfillmentItemReference: itemReference,
      quantity: handedQuantity,
      cumulativeHandedOverQuantity: item.handedOverQuantity + handedQuantity,
    });
  });
  const cumulative = new Map(
    lines.map((line) => [line.fulfillmentItemReference, line.cumulativeHandedOverQuantity]),
  );
  const completed = source.items.every(
    (item) =>
      (cumulative.get(item.fulfillmentItemReference) ?? item.handedOverQuantity) ===
      item.readyQuantity,
  );
  const handedOverAt = instant(command.handedOverAt);
  const nextAggregateVersion = source.aggregateVersion + 1n;
  if (nextAggregateVersion > maximumBigint) return fail("PICKUP_HANDOFF_VERSION_CONFLICT");
  const actorReference = reference(command.actorReference);
  const pickupLocationReference = reference(command.pickupLocationReference);
  const deviceReference = reference(command.deviceReference);
  const handoffReference = reference(command.handoffReference);
  const operationReference = reference(command.operationReference);
  const auditReference = reference(command.auditReference);
  const idempotencyReference = reference(command.idempotencyReference);
  const correlationReference = reference(command.correlationReference);
  const commonReferences = [
    actorReference,
    pickupLocationReference,
    deviceReference,
    handoffReference,
    operationReference,
    auditReference,
    idempotencyReference,
    correlationReference,
  ];
  if (new Set(commonReferences).size !== commonReferences.length)
    return fail("PICKUP_HANDOFF_INPUT_INVALID");
  const nextPhase = completed ? ("Completed" as const) : ("InProgress" as const);
  return Object.freeze({
    record: Object.freeze({
      handoffReference,
      fulfillmentReference: source.fulfillmentReference,
      brandReference: source.brandReference,
      storeReference: source.storeReference,
      pickupLocationReference,
      verificationReference: reference(verification.verificationReference),
      verificationMethod: verification.verificationMethod,
      recipientType: command.recipientType,
      recipientDisplayMask: command.recipientDisplayMask,
      actorReference,
      deviceReference,
      handedOverAt,
      validationStatus: "Validated" as const,
    }),
    items: Object.freeze(lines),
    operation: Object.freeze({
      operationReference,
      idempotencyReference,
      correlationReference,
      aggregateVersionBefore: source.aggregateVersion,
      aggregateVersionAfter: nextAggregateVersion,
      phaseBefore: source.canonicalPhase,
      phaseAfter: nextPhase,
      occurredAt: handedOverAt,
    }),
    audit: Object.freeze({
      auditReference,
      actorReference,
      actionCode: "PICKUP_HANDOFF_COMPLETED" as const,
      permission: completePickupHandoffPermission,
      purpose: "CompletePickupHandoff" as const,
      correlationReference,
      dataClassification: "Confidential" as const,
      occurredAt: handedOverAt,
    }),
    nextPhase,
    nextAggregateVersion,
  });
}
