import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresOrdinaryRefundRequestStatusSource,
  createOrdinaryRefundRoleResolver,
  observeOrdinaryRefundOrderAfterFence,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";
import { refundReadAccess } from "./merchant-refund-read-authority.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
interface Scope {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}
/** Read-only committed request progress; never authorizes refund execution. */
export function createMerchantOrdinaryRefundStatus(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  /** Trusted configuration, resolved with its current scope fences retained through commit. */
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: Scope,
  ): Promise<{
    providerAccountReference: string;
    environment: "Test" | "Live";
    roleMapping: unknown;
  }>;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const deny = (): never => {
    throw new Error("ORDINARY_REFUND_REQUEST_DENIED");
  };
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["orderReference", "operationReference"]);
    const orderReference = String(parseOpaqueUuidV7(raw.orderReference, "ACTOR_REFERENCE_INVALID"));
    const operationReference = String(
      parseOpaqueUuidV7(raw.operationReference, "ACTOR_REFERENCE_INVALID"),
    );
    return options.persistence.transactions.run((transaction) =>
      // WP-2423: the caller is resolved in full at the start and once before the reply; the owner
      // read in between only confirms it runs in this authorized transaction.
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const current = await resolve(
              transaction,
              input.sessionCookie,
              // WP-2423 Q5: workspace access here; refundReadAccess decides who may read refunds.
              "merchant.access",
              authenticated.sessionReference,
            );
            if (!(await current.allowed())) return deny();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied: deny,
        },
        async (authorized) => {
          const current = authorized.scope;
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
            tenantReference: current.selected.tenantReference,
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
          };
          const configuration = await options.resolveConfiguration(businessTransaction, scope);
          const workforce = createMerchantWorkforcePermissionSource({
            resolveContext: async () => ({
              tenantReference: scope.tenantReference,
              context: current.context,
            }),
          });
          const role = createOrdinaryRefundRoleResolver(configuration.roleMapping);
          /** The session's resolution until the refund fence is held, then the time read after it. */
          let observedAt = String(current.context.resolvedAt);
          const authorize = async (
            _tx: ConsumerTransaction,
            query: Scope & { orderReference: string; actorReference: string; observedAt: string },
          ) => {
            if (
              query.tenantReference !== scope.tenantReference ||
              query.brandReference !== scope.brandReference ||
              query.storeReference !== scope.storeReference ||
              query.orderReference !== orderReference ||
              query.actorReference !== String(current.actorReference) ||
              query.observedAt !== observedAt
            )
              return false;
            return authorized.guard();
          };
          // WP-2423 Q5: Owners/Finance read refunds too; only a Manager records requests.
          const readable = async () =>
            (
              await refundReadAccess(
                workforce,
                businessTransaction,
                {
                  ...scope,
                  actorReference: String(current.actorReference),
                  observedAt: String(current.context.resolvedAt),
                },
                role,
                current.kdsOperatorProfileAllows,
              )
            ).canRead;
          if (!(await readable())) return deny();
          authorized.recheckBeforeReply(readable);
          const allowed = () =>
            authorize(businessTransaction, {
              ...scope,
              orderReference,
              actorReference: String(current.actorReference),
              observedAt,
            });
          if (!(await allowed())) return deny();
          // v15 2026-10-18 (dd750045): read at a time taken once the Order's refund fence is held,
          // so a request recorded for this Order meanwhile is part of the history read.
          observedAt = await observeOrdinaryRefundOrderAfterFence(
            businessTransaction,
            scope,
            orderReference,
            observedAt,
            options.persistence.now,
          );
          const result = await createPostgresOrdinaryRefundRequestStatusSource({
            scope,
            providerAccountReference: configuration.providerAccountReference,
            environment: configuration.environment,
            authorize: async (_tx, query) =>
              query.operationReference === operationReference &&
              query.orderReference === orderReference &&
              (await allowed()),
          })(businessTransaction, { orderReference, operationReference, observedAt });
          return Object.freeze({ ...result, observedAt: String(result.observedAt) });
        },
      ),
    );
  };
}
