import type { ConsumerErrorCode } from "./consumer-inbox.js";
import type { OutboxDispatchErrorCode } from "./outbox-dispatch.js";

export const retryPolicy = {
  name: "eventing_default",
  version: 1,
  maximumActualHandoffs: 8,
  baseDelayMs: 1_000,
  multiplier: 2,
  maximumDelayMs: 300_000,
  maximumHorizonMs: 86_400_000,
} as const;

export const retryableSafeCodes = [
  "TRANSPORT_TIMEOUT",
  "TRANSPORT_UNAVAILABLE",
  "CONSUMER_TEMPORARY_FAILURE",
  "AGGREGATE_ORDER_GAP",
] as const;

export const nonRetryableSafeCodes = [
  "INVALID_ENVELOPE",
  "TRANSPORT_REJECTED",
  "CONSUMER_UNKNOWN",
  "EVENT_TYPE_UNSUPPORTED",
  "EVENT_SCHEMA_VERSION_UNSUPPORTED",
  "TENANT_SCOPE_DENIED",
  "CONSUMER_REJECTED",
] as const;

export const commitUnknownSafeCodes = ["COMMIT_OUTCOME_UNKNOWN"] as const;

export type RetryPath = "outbox" | "consumer";
export type RetrySafeCode = OutboxDispatchErrorCode | ConsumerErrorCode;
export type RetryFailureClass =
  "retryable" | "non_retryable" | "commit_unknown" | "ordering_gap" | "exhausted" | "operator_held";

export type RetryResolution =
  | {
      readonly decision: "retry_scheduled";
      readonly failureClass: "retryable" | "ordering_gap";
      readonly nextAvailableAt: string;
      readonly deadlineAt: string;
      readonly delayMs: number;
      readonly policyName: typeof retryPolicy.name;
      readonly policyVersion: typeof retryPolicy.version;
    }
  | {
      readonly decision: "dead_lettered";
      readonly failureClass: "non_retryable" | "exhausted";
      readonly deadlineAt: string;
      readonly policyName: typeof retryPolicy.name;
      readonly policyVersion: typeof retryPolicy.version;
    }
  | {
      readonly decision: "reconciliation_required";
      readonly failureClass: "commit_unknown";
      readonly deadlineAt: string;
      readonly policyName: typeof retryPolicy.name;
      readonly policyVersion: typeof retryPolicy.version;
    };

const outboxRetryable = new Set<string>(["TRANSPORT_TIMEOUT", "TRANSPORT_UNAVAILABLE"]);
const consumerRetryable = new Set<string>(["CONSUMER_TEMPORARY_FAILURE", "AGGREGATE_ORDER_GAP"]);
const commitUnknown = new Set<string>(commitUnknownSafeCodes);

function isRetryable(path: RetryPath, safeCode: string): boolean {
  return (path === "outbox" ? outboxRetryable : consumerRetryable).has(safeCode);
}

