import {
  DiningSessionError,
  parseDiningReference,
  parseDiningInstant,
  parseDiningSession,
  parseDiningParticipant,
  parseDiningTableStartEvidence,
} from "../../contracts/dining-session.js";
import { createDiningTable } from "../../domain/dining-table.js";
import {
  captureSessionData,
  sessionDependency,
} from "../../application/dining-session-snapshot.js";
import type { DiningCartParticipationOptions } from "../../application/dining-cart-participation-query.js";
import type { DiningTableStoreScope, DiningTableTransactionRunner } from "./dining-table-store.js";

function closed(value: unknown, keys: readonly string[]) {
  const copied = captureSessionData(value);
  if (
    copied === null ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.keys(copied).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(copied, key))
  )
    return sessionDependency();
  return copied as Record<string, unknown>;
}
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return sessionDependency();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return sessionDependency();
  const copied = captureSessionData(descriptor.value);
  if (!Array.isArray(copied) || copied.length > 1) return sessionDependency();
  return copied;
}

/** Fresh owner facts only; callers still need current identity, action authority and a write fence. */
export function createPostgresDiningParticipationStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
): DiningCartParticipationOptions["repository"] {
  return createParticipationStore(runner, scopeInput, false);
}

/** Borrow the caller's write transaction and retain these locks until its commit.
 * This proves current Dining Host participation only, never Guest identity or CSRF.
 * Acquire before any Cart lock. Do not release the transaction after this read.
 */
export function createPostgresDiningHostParticipationFence(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
): DiningCartParticipationOptions["repository"] {
  return createParticipationStore(runner, scopeInput, true);
}

function createParticipationStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
  fenceHost: boolean,
): DiningCartParticipationOptions["repository"] {
  const scope = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const tenant = parseDiningReference(scope.tenantReference);
  const brand = parseDiningReference(scope.brandReference);
  const store = parseDiningReference(scope.storeReference);
  return Object.freeze({
    async readCurrent(value) {
      let requested;
      try {
        const raw = closed(value, [
          "brandReference",
          "storeReference",
          "diningSessionReference",
          "participantReference",
          "observedAt",
        ]);
        requested = Object.freeze({
          brand: parseDiningReference(raw.brandReference),
          store: parseDiningReference(raw.storeReference),
          session: parseDiningReference(raw.diningSessionReference),
          participant: parseDiningReference(raw.participantReference),
          at: parseDiningInstant(raw.observedAt),
        });
      } catch {
        throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
      }
      if (requested.brand !== brand || requested.store !== store) return null;
      const input = requested;
      try {
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          let lockedTable: string | null = null;
          if (fenceHost) {
            // Observe only to choose the table lock; this is not authority.
            const located = rows(
              await tx.query(
                "SELECT table_id FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4",
                [tenant, brand, store, input.session],
              ),
            );
            if (located.length === 0) return null;
            lockedTable = parseDiningReference(closed(located[0], ["table_id"]).table_id);
            const tables = rows(
              await tx.query(
                "SELECT table_id FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
                [tenant, brand, store, lockedTable],
              ),
            );
            if (tables.length !== 1 || closed(tables[0], ["table_id"]).table_id !== lockedTable)
              return null;
            const sessions = rows(
              await tx.query(
                "SELECT table_id FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
                [tenant, brand, store, input.session],
              ),
            );
            // A concurrent move may have won before our table lock. Never follow
            // the new table while holding Session; retry from the outer action.
            if (sessions.length !== 1 || closed(sessions[0], ["table_id"]).table_id !== lockedTable)
              return null;
            const participants = rows(
              await tx.query(
                "SELECT participant_id FROM rms_dining.dining_participant WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND participant_id=$5 FOR UPDATE",
                [tenant, brand, store, input.session, input.participant],
              ),
            );
            if (
              participants.length !== 1 ||
              closed(participants[0], ["participant_id"]).participant_id !== input.participant
            )
              return null;
          }
          const found = rows(
            await tx.query(
              "SELECT s.session_snapshot AS session,p.participant_snapshot AS participant,t.table_snapshot AS table FROM rms_dining.dining_session s JOIN rms_dining.dining_participant p ON p.tenant_id=s.tenant_id AND p.brand_id=s.brand_id AND p.store_id=s.store_id AND p.session_id=s.session_id JOIN rms_dining.dining_table t ON t.tenant_id=s.tenant_id AND t.brand_id=s.brand_id AND t.store_id=s.store_id AND t.table_id=s.table_id WHERE s.tenant_id=$1 AND s.brand_id=$2 AND s.store_id=$3 AND s.session_id=$4 AND p.participant_id=$5",
              [tenant, brand, store, input.session, input.participant],
            ),
          );
          if (found.length === 0) return null;
          const raw = closed(found[0], ["session", "participant", "table"]);
          const session = parseDiningSession(raw.session);
          const participant = parseDiningParticipant(raw.participant);
          const currentTable = createDiningTable(raw.table);
          if (
            session.brandReference !== brand ||
            session.storeReference !== store ||
            session.diningSessionReference !== input.session ||
            participant.participantReference !== input.participant ||
            participant.diningSessionReference !== input.session ||
            currentTable.tenantReference !== tenant ||
            currentTable.brandReference !== brand ||
            currentTable.storeReference !== store
          )
            return sessionDependency();
          if (
            (fenceHost &&
              (session.hostParticipantReference !== input.participant ||
                session.tableReference !== lockedTable)) ||
            session.phase !== "Active" ||
            participant.status !== "Active" ||
            currentTable.tableReference !== session.tableReference ||
            currentTable.activeDiningSessionReference !== session.diningSessionReference ||
            currentTable.lifecycle !== "Published" ||
            currentTable.operationalState !== "Available" ||
            currentTable.observedAt > input.at ||
            currentTable.createdAt > input.at ||
            session.startedAt > input.at ||
            participant.joinedAt < session.startedAt ||
            participant.joinedAt > input.at
          )
            return null;
          const table = parseDiningTableStartEvidence({
            brandReference: brand,
            storeReference: store,
            tableReference: currentTable.tableReference,
            assignmentVersion: session.tableAssignmentVersion,
            tableState: "Eligible",
            activeDiningSessionReference: session.diningSessionReference,
            observedAt: input.at,
          });
          return Object.freeze({ session, participant, table });
        });
      } catch {
        return sessionDependency();
      }
    },
  });
}
