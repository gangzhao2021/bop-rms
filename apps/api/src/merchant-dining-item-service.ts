import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { parseDiningItemServiceRecord, parseDiningReference } from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
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
    return options.persistence.transactions.run(async (transaction) => {
      const { selected, context, store, actorReference, allowed } = await resolveScope(
        transaction,
        input.sessionCookie,
        "dining.item.serve",
        authorized.sessionReference,
      );
      if (
        String(record.actorReference) !== String(actorReference) ||
        record.tenantReference !== selected.tenantReference ||
        String(record.brandReference) !== String(context.brand.brandReference) ||
        String(record.storeReference) !== String(store.storeReference) ||
        (await allowed()) !== true
      )
        throw new Error("DINING_ITEM_SERVICE_PERMISSION_DENIED");
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
          (await allowed()) === true,
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
    });
  };
}
