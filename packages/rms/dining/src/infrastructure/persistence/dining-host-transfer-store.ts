import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
} from "@bop/audit";
import {
  createDiningHostTransfer,
  parseDiningHostTransferCommand,
  parseDiningHostTransferRecord,
  DiningHostTransferError,
  type DiningHostTransferCommand,
  type DiningHostTransferRecord,
} from "../../domain/dining-host-transfer.js";
import {
  parseDiningReference,
  parseDiningInstant,
  parseDiningParticipant,
} from "../../domain/dining-session.js";
import { createPostgresDiningClosingFence } from "./dining-closing-fence.js";
import type {
  DiningTableTransaction,
  DiningTableTransactionRunner,
  DiningTableStoreScope,
} from "./dining-table-store.js";
const fail = (): never => {
  throw new DiningHostTransferError();
};
function rows(value: unknown) {
  if (!value || typeof value !== "object") return fail();
  const raw = Object.getOwnPropertyDescriptor(value, "rows");
  if (!raw || !("value" in raw) || !Array.isArray(raw.value) || raw.value.length > 1) return fail();
  return raw.value as readonly Record<string, unknown>[];
}
/** Owns the transaction. Authorization must retain current authenticated actor and
 * employee permission/Guest binding fences. Candidate actor fields never grant access.
 * Replay returns original history, not current Host authority.
 */
