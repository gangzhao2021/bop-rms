import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { parseDiningItemServiceRecord, parseDiningReference } from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantDiningItemServiceComposition } from "./merchant-dining-item-service-composition.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { AppendAuditRecordInput } from "@bop/audit";

type CompositionOptions = Parameters<typeof createMerchantDiningItemServiceComposition>[0];

/** Authenticated merchant application; selected scope and actor never come from authority in the body. */
export function createMerchantDiningItemService(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  validateSource: CompositionOptions["validateSource"];
  audit: Pick<
    AppendAuditRecordInput,
    "reasonCode" | "retentionPolicyCode" | "retentionPolicyVersion"
  >;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authorized = await options.authentication.authorize(input);
    const command = readClosedRecord(input.command, ["record", "guestSessionReference"]);
    const record = parseDiningItemServiceRecord(command.record);
    const guestSessionReference = parseDiningReference(command.guestSessionReference);
    const denied = (): never => {
      throw new Error("DINING_ITEM_SERVICE_PERMISSION_DENIED");
    };
    // WP-2423: one authorized run. The staff member and `dining.item.serve` are resolved in full
    // once at the start and once more before the commit (inside this transaction); the Dining
    // owner checks in between take the run's no-query guard.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const current = await resolveScope(
              transaction,
              input.sessionCookie,
              "dining.item.serve",
              authorized.sessionReference,
            );
            if ((await current.allowed()) !== true) return denied();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async (authority) => {
          const { selected, context, store, actorReference } = authority.scope;
          if (
            String(record.actorReference) !== String(actorReference) ||
            record.tenantReference !== selected.tenantReference ||
            String(record.brandReference) !== String(context.brand.brandReference) ||
            String(record.storeReference) !== String(store.storeReference)
          )
            return denied();
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
          return createMerchantDiningItemServiceComposition({
            scope: {
              tenantReference: selected.tenantReference,
              brandReference: context.brand.brandReference,
              storeReference: store.storeReference,
            },
            now: options.persistence.now,
            authorize: async (_tx, candidate) =>
              String(candidate.actorReference) === String(actorReference) &&
              candidate.tenantReference === selected.tenantReference &&
              String(candidate.brandReference) === String(context.brand.brandReference) &&
              String(candidate.storeReference) === String(store.storeReference) &&
              (await authority.guard()),
            validateSource: options.validateSource,
            audit: async (fact) => ({
              ...options.audit,
              auditId: fact.auditReference,
              brandId: fact.brandReference,
              storeId: fact.storeReference,
              actor: { type: "User", reference: actorReference },
              actionCode: "DINING_ITEM_SERVED",
              targetType: "OrderItem",
              targetId: fact.orderItemReference,
              correlationId: fact.operationReference,
              occurredAt: fact.recordedAt,
              afterSummary: { quantity: fact.quantity, version: fact.itemServiceVersion },
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Restricted",
            }),
          }).commit({ transaction: businessTransaction, record, guestSessionReference });
        },
      ),
    );
  };
}
