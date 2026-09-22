import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresPaymentIntentBindingSource,
  createPostgresPaymentTerminalStore,
  createPostgresOrderPaymentRefundPosition,
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
/** Current requester financial context, not execution authority or a complete reconciliation timeline. */
export function createMerchantRefundPaymentContext(options: {
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
    const raw = readClosedRecord(input.query, ["paymentIntentReference"]);
    const paymentIntentReference = String(
      parseOpaqueUuidV7(raw.paymentIntentReference, "ACTOR_REFERENCE_INVALID"),
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
      const allowed = async () => {
        if (!(await current.allowed())) return false;
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
      if (!(await allowed())) return deny();
      const observedAt = String(current.context.resolvedAt);
      const binding = await createPostgresPaymentIntentBindingSource({
        scope: { ...scope, environment: configuration.environment },
        authorize: allowed,
      })(businessTransaction, { paymentIntentReference, observedAt });
      const terminal = await createPostgresPaymentTerminalStore(
        { run: (work) => work(businessTransaction) },
        {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          providerAccountReference: configuration.providerAccountReference,
          environment: configuration.environment,
        },
      ).read(binding.paymentIntentReference);
      if (
        terminal &&
        (terminal.paymentAttemptReference !== binding.paymentAttemptReference ||
          terminal.orderReference !== binding.orderReference ||
          terminal.recordedAt > observedAt)
      )
        return deny();
      if (terminal === null || terminal.outcome === "Failed") {
        if (!(await allowed())) return deny();
        return Object.freeze({
          ...binding,
          observedAt,
          paymentState: terminal === null ? ("Unresolved" as const) : ("Failed" as const),
          currencyCode: null,
          capturedAmountMinor: null,
          confirmedRefundMinor: null,
          pendingRefundMinor: null,
        });
      }
      if (
        !terminal.amount ||
        terminal.amount.currencyCode !== "CAD" ||
        terminal.amount.amountMinor <= 0n
      )
        return deny();
      const position = await createPostgresOrderPaymentRefundPosition({
        scope,
        providerAccountReference: configuration.providerAccountReference,
        environment: configuration.environment,
        authorize: allowed,
      })(businessTransaction, {
        orderReference: binding.orderReference,
        paymentTransactionReference: terminal.paymentTransactionReference,
        paymentIntentReference: binding.paymentIntentReference,
        paymentAttemptReference: binding.paymentAttemptReference,
        observedAt,
      });
      if (
        position.confirmedMinor + position.pendingMinor > terminal.amount.amountMinor ||
        !(await allowed())
      )
        return deny();
      return Object.freeze({
        ...binding,
        observedAt,
        paymentState: "Captured" as const,
        currencyCode: "CAD" as const,
        capturedAmountMinor: terminal.amount.amountMinor.toString(),
        confirmedRefundMinor: position.confirmedMinor.toString(),
        pendingRefundMinor: position.pendingMinor.toString(),
      });
    });
  };
}
