import {
  parsePublishingDigest,
  parsePublishingReference,
  parsePublishingVersion,
  type PublishingDigest,
  type PublishingReference,
  type PublishingVersion,
} from "@bop/publishing";
import {
  parseCanonicalInstant,
  type BrandReference,
  type CanonicalInstant,
  type StoreReference,
  type TenantScopeKind,
} from "@bop/tenant";
import {
  notificationChannels,
  queryDeliveryStatus,
  type DeliveryQueryStatus,
  type NotificationChannel,
  type NotificationPurpose,
} from "../domain/evaluate-delivery.js";

export type {
  DeliveryQueryStatus,
  NotificationChannel,
  NotificationPurpose,
} from "../domain/evaluate-delivery.js";

export type NotificationReference = string & { readonly __notificationReference: unique symbol };
export type NotificationDigest = string & { readonly __notificationDigest: unique symbol };
export type NotificationCode = string & { readonly __notificationCode: unique symbol };
export type NotificationVersion = number & { readonly __notificationVersion: unique symbol };
export type DeliveryAttemptSequence = number & {
  readonly __deliveryAttemptSequence: unique symbol;
};

export interface NotificationScope {
  readonly kind: TenantScopeKind;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
}

export const notificationPurposes = ["Transactional", "Marketing"] as const;
export const notificationPriorities = ["Low", "Normal", "High", "Critical"] as const;
export type NotificationPriority = (typeof notificationPriorities)[number];

export interface NotificationSource {
  readonly eventReference: NotificationReference;
  readonly eventType: string;
  readonly producerModule: string;
  readonly occurredAt: CanonicalInstant;
  readonly correlationReference: NotificationReference;
}

export interface NotificationTemplateSnapshot {
  readonly templateReference: PublishingReference;
  readonly templateVersion: PublishingVersion;
  readonly contentReference: PublishingReference;
  readonly contentDigest: PublishingDigest;
  readonly locale: string;
}

export interface NotificationRequest {
  readonly requestReference: NotificationReference;
  readonly deduplicationDigest: NotificationDigest;
  readonly notificationCode: NotificationCode;
  readonly source: NotificationSource;
  readonly recipientReference: NotificationReference;
  readonly scope: NotificationScope;
  readonly purpose: NotificationPurpose;
  readonly priority: NotificationPriority;
  readonly requestedChannels: readonly NotificationChannel[];
  readonly template: NotificationTemplateSnapshot;
  readonly outcome: "Accepted" | "Suppressed";
  readonly routedChannels: readonly NotificationChannel[];
  readonly suppressionReason:
    | "MARKETING_DISABLED"
    | "PREFERENCE_DENIED"
    | "CHANNEL_DISABLED"
    | "CHANNEL_SUPPRESSED"
    | "NO_ELIGIBLE_CHANNEL"
    | null;
  readonly requestedAt: CanonicalInstant;
}

export interface NotificationPreferenceEvidence {
  readonly evidenceReference: NotificationReference;
  readonly recipientReference: NotificationReference;
  readonly scope: NotificationScope;
  readonly purpose: NotificationPurpose;
  readonly decision: "Allow" | "Deny";
  readonly allowedChannels: readonly NotificationChannel[];
  readonly version: NotificationVersion;
  readonly checkedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}

export interface NotificationSuppressionEvidence {
  readonly evidenceReference: NotificationReference;
  readonly recipientReference: NotificationReference;
  readonly scope: NotificationScope;
  readonly purpose: NotificationPurpose;
  readonly channel: NotificationChannel;
  readonly decision: "Clear" | "Suppressed";
  readonly reasonCode: NotificationCode | null;
  readonly checkedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}

export interface NotificationDeliveryAttempt {
  readonly attemptReference: NotificationReference;
  readonly requestReference: NotificationReference;
  readonly channel: NotificationChannel;
  readonly sequence: DeliveryAttemptSequence;
  readonly destinationReference: NotificationReference;
  readonly outcome: "Accepted" | "Rejected" | "Unknown";
  readonly providerAttemptReference: NotificationReference | null;
  readonly attemptedAt: CanonicalInstant;
}

