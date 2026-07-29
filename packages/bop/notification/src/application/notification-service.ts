import { validateDomainEventEnvelope, type DomainEventEnvelope } from "@bop/eventing";
import {
  createNotificationDeliveryAttempt,
  createNotificationPreferenceEvidence,
  createNotificationRequest,
  createNotificationSuppressionEvidence,
  parseDeliveryAttemptSequence,
  parseNotificationInstant,
  parseNotificationReference,
  sameNotificationScope,
  type NotificationChannel,
  type NotificationDeliveryAttempt,
  type NotificationPreferenceEvidence,
  type NotificationReference,
  type NotificationRequest,
  type NotificationSuppressionEvidence,
} from "../contracts/notification.js";
import { evaluateNotificationRoute } from "../domain/evaluate-delivery.js";
import type {
  DeliverNotificationAdapterResult,
  NotificationDestinationResolution,
  NotificationPorts,
} from "./ports/notification-ports.js";

export const notificationServiceErrorCodes = [
  "NOTIFICATION_REQUEST_INVALID",
  "NOTIFICATION_EVIDENCE_DENIED",
  "NOTIFICATION_REQUEST_COMMIT_FAILED",
  "NOTIFICATION_DELIVERY_DENIED",
  "NOTIFICATION_DESTINATION_UNAVAILABLE",
  "NOTIFICATION_ATTEMPT_COMMIT_FAILED",
] as const;
export type NotificationServiceErrorCode = (typeof notificationServiceErrorCodes)[number];

export class NotificationServiceError extends Error {
  readonly code: NotificationServiceErrorCode;

  constructor(code: NotificationServiceErrorCode) {
    super("notification operation is unavailable");
    this.name = "NotificationServiceError";
    this.code = code;
  }
}

function fail(code: NotificationServiceErrorCode): never {
  throw new NotificationServiceError(code);
}

function exactEnvelope(
  input: unknown,
  fields: readonly string[],
  code: NotificationServiceErrorCode,
) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    fail(code);
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
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
    fail(code);
}

function eventMatchesRequest(event: DomainEventEnvelope, request: NotificationRequest): boolean {
  return (
    event.eventId === request.source.eventReference &&
    event.eventType === request.source.eventType &&
    event.producerModule === request.source.producerModule &&
    event.occurredAt === request.source.occurredAt &&
    event.correlationId === request.source.correlationReference &&
    event.tenantId === request.scope.brandReference &&
    (event.storeId ?? null) === request.scope.storeReference
  );
}

function currentEvidence(checkedAt: string, validUntil: string, evaluatedAt: string): boolean {
  return (
    Date.parse(checkedAt) <= Date.parse(evaluatedAt) &&
    Date.parse(evaluatedAt) < Date.parse(validUntil)
  );
}

function validateEvidence(
  request: NotificationRequest,
  preferenceInput: NotificationPreferenceEvidence,
  suppressionsInput: readonly NotificationSuppressionEvidence[],
): {
  preference: NotificationPreferenceEvidence;
  suppressions: readonly NotificationSuppressionEvidence[];
} {
  let preference: NotificationPreferenceEvidence;
  let suppressions: NotificationSuppressionEvidence[];
  try {
    preference = createNotificationPreferenceEvidence(preferenceInput);
    if (!Array.isArray(suppressionsInput)) fail("NOTIFICATION_EVIDENCE_DENIED");
    suppressions = suppressionsInput.map(createNotificationSuppressionEvidence);
  } catch {
    return fail("NOTIFICATION_EVIDENCE_DENIED");
  }
  if (
    preference.recipientReference !== request.recipientReference ||
    !sameNotificationScope(preference.scope, request.scope) ||
    preference.purpose !== request.purpose ||
    !currentEvidence(preference.checkedAt, preference.validUntil, request.requestedAt) ||
    suppressions.length !== request.requestedChannels.length ||
    new Set(suppressions.map((evidence) => evidence.channel)).size !== suppressions.length ||
    request.requestedChannels.some(
      (channel) => !suppressions.some((evidence) => evidence.channel === channel),
    ) ||
    suppressions.some(
      (evidence) =>
        evidence.recipientReference !== request.recipientReference ||
        !sameNotificationScope(evidence.scope, request.scope) ||
        evidence.purpose !== request.purpose ||
        !currentEvidence(evidence.checkedAt, evidence.validUntil, request.requestedAt),
    )
  )
    fail("NOTIFICATION_EVIDENCE_DENIED");
  return Object.freeze({ preference, suppressions: Object.freeze(suppressions) });
}

