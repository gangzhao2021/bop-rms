import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import {
  createDiningTableService,
  createPostgresDiningSessionMoveStore,
  createPostgresDiningSessionReadStore,
  createPostgresDiningTableStore,
  DiningTableWorkflowError,
  loadDiningPartySizes,
  parseDiningInstant,
  parseDiningReference,
} from "@rms/dining";
import { markDiningTableNeedsCleaning } from "./dining-table-needs-cleaning.js";
import { derivedReference } from "./merchant-products.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantDiningTableMoveErrorCode =
  | "DINING_TABLE_MOVE_INPUT_INVALID"
  | "DINING_TABLE_MOVE_PERMISSION_DENIED"
  /** A table changed meanwhile (seated, moved, blocked): read the tables again. */
  | "DINING_TABLE_MOVE_CHANGED"
  /** The table has no party seated. */
  | "DINING_TABLE_MOVE_NOT_SEATED"
  /** The table is checking out or closed: it stays where it is. */
  | "DINING_TABLE_MOVE_CHECKING_OUT"
  /** The other table has a party: joining two parties is table merging (not offered yet). */
  | "DINING_TABLE_MOVE_TARGET_OCCUPIED"
  /** The other table is blocked (being cleaned, out of use) or not set up. */
  | "DINING_TABLE_MOVE_TARGET_UNAVAILABLE"
  /** The other table has no table code guests can scan. */
  | "DINING_TABLE_MOVE_TARGET_NO_CODE"
  /** The other table seats fewer than the party recorded. */
  | "DINING_TABLE_MOVE_TARGET_TOO_SMALL"
  | "DINING_TABLE_MOVE_UNAVAILABLE";
export class MerchantDiningTableMoveError extends Error {
  constructor(readonly code: MerchantDiningTableMoveErrorCode) {
    super("dining table move " + code);
    this.name = "MerchantDiningTableMoveError";
  }
}
const fail = (code: MerchantDiningTableMoveErrorCode): never => {
  throw new MerchantDiningTableMoveError(code);
};
const hashes = {
  hashIntent: (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex"),
  equals: (left: string, right: string) => left === right,
};

export interface MerchantDiningTableMoveResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly diningSessionReference: string;
  readonly tableReference: string;
  readonly tableLabel: string;
  readonly fromTableReference: string;
  readonly fromTableLabel: string;
}

/**
 * WP-2423 item 8 ⑧ (Owner decision 3): staff move the party at a table to another table that is
 * free, in use and has a table code. The party's dining session moves as it is — its rounds,
 * bill, party size, tea, payments, host and shared cart all belong to the session — recorded once
 * (who, when, from and to, with the operation and the session's and both tables' versions); the
 * table it left waits for cleaning. A table checking out or closed stays; a table with a party is
 * refused (merging tables is not offered). The old table's codes stop admitting anyone to this
 * party: guests scan the new table's code (the session's join codes are bound to its table).
 */