export const notificationContractErrorCodes = [
  "NOTIFICATION_INPUT_INVALID",
  "NOTIFICATION_SCOPE_INVALID",
  "NOTIFICATION_SOURCE_INVALID",
  "NOTIFICATION_EVIDENCE_INVALID",
  "NOTIFICATION_ATTEMPT_INVALID",
] as const;
export type NotificationContractErrorCode = (typeof notificationContractErrorCodes)[number];

export class NotificationContractError extends Error {
  readonly code: NotificationContractErrorCode;

  constructor(code: NotificationContractErrorCode) {
    super("notification contract input is invalid");
    this.name = "NotificationContractError";
    this.code = code;
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const code = /^[A-Z][A-Z0-9_]{2,63}$/u;
const eventType = /^[A-Z][A-Za-z0-9]{2,127}$/u;
const producer = /^@(bop|rms)\/[a-z][a-z0-9-]{1,63}$/u;
const locale = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
const suppressionReasons = [
  "MARKETING_DISABLED",
  "PREFERENCE_DENIED",
  "CHANNEL_DISABLED",
  "CHANNEL_SUPPRESSED",
  "NO_ELIGIBLE_CHANNEL",
] as const;

function fail(error: NotificationContractErrorCode): never {
  throw new NotificationContractError(error);
}

function exact(value: object, fields: readonly string[], error: NotificationContractErrorCode) {
  if (Object.getPrototypeOf(value) !== Object.prototype) fail(error);
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !fields.includes(field)) ||
    keys.some((field) => {
      if (typeof field !== "string") return true;
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    fail(error);
}

function instant(value: unknown, error: NotificationContractErrorCode): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return fail(error);
  }
}

function uniqueChannels(
  value: unknown,
  allowEmpty: boolean,
  error: NotificationContractErrorCode,
): readonly NotificationChannel[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((channel) => !notificationChannels.includes(channel)) ||
    new Set(value).size !== value.length
  )
    fail(error);
  return Object.freeze([...value]) as readonly NotificationChannel[];
}

export function parseNotificationReference(value: unknown): NotificationReference {
  if (typeof value !== "string" || !uuidV7.test(value)) fail("NOTIFICATION_INPUT_INVALID");
  return value as NotificationReference;
}

export function parseNotificationDigest(value: unknown): NotificationDigest {
  if (typeof value !== "string" || !digest.test(value)) fail("NOTIFICATION_INPUT_INVALID");
  return value as NotificationDigest;
}

export function parseNotificationCode(value: unknown): NotificationCode {
  if (typeof value !== "string" || !code.test(value)) fail("NOTIFICATION_INPUT_INVALID");
  return value as NotificationCode;
}

export function parseNotificationVersion(value: unknown): NotificationVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("NOTIFICATION_INPUT_INVALID");
  return value as NotificationVersion;
}

export function parseDeliveryAttemptSequence(value: unknown): DeliveryAttemptSequence {
  return parseNotificationVersion(value) as unknown as DeliveryAttemptSequence;
}

export function parseNotificationInstant(value: unknown): CanonicalInstant {
  return instant(value, "NOTIFICATION_INPUT_INVALID");
}

export function createNotificationScope(input: NotificationScope): NotificationScope {
  exact(input, ["kind", "brandReference", "storeReference"], "NOTIFICATION_SCOPE_INVALID");
  const brandReference = parseNotificationReference(
    input.brandReference,
  ) as unknown as BrandReference;
  const storeReference =
    input.storeReference === null
      ? null
      : (parseNotificationReference(input.storeReference) as unknown as StoreReference);
  if (
    (input.kind !== "Brand" && input.kind !== "Store") ||
    (input.kind === "Brand" && storeReference !== null) ||
    (input.kind === "Store" && storeReference === null)
  )
    fail("NOTIFICATION_SCOPE_INVALID");
  return Object.freeze({ kind: input.kind, brandReference, storeReference });
}

export function sameNotificationScope(left: NotificationScope, right: NotificationScope): boolean {
  return (
    left.kind === right.kind &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference
  );
}

export function createNotificationSource(input: NotificationSource): NotificationSource {
  exact(
    input,
    ["eventReference", "eventType", "producerModule", "occurredAt", "correlationReference"],
    "NOTIFICATION_SOURCE_INVALID",
  );
  if (
    typeof input.eventType !== "string" ||
    !eventType.test(input.eventType) ||
    typeof input.producerModule !== "string" ||
    !producer.test(input.producerModule)
  )
    fail("NOTIFICATION_SOURCE_INVALID");
  return Object.freeze({
    eventReference: parseNotificationReference(input.eventReference),
    eventType: input.eventType,
    producerModule: input.producerModule,
    occurredAt: instant(input.occurredAt, "NOTIFICATION_SOURCE_INVALID"),
    correlationReference: parseNotificationReference(input.correlationReference),
  });
}

