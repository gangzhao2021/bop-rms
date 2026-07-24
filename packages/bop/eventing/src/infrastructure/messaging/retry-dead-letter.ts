import {
  deadLetterPermissions,
  deadLetterReasons,
  type DeadLetterCommand,
  type RetryResolution,
  resolveRetry,
  validateRetryResolution,
} from "../../contracts/retry-dead-letter.js";
import type { ConsumerTransaction } from "../../contracts/consumer-inbox.js";

export type RetryDeadLetterTransaction = ConsumerTransaction;

export type DeliveryDecisionResult =
  | { readonly status: "applied"; readonly deadLetterId?: string }
  | { readonly status: "already_applied"; readonly deadLetterId?: string }
  | { readonly status: "conflict" };

export interface RecordDeliveryDecisionInput {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly brandId: string;
  readonly storeId?: string;
  readonly eventId: string;
  readonly consumerName?: string;
  readonly idempotencyKey: string;
  readonly safeCode: string;
  readonly resolution: RetryResolution;
  readonly deadLetterId: string;
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const consumerNamePattern = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*[:]v[1-9][0-9]*$/u;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;

function validateDecisionInput(input: RecordDeliveryDecisionInput, path: "outbox" | "consumer") {
  for (const [name, value] of [
    ["attemptId", input.attemptId],
    ["brandId", input.brandId],
    ["eventId", input.eventId],
    ["idempotencyKey", input.idempotencyKey],
    ["deadLetterId", input.deadLetterId],
    ...(input.storeId ? ([["storeId", input.storeId]] as const) : []),
  ] as const)
    if (!uuidV7.test(value)) throw new TypeError(`${name} must be a UUIDv7`);
  if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 0 || input.attemptNumber > 8)
    throw new TypeError("attemptNumber must be an integer between 0 and 8");
  if (!safeCodePattern.test(input.safeCode)) throw new TypeError("safeCode is invalid");
  if (path === "consumer") {
    if (!input.consumerName || !consumerNamePattern.test(input.consumerName))
      throw new TypeError("consumerName is invalid");
  } else if (input.consumerName !== undefined)
    throw new TypeError("outbox decisions cannot contain consumerName");
  validateRetryResolution(path, input.safeCode, input.attemptNumber, input.resolution);
}

const appendAttemptSql = `INSERT INTO platform_eventing.delivery_attempt (
  attempt_id, brand_id, store_id, delivery_path, event_id, consumer_name,
  attempt_number, failure_class, safe_code, policy_name, policy_version,
  decision, next_available_at, deadline_at, idempotency_key
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
)
ON CONFLICT (
  brand_id, store_id, delivery_path, event_id, consumer_name, idempotency_key
) DO NOTHING
RETURNING attempt_id::text`;

const existingAttemptSql = `SELECT attempt_id::text
FROM platform_eventing.delivery_attempt
WHERE brand_id = $1
  AND store_id IS NOT DISTINCT FROM $2
  AND delivery_path = $3
  AND event_id = $4
  AND consumer_name IS NOT DISTINCT FROM $5
  AND idempotency_key = $6`;

async function appendAttempt(
  transaction: RetryDeadLetterTransaction,
  path: "outbox" | "consumer",
  input: RecordDeliveryDecisionInput,
): Promise<"inserted" | "duplicate"> {
  const result = await transaction.query(appendAttemptSql, [
    input.attemptId,
    input.brandId,
    input.storeId ?? null,
    path,
    input.eventId,
    input.consumerName ?? null,
    input.attemptNumber,
    input.resolution.failureClass,
    input.safeCode,
    input.resolution.policyName,
    input.resolution.policyVersion,
    input.resolution.decision,
    input.resolution.decision === "retry_scheduled" ? input.resolution.nextAvailableAt : null,
    input.resolution.deadlineAt,
    input.idempotencyKey,
  ]);
  if (result.rowCount === 1) return "inserted";
  const existing = await transaction.query(existingAttemptSql, [
    input.brandId,
    input.storeId ?? null,
    path,
    input.eventId,
    input.consumerName ?? null,
    input.idempotencyKey,
  ]);
  if (existing.rowCount === 1) return "duplicate";
  throw new Error("DELIVERY_ATTEMPT_IDEMPOTENCY_NOT_CONFIRMED");
}

