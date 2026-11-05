import { markDiningTableNeedsCleaning } from "./dining-table-needs-cleaning.js";
import { createDiningTableReleaseComposition } from "./dining-table-release-composition.js";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  DiningClosingError,
  listDiningGuestStartedSessions,
  loadDiningServiceSetting,
  parseDiningReference,
  parsePositiveDiningVersion,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
import {
  DiningCheckoutAlreadyPaidError,
  runDiningSessionClosing,
} from "./dining-session-closing-run.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { onlyRefusal } from "./merchant-failure.js";
const fail = (): never => {
  throw new Error("DINING_CLOSING_COMMAND_UNAVAILABLE");
};
// WP-2423 (B759): a missing permission and a changed session are told apart from failures.
const denied = (): never => {
  throw new DiningClosingError("DINING_CLOSING_PERMISSION_DENIED");
};
export { DiningCheckoutAlreadyPaidError };
/** The Task actions an unpaid-order exception Task can need while a table closes. */
const taskActions = ["task.create", "task.assign"] as const;

/** A table a guest started, at a Store whose switch is on now. */
async function guestStartedAtSwitchOnStore(
  tx: ConsumerTransaction,
  scope: { tenantReference: string; brandReference: string; storeReference: string },
  diningSessionReference: string,
): Promise<boolean> {
  if (!(await listDiningGuestStartedSessions(tx, scope, [diningSessionReference])).size)
    return false;
  return (await loadDiningServiceSetting(tx, scope)).guestTableStart;
}

export function createMerchantDiningClosingCommand(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  providerAccountReference: string;
  environment: "Test" | "Live";
  newReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
  exceptionTaskPolicy?: unknown;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input).catch(onlyRefusal(denied));
    const raw = readClosedRecord(input.command, [
      "action",
      "diningSessionReference",
      "operationReference",
      "expectedSessionVersion",
    ]);
    if (raw.action !== "Begin" && raw.action !== "Cancel" && raw.action !== "Finalize")
      return fail();
    const command = {
      action: raw.action as "Begin" | "Cancel" | "Finalize",
      diningSessionReference: parseDiningReference(raw.diningSessionReference),
      operationReference: parseDiningReference(raw.operationReference),
      expectedSessionVersion: parsePositiveDiningVersion(raw.expectedSessionVersion),
    };
    // WP-2423: one authorized run. The caller, its `dining.session.close` permission and the Task
    // permissions an unpaid-order exception Task may need are resolved in full once at the start
    // (one current-fact read) and once more before the reply; owner reads in between are fenced by
    // the run's guard (no query). Re-resolving the caller inside every owner read (as before) cost
    // ~3,000 statements to finalize a one-order table.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const current = await resolve(
              transaction,
              input.sessionCookie,
              "dining.session.close",
              authenticated.sessionReference,
            ).catch(onlyRefusal(denied));
            const decisions = await current.authorizeActions([
              "dining.session.close",
              ...taskActions,
            ]);
            const permission = decisions.get("dining.session.close");
            if (permission?.effect !== "Allow") return denied();
            return { current, permission, tasks: decisions, usedTasks: new Set<string>() };
          },
          // The Task permissions this run used are re-checked with the close permission, in the
          // same current-fact read, and must still answer as they did at the start.
          recheck: async ({ current, tasks, usedTasks }) => {
            if (usedTasks.size === 0) return (await current.allowed()) === true;
            const fresh = await current.authorizeActions(["dining.session.close", ...usedTasks]);
            return (
              fresh.get("dining.session.close")?.effect === "Allow" &&
              [...usedTasks].every(
                (action) =>
                  fresh.get(action)?.effect !== undefined &&
                  fresh.get(action)?.effect === tasks.get(action)?.effect,
              )
            );
          },
          denied,
        },
        (authority) => closeInRun(transaction, authority),
      ),
    );
    async function closeInRun(
      transaction: Parameters<
        Parameters<PersistentMerchantBffOptions["transactions"]["run"]>[0]
      >[0],
      authority: MerchantTransactionAuthority<{
        current: Awaited<ReturnType<typeof resolve>>;
        permission: NonNullable<
          Awaited<ReturnType<Awaited<ReturnType<typeof resolve>>["authorizeAction"]>>
        >;
        tasks: Awaited<ReturnType<Awaited<ReturnType<typeof resolve>>["authorizeActions"]>>;
        usedTasks: Set<string>;
      }>,
    ) {
      const { current, permission: closePermission, tasks, usedTasks } = authority.scope,
        guard = () => authority.guard();
      const scope = {
        tenantReference: current.selected.tenantReference,
        brandReference: String(current.context.brand.brandReference),
        storeReference: String(current.store.storeReference),
      };
      const tx: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await transaction.query(sql, values);
          if (!result || typeof result !== "object") return fail();
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown,
            rowCount = Object.getOwnPropertyDescriptor(result, "rowCount")?.value as unknown;
          if (
            !Array.isArray(rows) ||
            (rowCount !== null &&
              (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0))
          )
            return fail();
          return { rows: rows as readonly Row[], rowCount: rowCount as number | null };
        },
      };
      const observedAt = String(current.context.resolvedAt);
      const release = createDiningTableReleaseComposition({
        scope,
        actorReference: String(current.actorReference),
        authorize: guard,
        newReference: options.newReference,
        retentionPolicyCode: options.retentionPolicyCode,
        retentionPolicyVersion: options.retentionPolicyVersion,
      });
      return runDiningSessionClosing({
        transaction: tx,
        scope,
        command,
        observedAt,
        providerAccountReference: options.providerAccountReference,
        environment: options.environment,
        guard,
        newReference: options.newReference,
        release: async (session, version) => {
          await release(tx, {
            diningSessionReference: command.diningSessionReference,
            operationReference: command.operationReference,
            expectedSessionVersion: version,
            observedAt,
          });
          // WP-2423 DEC-DINING-GUEST-TABLE-START: at a Store where guests start tables, closing one
          // a guest started ends as the System's close does: no step nobody would take at 8 pm.
          if (await guestStartedAtSwitchOnStore(tx, scope, command.diningSessionReference)) return;
          // Handoff §25.3: the freed table waits for cleaning before it is seated again.
          await markDiningTableNeedsCleaning(tx, {
            scope,
            actorReference: String(current.actorReference),
            tableReference: String(session.tableReference),
            operationReference: options.newReference(),
            correlationReference: command.operationReference,
            observedAt,
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
            newReference: options.newReference,
            authorize: guard,
          });
        },
        // The permission decided for this run at its start (re-checked before the reply).
        authority: async (request, reason) => ({
          kind: "Staff",
          tenantContext: current.context,
          permission: closePermission,
          audit: {
            auditId: options.newReference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: current.actorReference },
            actionCode: `DINING_SESSION_CLOSING_${request.operation.toUpperCase()}`,
            targetType: "DiningSession",
            targetId: command.diningSessionReference,
            reasonCode: reason,
            correlationId: command.operationReference,
            occurredAt: request.observedAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Restricted",
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
          },
        }),
        ...(options.exceptionTaskPolicy === undefined
          ? {}
          : {
              tasks: {
                policy: options.exceptionTaskPolicy,
                actorReference: String(current.actorReference),
                // Decided for this run at its start; re-checked in full before the reply.
                authorizeTask: async (request: { action: unknown }) => {
                  const action = String(request.action);
                  const decision = tasks.get(action);
                  if (!decision || !(await guard())) return denied();
                  usedTasks.add(action);
                  return decision;
                },
              },
            }),
      });
    }
  };
}
