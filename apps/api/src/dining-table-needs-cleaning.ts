import { createHash } from "node:crypto";
import {
  createDiningTableService,
  createPostgresDiningTableStore,
  parseDiningInstant,
  parseDiningReference,
  parseDiningTableCode,
  transitionDiningTable,
} from "@rms/dining";

/**
 * WP-2423 (Handoff §25.3): a table its guests just left is not seated again until it is cleaned —
 * the same block reason staff choose on Tables ("Being cleaned").
 */
export const diningTableNeedsCleaningReason = "CLEANING";

const hashes = {
  hashIntent: (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex"),
  equals: (left: string, right: string) => left === right,
};

/**
 * Marks the table of a session that was just closed as needing cleaning: an ordinary Dining table
 * block (`TemporarilyBlocked`, reason `CLEANING`) recorded with its own operation and audit by
 * the staff member who closed it, in the caller's transaction. Guests can't start a table that is
 * blocked; staff clear it from Tables ("Cleaned") with the usual table command. Nothing is done when
 * the table is already blocked, seated again or not free (a retry of the close).
 */
export async function markDiningTableNeedsCleaning(
  tx: { query(sql: string, values: readonly unknown[]): Promise<unknown> },
  input: {
    readonly scope: { tenantReference: string; brandReference: string; storeReference: string };
    readonly actorReference: string;
    readonly tableReference: string;
    readonly operationReference: string;
    readonly correlationReference: string;
    readonly observedAt: string;
    readonly retentionPolicyCode: string;
    readonly retentionPolicyVersion: number;
    newReference(): string;
    authorize(): Promise<boolean>;
  },
): Promise<"Marked" | "Unchanged"> {
  const scope = input.scope;
  const runner = { run: <T>(work: (transaction: never) => Promise<T>) => work(tx as never) };
  const store = createPostgresDiningTableStore(runner as never, scope, hashes);
  const tableReference = parseDiningReference(input.tableReference);
  const operationReference = parseDiningReference(input.operationReference);
  if ((await store.resolveTableOperation(operationReference)) !== null) return "Unchanged";
  const table = await store.loadTable(tableReference);
  if (
    !table ||
    table.lifecycle !== "Published" ||
    table.operationalState !== "Available" ||
    table.activeDiningSessionReference !== null
  )
    return "Unchanged";
  const observedAt = parseDiningInstant(input.observedAt);
  const reasonCode = parseDiningTableCode(diningTableNeedsCleaningReason);
  const candidate = transitionDiningTable(table, "SetBlock", observedAt, reasonCode);
  const service = createDiningTableService({
    references: hashes,
    authorization: {
      async authorize(request) {
        if (
          request.action !== "SetBlock" ||
          request.targetReference !== tableReference ||
          request.observedAt !== observedAt ||
          (await input.authorize()) !== true
        )
          return null;
        return {
          tenantReference: parseDiningReference(scope.tenantReference),
          brandReference: parseDiningReference(scope.brandReference),
          storeReference: parseDiningReference(scope.storeReference),
          actorReference: parseDiningReference(input.actorReference),
          purpose: "dining-table" as const,
          permission: {
            effect: "Allow" as const,
            action: "dining.operate" as const,
            scopeKind: "Store" as const,
          },
          audit: {
            auditId: input.newReference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User" as const, reference: input.actorReference },
            actionCode: "DINING_TABLE_SETBLOCK",
            targetType: "DiningTable",
            targetId: tableReference,
            reasonCode,
            correlationId: input.correlationReference,
            occurredAt: observedAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Restricted",
            retentionPolicyCode: input.retentionPolicyCode,
            retentionPolicyVersion: input.retentionPolicyVersion,
          },
        };
      },
    },
    repository: {
      resolveTableOperation: store.resolveTableOperation,
      loadTable: store.loadTable,
      async commitTable(record) {
        if ((await input.authorize()) !== true) throw new Error("DINING_TABLE_PERMISSION_DENIED");
        return store.commitTable(record);
      },
      resolveMoveOperation: async () => null,
      loadSession: async () => null,
      commitMove: async () => {
        throw new Error("DINING_TABLE_COMMAND_UNAVAILABLE");
      },
    },
  });
  await service.executeTable({
    action: "SetBlock",
    operationReference,
    expectedAggregateVersion: table.aggregateVersion,
    candidate,
    observedAt,
  });
  return "Marked";
}