const createDeadLetterSql = `INSERT INTO platform_eventing.dead_letter_item (
  dead_letter_id, brand_id, store_id, delivery_path, event_id, consumer_name,
  failure_class, safe_code, attempt_count, policy_name, policy_version, status
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open')
ON CONFLICT (brand_id, store_id, delivery_path, event_id, consumer_name)
DO NOTHING
RETURNING dead_letter_id::text`;

const existingDeadLetterSql = `SELECT dead_letter_id::text
FROM platform_eventing.dead_letter_item
WHERE brand_id = $1
  AND store_id IS NOT DISTINCT FROM $2
  AND delivery_path = $3
  AND event_id = $4
  AND consumer_name IS NOT DISTINCT FROM $5`;

async function createDeadLetter(
  transaction: RetryDeadLetterTransaction,
  path: "outbox" | "consumer",
  input: RecordDeliveryDecisionInput,
): Promise<string> {
  const terminalClass =
    input.resolution.decision === "dead_lettered" ? input.resolution.failureClass : "operator_held";
  const inserted = await transaction.query<{ dead_letter_id: string }>(createDeadLetterSql, [
    input.deadLetterId,
    input.brandId,
    input.storeId ?? null,
    path,
    input.eventId,
    input.consumerName ?? null,
    terminalClass,
    input.safeCode,
    input.attemptNumber,
    input.resolution.policyName,
    input.resolution.policyVersion,
  ]);
  if (inserted.rows[0]) return inserted.rows[0].dead_letter_id;
  const existing = await transaction.query<{ dead_letter_id: string }>(existingDeadLetterSql, [
    input.brandId,
    input.storeId ?? null,
    path,
    input.eventId,
    input.consumerName ?? null,
  ]);
  const row = existing.rows[0];
  if (!row) throw new Error("DEAD_LETTER_IDENTITY_NOT_CONFIRMED");
  return row.dead_letter_id;
}

const lockParkedOutboxSql = `SELECT attempt_count, recorded_at
FROM platform_eventing.outbox_event
WHERE event_id = $1
  AND brand_id = $2
  AND store_id IS NOT DISTINCT FROM $3
  AND published_at IS NULL
  AND lease_token IS NULL
  AND last_error_code = $4
  AND attempt_count = $5
FOR UPDATE`;

const scheduleOutboxSql = `UPDATE platform_eventing.outbox_event
SET available_at = $2,
    last_error_code = NULL
WHERE event_id = $1
  AND published_at IS NULL
  AND lease_token IS NULL
  AND last_error_code IS NOT NULL`;

export async function recordOutboxFailureDecision(
  transaction: RetryDeadLetterTransaction,
  input: RecordDeliveryDecisionInput,
): Promise<DeliveryDecisionResult> {
  validateDecisionInput(input, "outbox");
  const priorAttempt = await transaction.query(existingAttemptSql, [
    input.brandId,
    input.storeId ?? null,
    "outbox",
    input.eventId,
    null,
    input.idempotencyKey,
  ]);
  if (priorAttempt.rowCount === 1) {
    const existing = await transaction.query<{ dead_letter_id: string }>(existingDeadLetterSql, [
      input.brandId,
      input.storeId ?? null,
      "outbox",
      input.eventId,
      null,
    ]);
    return {
      status: "already_applied",
      ...(existing.rows[0] ? { deadLetterId: existing.rows[0].dead_letter_id } : {}),
    };
  }
  const target = await transaction.query(lockParkedOutboxSql, [
    input.eventId,
    input.brandId,
    input.storeId ?? null,
    input.safeCode,
    input.attemptNumber,
  ]);
  if (target.rowCount !== 1) return { status: "conflict" };
  const appended = await appendAttempt(transaction, "outbox", input);
  if (appended === "duplicate") {
    const existing = await transaction.query<{ dead_letter_id: string }>(existingDeadLetterSql, [
      input.brandId,
      input.storeId ?? null,
      "outbox",
      input.eventId,
      null,
    ]);
    return {
      status: "already_applied",
      ...(existing.rows[0] ? { deadLetterId: existing.rows[0].dead_letter_id } : {}),
    };
  }
  if (input.resolution.decision === "retry_scheduled") {
    const scheduled = await transaction.query(scheduleOutboxSql, [
      input.eventId,
      input.resolution.nextAvailableAt,
    ]);
    if (scheduled.rowCount !== 1) throw new Error("OUTBOX_RETRY_SCHEDULE_NOT_CONFIRMED");
    return { status: "applied" };
  }
  if (input.resolution.decision === "reconciliation_required") return { status: "applied" };
  return {
    status: "applied",
    deadLetterId: await createDeadLetter(transaction, "outbox", input),
  };
}

