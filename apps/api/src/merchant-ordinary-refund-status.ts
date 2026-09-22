import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresOrdinaryRefundRequestStatusSource,
  createOrdinaryRefundRoleResolver,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";
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
    return options.persistence.transactions.run(async (transaction) => {
      const current = await resolve(
        transaction,
        input.sessionCookie,
        "payment.refund.request",
        authenticated.sessionReference,
      );
      if (!(await current.allowed())) return deny();
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
          query.observedAt !== String(current.context.resolvedAt) ||
          !(await current.allowed())
        )
          return false;
        const authority = await workforce(businessTransaction, {
          ...scope,
          actorReference: String(current.actorReference),
          observedAt: current.context.resolvedAt,
          permissionCode: "payment.refund.request",
        });
        return (
          authority.decision.effect === "Allow" &&
          role("payment.refund.request", authority.activeRoleCodes) === "Manager"
        );
      };
      const allowed = () =>
        authorize(businessTransaction, {
          ...scope,
          orderReference,
          actorReference: String(current.actorReference),
          observedAt: String(current.context.resolvedAt),
        });
      if (!(await allowed())) return deny();
      const observedAt = String(current.context.resolvedAt);
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
    });
  };
}
