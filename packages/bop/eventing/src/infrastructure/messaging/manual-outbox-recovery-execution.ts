import { createManualOutboxRecoveryCompletion } from "./manual-outbox-recovery-completion.js";
import type { ConsumerTransaction } from "../../contracts/consumer-inbox.js";
import type { DeadLetterCommand } from "../../contracts/retry-dead-letter.js";
import { loadOutboxEnvelope } from "./dispatch-outbox.js";
import type { ManualOutboxRecoveryStoreOptions } from "./manual-outbox-recovery-store.js";
import type { createManualOutboxRecoveryRegistry } from "./manual-outbox-recovery-registry.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function instant(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("MANUAL_RECOVERY_CLOCK_INVALID");
  return value;
}
export function createManualOutboxRecoveryExecution(
  options: Omit<ManualOutboxRecoveryStoreOptions, "registryDigest"> & {
    readonly registry: ReturnType<typeof createManualOutboxRecoveryRegistry>;
    readonly leaseOwner: string;
  },
) {
  const scope = Object.freeze({ ...options.scope });
  if (
    !uuid.test(scope.brandId) ||
    (scope.storeId !== undefined && !uuid.test(scope.storeId)) ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(options.leaseOwner)
  )
    throw new TypeError("MANUAL_RECOVERY_EXECUTION_CONFIG_INVALID");
  return Object.freeze({
    record: createManualOutboxRecoveryCompletion(options),
    async claim(requestedScope: { brandId: string; storeId?: string }, recoveryReference: string) {
      if (
        requestedScope.brandId !== scope.brandId ||
        requestedScope.storeId !== scope.storeId ||
        !uuid.test(recoveryReference)
      )
        throw new Error("MANUAL_RECOVERY_SCOPE_DENIED");
      try {
        return await options.transactions.run(async (tx: ConsumerTransaction) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandId, scope.storeId ?? ""],
          );
          const rows = await tx.query<{
            event_id: string;
            dead_letter_id: string;
            actor_id: string;
            action_id: string;
            idempotency_key: string;
            expected_dead_letter_version: string;
            reason_code: DeadLetterCommand["reason"];
            registry_digest: string;
            start_deadline_at: string;
            requested_at: string;
            state: string;
            version: string;
          }>(
            `SELECT r.event_id::text,r.dead_letter_id::text,r.actor_id::text,r.action_id::text,r.idempotency_key::text,r.expected_dead_letter_version::text,r.reason_code,r.registry_digest,
    to_char(r.start_deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_deadline_at,
    to_char(r.requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,x.state,x.version::text
    FROM platform_eventing.manual_outbox_recovery r JOIN platform_eventing.manual_outbox_recovery_execution x USING(recovery_id)
    WHERE r.recovery_id=$1 AND r.brand_id=$2 AND r.store_id IS NOT DISTINCT FROM $3 FOR UPDATE OF x`,
            [recoveryReference, scope.brandId, scope.storeId ?? null],
          );
          const row = rows.rows[0];
          if (rows.rows.length === 0) return null;
          if (rows.rows.length !== 1 || !row) throw new Error();
          const command: DeadLetterCommand = {
            ...scope,
            deadLetterId: row.dead_letter_id,
            actorId: row.actor_id,
            actionId: row.action_id,
            idempotencyKey: row.idempotency_key,
            expectedVersion: BigInt(row.expected_dead_letter_version),
            reason: row.reason_code,
            purpose: "RELIABILITY_RECOVERY",
            permission: "EVENTING_DEAD_LETTER_RETRY",
          };
          const authorize = async () => {
            if ((await options.authorizeAndFence(tx, command)) !== true)
              throw new Error("MANUAL_RECOVERY_PERMISSION_DENIED");
          };
          await authorize();
          if (row.state !== "scheduled") return null;
          if (row.registry_digest !== options.registry.digest)
            throw new Error("MANUAL_RECOVERY_REGISTRY_CHANGED");
          const dead = await tx.query(
            `SELECT dead_letter_id FROM platform_eventing.dead_letter_item WHERE dead_letter_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND event_id=$4 AND delivery_path='outbox' AND status='retry_scheduled' AND version=$5 FOR UPDATE`,
            [
              row.dead_letter_id,
              scope.brandId,
              scope.storeId ?? null,
              row.event_id,
              (command.expectedVersion + 1n).toString(),
            ],
          );
          if (dead.rowCount !== 1) throw new Error();
          const event = await tx.query(
            `SELECT event_id FROM platform_eventing.outbox_event e WHERE event_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND published_at IS NULL AND lease_token IS NULL AND ordering_released_at IS NULL AND attempt_count=8 AND last_error_code IN ('TRANSPORT_UNAVAILABLE','TRANSPORT_TIMEOUT') AND NOT EXISTS(SELECT 1 FROM platform_eventing.outbox_event earlier WHERE earlier.brand_id=e.brand_id AND earlier.aggregate_type=e.aggregate_type AND earlier.aggregate_id=e.aggregate_id AND earlier.published_at IS NULL AND earlier.ordering_released_at IS NULL AND (earlier.aggregate_version,earlier.event_id)<(e.aggregate_version,e.event_id)) FOR UPDATE OF e`,
            [row.event_id, scope.brandId, scope.storeId ?? null],
          );
          if (event.rowCount !== 1) throw new Error();
          const envelope = await loadOutboxEnvelope(tx, row.event_id);
          if (!envelope) throw new Error();
          options.registry.consumersFor(envelope);
          await authorize();
          const at = instant(options.now());
          if (at < instant(row.requested_at)) throw new Error();
          if (at >= instant(row.start_deadline_at)) return null;
          const token = options.generateReference();
          if (!uuid.test(token)) throw new Error();
          const deadline = new Date(Date.parse(at) + 30000).toISOString();
          const changed = await tx.query(
            `UPDATE platform_eventing.manual_outbox_recovery_execution SET state='claimed',version=version+1,lease_token=$2,lease_owner=$3,lease_expires_at=$4 WHERE recovery_id=$1 AND state='scheduled' AND version=$5 RETURNING recovery_id`,
            [recoveryReference, token, options.leaseOwner, deadline, row.version],
          );
          if (changed.rowCount !== 1) throw new Error();
          const attempt = await tx.query(
            `INSERT INTO platform_eventing.manual_outbox_recovery_attempt(recovery_id,brand_id,store_id,event_id,lease_token,started_at,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING recovery_id`,
            [
              recoveryReference,
              scope.brandId,
              scope.storeId ?? null,
              row.event_id,
              token,
              at,
              deadline,
            ],
          );
          if (attempt.rowCount !== 1) throw new Error();
          await authorize();
          const end = instant(options.now());
          if (end < at || end >= deadline || end >= row.start_deadline_at) throw new Error();
          return Object.freeze({
            recoveryReference,
            leaseToken: token,
            leaseExpiresAt: deadline,
            registryDigest: row.registry_digest,
            envelope,
          });
        });
      } catch {
        throw new Error("MANUAL_RECOVERY_CLAIM_UNAVAILABLE");
      }
    },
  });
}