const parkedOutboxBatchSql = `SELECT
  event_id::text,
  brand_id::text,
  store_id::text,
  attempt_count,
  last_error_code,
  recorded_at
FROM platform_eventing.outbox_event
WHERE published_at IS NULL
  AND lease_token IS NULL
  AND last_error_code IS NOT NULL
  AND ordering_released_at IS NULL
  AND (
    (platform_helpers.current_store_id() IS NULL AND store_id IS NULL)
    OR store_id = platform_helpers.current_store_id()
  )
ORDER BY recorded_at, event_id
FOR UPDATE SKIP LOCKED
LIMIT $1`;

export async function scheduleParkedOutboxBatch(
  transaction: RetryDeadLetterTransaction,
  input: {
    readonly batchSize: number;
    readonly now: string;
    readonly random: () => number;
    readonly identities: (eventId: string) => {
      readonly attemptId: string;
      readonly deadLetterId: string;
      readonly idempotencyKey: string;
    };
  },
): Promise<readonly DeliveryDecisionResult[]> {
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 25)
    throw new TypeError("batchSize must be an integer between 1 and 25");
  if (!Number.isFinite(Date.parse(input.now))) throw new TypeError("now must be an ISO instant");
  const parked = await transaction.query<{
    event_id: string;
    brand_id: string;
    store_id: string | null;
    attempt_count: number;
    last_error_code: string;
    recorded_at: Date | string;
  }>(parkedOutboxBatchSql, [input.batchSize]);
  const results: DeliveryDecisionResult[] = [];
  for (const row of parked.rows) {
    const identities = input.identities(row.event_id);
    const firstAttemptAt =
      row.recorded_at instanceof Date
        ? row.recorded_at.toISOString()
        : new Date(row.recorded_at).toISOString();
    results.push(
      await recordOutboxFailureDecision(transaction, {
        ...identities,
        attemptNumber: row.attempt_count,
        brandId: row.brand_id,
        ...(row.store_id ? { storeId: row.store_id } : {}),
        eventId: row.event_id,
        safeCode: row.last_error_code,
        resolution: resolveRetry({
          actualAttemptNumber: row.attempt_count,
          firstAttemptAt,
          now: input.now,
          path: "outbox",
          random: input.random(),
          safeCode: row.last_error_code,
        }),
      }),
    );
  }
  return results;
}

const scheduleConsumerSql = `INSERT INTO platform_eventing.consumer_retry_schedule (
  schedule_id, brand_id, store_id, event_id, consumer_name, source_attempt_id,
  attempt_count, available_at, deadline_at, state
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scheduled')
ON CONFLICT (brand_id, store_id, consumer_name, event_id)
DO UPDATE SET
  source_attempt_id = EXCLUDED.source_attempt_id,
  attempt_count = EXCLUDED.attempt_count,
  available_at = EXCLUDED.available_at,
  deadline_at = EXCLUDED.deadline_at,
  state = 'scheduled',
  lease_token = NULL,
  lease_owner = NULL,
  lease_expires_at = NULL,
  version = platform_eventing.consumer_retry_schedule.version + 1
WHERE platform_eventing.consumer_retry_schedule.state IN ('claimed', 'completed', 'dead_lettered')
RETURNING schedule_id::text`;

const deadLetterConsumerScheduleSql = `INSERT INTO platform_eventing.consumer_retry_schedule (
  schedule_id, brand_id, store_id, event_id, consumer_name, source_attempt_id,
  attempt_count, available_at, deadline_at, state
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'dead_lettered')
ON CONFLICT (brand_id, store_id, consumer_name, event_id)
DO UPDATE SET
  source_attempt_id = EXCLUDED.source_attempt_id,
  attempt_count = EXCLUDED.attempt_count,
  deadline_at = EXCLUDED.deadline_at,
  state = 'dead_lettered',
  lease_token = NULL,
  lease_owner = NULL,
  lease_expires_at = NULL,
  version = platform_eventing.consumer_retry_schedule.version + 1
RETURNING schedule_id::text`;

