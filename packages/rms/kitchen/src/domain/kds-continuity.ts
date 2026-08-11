import {
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
  type KitchenDigest,
  type KitchenInstant,
  type KitchenReference,
} from "./kitchen-ticket.js";

export const kdsContinuityPermission = "kitchen.operate" as const;
export const kdsManualRunbookCode = "KDS_MANUAL_CONTINUITY" as const;

export const kdsContinuityErrorCodes = [
  "KDS_CONTINUITY_INPUT_INVALID",
  "KDS_CONTINUITY_SCOPE_MISMATCH",
  "KDS_OPERATOR_SESSION_UNAVAILABLE",
  "KDS_HANDOVER_PRECONDITION_FAILED",
  "KDS_RECOVERY_SOURCE_REQUIRED",
] as const;

export type KdsContinuityErrorCode = (typeof kdsContinuityErrorCodes)[number];

export class KdsContinuityError extends Error {
  constructor(readonly code: KdsContinuityErrorCode) {
    super("KDS continuity is unavailable");
    this.name = "KdsContinuityError";
  }
}

export interface KdsOperatorSessionEvidence {
  readonly sessionReference: KitchenReference;
  readonly actorReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly sessionVersion: number;
  readonly sessionKind: "NamedKdsOperator";
  readonly state: "Active" | "Locked" | "Ended";
  readonly observedAt: KitchenInstant;
  readonly validUntil: KitchenInstant;
}

export interface KdsProjectionEvidence {
  readonly projectionGenerationReference: KitchenReference;
  readonly sourceCheckpointReference: KitchenReference;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly partial: false;
  readonly asOfUtc: KitchenInstant;
}

export interface KdsContinuityState {
  readonly mode:
    | "Live"
    | "ReconnectingReadOnly"
    | "StaleReadOnly"
    | "OfflineReadOnly"
    | "Locked"
    | "ReconciliationRequired";
  readonly commandsAllowed: boolean;
  readonly commandQueueing: false;
  readonly safeSnapshotVisible: boolean;
  readonly nonColorIndicator: true;
  readonly statusToken: string;
  readonly manualRunbookCode: "KDS_MANUAL_CONTINUITY" | null;
  readonly actorReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly projectionGenerationReference: KitchenReference;
  readonly sourceCheckpointReference: KitchenReference;
  readonly asOfUtc: KitchenInstant;
}

export interface KdsOperatorHandoverRecord {
  readonly handoverReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly priorSessionReference: KitchenReference;
  readonly priorActorReference: KitchenReference;
  readonly priorFinalState: "Locked" | "Ended";
  readonly priorFinalizedAt: KitchenInstant;
  readonly nextSessionReference: KitchenReference;
  readonly nextActorReference: KitchenReference;
  readonly nextActivatedAt: KitchenInstant;
  readonly recordedAt: KitchenInstant;
  readonly reasonCode: "ShiftHandover" | "Break" | "OperatorReplacement";
}

export interface KdsRecoveryReconciliationRecord {
  readonly reconciliationReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly operatorActorReference: KitchenReference;
  readonly offlineSnapshotDigest: KitchenDigest;
  readonly offlineCheckpointReference: KitchenReference;
  readonly offlineCapturedAt: KitchenInstant;
  readonly sourceSnapshotDigest: KitchenDigest;
  readonly sourceCheckpointReference: KitchenReference;
  readonly sourceLoadedAt: KitchenInstant;
  readonly manualContinuityEvidenceReference: KitchenReference | null;
  readonly reasonCode: "NoOfflineMutation" | "ManualContinuityUsed" | "SourceChanged";
  readonly outcome: "ConvergedNoAction" | "RequiresAuthorizedResolution";
  readonly commandReplayCount: 0;
  readonly reconciledAt: KitchenInstant;
}

function fail(code: KdsContinuityErrorCode = "KDS_CONTINUITY_INPUT_INVALID"): never {
  throw new KdsContinuityError(code);
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return fail();
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
        return fail();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KdsContinuityError) throw error;
    return fail();
  }
}

function reference(value: unknown): KitchenReference {
  try {
    return parseKitchenTicketReference(value);
  } catch {
    return fail();
  }
}

function digest(value: unknown): KitchenDigest {
  try {
    return parseKitchenTicketDigest(value);
  } catch {
    return fail();
  }
}

