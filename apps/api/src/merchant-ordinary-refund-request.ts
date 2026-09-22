import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresOrdinaryRefundRequestRuntime,
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
/** Records a request only. Requester Manager capability is distinct from approval/execution MFA. */
export function createMerchantOrdinaryRefundRequest(options: {
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
  newAuditReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const deny = (): never => {
    throw new Error("ORDINARY_REFUND_REQUEST_DENIED");
  };
  const resolveCommand = async (
    input: { sessionCookie: unknown; csrf: unknown; command: unknown },
    preview: boolean,
  ) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "orderReference",
      "requestReference",
      "operationReference",
      "expectedClaimVersion",
      "reasonCode",
      "items",
    ]);
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
      const runtime = createPostgresOrdinaryRefundRequestRuntime({
        scope: {
          ...scope,
          providerAccountReference: configuration.providerAccountReference,
          environment: configuration.environment,
        },
        authorize,
        now: () => String(current.context.resolvedAt),
        newAuditReference: options.newAuditReference,
        retentionPolicyCode: options.retentionPolicyCode,
        retentionPolicyVersion: options.retentionPolicyVersion,
      });
      const result = await (preview ? runtime.preview : runtime)(businessTransaction, {
        ...raw,
        orderReference,
        actorReference: String(current.actorReference),
      });
      if (!(await current.allowed())) return deny();
      const components = {
        netAmountMinor: 0n,
        taxAmountMinor: 0n,
        tipAmountMinor: 0n,
        serviceChargeAmountMinor: 0n,
        serviceChargeTaxAmountMinor: 0n,
      };
      for (const payment of result.request.payments)
        for (const item of payment.items)
          for (const key of Object.keys(components) as (keyof typeof components)[])
            components[key] += item.components[key];
      return Object.freeze({
        status: result.status,
        components: Object.freeze(
          Object.fromEntries(
            Object.entries(components).map(([key, amount]) => [key, amount.toString()]),
          ),
        ),
        requestReference: result.request.requestReference,
        operationReference: result.request.operationReference,
        claimVersion: result.claimVersion,
        currencyCode: result.request.currencyCode,
        amountMinor: result.request.amountMinor.toString(),
        paymentAttemptReferences: Object.freeze(
          result.request.payments.map((payment) => payment.paymentAttemptReference),
        ),
      });
    });
  };
  const record = async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const result = await resolveCommand(input, false);
    if (result.status === "Previewed") return deny();
    return Object.freeze({
      status: result.status,
      requestReference: result.requestReference,
      operationReference: result.operationReference,
      claimVersion: result.claimVersion,
      currencyCode: result.currencyCode,
      amountMinor: result.amountMinor,
      paymentAttemptReferences: result.paymentAttemptReferences,
    });
  };
  return Object.assign(record, {
    async preview(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
      const result = await resolveCommand(input, true);
      if (result.status !== "Previewed") return deny();
      return Object.freeze({ ...result, status: "Previewed" as const });
    },
  });
}