const reconcileConsumerSql = `INSERT INTO platform_eventing.consumer_retry_schedule (
  schedule_id, brand_id, store_id, event_id, consumer_name, source_attempt_id,
  attempt_count, available_at, deadline_at, state
) VALUES ($1, $2, $3, $4, $5, $6, $7, statement_timestamp(), $8, 'scheduled')
ON CONFLICT (brand_id, store_id, consumer_name, event_id)
DO UPDATE SET
  source_attempt_id = EXCLUDED.source_attempt_id,
  attempt_count = EXCLUDED.attempt_count,
  available_at = statement_timestamp(),
  deadline_at = EXCLUDED.deadline_at,
  state = 'scheduled',
  lease_token = NULL,
  lease_owner = NULL,
  lease_expires_at = NULL,
  version = platform_eventing.consumer_retry_schedule.version + 1
WHERE platform_eventing.consumer_retry_schedule.state IN ('claimed', 'completed', 'dead_lettered')
RETURNING schedule_id::text`;

export async function recordConsumerFailureDecision(
  transaction: RetryDeadLetterTransaction,
  input: RecordDeliveryDecisionInput & { readonly scheduleId: string },
): Promise<DeliveryDecisionResult> {
  validateDecisionInput(input, "consumer");
  if (!uuidV7.test(input.scheduleId)) throw new TypeError("scheduleId must be a UUIDv7");
  const appended = await appendAttempt(transaction, "consumer", input);
  if (appended === "duplicate") {
    const existing = await transaction.query<{ dead_letter_id: string }>(existingDeadLetterSql, [
      input.brandId,
      input.storeId ?? null,
      "consumer",
      input.eventId,
      input.consumerName,
    ]);
    return {
      status: "already_applied",
      ...(existing.rows[0] ? { deadLetterId: existing.rows[0].dead_letter_id } : {}),
    };
  }
  if (input.resolution.decision === "reconciliation_required") {
    const scheduled = await transaction.query(reconcileConsumerSql, [
      input.scheduleId,
      input.brandId,
      input.storeId ?? null,
      input.eventId,
      input.consumerName,
      input.attemptId,
      input.attemptNumber,
      input.resolution.deadlineAt,
    ]);
    if (scheduled.rowCount !== 1) throw new Error("CONSUMER_RECONCILIATION_SCHEDULE_NOT_CONFIRMED");
    return { status: "applied" };
  }
  if (input.resolution.decision === "dead_lettered") {
    if (input.attemptNumber > 0)
      await transaction.query(deadLetterConsumerScheduleSql, [
        input.scheduleId,
        input.brandId,
        input.storeId ?? null,
        input.eventId,
        input.consumerName,
        input.attemptId,
        input.attemptNumber,
        input.resolution.deadlineAt,
      ]);
    return {
      status: "applied",
      deadLetterId: await createDeadLetter(transaction, "consumer", input),
    };
  }
  const scheduled = await transaction.query(scheduleConsumerSql, [
    input.scheduleId,
    input.brandId,
    input.storeId ?? null,
    input.eventId,
    input.consumerName,
    input.attemptId,
    input.attemptNumber,
    input.resolution.nextAvailableAt,
    input.resolution.deadlineAt,
  ]);
  if (scheduled.rowCount !== 1) throw new Error("CONSUMER_RETRY_SCHEDULE_NOT_CONFIRMED");
  return { status: "applied" };
}

export interface ClaimedConsumerRetry {
  readonly scheduleId: string;
  readonly eventId: string;
  readonly consumerName: string;
  readonly deadlineAt: string;
  readonly attemptCount: number;
  readonly leaseToken: string;
  readonly version: bigint;
}

