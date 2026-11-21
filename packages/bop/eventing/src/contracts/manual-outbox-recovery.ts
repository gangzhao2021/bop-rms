import { retryPolicy, type DeadLetterCommand } from "./retry-dead-letter.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export const manualOutboxRecoveryPolicy = Object.freeze({
  name: "eventing_manual_single_handoff",
  version: 1,
  maximumHandoffs: 1,
  startWindowMs: 300000,
});
export interface ExhaustedOutboxRecoveryFacts {
  readonly deadLetterId: string;
  readonly eventId: string;
  readonly brandId: string;
  readonly storeId: string | null;
  readonly deadLetterVersion: bigint;
  readonly status: "open" | "retry_scheduled" | "discarded" | "resolved";
  readonly deliveryPath: "outbox" | "consumer";
  readonly failureClass: string;
  readonly safeCode: string;
  readonly automaticAttemptCount: number;
  readonly published: boolean;
  readonly leased: boolean;
  readonly orderingReleased: boolean;
  readonly earlierUnpublishedEvent: boolean;
  readonly activeRecovery: boolean;
}
/** Eligibility only: trusted owner facts must be read under retained locks and
 * current operator authorization. This does not schedule, authorize or publish.
 */
export function planExhaustedOutboxRecovery(input: {
  readonly command: DeadLetterCommand;
  readonly facts: ExhaustedOutboxRecoveryFacts;
  readonly observedAt: string;
  readonly registryDigest: string;
}) {
  const { command, facts, observedAt, registryDigest } = input;
  const deny = (): never => {
    throw new Error("MANUAL_OUTBOX_RECOVERY_INELIGIBLE");
  };
  if (
    ![
      command.deadLetterId,
      command.brandId,
      command.actorId,
      command.actionId,
      command.idempotencyKey,
      facts.eventId,
      ...(command.storeId === undefined ? [] : [command.storeId]),
    ].every((value) => uuid.test(value)) ||
    command.permission !== "EVENTING_DEAD_LETTER_RETRY" ||
    command.purpose !== "RELIABILITY_RECOVERY" ||
    !["DEPENDENCY_RECOVERED", "TRANSIENT_RECOVERED"].includes(command.reason) ||
    typeof command.expectedVersion !== "bigint" ||
    command.expectedVersion < 0n ||
    facts.deadLetterId !== command.deadLetterId ||
    facts.brandId !== command.brandId ||
    facts.storeId !== (command.storeId ?? null) ||
    facts.deadLetterVersion !== command.expectedVersion ||
    facts.status !== "open" ||
    facts.deliveryPath !== "outbox" ||
    facts.failureClass !== "exhausted" ||
    !["TRANSPORT_UNAVAILABLE", "TRANSPORT_TIMEOUT"].includes(facts.safeCode) ||
    facts.automaticAttemptCount !== retryPolicy.maximumActualHandoffs ||
    facts.published !== false ||
    facts.leased !== false ||
    facts.orderingReleased !== false ||
    facts.earlierUnpublishedEvent !== false ||
    facts.activeRecovery !== false ||
    !/^sha256:[0-9a-f]{64}$/u.test(registryDigest) ||
    !instant.test(observedAt) ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt
  )
    return deny();
  const deadline = new Date(
    Date.parse(observedAt) + manualOutboxRecoveryPolicy.startWindowMs,
  ).toISOString();
  if (!instant.test(deadline)) return deny();
  return Object.freeze({
    policyName: manualOutboxRecoveryPolicy.name,
    policyVersion: manualOutboxRecoveryPolicy.version,
    maximumHandoffs: manualOutboxRecoveryPolicy.maximumHandoffs,
    eventId: facts.eventId,
    deadLetterId: facts.deadLetterId,
    originalAutomaticAttemptCount: facts.automaticAttemptCount,
    expectedDeadLetterVersion: facts.deadLetterVersion,
    registryDigest,
    observedAt,
    startDeadlineAt: deadline,
  });
}