function instant(value: unknown): KitchenInstant {
  try {
    return parseKitchenTicketInstant(value);
  } catch {
    return fail();
  }
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail();
  return value as number;
}

export function parseKdsOperatorSessionEvidence(value: unknown): KdsOperatorSessionEvidence {
  const raw = exact(value, [
    "sessionReference",
    "actorReference",
    "brandReference",
    "storeReference",
    "sessionVersion",
    "sessionKind",
    "state",
    "observedAt",
    "validUntil",
  ]);
  if (
    raw.sessionKind !== "NamedKdsOperator" ||
    (raw.state !== "Active" && raw.state !== "Locked" && raw.state !== "Ended")
  )
    return fail("KDS_OPERATOR_SESSION_UNAVAILABLE");
  const observedAt = instant(raw.observedAt);
  const validUntil = instant(raw.validUntil);
  if (Date.parse(observedAt) >= Date.parse(validUntil))
    return fail("KDS_OPERATOR_SESSION_UNAVAILABLE");
  return Object.freeze({
    sessionReference: reference(raw.sessionReference),
    actorReference: reference(raw.actorReference),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    sessionVersion: version(raw.sessionVersion),
    sessionKind: "NamedKdsOperator",
    state: raw.state,
    observedAt,
    validUntil,
  });
}

export function parseKdsProjectionEvidence(value: unknown): KdsProjectionEvidence {
  const raw = exact(value, [
    "projectionGenerationReference",
    "sourceCheckpointReference",
    "freshnessStatus",
    "partial",
    "asOfUtc",
  ]);
  if ((raw.freshnessStatus !== "Fresh" && raw.freshnessStatus !== "Stale") || raw.partial !== false)
    return fail();
  return Object.freeze({
    projectionGenerationReference: reference(raw.projectionGenerationReference),
    sourceCheckpointReference: reference(raw.sourceCheckpointReference),
    freshnessStatus: raw.freshnessStatus,
    partial: false,
    asOfUtc: instant(raw.asOfUtc),
  });
}

export function buildKdsContinuityState(input: {
  readonly session: KdsOperatorSessionEvidence;
  readonly projection: KdsProjectionEvidence;
  readonly connection: "Online" | "Reconnecting" | "Offline";
  readonly observedAt: string;
  readonly recoveryRequired: boolean;
}): KdsContinuityState {
  const session = parseKdsOperatorSessionEvidence(input.session);
  const projection = parseKdsProjectionEvidence(input.projection);
  const observedAt = instant(input.observedAt);
  const sessionActive =
    session.state === "Active" && Date.parse(observedAt) < Date.parse(session.validUntil);
  if (
    Date.parse(session.observedAt) > Date.parse(observedAt) ||
    Date.parse(projection.asOfUtc) > Date.parse(observedAt)
  )
    return fail("KDS_OPERATOR_SESSION_UNAVAILABLE");
  let mode: KdsContinuityState["mode"];
  if (!sessionActive) mode = "Locked";
  else if (input.recoveryRequired) mode = "ReconciliationRequired";
  else if (input.connection === "Offline") mode = "OfflineReadOnly";
  else if (input.connection === "Reconnecting") mode = "ReconnectingReadOnly";
  else if (input.connection !== "Online") return fail();
  else if (projection.freshnessStatus === "Stale") mode = "StaleReadOnly";
  else mode = "Live";
  const commandsAllowed = mode === "Live";
  return Object.freeze({
    mode,
    commandsAllowed,
    commandQueueing: false,
    safeSnapshotVisible: mode !== "Locked",
    nonColorIndicator: true,
    statusToken: `KDS_${mode.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`,
    manualRunbookCode:
      mode === "OfflineReadOnly" || mode === "ReconciliationRequired" ? kdsManualRunbookCode : null,
    actorReference: session.actorReference,
    brandReference: session.brandReference,
    storeReference: session.storeReference,
    projectionGenerationReference: projection.projectionGenerationReference,
    sourceCheckpointReference: projection.sourceCheckpointReference,
    asOfUtc: projection.asOfUtc,
  });
}

