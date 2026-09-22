import { createDiningExceptionTaskComposition } from "./dining-exception-task-composition.js";
import { createDiningTableReleaseComposition } from "./dining-table-release-composition.js";
import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createDiningClosingService,
  createPostgresDiningClosingStore,
  createPostgresDiningClosingFence,
  parseDiningReference,
  parseDiningHash,
  parsePositiveDiningVersion,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  createDiningSettledSessionEvidence,
  createDiningSessionClosingEvidence,
} from "./dining-settled-session-evidence.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
const fail = (): never => {
  throw new Error("DINING_CLOSING_COMMAND_UNAVAILABLE");
};
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
    const authenticated = await options.authentication.authorize(input);
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
    return options.persistence.transactions.run(async (transaction) => {
      const current = await resolve(
          transaction,
          input.sessionCookie,
          "dining.session.close",
          authenticated.sessionReference,
        ),
        allowed = async () => (await current.allowed()) === true;
      if (!(await allowed())) return fail();
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
        authorize: allowed,
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
      const fence = createPostgresDiningClosingFence({ scope, authorize: allowed });
      const session = await fence(tx, {
        diningSessionReference: command.diningSessionReference,
        observedAt,
      });
      const prior = await store.readReceipt(command.operationReference, allowed);
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
        if (!(await allowed())) return fail();
        return Object.freeze({
          status: "AlreadyApplied" as const,
          phase: prior.record.session.phase,
          sessionVersion: prior.record.session.version,
        });
      }
      if (session.version !== command.expectedSessionVersion) return fail();
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
        authorize: allowed,
        authorizeKitchen: allowed,
        authorizeDining: allowed,
        authorizeAndFence,
      });
      let resolvedEvidence: Awaited<ReturnType<typeof evidence.load>> | null = null;
      const service = createDiningClosingService({
        store,
        hashes,
        authorization: {
          authorize: async (request) => {
            const permission = await current.authorizeAction("dining.session.close");
            if (
              permission?.effect !== "Allow" ||
              request.session.diningSessionReference !== command.diningSessionReference
            )
              return null;
            return {
              kind: "Staff",
              tenantContext: current.context,
              permission,
              audit: {
                auditId: options.newReference(),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "User", reference: current.actorReference },
                actionCode: `DINING_SESSION_CLOSING_${request.operation.toUpperCase()}`,
                targetType: "DiningSession",
                targetId: command.diningSessionReference,
                reasonCode: "CUSTOMER_FINISHED",
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
              authorizeAndFence: async () => (await allowed()) && (await authorizeAndFence()),
              authorizeTask: async (request) => {
                const decision = await current.authorizeAction(request.action);
                if (!decision) return fail();
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
      if (!(await allowed())) return fail();
      return Object.freeze({
        status: result.status,
        phase: result.session.phase,
        sessionVersion: result.session.version,
      });
    });
  };
}
