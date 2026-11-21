import type { TenantContext } from "@bop/tenant";
import type { ConsumerTransaction } from "@bop/eventing";
import type { AppendAuditRecordInput } from "@bop/audit";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantOrdinaryRefundOperation } from "./merchant-ordinary-refund-operation.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

type CompositionOptions = Parameters<typeof createMerchantOrdinaryRefundOperation>[0];
/** Authenticated preparation command only. It does not submit a Provider refund. */
export function createMerchantOrdinaryRefundCommand(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: CompositionOptions["scope"] & { actorReference: string },
    authority: { readonly context: TenantContext; authorize(): Promise<boolean> },
  ): Promise<Omit<CompositionOptions, "scope" | "authorize">>;
  audit: Pick<
    AppendAuditRecordInput,
    "reasonCode" | "retentionPolicyCode" | "retentionPolicyVersion"
  >;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const keys = [
      "orderReference",
      "requestReference",
      "paymentAttemptReference",
      "operationReference",
      "auditReference",
    ] as const;
    const raw = readClosedRecord(input.command, [...keys, "approvalReference"]);
    const command = Object.fromEntries(
      keys.map((key) => [key, String(parseOpaqueUuidV7(raw[key], "ACTOR_REFERENCE_INVALID"))]),
    ) as Record<(typeof keys)[number], string>;
    const approvalReference =
      raw.approvalReference === null
        ? null
        : String(parseOpaqueUuidV7(raw.approvalReference, "ACTOR_REFERENCE_INVALID"));
    const deny = (): never => {
      throw new Error("ORDINARY_REFUND_COMMAND_DENIED");
    };
    // WP-2423: one authorized run. The caller and `payment.refund.execute` are resolved in full
    // once at the start and once more before the commit (inside this transaction, so a withdrawn
    // permission or ended Session never commits the prepared refund); the Payment owner callbacks
    // in between, taken while the order's refund rows are locked, use the run's no-query guard.
    // This command prepares only; it makes no Provider call.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const resolved = await resolveScope(
              transaction,
              input.sessionCookie,
              "payment.refund.execute",
              authenticated.sessionReference,
            );
            if ((await resolved.allowed()) !== true) return deny();
            return resolved;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied: deny,
        },
        async (authority) => {
          const { selected, context, store, actorReference } = authority.scope;
          const guard = () => authority.guard();
          const businessTransaction: ConsumerTransaction = {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              const result = await transaction.query(sql, values);
              if (!result || typeof result !== "object")
                throw new Error("ORDINARY_REFUND_COMMAND_UNAVAILABLE");
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
                throw new Error("ORDINARY_REFUND_COMMAND_UNAVAILABLE");
              return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
            },
          };

          const scope = {
            tenantReference: selected.tenantReference,
            brandReference: String(context.brand.brandReference),
            storeReference: String(store.storeReference),
          };
          const configuration = await options.resolveConfiguration(
            businessTransaction,
            { ...scope, actorReference: String(actorReference) },
            Object.freeze({ context, authorize: guard }),
          );
          const runtime = createMerchantOrdinaryRefundOperation({
            ...configuration,
            scope,
            authorize: async (_tx, query) =>
              query.tenantReference === scope.tenantReference &&
              query.brandReference === scope.brandReference &&
              query.storeReference === scope.storeReference &&
              query.orderReference === command.orderReference &&
              query.requestReference === command.requestReference &&
              (await guard()),
          });
          const result = await runtime.prepareAndRecord(
            businessTransaction,
            {
              ...command,
              approvalReference,
              executorReference: String(actorReference),
              providerOperationReference: command.operationReference,
            },
            options.audit,
          );
          return result;
        },
      ),
    );
  };
}
