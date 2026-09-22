import type { DeadLetterCommand } from "../../contracts/retry-dead-letter.js";
import type { ManualOutboxRecoveryStoreOptions } from "./manual-outbox-recovery-store.js";
import type { createManualOutboxRecoveryRegistry } from "./manual-outbox-recovery-registry.js";
import { loadOutboxEnvelope } from "./dispatch-outbox.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function clock(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error();
  return value;
}
export interface ManualRecoveryCompletionInput {
  readonly recoveryReference: string;
  readonly leaseToken: string;
  readonly result: {
    readonly outcome: "acknowledged" | "failed" | "unknown";
    readonly safeCode: string;
  };
}
/** Trusted Worker port, never expose as a client-asserted publication endpoint. */
export function createManualOutboxRecoveryCompletion(
  options: Omit<ManualOutboxRecoveryStoreOptions, "registryDigest"> & {
    readonly registry: ReturnType<typeof createManualOutboxRecoveryRegistry>;
  },
) {
  const scope = Object.freeze({ ...options.scope });
  return async (
    requestedScope: { brandId: string; storeId?: string },
    input: ManualRecoveryCompletionInput,
  ): Promise<"recorded" | "lost_lease"> => {
    if (
      requestedScope.brandId !== scope.brandId ||
      requestedScope.storeId !== scope.storeId ||
      !uuid.test(input.recoveryReference) ||
      !uuid.test(input.leaseToken)
    )
      throw new Error("MANUAL_RECOVERY_SCOPE_DENIED");
    const result = Object.freeze({ ...input.result });
    if (!(
      (result.outcome === "acknowledged" && result.safeCode === "ACKNOWLEDGED") ||
      (result.outcome === "unknown" && result.safeCode === "COMMIT_OUTCOME_UNKNOWN") ||
      (result.outcome === "failed" &&
        ["TRANSPORT_UNAVAILABLE", "TRANSPORT_TIMEOUT", "TRANSPORT_REJECTED"].includes(
          result.safeCode,
        ))
    ))
      throw new Error("MANUAL_RECOVERY_OUTCOME_INVALID");
    try {
      return await options.transactions.run(async (tx) => {
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
          state: string;
          version: string;
          lease_token: string | null;
          attempt_token: string;
          started_at: string;
          deadline_at: string;
        }>(
          `SELECT r.event_id::text,r.dead_letter_id::text,r.actor_id::text,r.action_id::text,r.idempotency_key::text,r.expected_dead_letter_version::text,r.reason_code,r.registry_digest,x.state,x.version::text,x.lease_token::text,a.lease_token::text AS attempt_token,
    to_char(a.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
    to_char(a.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deadline_at
    FROM platform_eventing.manual_outbox_recovery r JOIN platform_eventing.manual_outbox_recovery_execution x USING(recovery_id) JOIN platform_eventing.manual_outbox_recovery_attempt a USING(recovery_id)
    WHERE r.recovery_id=$1 AND r.brand_id=$2 AND r.store_id IS NOT DISTINCT FROM $3 FOR UPDATE OF x`,
          [input.recoveryReference, scope.brandId, scope.storeId ?? null],
        );
        const row = rows.rows[0];
        if (rows.rows.length === 0) return "lost_lease";
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
          if ((await options.authorizeAndFence(tx, command)) !== true) throw new Error();
        };
        await authorize();
        if (input.leaseToken !== row.attempt_token) return "lost_lease";
        if (row.registry_digest !== options.registry.digest) throw new Error();
        const existing = await tx.query<{ outcome: string; safe_code: string }>(
          `SELECT outcome,safe_code FROM platform_eventing.manual_outbox_recovery_outcome WHERE recovery_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND lease_token=$4`,
          [input.recoveryReference, scope.brandId, scope.storeId ?? null, input.leaseToken],
        );
        if (existing.rows.length) {
          const saved = existing.rows[0];
          if (
            existing.rows.length !== 1 ||
            saved?.outcome !== result.outcome ||
            saved.safe_code !== result.safeCode
          )
            throw new Error();
          await authorize();
          return "recorded";
        }
        if (row.state !== "claimed" || row.lease_token !== input.leaseToken) return "lost_lease";
        const at = clock(options.now());
        if (at < clock(row.started_at)) throw new Error();
        if (result.outcome !== "unknown" && at >= clock(row.deadline_at)) return "lost_lease";
        const dead = await tx.query(
          `SELECT dead_letter_id FROM platform_eventing.dead_letter_item WHERE dead_letter_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND event_id=$4 AND status='retry_scheduled' AND version=$5 FOR UPDATE`,
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
        if (result.outcome === "acknowledged") {
          const envelope = await loadOutboxEnvelope(tx, row.event_id);
          if (!envelope || !(await options.registry.acknowledged(tx, envelope)))
            throw new Error("MANUAL_RECOVERY_ACK_INCOMPLETE");
        }
        await authorize();
        const outcome = await tx.query(
          `INSERT INTO platform_eventing.manual_outbox_recovery_outcome(recovery_id,brand_id,store_id,event_id,lease_token,outcome,safe_code,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING recovery_id`,
          [
            input.recoveryReference,
            scope.brandId,
            scope.storeId ?? null,
            row.event_id,
            input.leaseToken,
            result.outcome,
            result.safeCode,
            at,
          ],
        );
        if (outcome.rowCount !== 1) throw new Error();
        if (result.outcome === "acknowledged") {
          const actionId = options.generateReference();
          if (!uuid.test(actionId)) throw new Error();
          const action = await tx.query(
            `INSERT INTO platform_eventing.dead_letter_action(action_id,dead_letter_id,brand_id,store_id,action,actor_id,permission_code,purpose_code,reason_code,expected_version,idempotency_key) VALUES($1,$2,$3,$4,'resolve_retry',$5,$6,$7,$8,$9,$10) RETURNING action_id`,
            [
              actionId,
              row.dead_letter_id,
              scope.brandId,
              scope.storeId ?? null,
              row.actor_id,
              command.permission,
              command.purpose,
              command.reason,
              (command.expectedVersion + 1n).toString(),
              input.recoveryReference,
            ],
          );
          if (action.rowCount !== 1) throw new Error();
          const published = await tx.query(
            `UPDATE platform_eventing.outbox_event SET published_at=statement_timestamp(),last_error_code=NULL WHERE event_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND published_at IS NULL AND lease_token IS NULL AND attempt_count=8 RETURNING event_id`,
            [row.event_id, scope.brandId, scope.storeId ?? null],
          );
          if (published.rowCount !== 1) throw new Error();
          const resolved = await tx.query(
            `UPDATE platform_eventing.dead_letter_item SET status='resolved',resolution_kind='retry_completed',resolved_at=statement_timestamp(),version=version+1 WHERE dead_letter_id=$1 AND status='retry_scheduled' AND version=$2 RETURNING dead_letter_id`,
            [row.dead_letter_id, (command.expectedVersion + 1n).toString()],
          );
          if (resolved.rowCount !== 1) throw new Error();
        } else if (result.outcome === "failed") {
          const reopened = await tx.query(
            `UPDATE platform_eventing.dead_letter_item SET status='open',version=version+1 WHERE dead_letter_id=$1 AND status='retry_scheduled' AND version=$2 RETURNING dead_letter_id`,
            [row.dead_letter_id, (command.expectedVersion + 1n).toString()],
          );
          if (reopened.rowCount !== 1) throw new Error();
        }
        const done = await tx.query(
          `UPDATE platform_eventing.manual_outbox_recovery_execution SET state=$2,version=version+1,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE recovery_id=$1 AND state='claimed' AND lease_token=$3 AND version=$4 RETURNING recovery_id`,
          [input.recoveryReference, result.outcome, input.leaseToken, row.version],
        );
        if (done.rowCount !== 1) throw new Error();
        await authorize();
        const end = clock(options.now());
        if (end < at || (result.outcome !== "unknown" && end >= row.deadline_at)) throw new Error();
        return "recorded";
      });
    } catch {
      throw new Error("MANUAL_RECOVERY_COMPLETION_UNAVAILABLE");
    }
  };
}