const claimConsumerRetriesSql = `WITH candidates AS (
  SELECT schedule_id
  FROM platform_eventing.consumer_retry_schedule
  WHERE (
      state = 'scheduled'
      OR (state = 'claimed' AND lease_expires_at <= $5)
    )
    AND available_at <= $5
    AND (
      (platform_helpers.current_store_id() IS NULL AND store_id IS NULL)
      OR store_id = platform_helpers.current_store_id()
    )
  ORDER BY available_at, schedule_id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE platform_eventing.consumer_retry_schedule AS schedule
SET state = 'claimed',
    lease_token = $2,
    lease_owner = $3,
    lease_expires_at = $5 + ($4 * interval '1 second'),
    version = schedule.version + 1
FROM candidates
WHERE schedule.schedule_id = candidates.schedule_id
RETURNING
  schedule.schedule_id::text,
  schedule.event_id::text,
  schedule.consumer_name,
  schedule.attempt_count,
  schedule.deadline_at,
  schedule.lease_token::text,
  schedule.version::text`;

export async function claimConsumerRetryBatch(
  transaction: RetryDeadLetterTransaction,
  input: {
    readonly batchSize: number;
    readonly leaseDurationSeconds: number;
    readonly leaseOwner: string;
    readonly leaseToken: string;
    readonly now: string;
  },
): Promise<readonly ClaimedConsumerRetry[]> {
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 25)
    throw new TypeError("batchSize must be an integer between 1 and 25");
  if (
    !Number.isInteger(input.leaseDurationSeconds) ||
    input.leaseDurationSeconds < 1 ||
    input.leaseDurationSeconds > 300
  )
    throw new TypeError("leaseDurationSeconds must be an integer between 1 and 300");
  if (!uuidV7.test(input.leaseToken)) throw new TypeError("leaseToken must be a UUIDv7");
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(input.leaseOwner))
    throw new TypeError("leaseOwner is invalid");
  if (!Number.isFinite(Date.parse(input.now))) throw new TypeError("now must be an ISO instant");
  const result = await transaction.query<{
    schedule_id: string;
    event_id: string;
    consumer_name: string;
    attempt_count: number;
    deadline_at: Date | string;
    lease_token: string;
    version: string;
  }>(claimConsumerRetriesSql, [
    input.batchSize,
    input.leaseToken,
    input.leaseOwner,
    input.leaseDurationSeconds,
    input.now,
  ]);
  return result.rows.map((row) => ({
    scheduleId: row.schedule_id,
    eventId: row.event_id,
    consumerName: row.consumer_name,
    deadlineAt:
      row.deadline_at instanceof Date
        ? row.deadline_at.toISOString()
        : new Date(row.deadline_at).toISOString(),
    attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
    version: BigInt(row.version),
  }));
}

const completeConsumerRetrySql = `UPDATE platform_eventing.consumer_retry_schedule
SET state = $4,
    lease_token = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    version = version + 1
WHERE schedule_id = $1
  AND lease_token = $2
  AND version = $3
  AND state = 'claimed'`;

export async function completeConsumerRetry(
  transaction: RetryDeadLetterTransaction,
  input: {
    readonly scheduleId: string;
    readonly leaseToken: string;
    readonly expectedVersion: bigint;
    readonly outcome: "completed" | "dead_lettered";
  },
): Promise<"completed" | "conflict"> {
  const result = await transaction.query(completeConsumerRetrySql, [
    input.scheduleId,
    input.leaseToken,
    input.expectedVersion.toString(),
    input.outcome,
  ]);
  return result.rowCount === 1 ? "completed" : "conflict";
}

function validateCommand(command: DeadLetterCommand, action: "retry" | "discard" | "release") {
  for (const [name, value] of [
    ["deadLetterId", command.deadLetterId],
    ["brandId", command.brandId],
    ["actorId", command.actorId],
    ["idempotencyKey", command.idempotencyKey],
    ["actionId", command.actionId],
    ...(command.storeId ? ([["storeId", command.storeId]] as const) : []),
  ] as const)
    if (!uuidV7.test(value)) throw new TypeError(`${name} must be a UUIDv7`);
  if (!deadLetterPermissions.includes(command.permission))
    throw new TypeError("permission is invalid");
  if (!deadLetterReasons.includes(command.reason)) throw new TypeError("reason is invalid");
  const expectedPermission =
    action === "retry" ? "EVENTING_DEAD_LETTER_RETRY" : "EVENTING_DEAD_LETTER_DISCARD";
  if (command.permission !== expectedPermission)
    throw new TypeError("permission does not authorize the requested action");
  if (
    (action === "retry" &&
      command.reason !== "TRANSIENT_RECOVERED" &&
      command.reason !== "DEPENDENCY_RECOVERED") ||
    (action === "discard" && command.reason !== "AUTHORIZED_DISCARD") ||
    (action === "release" && command.reason !== "ORDERING_RELEASE")
  )
    throw new TypeError("reason does not authorize the requested action");
  if (command.expectedVersion < 0n) throw new TypeError("expectedVersion cannot be negative");
}