function validInstant(value: string, name: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} must be an ISO instant`);
  return milliseconds;
}

export function resolveRetry(input: {
  readonly actualAttemptNumber: number;
  readonly firstAttemptAt: string;
  readonly now: string;
  readonly path: RetryPath;
  readonly random: number;
  readonly safeCode: string;
}): RetryResolution {
  if (!Number.isInteger(input.actualAttemptNumber) || input.actualAttemptNumber < 0)
    throw new TypeError("actualAttemptNumber must be a non-negative integer");
  if (input.random < 0 || input.random >= 1 || !Number.isFinite(input.random))
    throw new TypeError("random must be in the half-open interval [0, 1)");
  const now = validInstant(input.now, "now");
  const firstAttemptAt = validInstant(input.firstAttemptAt, "firstAttemptAt");
  if (now < firstAttemptAt) throw new TypeError("now cannot precede firstAttemptAt");
  const deadline = firstAttemptAt + retryPolicy.maximumHorizonMs;
  const common = {
    deadlineAt: new Date(deadline).toISOString(),
    policyName: retryPolicy.name,
    policyVersion: retryPolicy.version,
  } as const;
  if (input.path === "consumer" && commitUnknown.has(input.safeCode)) {
    if (now >= deadline) return { ...common, decision: "dead_lettered", failureClass: "exhausted" };
    return {
      ...common,
      decision: "reconciliation_required",
      failureClass: "commit_unknown",
    };
  }
  if (!isRetryable(input.path, input.safeCode))
    return { ...common, decision: "dead_lettered", failureClass: "non_retryable" };
  if (input.actualAttemptNumber === 0)
    throw new TypeError("retryable failures require an actual handoff");
  if (input.actualAttemptNumber >= retryPolicy.maximumActualHandoffs || now >= deadline)
    return { ...common, decision: "dead_lettered", failureClass: "exhausted" };
  const unjitteredDelay = Math.min(
    retryPolicy.maximumDelayMs,
    retryPolicy.baseDelayMs * retryPolicy.multiplier ** Math.max(0, input.actualAttemptNumber - 1),
  );
  const delayMs = Math.floor(input.random * unjitteredDelay);
  const next = Math.min(now + delayMs, deadline);
  return {
    ...common,
    decision: "retry_scheduled",
    failureClass: input.safeCode === "AGGREGATE_ORDER_GAP" ? "ordering_gap" : "retryable",
    nextAvailableAt: new Date(next).toISOString(),
    delayMs: next - now,
  };
}

export function validateRetryResolution(
  path: RetryPath,
  safeCode: string,
  actualAttemptNumber: number,
  resolution: RetryResolution,
): void {
  if (
    resolution.policyName !== retryPolicy.name ||
    resolution.policyVersion !== retryPolicy.version
  )
    throw new TypeError("retry resolution policy is invalid");
  if (path === "consumer" && commitUnknown.has(safeCode)) {
    if (resolution.decision === "dead_lettered" && resolution.failureClass === "exhausted") return;
    if (
      resolution.decision !== "reconciliation_required" ||
      resolution.failureClass !== "commit_unknown"
    )
      throw new TypeError("commit-unknown resolution is invalid");
    return;
  }
  if (isRetryable(path, safeCode)) {
    if (actualAttemptNumber < 1)
      throw new TypeError("retryable failures require an actual handoff");
    if (
      resolution.decision === "retry_scheduled" &&
      resolution.failureClass ===
        (safeCode === "AGGREGATE_ORDER_GAP" ? "ordering_gap" : "retryable")
    )
      return;
    if (resolution.decision === "dead_lettered" && resolution.failureClass === "exhausted") return;
    throw new TypeError("retryable failure resolution is invalid");
  }
  if (resolution.decision !== "dead_lettered" || resolution.failureClass !== "non_retryable")
    throw new TypeError("non-retryable failure resolution is invalid");
}

export const deadLetterPermissions = [
  "EVENTING_DEAD_LETTER_RETRY",
  "EVENTING_DEAD_LETTER_DISCARD",
] as const;
export type DeadLetterPermission = (typeof deadLetterPermissions)[number];

export const deadLetterReasons = [
  "TRANSIENT_RECOVERED",
  "DEPENDENCY_RECOVERED",
  "AUTHORIZED_DISCARD",
  "ORDERING_RELEASE",
] as const;
export type DeadLetterReason = (typeof deadLetterReasons)[number];

export interface DeadLetterCommand {
  readonly deadLetterId: string;
  readonly brandId: string;
  readonly storeId?: string;
  readonly actorId: string;
  readonly permission: DeadLetterPermission;
  readonly purpose: "RELIABILITY_RECOVERY";
  readonly reason: DeadLetterReason;
  readonly expectedVersion: bigint;
  readonly idempotencyKey: string;
  readonly actionId: string;
}

export interface RetryTelemetryEvent {
  readonly path: RetryPath;
  readonly failureClass:
    "retryable" | "non_retryable" | "commit_unknown" | "ordering_gap" | "exhausted";
  readonly safeCode: string;
  readonly attemptBucket: "1" | "2-3" | "4-7" | "8";
  readonly delayBucket: "none" | "<1s" | "1-9s" | "10-59s" | "1-4m" | "5m";
  readonly outcome:
    "retry_scheduled" | "dead_lettered" | "reconciliation_required" | "completed" | "conflict";
}

export function retryTelemetryBuckets(
  attempt: number,
  delayMs?: number,
): Pick<RetryTelemetryEvent, "attemptBucket" | "delayBucket"> {
  const attemptBucket = attempt === 1 ? "1" : attempt <= 3 ? "2-3" : attempt <= 7 ? "4-7" : "8";
  const delayBucket =
    delayMs === undefined
      ? "none"
      : delayMs < 1_000
        ? "<1s"
        : delayMs < 10_000
          ? "1-9s"
          : delayMs < 60_000
            ? "10-59s"
            : delayMs < 300_000
              ? "1-4m"
              : "5m";
  return { attemptBucket, delayBucket };
}