function sameChannels(
  left: readonly NotificationChannel[],
  right: readonly NotificationChannel[],
): boolean {
  return left.length === right.length && left.every((channel, index) => channel === right[index]);
}

export interface RegisterNotificationInput {
  readonly eventEnvelope: DomainEventEnvelope;
  readonly request: NotificationRequest;
  readonly preferenceEvidence: NotificationPreferenceEvidence;
  readonly suppressionEvidence: readonly NotificationSuppressionEvidence[];
  readonly idempotencyKey: NotificationReference;
}

export async function registerNotificationRequest(
  input: RegisterNotificationInput,
  ports: NotificationPorts,
): Promise<NotificationRequest> {
  let event: DomainEventEnvelope;
  let request: NotificationRequest;
  let idempotencyKey: NotificationReference;
  try {
    exactEnvelope(
      input,
      ["eventEnvelope", "request", "preferenceEvidence", "suppressionEvidence", "idempotencyKey"],
      "NOTIFICATION_REQUEST_INVALID",
    );
    event = validateDomainEventEnvelope(input.eventEnvelope);
    request = createNotificationRequest(input.request);
    idempotencyKey = parseNotificationReference(input.idempotencyKey);
  } catch {
    return fail("NOTIFICATION_REQUEST_INVALID");
  }
  if (!eventMatchesRequest(event, request)) fail("NOTIFICATION_REQUEST_INVALID");
  const evidence = validateEvidence(request, input.preferenceEvidence, input.suppressionEvidence);
  const route = evaluateNotificationRoute({
    purpose: request.purpose,
    requestedChannels: request.requestedChannels,
    preferenceDecision: evidence.preference.decision,
    preferredChannels: evidence.preference.allowedChannels,
    suppressions: evidence.suppressions,
  });
  if (
    request.outcome !== route.outcome ||
    !sameChannels(request.routedChannels, route.channels) ||
    request.suppressionReason !== (route.outcome === "Suppressed" ? route.reason : null)
  )
    fail("NOTIFICATION_EVIDENCE_DENIED");
  try {
    await ports.unitOfWork.registerRequest({
      idempotencyKey,
      request,
      preferenceEvidenceReference: evidence.preference.evidenceReference,
      suppressionEvidenceReferences: Object.freeze(
        evidence.suppressions.map((value) => value.evidenceReference),
      ),
    });
  } catch {
    return fail("NOTIFICATION_REQUEST_COMMIT_FAILED");
  }
  return request;
}

function validateDestination(
  input: NotificationDestinationResolution,
): NotificationDestinationResolution {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return fail("NOTIFICATION_DESTINATION_UNAVAILABLE");
  if (input.outcome === "Resolved") {
    exactEnvelope(
      input,
      ["outcome", "destinationReference"],
      "NOTIFICATION_DESTINATION_UNAVAILABLE",
    );
    return Object.freeze({
      outcome: input.outcome,
      destinationReference: parseNotificationReference(input.destinationReference),
    });
  }
  exactEnvelope(input, ["outcome", "reason"], "NOTIFICATION_DESTINATION_UNAVAILABLE");
  if (
    input.outcome !== "Unavailable" ||
    (input.reason !== "DESTINATION_UNAVAILABLE" && input.reason !== "DESTINATION_SUPPRESSED")
  )
    return fail("NOTIFICATION_DESTINATION_UNAVAILABLE");
  return Object.freeze({ outcome: input.outcome, reason: input.reason });
}

function validateAdapterResult(
  input: DeliverNotificationAdapterResult,
): DeliverNotificationAdapterResult {
  exactEnvelope(input, ["outcome", "providerAttemptReference"], "NOTIFICATION_DELIVERY_DENIED");
  if (input.outcome === "Accepted")
    return Object.freeze({
      outcome: input.outcome,
      providerAttemptReference: parseNotificationReference(input.providerAttemptReference),
    });
  if (
    (input.outcome !== "Rejected" && input.outcome !== "Unknown") ||
    input.providerAttemptReference !== null
  )
    return fail("NOTIFICATION_DELIVERY_DENIED");
  return Object.freeze({
    outcome: input.outcome,
    providerAttemptReference: null,
  });
}