const existingActionSql = `SELECT action_id::text
FROM platform_eventing.dead_letter_action
WHERE brand_id = $1
  AND store_id IS NOT DISTINCT FROM $2
  AND idempotency_key = $3`;

const lockDeadLetterSql = `SELECT delivery_path, event_id::text, consumer_name, status, version::text
FROM platform_eventing.dead_letter_item
WHERE dead_letter_id = $1
  AND brand_id = $2
  AND store_id IS NOT DISTINCT FROM $3
FOR UPDATE`;

const insertActionSql = `INSERT INTO platform_eventing.dead_letter_action (
  action_id, dead_letter_id, brand_id, store_id, action, actor_id,
  permission_code, purpose_code, reason_code, expected_version, idempotency_key
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (brand_id, store_id, idempotency_key) DO NOTHING
RETURNING action_id::text`;

export async function applyDeadLetterCommand(
  transaction: RetryDeadLetterTransaction,
  action: "retry" | "discard",
  command: DeadLetterCommand,
): Promise<"applied" | "already_applied" | "conflict"> {
  validateCommand(command, action);
  const duplicate = await transaction.query(existingActionSql, [
    command.brandId,
    command.storeId ?? null,
    command.idempotencyKey,
  ]);
  if (duplicate.rowCount === 1) return "already_applied";
  const locked = await transaction.query<{
    delivery_path: "outbox" | "consumer";
    event_id: string;
    consumer_name: string | null;
    status: string;
    version: string;
  }>(lockDeadLetterSql, [command.deadLetterId, command.brandId, command.storeId ?? null]);
  const item = locked.rows[0];
  if (!item || item.status !== "open" || BigInt(item.version) !== command.expectedVersion)
    return "conflict";
  if (action === "retry") {
    const target =
      item.delivery_path === "outbox"
        ? await transaction.query(
            `SELECT event_id
             FROM platform_eventing.outbox_event
             WHERE event_id = $1
               AND published_at IS NULL
               AND lease_token IS NULL
               AND attempt_count < 8
               AND last_error_code IS NOT NULL
             FOR UPDATE`,
            [item.event_id],
          )
        : await transaction.query(
            `SELECT schedule_id
             FROM platform_eventing.consumer_retry_schedule
             WHERE event_id = $1
               AND consumer_name = $2
               AND state = 'dead_lettered'
             FOR UPDATE`,
            [item.event_id, item.consumer_name],
          );
    if (target.rowCount !== 1) return "conflict";
  }
  const inserted = await transaction.query(insertActionSql, [
    command.actionId,
    command.deadLetterId,
    command.brandId,
    command.storeId ?? null,
    action,
    command.actorId,
    command.permission,
    command.purpose,
    command.reason,
    command.expectedVersion.toString(),
    command.idempotencyKey,
  ]);
  if (inserted.rowCount !== 1) return "already_applied";
  if (action === "retry") {
    const retried =
      item.delivery_path === "outbox"
        ? await transaction.query(
            `UPDATE platform_eventing.outbox_event
             SET last_error_code = NULL,
                 available_at = statement_timestamp()
             WHERE event_id = $1
           AND published_at IS NULL
           AND lease_token IS NULL
           AND attempt_count < 8
           AND last_error_code IS NOT NULL`,
            [item.event_id],
          )
        : await transaction.query(
            `UPDATE platform_eventing.consumer_retry_schedule
             SET state = 'scheduled',
                 available_at = statement_timestamp(),
                 lease_token = NULL,
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 version = version + 1
             WHERE event_id = $1
               AND consumer_name = $2
               AND state = 'dead_lettered'`,
            [item.event_id, item.consumer_name],
          );
    if (retried.rowCount !== 1) throw new Error("DEAD_LETTER_RETRY_TARGET_NOT_CONFIRMED");
  }
  const updated = await transaction.query(
    `UPDATE platform_eventing.dead_letter_item
     SET status = $2,
         version = version + 1
     WHERE dead_letter_id = $1
       AND status = 'open'
       AND version = $3`,
    [
      command.deadLetterId,
      action === "retry" ? "retry_scheduled" : "discarded",
      command.expectedVersion.toString(),
    ],
  );
  if (updated.rowCount !== 1) throw new Error("DEAD_LETTER_COMMAND_NOT_CONFIRMED");
  return "applied";
}

