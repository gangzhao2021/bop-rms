import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "../../contracts/consumer-inbox.js";
import type { DeadLetterCommand } from "../../contracts/retry-dead-letter.js";
import {
  planExhaustedOutboxRecovery,
  type ExhaustedOutboxRecoveryFacts,
} from "../../contracts/manual-outbox-recovery.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export class ManualOutboxRecoveryError extends Error {
  constructor(readonly code: "INPUT_INVALID" | "PERMISSION_DENIED" | "CONFLICT" | "UNAVAILABLE") {
    super("Manual Outbox recovery could not be scheduled.");
    this.name = "ManualOutboxRecoveryError";
  }
}
const fail = (code: ManualOutboxRecoveryError["code"]): never => {
  throw new ManualOutboxRecoveryError(code);
};
function command(value: unknown): DeadLetterCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("INPUT_INVALID");
  const raw: Record<string, unknown> = {};
  const keys = [
    "deadLetterId",
    "brandId",
    "actorId",
    "permission",
    "purpose",
    "reason",
    "expectedVersion",
    "idempotencyKey",
    "actionId",
  ];
  if (Object.hasOwn(value, "storeId")) keys.push("storeId");
  if (Reflect.ownKeys(value).length !== keys.length) return fail("INPUT_INVALID");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return fail("INPUT_INVALID");
    raw[key] = descriptor.value;
  }
  for (const key of [
    "deadLetterId",
    "brandId",
    "actorId",
    "idempotencyKey",
    "actionId",
    ...(keys.includes("storeId") ? ["storeId"] : []),
  ])
    if (typeof raw[key] !== "string" || !uuid.test(raw[key])) return fail("INPUT_INVALID");
  if (
    raw.permission !== "EVENTING_DEAD_LETTER_RETRY" ||
    raw.purpose !== "RELIABILITY_RECOVERY" ||
    (raw.reason !== "TRANSIENT_RECOVERED" && raw.reason !== "DEPENDENCY_RECOVERED") ||
    typeof raw.expectedVersion !== "bigint" ||
    raw.expectedVersion < 0n
  )
    return fail("INPUT_INVALID");
  return Object.freeze(raw) as unknown as DeadLetterCommand;
}
function canonical(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail("UNAVAILABLE");
  return value;
}
export interface ManualOutboxRecoveryStoreOptions {
  readonly scope: { readonly brandId: string; readonly storeId?: string };
  readonly registryDigest: string;
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  /** Revalidate current Actor/purpose/permission, retaining authority fences until transaction ends. */
  authorizeAndFence(tx: ConsumerTransaction, command: DeadLetterCommand): Promise<boolean>;
  generateReference(): string;
  now(): string;
}
/** Scheduling only. The runner must roll back every thrown error. No transport is invoked. */
export function createManualOutboxRecoveryStore(options: ManualOutboxRecoveryStoreOptions) {
  const scope = Object.freeze({ ...options.scope }),
    registryDigest = options.registryDigest;
  if (
    !uuid.test(scope.brandId) ||
    (scope.storeId !== undefined && !uuid.test(scope.storeId)) ||
    !/^sha256:[0-9a-f]{64}$/u.test(registryDigest)
  )
    throw new TypeError("MANUAL_RECOVERY_CONFIG_INVALID");
  return Object.freeze({
    async schedule(value: unknown) {
      const input = command(value);
      if (input.brandId !== scope.brandId || input.storeId !== scope.storeId)
        return fail("PERMISSION_DENIED");
      const intentDigest =
        "sha256:" +
        createHash("sha256")
          .update(
            JSON.stringify([
              input.deadLetterId,
              input.brandId,
              input.storeId ?? null,
              input.actorId,
              input.permission,
              input.purpose,
              input.reason,
              input.expectedVersion.toString(),
              input.idempotencyKey,
              input.actionId,
              registryDigest,
            ]),
          )
          .digest("hex");
      try {
        return await options.transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandId, scope.storeId ?? ""],
          );
          const authorize = async () => {
            if ((await options.authorizeAndFence(tx, input)) !== true)
              return fail("PERMISSION_DENIED");
          };
          await authorize();
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            JSON.stringify([
              "eventing.manual-recovery",
              scope.brandId,
              scope.storeId ?? null,
              input.idempotencyKey,
            ]),
          ]);
          const existing = await tx.query<{
            recovery_id: string;
            intent_digest: string;
            requested_at: string;
            start_deadline_at: string;
          }>(
            `SELECT recovery_id::text,intent_digest,
    to_char(requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
    to_char(start_deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_deadline_at
    FROM platform_eventing.manual_outbox_recovery WHERE brand_id=$1 AND store_id IS NOT DISTINCT FROM $2 AND idempotency_key=$3`,
            [scope.brandId, scope.storeId ?? null, input.idempotencyKey],
          );
          if (existing.rows.length) {
            const receipt = existing.rows[0];
            if (existing.rows.length !== 1 || !receipt || receipt.intent_digest !== intentDigest)
              return fail("CONFLICT");
            if (
              !uuid.test(receipt.recovery_id) ||
              Date.parse(canonical(receipt.start_deadline_at)) -
                Date.parse(canonical(receipt.requested_at)) !==
                300000
            )
              return fail("UNAVAILABLE");
            await authorize();
            return Object.freeze({
              status: "Replayed" as const,
              recoveryReference: receipt.recovery_id,
              requestedAt: receipt.requested_at,
              startDeadlineAt: receipt.start_deadline_at,
            });
          }
          const locked = await tx.query<{
            event_id: string;
            version: string;
            status: ExhaustedOutboxRecoveryFacts["status"];
            delivery_path: ExhaustedOutboxRecoveryFacts["deliveryPath"];
            failure_class: string;
            safe_code: string;
            attempt_count: number;
          }>(
            `SELECT event_id::text,version::text,status,delivery_path,failure_class,safe_code,attempt_count
    FROM platform_eventing.dead_letter_item WHERE dead_letter_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 FOR UPDATE`,
            [input.deadLetterId, scope.brandId, scope.storeId ?? null],
          );
          const dead = locked.rows[0];
          if (locked.rows.length !== 1 || !dead) return fail("CONFLICT");
          const events = await tx.query<{
            attempt_count: number;
            last_error_code: string;
            published: boolean;
            leased: boolean;
            ordering_released: boolean;
            earlier: boolean;
            active: boolean;
          }>(
            `SELECT e.attempt_count,e.last_error_code,e.published_at IS NOT NULL AS published,e.lease_token IS NOT NULL AS leased,e.ordering_released_at IS NOT NULL AS ordering_released,
    EXISTS(SELECT 1 FROM platform_eventing.outbox_event earlier WHERE earlier.brand_id=e.brand_id AND earlier.aggregate_type=e.aggregate_type AND earlier.aggregate_id=e.aggregate_id AND earlier.published_at IS NULL AND earlier.ordering_released_at IS NULL AND (earlier.aggregate_version,earlier.event_id)<(e.aggregate_version,e.event_id)) AS earlier,
    EXISTS(SELECT 1 FROM platform_eventing.manual_outbox_recovery_execution x WHERE x.brand_id=e.brand_id AND x.store_id IS NOT DISTINCT FROM e.store_id AND x.event_id=e.event_id AND x.state IN ('scheduled','claimed','unknown')) AS active
    FROM platform_eventing.outbox_event e WHERE e.event_id=$1 AND e.brand_id=$2 AND e.store_id IS NOT DISTINCT FROM $3 FOR UPDATE OF e`,
            [dead.event_id, scope.brandId, scope.storeId ?? null],
          );
          const event = events.rows[0];
          if (
            events.rows.length !== 1 ||
            !event ||
            event.last_error_code !== dead.safe_code ||
            event.attempt_count !== dead.attempt_count
          )
            return fail("CONFLICT");
          await authorize();
          const at = canonical(options.now());
          let plan;
          try {
            plan = planExhaustedOutboxRecovery({
              command: input,
              registryDigest,
              observedAt: at,
              facts: {
                deadLetterId: input.deadLetterId,
                eventId: dead.event_id,
                brandId: scope.brandId,
                storeId: scope.storeId ?? null,
                deadLetterVersion: BigInt(dead.version),
                status: dead.status,
                deliveryPath: dead.delivery_path,
                failureClass: dead.failure_class,
                safeCode: dead.safe_code,
                automaticAttemptCount: event.attempt_count,
                published: event.published,
                leased: event.leased,
                orderingReleased: event.ordering_released,
                earlierUnpublishedEvent: event.earlier,
                activeRecovery: event.active,
              },
            });
          } catch {
            return fail("CONFLICT");
          }
          const recovery = options.generateReference();
          if (!uuid.test(recovery)) return fail("UNAVAILABLE");
          const inserted = await tx.query(
            `INSERT INTO platform_eventing.manual_outbox_recovery(recovery_id,brand_id,store_id,dead_letter_id,event_id,actor_id,action_id,idempotency_key,expected_dead_letter_version,purpose_code,reason_code,permission_code,policy_name,policy_version,original_automatic_attempt_count,maximum_handoffs,intent_digest,registry_digest,requested_at,start_deadline_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING recovery_id`,
            [
              recovery,
              scope.brandId,
              scope.storeId ?? null,
              input.deadLetterId,
              plan.eventId,
              input.actorId,
              input.actionId,
              input.idempotencyKey,
              input.expectedVersion.toString(),
              input.purpose,
              input.reason,
              input.permission,
              plan.policyName,
              plan.policyVersion,
              plan.originalAutomaticAttemptCount,
              plan.maximumHandoffs,
              intentDigest,
              registryDigest,
              at,
              plan.startDeadlineAt,
            ],
          );
          if (inserted.rowCount !== 1) return fail("UNAVAILABLE");
          const scheduled = await tx.query(
            `INSERT INTO platform_eventing.manual_outbox_recovery_execution(recovery_id,brand_id,store_id,event_id,state,version) VALUES($1,$2,$3,$4,'scheduled',1) RETURNING recovery_id`,
            [recovery, scope.brandId, scope.storeId ?? null, plan.eventId],
          );
          if (scheduled.rowCount !== 1) return fail("UNAVAILABLE");
          const action = await tx.query(
            `INSERT INTO platform_eventing.dead_letter_action(action_id,dead_letter_id,brand_id,store_id,action,actor_id,permission_code,purpose_code,reason_code,expected_version,idempotency_key) VALUES($1,$2,$3,$4,'retry',$5,$6,$7,$8,$9,$10) RETURNING action_id`,
            [
              input.actionId,
              input.deadLetterId,
              scope.brandId,
              scope.storeId ?? null,
              input.actorId,
              input.permission,
              input.purpose,
              input.reason,
              input.expectedVersion.toString(),
              input.idempotencyKey,
            ],
          );
          if (action.rowCount !== 1) return fail("UNAVAILABLE");
          const changed = await tx.query(
            `UPDATE platform_eventing.dead_letter_item SET status='retry_scheduled',version=version+1 WHERE dead_letter_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND status='open' AND version=$4 RETURNING dead_letter_id`,
            [
              input.deadLetterId,
              scope.brandId,
              scope.storeId ?? null,
              input.expectedVersion.toString(),
            ],
          );
          if (changed.rowCount !== 1) return fail("CONFLICT");
          await authorize();
          const end = canonical(options.now());
          if (end < at || end >= plan.startDeadlineAt) return fail("UNAVAILABLE");
          return Object.freeze({
            status: "Scheduled" as const,
            recoveryReference: recovery,
            requestedAt: at,
            startDeadlineAt: plan.startDeadlineAt,
          });
        });
      } catch (error) {
        if (error instanceof ManualOutboxRecoveryError) throw error;
        return fail("UNAVAILABLE");
      }
    },
  });
}