export function createKdsOperatorHandover(input: {
  readonly handoverReference: string;
  readonly priorSession: KdsOperatorSessionEvidence;
  readonly nextSession: KdsOperatorSessionEvidence;
  readonly priorFinalizedAt: string;
  readonly nextActivatedAt: string;
  readonly recordedAt: string;
  readonly reasonCode: KdsOperatorHandoverRecord["reasonCode"];
}): KdsOperatorHandoverRecord {
  const prior = parseKdsOperatorSessionEvidence(input.priorSession);
  const next = parseKdsOperatorSessionEvidence(input.nextSession);
  const priorFinalizedAt = instant(input.priorFinalizedAt);
  const nextActivatedAt = instant(input.nextActivatedAt);
  const recordedAt = instant(input.recordedAt);
  if (prior.brandReference !== next.brandReference || prior.storeReference !== next.storeReference)
    return fail("KDS_CONTINUITY_SCOPE_MISMATCH");
  if (
    (prior.state !== "Locked" && prior.state !== "Ended") ||
    next.state !== "Active" ||
    prior.actorReference === next.actorReference ||
    prior.sessionReference === next.sessionReference ||
    Date.parse(priorFinalizedAt) > Date.parse(nextActivatedAt) ||
    Date.parse(nextActivatedAt) > Date.parse(recordedAt) ||
    Date.parse(prior.observedAt) > Date.parse(priorFinalizedAt) ||
    Date.parse(next.observedAt) > Date.parse(nextActivatedAt) ||
    !["ShiftHandover", "Break", "OperatorReplacement"].includes(input.reasonCode)
  )
    return fail("KDS_HANDOVER_PRECONDITION_FAILED");
  return Object.freeze({
    handoverReference: reference(input.handoverReference),
    brandReference: prior.brandReference,
    storeReference: prior.storeReference,
    priorSessionReference: prior.sessionReference,
    priorActorReference: prior.actorReference,
    priorFinalState: prior.state,
    priorFinalizedAt,
    nextSessionReference: next.sessionReference,
    nextActorReference: next.actorReference,
    nextActivatedAt,
    recordedAt,
    reasonCode: input.reasonCode,
  });
}

export function createKdsRecoveryReconciliation(input: {
  readonly reconciliationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly operatorActorReference: string;
  readonly offlineSnapshotDigest: string;
  readonly offlineCheckpointReference: string;
  readonly offlineCapturedAt: string;
  readonly sourceSnapshotDigest: string;
  readonly sourceCheckpointReference: string;
  readonly sourceLoadedAt: string;
  readonly manualContinuityEvidenceReference: string | null;
  readonly reconciledAt: string;
}): KdsRecoveryReconciliationRecord {
  const offlineSnapshotDigest = digest(input.offlineSnapshotDigest);
  const sourceSnapshotDigest = digest(input.sourceSnapshotDigest);
  const offlineCheckpointReference = reference(input.offlineCheckpointReference);
  const sourceCheckpointReference = reference(input.sourceCheckpointReference);
  const offlineCapturedAt = instant(input.offlineCapturedAt);
  const sourceLoadedAt = instant(input.sourceLoadedAt);
  const reconciledAt = instant(input.reconciledAt);
  if (
    Date.parse(offlineCapturedAt) > Date.parse(sourceLoadedAt) ||
    Date.parse(sourceLoadedAt) > Date.parse(reconciledAt)
  )
    return fail("KDS_RECOVERY_SOURCE_REQUIRED");
  const manualEvidence =
    input.manualContinuityEvidenceReference === null
      ? null
      : reference(input.manualContinuityEvidenceReference);
  const sourceChanged =
    offlineSnapshotDigest !== sourceSnapshotDigest ||
    offlineCheckpointReference !== sourceCheckpointReference;
  const resolutionRequired = manualEvidence !== null || sourceChanged;
  return Object.freeze({
    reconciliationReference: reference(input.reconciliationReference),
    brandReference: reference(input.brandReference),
    storeReference: reference(input.storeReference),
    operatorActorReference: reference(input.operatorActorReference),
    offlineSnapshotDigest,
    offlineCheckpointReference,
    offlineCapturedAt,
    sourceSnapshotDigest,
    sourceCheckpointReference,
    sourceLoadedAt,
    manualContinuityEvidenceReference: manualEvidence,
    reasonCode:
      manualEvidence !== null
        ? "ManualContinuityUsed"
        : sourceChanged
          ? "SourceChanged"
          : "NoOfflineMutation",
    outcome: resolutionRequired ? "RequiresAuthorizedResolution" : "ConvergedNoAction",
    commandReplayCount: 0,
    reconciledAt,
  });
}