export function createMerchantDiningTableMove(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  newReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<MerchantDiningTableMoveResult> => {
    const authenticated = await options.authentication.authorize(input);
    let command: {
      operationReference: string;
      tableReference: string;
      expectedTableVersion: number;
      targetTableReference: string;
      expectedTargetTableVersion: number;
    };
    try {
      const raw = readClosedRecord(input.command, [
        "action",
        "operationReference",
        "tableReference",
        "expectedTableVersion",
        "targetTableReference",
        "expectedTargetTableVersion",
      ]);
      if (
        raw.action !== "Move" ||
        !Number.isSafeInteger(raw.expectedTableVersion) ||
        Number(raw.expectedTableVersion) < 1 ||
        !Number.isSafeInteger(raw.expectedTargetTableVersion) ||
        Number(raw.expectedTargetTableVersion) < 1
      )
        return fail("DINING_TABLE_MOVE_INPUT_INVALID");
      command = {
        operationReference: String(parseDiningReference(raw.operationReference)),
        tableReference: String(parseDiningReference(raw.tableReference)),
        expectedTableVersion: Number(raw.expectedTableVersion),
        targetTableReference: String(parseDiningReference(raw.targetTableReference)),
        expectedTargetTableVersion: Number(raw.expectedTargetTableVersion),
      };
      if (command.tableReference === command.targetTableReference)
        return fail("DINING_TABLE_MOVE_INPUT_INVALID");
    } catch (error) {
      if (error instanceof MerchantDiningTableMoveError) throw error;
      return fail("DINING_TABLE_MOVE_INPUT_INVALID");
    }
    try {
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                "dining.operate",
                authenticated.sessionReference,
              ).catch(() => fail("DINING_TABLE_MOVE_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true)
                return fail("DINING_TABLE_MOVE_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("DINING_TABLE_MOVE_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope,
              guard = () => authority.guard();
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const runner = { run: <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx) };
            const tables = createPostgresDiningTableStore(runner as never, scope, hashes);
            const moves = createPostgresDiningSessionMoveStore(runner as never, scope, hashes);
            const sessions = createPostgresDiningSessionReadStore(runner as never, scope);
            const actor = String(current.actorReference);
            // The table it left waits for cleaning (once per move, also on a retry).
            const clean = (sourceTableReference: string, observedAt: string) =>
              markDiningTableNeedsCleaning(tx, {
                scope,
                actorReference: actor,
                tableReference: sourceTableReference,
                operationReference: derivedReference(command.operationReference, "clean"),
                correlationReference: command.operationReference,
                observedAt,
                retentionPolicyCode: options.retentionPolicyCode,
                retentionPolicyVersion: options.retentionPolicyVersion,
                newReference: options.newReference,
                authorize: guard,
              });
            const result = (
              record: {
                readonly session: { readonly diningSessionReference: string };
                readonly sourceTable: { readonly tableReference: string; stableLabel: string };
                readonly targetTable: { readonly tableReference: string; stableLabel: string };
              },
              status: "Applied" | "AlreadyApplied",
            ): MerchantDiningTableMoveResult =>
              Object.freeze({
                status,
                diningSessionReference: String(record.session.diningSessionReference),
                tableReference: String(record.targetTable.tableReference),
                tableLabel: record.targetTable.stableLabel,
                fromTableReference: String(record.sourceTable.tableReference),
                fromTableLabel: record.sourceTable.stableLabel,
              });
            const prior = await moves.resolveMoveOperation(
              parseDiningReference(command.operationReference),
            );
            if (prior !== null) {
              if (
                prior.command.sourceTableReference !== command.tableReference ||
                prior.command.targetTableReference !== command.targetTableReference ||
                prior.command.expectedSourceTableVersion !== command.expectedTableVersion ||
                prior.command.expectedTargetTableVersion !== command.expectedTargetTableVersion
              )
                return fail("DINING_TABLE_MOVE_INPUT_INVALID");
              await clean(command.tableReference, prior.command.observedAt);
              return result(prior, "AlreadyApplied");
            }
            const source = await tables.loadTable(parseDiningReference(command.tableReference));
            const target = await tables.loadTable(
              parseDiningReference(command.targetTableReference),
            );
            if (source === null || target === null) return fail("DINING_TABLE_MOVE_INPUT_INVALID");
            if (
              source.aggregateVersion !== command.expectedTableVersion ||
              target.aggregateVersion !== command.expectedTargetTableVersion
            )
              return fail("DINING_TABLE_MOVE_CHANGED");
            const sessionReference = source.activeDiningSessionReference;
            if (sessionReference === null) return fail("DINING_TABLE_MOVE_NOT_SEATED");
            const [session] = await sessions.loadSessions([String(sessionReference)]);
            if (session === undefined || session === null) return fail("DINING_TABLE_MOVE_CHANGED");
            if (session.phase !== "Active") return fail("DINING_TABLE_MOVE_CHECKING_OUT");
            if (target.activeDiningSessionReference !== null)
              return fail("DINING_TABLE_MOVE_TARGET_OCCUPIED");
            if (target.lifecycle !== "Published" || target.operationalState !== "Available")
              return fail("DINING_TABLE_MOVE_TARGET_UNAVAILABLE");
            if (target.qrStatus !== "Active") return fail("DINING_TABLE_MOVE_TARGET_NO_CODE");
            // The party as recorded (none recorded: at least one guest).
            const partySize =
              (await loadDiningPartySizes(tx as never, scope, [String(sessionReference)])).get(
                String(sessionReference),
              )?.partySize ?? 1;
            if (target.capacity < partySize) return fail("DINING_TABLE_MOVE_TARGET_TOO_SMALL");
            const observedAt = parseDiningInstant(current.context.resolvedAt);
            const service = createDiningTableService({
              references: hashes,
              authorization: {
                async authorize(request) {
                  if (
                    request.action !== "MoveSession" ||
                    request.targetReference !== sessionReference ||
                    request.observedAt !== observedAt ||
                    !(await guard())
                  )
                    return null;
                  return {
                    tenantReference: parseDiningReference(scope.tenantReference),
                    brandReference: parseDiningReference(scope.brandReference),
                    storeReference: parseDiningReference(scope.storeReference),
                    actorReference: parseDiningReference(actor),
                    purpose: "dining-table" as const,
                    permission: {
                      effect: "Allow" as const,
                      action: "dining.operate" as const,
                      scopeKind: "Store" as const,
                    },
                    audit: {
                      auditId: options.newReference(),
                      brandId: scope.brandReference,
                      storeId: scope.storeReference,
                      actor: { type: "User" as const, reference: actor },
                      actionCode: "DINING_SESSION_MOVE_TABLE",
                      targetType: "DiningSession",
                      targetId: String(sessionReference),
                      reasonCode: "TABLE_MOVED",
                      correlationId: command.operationReference,
                      occurredAt: observedAt,
                      sourceChannel: "MERCHANT_WEB",
                      dataClassification: "Restricted",
                      retentionPolicyCode: options.retentionPolicyCode,
                      retentionPolicyVersion: options.retentionPolicyVersion,
                    },
                  };
                },
              },
              repository: {
                resolveTableOperation: tables.resolveTableOperation,
                loadTable: tables.loadTable,
                commitTable: async () => fail("DINING_TABLE_MOVE_UNAVAILABLE"),
                loadSession: sessions.loadSession,
                resolveMoveOperation: moves.resolveMoveOperation,
                async commitMove(record) {
                  if (!(await guard())) return fail("DINING_TABLE_MOVE_PERMISSION_DENIED");
                  return moves.commitMove(record);
                },
              },
            });
            const moved = await service.moveSession({
              operationReference: command.operationReference,
              diningSessionReference: sessionReference,
              sourceTableReference: command.tableReference,
              targetTableReference: command.targetTableReference,
              expectedSessionVersion: session.version,
              expectedSourceTableVersion: command.expectedTableVersion,
              expectedTargetTableVersion: command.expectedTargetTableVersion,
              partySize,
              observedAt,
            });
            await clean(command.tableReference, observedAt);
            return result(moved.result, moved.status);
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantDiningTableMoveError) throw error;
      if (
        error instanceof DiningTableWorkflowError &&
        (error.code === "DINING_TABLE_VERSION_CONFLICT" ||
          error.code === "DINING_TABLE_LIFECYCLE_CONFLICT" ||
          error.code === "DINING_TABLE_IDEMPOTENCY_CONFLICT")
      )
        return fail("DINING_TABLE_MOVE_CHANGED");
      throw error;
    }
  };
}
