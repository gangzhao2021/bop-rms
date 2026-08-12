import {
  createNotificationDeliveryAttempt,
  parseNotificationInstant,
  parseNotificationReference,
  type NotificationDeliveryAttempt,
} from "../contracts/notification.js";

export type DeliveryOperationalState =
  "NotAttempted" | "Delivered" | "Unknown" | "RetryScheduled" | "DeadLettered" | "Suppressed";

export class DeliveryOrchestrationError extends Error {
  readonly code:
    | "NOTIFICATION_RETRY_NOT_DUE"
    | "NOTIFICATION_RETRY_EXHAUSTED"
    | "NOTIFICATION_ATTEMPT_HISTORY_INVALID";
  constructor(code: DeliveryOrchestrationError["code"]) {
    super("notification delivery orchestration denied");
    this.name = "DeliveryOrchestrationError";
    this.code = code;
  }
}

const retryDelayMs = {
  Rejected: [60_000, 5 * 60_000, 15 * 60_000],
  Unknown: [15 * 60_000, 30 * 60_000, 60 * 60_000],
} as const;

function retryDelay(outcome: "Rejected" | "Unknown", sequence: number): number {
  if (outcome === "Unknown") return retryDelayMs.Unknown[sequence - 1] ?? retryDelayMs.Unknown[2];
  return retryDelayMs.Rejected[sequence - 1] ?? retryDelayMs.Rejected[2];
}

export function assertAuthorizedRetryDue(input: {
  readonly previousAttempt: NotificationDeliveryAttempt;
  readonly attemptedAt: string;
}): void {
  const previous = createNotificationDeliveryAttempt(input.previousAttempt);
  const attemptedAt = parseNotificationInstant(input.attemptedAt);
  if (previous.outcome === "Accepted")
    throw new DeliveryOrchestrationError("NOTIFICATION_ATTEMPT_HISTORY_INVALID");
  if (previous.sequence >= 3) throw new DeliveryOrchestrationError("NOTIFICATION_RETRY_EXHAUSTED");
  const dueAt = Date.parse(previous.attemptedAt) + retryDelay(previous.outcome, previous.sequence);
  if (Date.parse(attemptedAt) < dueAt)
    throw new DeliveryOrchestrationError("NOTIFICATION_RETRY_NOT_DUE");
}

export function summarizeDeliveryOperations(input: {
  readonly requestReference: string;
  readonly requestOutcome: "Accepted" | "Suppressed";
  readonly attempts: readonly NotificationDeliveryAttempt[];
  readonly observedAt: string;
}) {
  const requestReference = parseNotificationReference(input.requestReference);
  parseNotificationInstant(input.observedAt);
  if (!Array.isArray(input.attempts))
    throw new DeliveryOrchestrationError("NOTIFICATION_ATTEMPT_HISTORY_INVALID");
  const attempts = input.attempts.map(createNotificationDeliveryAttempt);
  attempts.forEach((attempt, index) => {
    if (
      attempt.requestReference !== requestReference ||
      attempt.sequence !== index + 1 ||
      (index > 0 &&
        Date.parse(attempt.attemptedAt) < Date.parse(attempts[index - 1]?.attemptedAt ?? ""))
    )
      throw new DeliveryOrchestrationError("NOTIFICATION_ATTEMPT_HISTORY_INVALID");
  });
  const latest = attempts.at(-1);
  let state: DeliveryOperationalState;
  let nextEligibleAt: string | null = null;
  if (input.requestOutcome === "Suppressed") state = "Suppressed";
  else if (!latest) state = "NotAttempted";
  else if (latest.outcome === "Accepted") state = "Delivered";
  else if (latest.sequence >= 3) state = "DeadLettered";
  else {
    const delay = retryDelay(latest.outcome, latest.sequence);
    nextEligibleAt = new Date(Date.parse(latest.attemptedAt) + delay).toISOString();
    state = latest.outcome === "Unknown" ? "Unknown" : "RetryScheduled";
  }
  return Object.freeze({
    requestReference,
    state,
    latestAttemptReference: latest?.attemptReference ?? null,
    attemptCount: attempts.length,
    channel: latest?.channel ?? null,
    lastAttemptedAt: latest?.attemptedAt ?? null,
    nextEligibleAt,
  });
}