export function createNotificationTemplateSnapshot(
  input: NotificationTemplateSnapshot,
): NotificationTemplateSnapshot {
  exact(
    input,
    ["templateReference", "templateVersion", "contentReference", "contentDigest", "locale"],
    "NOTIFICATION_INPUT_INVALID",
  );
  if (typeof input.locale !== "string" || !locale.test(input.locale))
    fail("NOTIFICATION_INPUT_INVALID");
  return Object.freeze({
    templateReference: parsePublishingReference(input.templateReference),
    templateVersion: parsePublishingVersion(input.templateVersion),
    contentReference: parsePublishingReference(input.contentReference),
    contentDigest: parsePublishingDigest(input.contentDigest),
    locale: input.locale,
  });
}

export function createNotificationRequest(input: NotificationRequest): NotificationRequest {
  exact(
    input,
    [
      "requestReference",
      "deduplicationDigest",
      "notificationCode",
      "source",
      "recipientReference",
      "scope",
      "purpose",
      "priority",
      "requestedChannels",
      "template",
      "outcome",
      "routedChannels",
      "suppressionReason",
      "requestedAt",
    ],
    "NOTIFICATION_INPUT_INVALID",
  );
  if (
    !notificationPurposes.includes(input.purpose) ||
    !notificationPriorities.includes(input.priority) ||
    (input.outcome !== "Accepted" && input.outcome !== "Suppressed")
  )
    fail("NOTIFICATION_INPUT_INVALID");
  const requestedChannels = uniqueChannels(
    input.requestedChannels,
    false,
    "NOTIFICATION_INPUT_INVALID",
  );
  const routedChannels = uniqueChannels(input.routedChannels, true, "NOTIFICATION_INPUT_INVALID");
  const source = createNotificationSource(input.source);
  const requestedAt = instant(input.requestedAt, "NOTIFICATION_INPUT_INVALID");
  if (
    routedChannels.some((channel) => !requestedChannels.includes(channel)) ||
    Date.parse(requestedAt) < Date.parse(source.occurredAt) ||
    (input.outcome === "Accepted" &&
      (routedChannels.length === 0 || input.suppressionReason !== null)) ||
    (input.outcome === "Suppressed" &&
      (routedChannels.length !== 0 ||
        input.suppressionReason === null ||
        !suppressionReasons.includes(input.suppressionReason)))
  )
    fail("NOTIFICATION_INPUT_INVALID");
  return Object.freeze({
    requestReference: parseNotificationReference(input.requestReference),
    deduplicationDigest: parseNotificationDigest(input.deduplicationDigest),
    notificationCode: parseNotificationCode(input.notificationCode),
    source,
    recipientReference: parseNotificationReference(input.recipientReference),
    scope: createNotificationScope(input.scope),
    purpose: input.purpose,
    priority: input.priority,
    requestedChannels,
    template: createNotificationTemplateSnapshot(input.template),
    outcome: input.outcome,
    routedChannels,
    suppressionReason: input.suppressionReason,
    requestedAt,
  });
}

export function createNotificationPreferenceEvidence(
  input: NotificationPreferenceEvidence,
): NotificationPreferenceEvidence {
  exact(
    input,
    [
      "evidenceReference",
      "recipientReference",
      "scope",
      "purpose",
      "decision",
      "allowedChannels",
      "version",
      "checkedAt",
      "validUntil",
    ],
    "NOTIFICATION_EVIDENCE_INVALID",
  );
  if (
    !notificationPurposes.includes(input.purpose) ||
    (input.decision !== "Allow" && input.decision !== "Deny")
  )
    fail("NOTIFICATION_EVIDENCE_INVALID");
  const allowedChannels = uniqueChannels(
    input.allowedChannels,
    true,
    "NOTIFICATION_EVIDENCE_INVALID",
  );
  const checkedAt = instant(input.checkedAt, "NOTIFICATION_EVIDENCE_INVALID");
  const validUntil = instant(input.validUntil, "NOTIFICATION_EVIDENCE_INVALID");
  if (
    Date.parse(validUntil) <= Date.parse(checkedAt) ||
    (input.decision === "Deny" && allowedChannels.length !== 0)
  )
    fail("NOTIFICATION_EVIDENCE_INVALID");
  return Object.freeze({
    evidenceReference: parseNotificationReference(input.evidenceReference),
    recipientReference: parseNotificationReference(input.recipientReference),
    scope: createNotificationScope(input.scope),
    purpose: input.purpose,
    decision: input.decision,
    allowedChannels,
    version: parseNotificationVersion(input.version),
    checkedAt,
    validUntil,
  });
}

