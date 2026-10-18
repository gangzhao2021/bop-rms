import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresCardMachinePaymentStore,
  createPostgresOrdinaryRefundPositionSource,
  createPostgresPaymentIntentBindingSource,
  createPostgresPaymentTerminalStore,
  createPostgresOrderPaymentRefundPosition,
  createOrdinaryRefundRoleResolver,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
import { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";
import { refundReadAccess } from "./merchant-refund-read-authority.js";
import { cardMachineWholeRefundSource } from "./merchant-card-machine-refund.js";
import type { MerchantRefundSoleOperatorResolver } from "./merchant-sole-operator.js";
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
  /** WP-2423 Q19: lets an Owner start a request while sole operator is in effect for them. */
  soleOperator?: MerchantRefundSoleOperatorResolver;
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
    // WP-2423: one authorized run. The caller is resolved in full once at the start and once more
    // before the reply (with who may read refunds); owner reads in between take the run's guard
    // (no query) instead of re-resolving the caller in every read.
    return options.persistence.transactions.run((transaction) =>
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
        (authority) => readInRun(transaction, authority),
      ),
    );
    async function readInRun(
      transaction: Parameters<
        Parameters<PersistentMerchantBffOptions["transactions"]["run"]>[0]
      >[0],
      authority: MerchantTransactionAuthority<Awaited<ReturnType<typeof resolve>>>,
    ) {
      const current = authority.scope;
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
      authority.bind(businessTransaction);
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
      const viewer = { canRequest: false as boolean };
      // WP-2423 Q19: read once per request (display only; the request command rechecks).
      let soleOperatorStatus: Promise<string> | null = null;
      const soleOperator = options.soleOperator;
      const soleOperatorEffective =
        soleOperator === undefined
          ? undefined
          : async () => {
              soleOperatorStatus ??= soleOperator(
                businessTransaction,
                {
                  ...scope,
                  actorReference: String(current.actorReference),
                  observedAt: String(current.context.resolvedAt),
                },
                { context: current.context, authorize: () => authority.guard() },
              );
              return (await soleOperatorStatus) === "Effective";
            };
      // WP-2423 Q5: Owners/Finance read refunds too; only a Manager records requests. Decided in
      // full here and once more before the reply.
      const readAccess = async () => {
        const access = await refundReadAccess(
          workforce,
          businessTransaction,
          {
            ...scope,
            actorReference: String(current.actorReference),
            observedAt: String(current.context.resolvedAt),
          },
          role,
          current.kdsOperatorProfileAllows,
          soleOperatorEffective,
        );
        viewer.canRequest = access.canRequest;
        return access.canRead;
      };
      if (!(await readAccess())) return deny();
      authority.recheckBeforeReply(readAccess);
      const allowed = (tx?: unknown) => authority.guard(tx);
      const observedAt = String(current.context.resolvedAt);
      // WP-2423 item 4: a payment taken on the Store's own card machine. Its refunds are made on
      // that machine: confirmed is what was recorded as refunded there (ordinary requests and
      // whole refunds of a cancelled or unfulfillable round); pending is an ordinary request not
      // yet recorded, or the rest of a whole refund still owed.
      // Owner reads run inside this transaction after the full check above; it is repeated
      // before the reply (withMerchantTransactionAuthorization).
      const card = await createPostgresCardMachinePaymentStore({
        scope,
        authorize: async () => true,
      }).loadByIntent(businessTransaction, paymentIntentReference);
      if (card !== null) {
        if (card.recordedAt > observedAt) return deny();
        const cards = createPostgresCardMachinePaymentStore({
          scope,
          authorize: async (_tx, query) => query.orderReference === card.orderReference,
        });
        const ordinary = await createPostgresOrdinaryRefundPositionSource({
          scope,
          providerAccountReference: configuration.providerAccountReference,
          environment: configuration.environment,
          authorize: async (_tx, query) => query.orderReference === card.orderReference,
        })(businessTransaction, {
          orderReference: card.orderReference,
          paymentTransactionReference: card.cardMachinePaymentReference,
          paymentIntentReference: card.paymentIntentReference,
          paymentAttemptReference: card.paymentAttemptReference,
          observedAt,
        });
        const refunds = await cards.refunds(businessTransaction, card.cardMachinePaymentReference);
        const captured = card.preparation.total.amountMinor;
        const confirmed = refunds
          .filter((refund) => refund.recordedAt <= observedAt)
          .reduce((sum, refund) => sum + refund.amountMinor, 0n);
        let pending = ordinary.pendingMinor;
        const whole = await cardMachineWholeRefundSource(businessTransaction, scope, card);
        if (whole !== null && !refunds.some((refund) => refund.sourceReference === whole.reference))
          pending = captured - confirmed;
        if (confirmed + pending > captured) return deny();
        return Object.freeze({
          paymentIntentReference: card.paymentIntentReference,
          paymentAttemptReference: card.paymentAttemptReference,
          orderReference: card.orderReference,
          orderBatchReference: card.orderBatchReference,
          observedAt,
          paymentState: "Captured" as const,
          paymentMethod: "CardMachine" as const,
          currencyCode: "CAD" as const,
          capturedAmountMinor: captured.toString(),
          confirmedRefundMinor: confirmed.toString(),
          pendingRefundMinor: pending.toString(),
          canRequest: viewer.canRequest,
        });
      }
      const binding = await createPostgresPaymentIntentBindingSource({
        scope: { ...scope, environment: configuration.environment },
        authorize: (tx) => allowed(tx),
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
        return Object.freeze({
          ...binding,
          observedAt,
          paymentState: terminal === null ? ("Unresolved" as const) : ("Failed" as const),
          paymentMethod: "Online" as const,
          currencyCode: null,
          capturedAmountMinor: null,
          confirmedRefundMinor: null,
          pendingRefundMinor: null,
          canRequest: viewer.canRequest,
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
        authorize: (tx) => allowed(tx),
      })(businessTransaction, {
        orderReference: binding.orderReference,
        paymentTransactionReference: terminal.paymentTransactionReference,
        paymentIntentReference: binding.paymentIntentReference,
        paymentAttemptReference: binding.paymentAttemptReference,
        observedAt,
      });
      if (position.confirmedMinor + position.pendingMinor > terminal.amount.amountMinor)
        return deny();
      return Object.freeze({
        ...binding,
        observedAt,
        paymentState: "Captured" as const,
        paymentMethod: "Online" as const,
        currencyCode: "CAD" as const,
        capturedAmountMinor: terminal.amount.amountMinor.toString(),
        confirmedRefundMinor: position.confirmedMinor.toString(),
        pendingRefundMinor: position.pendingMinor.toString(),
        // WP-2423 Q5: only a Manager records a refund request; Owners/Finance read and approve.
        canRequest: viewer.canRequest,
      });
    }
  };
}
