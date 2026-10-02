import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import {
  createDiningTable,
  createDiningTableService,
  createPostgresDiningTableStore,
  parseDiningInstant,
  parseDiningReference,
  parseDiningTableCode,
  transitionDiningTable,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

export function createMerchantDiningTableCommand(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  newReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "action",
      "tableReference",
      "expectedAggregateVersion",
      "operationReference",
      "reasonCode",
    ]);
    if (raw.action !== "SetBlock" && raw.action !== "ClearBlock")
      throw new Error("DINING_TABLE_COMMAND_UNAVAILABLE");
    const action = raw.action;
    const tableReference = parseDiningReference(raw.tableReference);
    const operationReference = parseDiningReference(raw.operationReference);
    if (
      !Number.isSafeInteger(raw.expectedAggregateVersion) ||
      (raw.expectedAggregateVersion as number) < 1
    )
      throw new Error("DINING_TABLE_COMMAND_UNAVAILABLE");
    const expectedAggregateVersion = raw.expectedAggregateVersion as number;
    const reasonCode = action === "SetBlock" ? parseDiningTableCode(raw.reasonCode) : null;
    if (action === "ClearBlock" && raw.reasonCode !== null)
      throw new Error("DINING_TABLE_COMMAND_UNAVAILABLE");

    return options.persistence.transactions.run(async (tx) => {
      const current = await resolve(
        tx,
        input.sessionCookie,
        "dining.operate",
        authenticated.sessionReference,
      );
      const allowed = async () => (await current.allowed()) === true;
      if (!(await allowed())) throw new Error("DINING_TABLE_COMMAND_UNAVAILABLE");
      const scope = {
        tenantReference: current.selected.tenantReference,
        brandReference: current.context.brand.brandReference,
        storeReference: current.store.storeReference,
      };
      const runner = { run: <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx) };
      const store = createPostgresDiningTableStore(runner, scope, {
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (left, right) => left === right,
      });
      const prior = await store.resolveTableOperation(operationReference);
      let candidate;
      let observedAt: string;
      if (prior !== null) {
        if (
          prior.table.tableReference !== tableReference ||
          prior.table.aggregateVersion !== expectedAggregateVersion + 1 ||
          prior.audit.actionCode !== `DINING_TABLE_${action.toUpperCase()}` ||
          (action === "SetBlock" && prior.table.blockReasonCode !== reasonCode) ||
          (action === "ClearBlock" && prior.table.blockReasonCode !== null)
        )
          throw new Error("DINING_TABLE_COMMAND_UNAVAILABLE");
        candidate = createDiningTable(prior.table);
        observedAt = candidate.observedAt;
      } else {
        const table = await store.loadTable(tableReference);
        if (!table || table.aggregateVersion !== expectedAggregateVersion)
          throw new Error("DINING_TABLE_COMMAND_UNAVAILABLE");
        observedAt = current.context.resolvedAt;
        candidate = transitionDiningTable(
          table,
          action,
          parseDiningInstant(observedAt),
          reasonCode,
        );
      }
      const service = createDiningTableService({
        references: {
          hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
          equals: (left, right) => left === right,
        },
        authorization: {
          async authorize(request) {
            if (
              request.action !== action ||
              request.targetReference !== tableReference ||
              request.observedAt !== observedAt ||
              !(await allowed())
            )
              return null;
            return {
              tenantReference: parseDiningReference(scope.tenantReference),
              brandReference: parseDiningReference(scope.brandReference),
              storeReference: parseDiningReference(scope.storeReference),
              actorReference: parseDiningReference(current.actorReference),
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
                actor: { type: "User" as const, reference: current.actorReference },
                actionCode: `DINING_TABLE_${action.toUpperCase()}`,
                targetType: "DiningTable",
                targetId: tableReference,
                reasonCode:
                  action === "SetBlock" ? (reasonCode ?? "TABLE_BLOCKED") : "TABLE_BLOCK_CLEARED",
                correlationId: operationReference,
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
          resolveTableOperation: store.resolveTableOperation,
          loadTable: store.loadTable,
          async commitTable(record) {
            if (!(await allowed())) throw new Error("DINING_TABLE_PERMISSION_DENIED");
            return store.commitTable(record);
          },
          resolveMoveOperation: async () => null,
          loadSession: async () => null,
          commitMove: async () => {
            throw new Error("DINING_TABLE_COMMAND_UNAVAILABLE");
          },
        },
      });
      const result = await service.executeTable({
        action,
        operationReference,
        expectedAggregateVersion,
        candidate,
        observedAt,
      });
      if (!(await allowed())) throw new Error("DINING_TABLE_COMMAND_UNAVAILABLE");
      return Object.freeze({
        status: result.status,
        tableReference: result.table.tableReference,
        operationalState: result.table.operationalState,
        aggregateVersion: result.table.aggregateVersion,
      });
    });
  };
}