export interface ExecuteNotificationDeliveryInput {
  readonly request: NotificationRequest;
  readonly attemptReference: NotificationReference;
  readonly channel: NotificationChannel;
  readonly previousAttempt: NotificationDeliveryAttempt | null;
  readonly idempotencyKey: NotificationReference;
  readonly attemptedAt: string;
}

export async function executeNotificationDelivery(
  input: ExecuteNotificationDeliveryInput,
  ports: NotificationPorts,
): Promise<NotificationDeliveryAttempt> {
  let request: NotificationRequest;
  let attemptReference: NotificationReference;
  let previousAttempt: NotificationDeliveryAttempt | null;
  let idempotencyKey: NotificationReference;
  let attemptedAt: ReturnType<typeof parseNotificationInstant>;
  try {
    exactEnvelope(
      input,
      [
        "request",
        "attemptReference",
        "channel",
        "previousAttempt",
        "idempotencyKey",
        "attemptedAt",
      ],
      "NOTIFICATION_DELIVERY_DENIED",
    );
    request = createNotificationRequest(input.request);
    attemptReference = parseNotificationReference(input.attemptReference);
    previousAttempt =
      input.previousAttempt === null
        ? null
        : createNotificationDeliveryAttempt(input.previousAttempt);
    idempotencyKey = parseNotificationReference(input.idempotencyKey);
    attemptedAt = parseNotificationInstant(input.attemptedAt);
  } catch {
    return fail("NOTIFICATION_DELIVERY_DENIED");
  }
  if (
    request.outcome !== "Accepted" ||
    !request.routedChannels.includes(input.channel) ||
    (previousAttempt !== null &&
      (previousAttempt.requestReference !== request.requestReference ||
        previousAttempt.channel !== input.channel ||
        previousAttempt.outcome === "Accepted" ||
        previousAttempt.attemptReference === attemptReference)) ||
    Date.parse(attemptedAt) < Date.parse(request.requestedAt) ||
    (previousAttempt !== null && Date.parse(attemptedAt) < Date.parse(previousAttempt.attemptedAt))
  )
    fail("NOTIFICATION_DELIVERY_DENIED");

  let destination: NotificationDestinationResolution;
  try {
    destination = validateDestination(
      await ports.destinations.resolve({
        recipientReference: request.recipientReference,
        requestReference: request.requestReference,
        channel: input.channel,
        evaluatedAt: attemptedAt,
      }),
    );
  } catch {
    return fail("NOTIFICATION_DESTINATION_UNAVAILABLE");
  }
  if (destination.outcome !== "Resolved") fail("NOTIFICATION_DESTINATION_UNAVAILABLE");

  let adapterResult: DeliverNotificationAdapterResult;
  const adapter = ports.adapters[input.channel];
  if (adapter === undefined) fail("NOTIFICATION_DELIVERY_DENIED");
  try {
    adapterResult = validateAdapterResult(
      await adapter.deliver({
        requestReference: request.requestReference,
        attemptReference,
        channel: input.channel,
        destinationReference: destination.destinationReference,
        templateReference: request.template.templateReference,
        templateVersion: request.template.templateVersion,
        contentReference: request.template.contentReference,
        contentDigest: request.template.contentDigest,
        locale: request.template.locale,
        idempotencyKey,
      }),
    );
  } catch {
    adapterResult = Object.freeze({
      outcome: "Unknown",
      providerAttemptReference: null,
    });
  }
  const attempt = createNotificationDeliveryAttempt({
    attemptReference,
    requestReference: request.requestReference,
    channel: input.channel,
    sequence: parseDeliveryAttemptSequence(
      previousAttempt === null ? 1 : previousAttempt.sequence + 1,
    ),
    destinationReference: destination.destinationReference,
    outcome: adapterResult.outcome,
    providerAttemptReference: adapterResult.providerAttemptReference,
    attemptedAt,
  });
  try {
    await ports.unitOfWork.appendAttempt({
      idempotencyKey,
      request,
      previousAttempt,
      attempt,
    });
  } catch {
    return fail("NOTIFICATION_ATTEMPT_COMMIT_FAILED");
  }
  return attempt;
}