export function createNotificationSuppressionEvidence(
  input: NotificationSuppressionEvidence,
): NotificationSuppressionEvidence {
  exact(
    input,
    [
      "evidenceReference",
      "recipientReference",
      "scope",
      "purpose",
      "channel",
      "decision",
      "reasonCode",
      "checkedAt",
      "validUntil",
    ],
    "NOTIFICATION_EVIDENCE_INVALID",
  );
  if (
    !notificationPurposes.includes(input.purpose) ||
    !notificationChannels.includes(input.channel) ||
    (input.decision !== "Clear" && input.decision !== "Suppressed") ||
    (input.decision === "Clear" && input.reasonCode !== null) ||
    (input.decision === "Suppressed" && input.reasonCode === null)
  )
    fail("NOTIFICATION_EVIDENCE_INVALID");
  const checkedAt = instant(input.checkedAt, "NOTIFICATION_EVIDENCE_INVALID");
  const validUntil = instant(input.validUntil, "NOTIFICATION_EVIDENCE_INVALID");
  if (Date.parse(validUntil) <= Date.parse(checkedAt)) fail("NOTIFICATION_EVIDENCE_INVALID");
  return Object.freeze({
    evidenceReference: parseNotificationReference(input.evidenceReference),
    recipientReference: parseNotificationReference(input.recipientReference),
    scope: createNotificationScope(input.scope),
    purpose: input.purpose,
    channel: input.channel,
    decision: input.decision,
    reasonCode: input.reasonCode === null ? null : parseNotificationCode(input.reasonCode),
    checkedAt,
    validUntil,
  });
}

export function createNotificationDeliveryAttempt(
  input: NotificationDeliveryAttempt,
): NotificationDeliveryAttempt {
  exact(
    input,
    [
      "attemptReference",
      "requestReference",
      "channel",
      "sequence",
      "destinationReference",
      "outcome",
      "providerAttemptReference",
      "attemptedAt",
    ],
    "NOTIFICATION_ATTEMPT_INVALID",
  );
  if (
    !notificationChannels.includes(input.channel) ||
    (input.outcome !== "Accepted" && input.outcome !== "Rejected" && input.outcome !== "Unknown") ||
    (input.outcome === "Accepted" && input.providerAttemptReference === null) ||
    (input.outcome !== "Accepted" && input.providerAttemptReference !== null)
  )
    fail("NOTIFICATION_ATTEMPT_INVALID");
  return Object.freeze({
    attemptReference: parseNotificationReference(input.attemptReference),
    requestReference: parseNotificationReference(input.requestReference),
    channel: input.channel,
    sequence: parseDeliveryAttemptSequence(input.sequence),
    destinationReference: parseNotificationReference(input.destinationReference),
    outcome: input.outcome,
    providerAttemptReference:
      input.providerAttemptReference === null
        ? null
        : parseNotificationReference(input.providerAttemptReference),
    attemptedAt: instant(input.attemptedAt, "NOTIFICATION_ATTEMPT_INVALID"),
  });
}

export function resolveNotificationDeliveryStatus(
  requestReference: unknown,
  attempts: readonly NotificationDeliveryAttempt[],
): DeliveryQueryStatus {
  const request = parseNotificationReference(requestReference);
  const values = attempts.map(createNotificationDeliveryAttempt);
  const ordered = [...values].sort((left, right) => left.sequence - right.sequence);
  if (
    ordered.some(
      (attempt, index) => attempt.requestReference !== request || attempt.sequence !== index + 1,
    )
  )
    fail("NOTIFICATION_ATTEMPT_INVALID");
  return queryDeliveryStatus(ordered);
}
