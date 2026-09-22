import { createPostgresReceiptOrderSource } from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresOrdinaryRefundRequestContextSource,
  createPostgresCapturedBatchPaymentSource,
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
/** Selection aid only. Unclaimed units do not authorize refunds or establish current financial balance. */
export function createMerchantOrdinaryRefundItems(options: {
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
  newReference(): string;
  locale: string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const deny = (): never => {
    throw new Error("ORDINARY_REFUND_REQUEST_DENIED");
  };
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["orderReference"]);
    const orderReference = String(parseOpaqueUuidV7(raw.orderReference, "ACTOR_REFERENCE_INVALID"));
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
      const context = await createPostgresOrdinaryRefundRequestContextSource({
        scope,
        authorize: allowed,
      })(businessTransaction, {
        orderReference,
        operationReference: options.newReference(),
        observedAt,
      });
      if (context.existing !== null) return deny();
      const order = await createPostgresReceiptOrderSource({ ...scope, authorize: allowed })(
        businessTransaction,
        { orderReference, observedAt },
      );
      const captured = createPostgresCapturedBatchPaymentSource({
        scope: {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          providerAccountReference: configuration.providerAccountReference,
          environment: configuration.environment,
        },
        authorize: allowed,
      });
      const paid = new Map<string, string>();
      for (const batch of order.batches) {
        const payment = await captured.load(businessTransaction, {
          orderReference,
          orderBatchReference: batch.orderBatchReference,
          observedAt,
        });
        if (payment) paid.set(batch.orderBatchReference, payment.paymentIntentReference);
      }
      const items = order.items.map(({ snapshot }) => {
        const occupied = context.history.flatMap((request) =>
          request.payments.flatMap((payment) =>
            payment.items
              .filter((item) => item.orderItemReference === snapshot.orderItemReference)
              .flatMap((item) => item.refundUnitOrdinals),
          ),
        );
        if (
          new Set(occupied).size !== occupied.length ||
          occupied.some((ordinal) => ordinal > snapshot.quantity)
        )
          return deny();
        const label =
          snapshot.catalog.localizedNames[options.locale] ??
          snapshot.catalog.localizedNames["en-CA"] ??
          Object.values(snapshot.catalog.localizedNames)[0];
        if (!label) return deny();
        const paymentCaptured = paid.has(snapshot.orderBatchReference);
        return Object.freeze({
          orderBatchReference: String(snapshot.orderBatchReference),
          orderItemReference: String(snapshot.orderItemReference),
          label,
          quantity: snapshot.quantity,
          unclaimedQuantity: paymentCaptured ? snapshot.quantity - occupied.length : 0,
          paymentCaptured,
          paymentIntentReference: paid.get(snapshot.orderBatchReference) ?? null,
        });
      });
      if (!(await allowed())) return deny();
      return Object.freeze({
        orderReference,
        orderNumber: order.orderNumber,
        claimVersion: context.history.length,
        items: Object.freeze(items),
        recentRequests: Object.freeze(
          context.history.slice(-20).map((request) =>
            Object.freeze({
              requestReference: String(request.requestReference),
              operationReference: String(request.operationReference),
              claimVersion: request.expectedClaimVersion + 1,
              requestedAt: String(request.requestedAt),
              reasonCode: request.reasonCode,
              currencyCode: request.currencyCode,
              amountMinor: request.amountMinor.toString(),
            }),
          ),
        ),
      });
    });
  };
}
