import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDiningClosingFence,
  listDiningSessionJoinAdmissions,
  listDiningSessionMergesInto,
  loadDiningGuestTableActivity,
  staffRoundNotSentCloseReason,
} from "@rms/dining";
import { listStoreDiningSessionOrderActivity, listStoreDiningSessionOrders } from "@rms/ordering";
import { runDiningSessionClosing } from "./dining-session-closing-run.js";
import { createDiningTableReleaseComposition } from "./dining-table-release-composition.js";

export interface DiningRefusedRoundTableCloseOptions {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly providerAccountReference: string;
  readonly environment: "Test" | "Live";
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  /** The Store's own runtime gate (this process may act for the Store now). */
  authorize(): Promise<boolean>;
  now(): string;
  newReference(): string;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
}

/**
 * WP-2423 batch 30: a staff round opened an empty table, then was refused because the staff member
 * signed out (or lost the right to send rounds) before anything was ordered. Their own close is
 * refused for the same reason, so the System closes the Session again (Begin, then Finalize, which
 * frees the table), in one transaction, recorded as the System with reason STAFF_ROUND_NOT_SENT.
 *
 * Only when everything on the table is still that round's own doing: the Session is Active and was
 * started by that staff member, no order exists for it, its cart is empty, no call is open, no
 * other table was merged into it, and nobody joined it but the round's own table guest. Anything
 * else keeps it open for staff (`Kept`). Nothing was served, so the freed table is not held for
 * cleaning (as the staff member's own close of a refused opening).
 */
export function createDiningRefusedRoundTableClose(options: DiningRefusedRoundTableCloseOptions) {
  const { scope } = options;
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const authorize = () => options.authorize();
  return async (input: {
    readonly tableReference: string;
    readonly diningSessionReference: string;
    readonly actorReference: string;
    readonly admissionReference: string;
  }): Promise<"Closed" | "Kept"> =>
    options.transactions.run(async (tx) => {
      const observedAt = options.now();
      const session = input.diningSessionReference;
      const fenced = await createPostgresDiningClosingFence({ scope, authorize })(tx, {
        diningSessionReference: session,
        observedAt,
      });
      if (
        fenced.phase !== "Active" ||
        String(fenced.tableReference) !== input.tableReference ||
        String(fenced.startedByActorReference) !== input.actorReference
      )
        return "Kept";
      if ((await listStoreDiningSessionOrders(tx, owner, [session])).has(session)) return "Kept";
      const ordering = (
        await listStoreDiningSessionOrderActivity(tx, owner, [session], observedAt)
      ).get(session);
      if (ordering?.cartHasItems === true) return "Kept";
      const dining = (await loadDiningGuestTableActivity(tx, owner, [session])).get(session);
      if (dining?.phase !== "Active" || dining.openStaffCall) return "Kept";
      if (
        ((await listDiningSessionMergesInto(tx as never, owner, [session])).get(session)?.length ??
          0) > 0
      )
        return "Kept";
      const admissions = await listDiningSessionJoinAdmissions(tx, owner, session);
      if (admissions.some((admission) => admission !== input.admissionReference)) return "Kept";
      const reasonCode = staffRoundNotSentCloseReason;
      const finalizeOperation = options.newReference();
      const closing = (
        action: "Begin" | "Finalize",
        operationReference: string,
        expectedSessionVersion: number,
      ) =>
        runDiningSessionClosing({
          transaction: tx,
          scope,
          command: {
            action,
            diningSessionReference: session,
            operationReference,
            expectedSessionVersion,
          },
          observedAt,
          providerAccountReference: options.providerAccountReference,
          environment: options.environment,
          guard: authorize,
          newReference: options.newReference,
          closingReason: async () => reasonCode,
          authority: async (request, reason) =>
            Object.freeze({
              kind: "System" as const,
              diningSessionReference: request.session.diningSessionReference,
              storeReference: request.session.storeReference,
              observedAt: request.observedAt,
              audit: {
                auditId: options.newReference(),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "System" as const },
                actionCode: `DINING_SESSION_CLOSING_${request.operation.toUpperCase()}`,
                targetType: "DiningSession",
                targetId: session,
                reasonCode: reason,
                correlationId: operationReference,
                occurredAt: request.observedAt,
                sourceChannel: "SYSTEM",
                dataClassification: "Restricted" as const,
                retentionPolicyCode: options.retentionPolicyCode,
                retentionPolicyVersion: options.retentionPolicyVersion,
              },
            }),
          release: async (_closed, version) => {
            await createDiningTableReleaseComposition({
              scope,
              actorReference: null,
              sourceChannel: "SYSTEM",
              authorize,
              newReference: options.newReference,
              retentionPolicyCode: options.retentionPolicyCode,
              retentionPolicyVersion: options.retentionPolicyVersion,
            })(tx, {
              diningSessionReference: session,
              operationReference: finalizeOperation,
              expectedSessionVersion: version,
              observedAt,
            });
          },
        });
      const begun = await closing("Begin", options.newReference(), fenced.version);
      const closed = await closing("Finalize", finalizeOperation, begun.sessionVersion);
      return closed.phase === "Closed" ? "Closed" : "Kept";
    });
}