export async function resolveDeadLetter(
  transaction: RetryDeadLetterTransaction,
  resolution: "retry_completed" | "discard_released",
  command: DeadLetterCommand,
): Promise<"applied" | "already_applied" | "conflict"> {
  validateCommand(command, resolution === "retry_completed" ? "retry" : "release");
  const duplicate = await transaction.query(existingActionSql, [
    command.brandId,
    command.storeId ?? null,
    command.idempotencyKey,
  ]);
  if (duplicate.rowCount === 1) return "already_applied";
  const locked = await transaction.query<{
    delivery_path: "outbox" | "consumer";
    event_id: string;
    consumer_name: string | null;
    status: string;
    version: string;
  }>(lockDeadLetterSql, [command.deadLetterId, command.brandId, command.storeId ?? null]);
  const item = locked.rows[0];
  const expectedStatus = resolution === "retry_completed" ? "retry_scheduled" : "discarded";
  if (!item || item.status !== expectedStatus || BigInt(item.version) !== command.expectedVersion)
    return "conflict";
  if (resolution === "retry_completed") {
    const completion =
      item.delivery_path === "outbox"
        ? await transaction.query(
            `SELECT event_id
             FROM platform_eventing.outbox_event
             WHERE event_id = $1 AND published_at IS NOT NULL`,
            [item.event_id],
          )
        : await transaction.query(
            `SELECT schedule_id
             FROM platform_eventing.consumer_retry_schedule
             WHERE event_id = $1
               AND consumer_name = $2
               AND state = 'completed'`,
            [item.event_id, item.consumer_name],
          );
    if (completion.rowCount !== 1) return "conflict";
  } else if (item.delivery_path === "outbox") {
    const releasable = await transaction.query(
      `SELECT event_id
       FROM platform_eventing.outbox_event
       WHERE event_id = $1
         AND published_at IS NULL
         AND last_error_code IS NOT NULL
         AND ordering_released_at IS NULL
       FOR UPDATE`,
      [item.event_id],
    );
    if (releasable.rowCount !== 1) return "conflict";
  }
  const inserted = await transaction.query(insertActionSql, [
    command.actionId,
    command.deadLetterId,
    command.brandId,
    command.storeId ?? null,
    resolution === "retry_completed" ? "resolve_retry" : "release",
    command.actorId,
    command.permission,
    command.purpose,
    command.reason,
    command.expectedVersion.toString(),
    command.idempotencyKey,
  ]);
  if (inserted.rowCount !== 1) return "already_applied";
  if (resolution === "discard_released" && item.delivery_path === "outbox") {
    const released = await transaction.query(
      `UPDATE platform_eventing.outbox_event
       SET ordering_released_at = statement_timestamp()
       WHERE event_id = $1
         AND published_at IS NULL
         AND last_error_code IS NOT NULL
         AND ordering_released_at IS NULL`,
      [item.event_id],
    );
    if (released.rowCount !== 1) throw new Error("DEAD_LETTER_RELEASE_TARGET_NOT_CONFIRMED");
  }
  const updated = await transaction.query(
    `UPDATE platform_eventing.dead_letter_item
     SET status = 'resolved',
         resolution_kind = $2,
         resolved_at = statement_timestamp(),
         version = version + 1
     WHERE dead_letter_id = $1
       AND status = $3
       AND version = $4`,
    [command.deadLetterId, resolution, expectedStatus, command.expectedVersion.toString()],
  );
  if (updated.rowCount !== 1) throw new Error("DEAD_LETTER_RESOLUTION_NOT_CONFIRMED");
  return "applied";
}
