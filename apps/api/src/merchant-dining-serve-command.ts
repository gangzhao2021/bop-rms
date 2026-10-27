import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import type { AppendAuditRecordInput } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { createPostgresMerchantOrderIndex, parseOrderingReference } from "@rms/ordering";
import {
  createPostgresDiningItemServiceOperationReader,
  parseDiningItemServiceRecord,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createDiningOrderPreparationProgress } from "./dining-order-preparation-progress.js";
import { createMerchantDiningTableContext } from "./merchant-dining-table-context.js";
import { createMerchantDiningItemServiceComposition } from "./merchant-dining-item-service-composition.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
const fail = (): never => {
  throw new Error("DINING_SERVE_COMMAND_DENIED");
};
const version = (value: unknown, min = 1) => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value >= 2147483647
  )
    return fail();
  return value;
};
type Preparation = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createDiningOrderPreparationProgress>["load"]>>
>;
const digest = (current: Preparation) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        brandReference: current.brandReference,
        storeReference: current.storeReference,
        orderReference: current.orderReference,
        orderVersion: current.orderVersion,
        items: current.items,
      }),
    )
    .digest("hex");
export function createMerchantDiningServeCommand(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  reference(): string;
  audit: Pick<
    AppendAuditRecordInput,
    "reasonCode" | "retentionPolicyCode" | "retentionPolicyVersion"
  >;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authorized = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "operationReference",
      "orderReference",
      "orderItemReference",
      "quantity",
      "expectedOrderVersion",
      "expectedItemServiceVersion",
      "expectedSessionVersion",
      "expectedTableAssignmentVersion",
    ]);
    const command = {
      operationReference: parseOrderingReference(raw.operationReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderItemReference: parseOrderingReference(raw.orderItemReference),
      quantity: version(raw.quantity),
      expectedOrderVersion: version(raw.expectedOrderVersion),
      expectedItemServiceVersion: version(raw.expectedItemServiceVersion, 0),
      expectedSessionVersion: version(raw.expectedSessionVersion),
      expectedTableAssignmentVersion: version(raw.expectedTableAssignmentVersion),
    };
    if (command.quantity > 999) return fail();
    // WP-2423: one authorized run. The caller and `dining.item.serve` are resolved in full once at
    // the start and once more before the commit (inside this transaction, so a withdrawn
    // permission or ended Session never commits); the Ordering, Kitchen and Dining owner reads and
    // the serve write in between take the run's no-query guard.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const resolved = await resolve(
              transaction,
              input.sessionCookie,
              "dining.item.serve",
              authorized.sessionReference,
            );
            if ((await resolved.allowed()) !== true) return fail();
            return resolved;
          },
          recheck: async (resolved) => (await resolved.allowed()) === true,
          denied: fail,
        },
        async (authority) => {
          const resolved = authority.scope,
            guard = () => authority.guard();
          const scope = {
            tenantReference: resolved.selected.tenantReference,
            brandReference: resolved.context.brand.brandReference,
            storeReference: resolved.store.storeReference,
          };
          const businessTransaction: ConsumerTransaction = {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              const result = await transaction.query(sql, values);
              if (!result || typeof result !== "object")
                throw new Error("DINING_ITEM_SERVICE_UNAVAILABLE");
              const rows = Object.getOwnPropertyDescriptor(result, "rows");
              const count = Object.getOwnPropertyDescriptor(result, "rowCount");
              if (
                !rows ||
                !("value" in rows) ||
                !Array.isArray(rows.value) ||
                !count ||
                !("value" in count) ||
                (count.value !== null &&
                  (typeof count.value !== "number" ||
                    !Number.isSafeInteger(count.value) ||
                    count.value < 0))
              )
                throw new Error("DINING_ITEM_SERVICE_UNAVAILABLE");
              return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
            },
          };
          authority.bind(businessTransaction);

          const selected = await createPostgresMerchantOrderIndex({
            ...scope,
            authorize: guard,
          }).find({ transaction: businessTransaction, orderReference: command.orderReference });
          if (
            !selected ||
            selected.orderType !== "DineIn" ||
            selected.diningSessionReference === null
          )
            return fail();
          const observedAt = options.persistence.now();
          const current = await createDiningOrderPreparationProgress({
            ...scope,
            authorize: guard,
            authorizeKitchen: guard,
          }).load({
            transaction: businessTransaction,
            ...scope,
            orderReference: command.orderReference,
            diningSessionReference: selected.diningSessionReference,
            guestSessionReference: selected.guestSessionReference,
            observedAt,
          });
          const prior = await createPostgresDiningItemServiceOperationReader({
            scope,
            authorize: guard,
          }).load({
            transaction: businessTransaction,
            operationReference: command.operationReference,
          });
          if (prior) {
            if (
              String(prior.actorReference) !== String(resolved.actorReference) ||
              String(prior.orderReference) !== command.orderReference ||
              String(prior.orderItemReference) !== command.orderItemReference ||
              prior.quantity !== command.quantity ||
              prior.expectedOrderVersion !== command.expectedOrderVersion ||
              prior.expectedItemServiceVersion !== command.expectedItemServiceVersion ||
              prior.sessionVersion !== command.expectedSessionVersion ||
              prior.tableAssignmentVersion !== command.expectedTableAssignmentVersion
            )
              return fail();
            return Object.freeze({
              status: "AlreadyCommitted" as const,
              itemServiceVersion: prior.itemServiceVersion,
            });
          }
          const item = current?.items.find(
            (item) => String(item.orderItemReference) === command.orderItemReference,
          );
          if (
            !current ||
            current.orderVersion !== command.expectedOrderVersion ||
            !item ||
            item.phase !== "Ready"
          )
            return fail();
          const table = await createMerchantDiningTableContext({
            scope,
            authorize: guard,
            // A table checking out is still served (DEC-DINE-IN-PAY-LATER: close after serving).
            allowClosingSession: true,
          }).load(businessTransaction, selected.diningSessionReference, observedAt);
          if (
            table.sessionVersion !== command.expectedSessionVersion ||
            table.tableAssignmentVersion !== command.expectedTableAssignmentVersion
          )
            return fail();
          const record = parseDiningItemServiceRecord({
            ...scope,
            serviceReference: options.reference(),
            operationReference: command.operationReference,
            auditReference: options.reference(),
            diningSessionReference: selected.diningSessionReference,
            tableReference: table.tableReference,
            sessionVersion: table.sessionVersion,
            tableAssignmentVersion: table.tableAssignmentVersion,
            orderReference: command.orderReference,
            orderBatchReference: item.orderBatchReference,
            orderItemReference: command.orderItemReference,
            actorReference: resolved.actorReference,
            expectedOrderVersion: command.expectedOrderVersion,
            expectedItemServiceVersion: command.expectedItemServiceVersion,
            itemServiceVersion: command.expectedItemServiceVersion + 1,
            quantity: command.quantity,
            purposeCode: "ServeDiningOrderItem",
            permissionCode: "dining.item.serve",
            servedAt: observedAt,
            recordedAt: observedAt,
            sourceCheckpoint: command.orderReference,
            sourceDigest: digest(current),
          });
          const result = await createMerchantDiningItemServiceComposition({
            scope,
            now: options.persistence.now,
            authorize: guard,
            validateSource: async (_tx, candidate, fresh) =>
              candidate.sourceDigest === digest(fresh) &&
              String(candidate.sourceCheckpoint) === String(fresh.orderReference),
            audit: async (fact) => ({
              ...options.audit,
              auditId: fact.auditReference,
              brandId: fact.brandReference,
              storeId: fact.storeReference,
              actor: { type: "User", reference: resolved.actorReference },
              actionCode: "DINING_ITEM_SERVED",
              targetType: "OrderItem",
              targetId: fact.orderItemReference,
              correlationId: fact.operationReference,
              occurredAt: fact.recordedAt,
              afterSummary: { quantity: fact.quantity, version: fact.itemServiceVersion },
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Restricted",
            }),
          }).commit({
            transaction: businessTransaction,
            record,
            guestSessionReference: selected.guestSessionReference,
          });
          return Object.freeze({
            status: result.status,
            itemServiceVersion: result.record.itemServiceVersion,
          });
        },
      ),
    );
  };
}