export function createPostgresDiningHostTransferStore(
  runner: DiningTableTransactionRunner,
  options: {
    scope: DiningTableStoreScope;
    now(): string;
    authorize(tx: DiningTableTransaction, command: DiningHostTransferCommand): Promise<boolean>;
    audit(record: DiningHostTransferRecord): unknown;
  },
) {
  const scope = {
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  };
  return Object.freeze({
    async transfer(value: unknown) {
      const command = parseDiningHostTransferCommand(value);
      if (
        command.tenantReference !== scope.tenantReference ||
        command.brandReference !== scope.brandReference ||
        command.storeReference !== scope.storeReference
      )
        return fail();
      let previous = command.observedAt;
      const tick = () => {
        const at = parseDiningInstant(options.now());
        if (at < previous) return fail();
        previous = at;
        return at;
      };
      try {
        return await runner.run(async (tx) => {
          const authorize = async () => {
            tick();
            if ((await options.authorize(tx, command)) !== true) return fail();
            tick();
            return true;
          };
          await authorize();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningHostTransfer:${scope.tenantReference}:${scope.brandReference}:${scope.storeReference}:${command.operationReference}`,
          ]);
          const prior = rows(
            await tx.query(
              "SELECT record_json AS record FROM rms_dining.dining_host_transfer_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
              [
                scope.tenantReference,
                scope.brandReference,
                scope.storeReference,
                command.operationReference,
              ],
            ),
          )[0];
          if (prior) {
            const original = parseDiningHostTransferRecord(prior.record);
            if (
              original.command.observedAt > command.observedAt ||
              canonicalizeRfc8785({ ...original.command, observedAt: command.observedAt }) !==
                canonicalizeRfc8785(command)
            )
              return fail();
            await authorize();
            return Object.freeze({ status: "AlreadyApplied" as const, record: original });
          }
          const session = await createPostgresDiningClosingFence({ scope, authorize })(tx, {
            diningSessionReference: command.diningSessionReference,
            observedAt: command.observedAt,
          });
          const target = rows(
            await tx.query(
              "SELECT participant_snapshot AS participant FROM rms_dining.dining_participant WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND participant_id=$5 FOR UPDATE",
              [
                scope.tenantReference,
                scope.brandReference,
                scope.storeReference,
                command.diningSessionReference,
                command.targetParticipantReference,
              ],
            ),
          )[0];
          if (!target) return fail();
          const record = createDiningHostTransfer({
            command,
            session,
            targetParticipant: target.participant,
          });
          const audit = validateAuditRecord(options.audit(record), Date.parse(tick()));
          if (
            audit.brandId !== scope.brandReference ||
            audit.storeId !== scope.storeReference ||
            audit.targetType !== "DiningSession" ||
            audit.targetId !== command.diningSessionReference ||
            audit.correlationId !== command.operationReference ||
            audit.actionCode !== "DINING_HOST_TRANSFERRED" ||
            audit.occurredAt !== command.observedAt ||
            audit.reasonCode !== command.reasonCode ||
            audit.dataClassification !== "Restricted" ||
            Object.keys(audit.beforeSummary ?? {}).length !== 0 ||
            Object.keys(audit.afterSummary ?? {}).length !== 0 ||
            (command.actorType === "Staff"
              ? audit.actor.type !== "User" ||
                audit.actor.reference !== command.actorReference ||
                audit.sourceChannel !== "MERCHANT_WEB"
              : audit.actor.type !== "System" || audit.sourceChannel !== "CUSTOMER_PWA")
          )
            return fail();
          await authorize();
          const updated = await tx.query(
            "UPDATE rms_dining.dining_session SET version=$5,session_snapshot=$6::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND version=$7 AND session_snapshot=$8::jsonb",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              command.diningSessionReference,
              record.session.version,
              JSON.stringify(record.session),
              command.expectedSessionVersion,
              JSON.stringify(record.previousSession),
            ],
          );
          if (
            !updated ||
            typeof updated !== "object" ||
            Object.getOwnPropertyDescriptor(updated, "rowCount")?.value !== 1
          )
            return fail();
          const inserted = rows(
            await tx.query(
              "INSERT INTO rms_dining.dining_host_transfer_operation (tenant_id,brand_id,store_id,operation_id,session_id,target_participant_id,expected_version,occurred_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING operation_id",
              [
                scope.tenantReference,
                scope.brandReference,
                scope.storeReference,
                command.operationReference,
                command.diningSessionReference,
                command.targetParticipantReference,
                command.expectedSessionVersion,
                command.observedAt,
                JSON.stringify(record),
              ],
            ),
          );
          if (inserted.length !== 1 || inserted[0]?.operation_id !== command.operationReference)
            return fail();
          await appendAuditRecordInTransaction(tx, audit);
          await authorize();
          return Object.freeze({ status: "Applied" as const, record });
        });
      } catch {
        return fail();
      }
    },
  });
}

/** Coherent read for employee selection, never a transferable authorization token. */
export function createPostgresDiningHostTransferSelection(
  runner: DiningTableTransactionRunner,
  options: {
    scope: DiningTableStoreScope;
    now(): string;
    authorize(tx: DiningTableTransaction): Promise<boolean>;
  },
) {
  const scope = {
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  };
  return Object.freeze({
    async readCurrent(value: unknown) {
      try {
        if (
          !value ||
          typeof value !== "object" ||
          Object.getPrototypeOf(value) !== Object.prototype ||
          Reflect.ownKeys(value).length !== 1
        )
          return fail();
        const d = Object.getOwnPropertyDescriptor(value, "diningSessionReference");
        if (!d?.enumerable || !("value" in d)) return fail();
        const reference = parseDiningReference(d.value);
        return await runner.run(async (tx) => {
          const at = parseDiningInstant(options.now());
          const authorize = async () => {
            if (parseDiningInstant(options.now()) < at || (await options.authorize(tx)) !== true)
              return fail();
            return true;
          };
          await authorize();
          const session = await createPostgresDiningClosingFence({ scope, authorize })(tx, {
            diningSessionReference: reference,
            observedAt: at,
          });
          if (!["Active", "Closing"].includes(session.phase)) return fail();
          const result = await tx.query(
            "SELECT participant_snapshot AS participant FROM rms_dining.dining_participant WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND status='Active' ORDER BY participant_snapshot->>'joinedAt',participant_id LIMIT 101 FOR SHARE",
            [scope.tenantReference, scope.brandReference, scope.storeReference, reference],
          );
          if (!result || typeof result !== "object") return fail();
          const list = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(list) || list.length > 100) return fail();
          const seen = new Set<string>();
          let previous = "";
          const participants = list.map((row) => {
            if (!row || typeof row !== "object") return fail();
            const raw = Object.getOwnPropertyDescriptor(row, "participant");
            if (!raw || !("value" in raw)) return fail();
            const p = parseDiningParticipant(raw.value),
              key = p.joinedAt + ":" + p.participantReference;
            if (
              p.diningSessionReference !== reference ||
              p.status !== "Active" ||
              p.joinedAt < session.startedAt ||
              p.joinedAt > at ||
              seen.has(p.participantReference) ||
              key <= previous
            )
              return fail();
            seen.add(p.participantReference);
            previous = key;
            return Object.freeze({
              participantReference: p.participantReference,
              joinedAt: p.joinedAt,
              isHost: p.participantReference === session.hostParticipantReference,
            });
          });
          await authorize();
          if (parseDiningInstant(options.now()) < at) return fail();
          return Object.freeze({
            diningSessionReference: reference,
            sessionVersion: session.version,
            phase: session.phase,
            hostParticipantReference: session.hostParticipantReference,
            participants: Object.freeze(participants),
            observedAt: at,
          });
        });
      } catch {
        return fail();
      }
    },
  });
}
