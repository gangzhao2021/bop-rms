import { createDiningExceptionTaskComposition } from "./dining-exception-task-composition.js";
import { createDiningTableReleaseComposition } from "./dining-table-release-composition.js";
import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  DiningClosingError,
  createDiningClosingService,
  createPostgresDiningClosingStore,
  createPostgresDiningClosingFence,
  parseDiningReference,
  parseDiningHash,
  parsePositiveDiningVersion,
} from "@rms/dining";
import {
  createPostgresStaffOrderCancellationReader,
  listStoreDiningSessionOrders,
} from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
import {
  createDiningSettledSessionEvidence,
  createDiningSessionClosingEvidence,
} from "./dining-settled-session-evidence.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
const fail = (): never => {
  throw new Error("DINING_CLOSING_COMMAND_UNAVAILABLE");
};
// WP-2423 (B759): a missing permission and a changed session are told apart from failures.
const denied = (): never => {
  throw new DiningClosingError("DINING_CLOSING_PERMISSION_DENIED");
};
const changed = (): never => {
  throw new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");
};
/** The Task actions an unpaid-order exception Task can need while a table closes. */
const taskActions = ["task.create", "task.assign"] as const;

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
    const authenticated = await options.authentication.authorize(input).catch(denied);
    const raw = readClosedRecord(input.command, [
      "action",
      "diningSessionReference",
      "operationReference",
      "expectedSessionVersion",
    ]);
    if (raw.action !== "Begin" && raw.action !== "Finalize") return fail();
    const command = {
      action: raw.action,
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
            ).catch(denied);
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
      const hashes = {
        hashIntent: (value: string) =>
          parseDiningHash(createHash("sha256").update(value).digest("hex")),
        equals: (a: string, b: string) => a === b,
      };
      const runner = { run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(tx) };
      const store = createPostgresDiningClosingStore(runner, scope, hashes);
      const observedAt = String(current.context.resolvedAt);
      const release = createDiningTableReleaseComposition({
        scope,
        actorReference: String(current.actorReference),
        authorize: guard,
        newReference: options.newReference,
        retentionPolicyCode: options.retentionPolicyCode,
        retentionPolicyVersion: options.retentionPolicyVersion,
      });
      const releaseClosedTable = (version: number) =>
        release(tx, {
          diningSessionReference: command.diningSessionReference,
          operationReference: command.operationReference,
          expectedSessionVersion: version,
          observedAt,
        });
      const fence = createPostgresDiningClosingFence({ scope, authorize: guard });
      const session = await fence(tx, {
        diningSessionReference: command.diningSessionReference,
        observedAt,
      });
      const prior = await store.readReceipt(command.operationReference, guard);
      if (prior) {
        if (
          prior.record.action !== command.action ||
          prior.record.session.diningSessionReference !== command.diningSessionReference ||
          prior.expectedVersion !== command.expectedSessionVersion ||
          prior.occurredAt > observedAt ||
          prior.record.session.version > session.version
        )
          return fail();
        if (command.action === "Finalize") await releaseClosedTable(prior.record.session.version);
        return Object.freeze({
          status: "AlreadyApplied" as const,
          phase: prior.record.session.phase,
          sessionVersion: prior.record.session.version,
        });
      }
      if (session.version !== command.expectedSessionVersion) return changed();
      const authorizeAndFence = async () => {
        const again = await fence(tx, {
          diningSessionReference: command.diningSessionReference,
          observedAt,
        });
        return (
          again.version === session.version &&
          again.tableAssignmentVersion === session.tableAssignmentVersion
        );
      };
      const evidence = (
        options.exceptionTaskPolicy === undefined
          ? createDiningSettledSessionEvidence
          : createDiningSessionClosingEvidence
      )({
        ...scope,
        diningScope: scope,
        paymentScope: {
          ...scope,
          providerAccountReference: options.providerAccountReference,
          environment: options.environment,
        },
        authorize: guard,
        authorizeKitchen: guard,
        authorizeDining: guard,
        authorizeAndFence,
        // WP-2423 item 2: an Order whose every round was cancelled is closed with the table too.
        includeCancelled: true,
      });
      let resolvedEvidence: Awaited<ReturnType<typeof evidence.load>> | null = null;
      // DEC-TABLE-CLOSE-GUESTS-LEFT: a table whose rounds were closed out because the guests left
      // is recorded as closed for that reason, not as guests who finished. Ordering owner reads.
      let closingReason: Promise<"GUEST_LEFT" | "CUSTOMER_FINISHED"> | null = null;
      const reasonFor = () =>
        (closingReason ??= (async () => {
          const owner = {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
          };
          const order = (
            await listStoreDiningSessionOrders(tx, owner, [String(command.diningSessionReference)])
          ).get(String(command.diningSessionReference));
          if (order === undefined) return "CUSTOMER_FINISHED";
          const cancellations = await createPostgresStaffOrderCancellationReader(
            owner,
          ).listByOrders(tx, [order]);
          return cancellations.some((record) => record.reasonCode === "GUEST_LEFT")
            ? "GUEST_LEFT"
            : "CUSTOMER_FINISHED";
        })());
      const service = createDiningClosingService({
        store,
        hashes,
        authorization: {
          authorize: async (request) => {
            // The permission decided for this run at its start (re-checked before the reply).
            if (
              !(await guard()) ||
              request.session.diningSessionReference !== command.diningSessionReference
            )
              return null;
            return {
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
                reasonCode: await reasonFor(),
                correlationId: command.operationReference,
                occurredAt: request.observedAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Restricted",
                retentionPolicyCode: options.retentionPolicyCode,
                retentionPolicyVersion: options.retentionPolicyVersion,
              },
            };
          },
        },
        closureEvidence: {
          resolve: async (query) => {
            resolvedEvidence = await evidence.load(
              tx,
              {
                diningSessionReference: query.diningSessionReference,
                observedAt: query.observedAt,
              },
              session.version,
            );
            return resolvedEvidence;
          },
        },
        reversibility: { evaluate: async () => "Unavailable" },
        tasks: {
          ensure: async (taskInput) => {
            if (!resolvedEvidence || options.exceptionTaskPolicy === undefined) return fail();
            return createDiningExceptionTaskComposition({
              transaction: tx,
              scope,
              actorReference: String(current.actorReference),
              correlationReference: command.operationReference,
              observedAt,
              evidence: resolvedEvidence,
              policy: options.exceptionTaskPolicy,
              hashes,
              newReference: options.newReference,
              authorizeAndFence: async () => (await guard()) && (await authorizeAndFence()),
              // Decided for this run at its start; re-checked in full before the reply.
              authorizeTask: async (request) => {
                const action = String(request.action);
                const decision = tasks.get(action);
                if (!decision || !(await guard())) return fail();
                usedTasks.add(action);
                return decision;
              },
            }).ensure(taskInput);
          },
        },
      });
      const request = {
        diningSessionReference: command.diningSessionReference,
        operationReference: command.operationReference,
        expectedSessionVersion: command.expectedSessionVersion,
        requestedAt: observedAt,
      };
      const result = await (command.action === "Begin"
        ? service.begin(request)
        : service.finalize(request));
      if (command.action === "Finalize") await releaseClosedTable(result.session.version);
      return Object.freeze({
        status: result.status,
        phase: result.session.phase,
        sessionVersion: result.session.version,
      });
    }
  };
}
