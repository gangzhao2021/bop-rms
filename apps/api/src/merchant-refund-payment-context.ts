import { readOrderRefundRecoveries, refundRecoveryPermission } from "./merchant-refund-recovery.js";
import { withOptionalRead } from "./merchant-round-business-date.js";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  cardMachineOrderRefundedMinor,
  cardMachinePaymentTakenMinor,
  createPostgresCardMachinePaymentStore,
  createPostgresOrdinaryRefundPositionSource,
  createPostgresPaymentIntentBindingSource,
  createPostgresPaymentTerminalStore,
  createPostgresOrderPaymentRefundPosition,
  createOrdinaryRefundRoleResolver,
  observeOrdinaryRefundOrderAfterFence,
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
  /** A fact recorded after this read's observation time: the payment changed while loading. */
  const changed = (): never => {
    throw new Error("MERCHANT_REFUND_READ_CHANGED");
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
      const viewer = {
        canRequest: false as boolean,
        requestBlocked: null as "SoleOperatorOff" | null,
        canSend: false as boolean,
      };
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
          // b9: an owner who only approves still sends here, as on Approvals.
          true,
        );
        viewer.canRequest = access.canRequest;
        viewer.requestBlocked = access.requestBlocked;
        viewer.canSend = access.canSend;
        return access.canRead;
      };
      if (!(await readAccess())) return deny();
      authority.recheckBeforeReply(readAccess);
      // WP-2423 M163: money taken back on this payment's order, and whether this reader may
      // record it (a Store Manager or the Owner). Unreadable: none shown, nothing offered.
      const recoveryFacts = async (orderReference: string) => {
        const canRecover =
          (await current.authorizeAction(refundRecoveryPermission))?.effect === "Allow";
        const recoveries = await withOptionalRead(
          businessTransaction,
          () => readOrderRefundRecoveries(businessTransaction, scope, orderReference),
          null,
        );
        return {
          canRecover: canRecover && recoveries !== null,
          recoveries: recoveries ?? [],
        };
      };
      const allowed = (tx?: unknown) => authority.guard(tx);
      const resolvedAt = String(current.context.resolvedAt);
      // v15 2026-10-18 (dd750045): once the Order is known, the payment's refunds are read at a
      // time taken after the Order's refund fence is held (a request recorded for the Order
      // meanwhile is part of the read), never at the session's resolution.
      const observeOrder = (orderReference: string) =>
        observeOrdinaryRefundOrderAfterFence(
          businessTransaction,
          scope,
          orderReference,
          resolvedAt,
          options.persistence.now,
        );
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
        const observedAt = await observeOrder(card.orderReference);
        if (card.recordedAt > observedAt) return changed();
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
        const refunds = (
          await cards.refunds(businessTransaction, card.cardMachinePaymentReference)
        ).filter((refund) => refund.recordedAt <= observedAt);
        const captured = card.preparation.total.amountMinor;
        const handedBack = refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n);
        // WP-2423 M52/M131: cash goes back in whole nickels, so what a counter cash payment's
        // refunds gave the Order is counted in the Order's terms (each request at its own amount,
        // a cancellation at the rest of the Order once the drawer gave back all the cash it took),
        // never the drawer's: the rounding is the drawer's, as for a table's cash.
        const confirmed =
          card.cash === undefined
            ? handedBack
            : cardMachineOrderRefundedMinor(card, {
                nominalMinor:
                  ordinary.confirmedMinor +
                  refunds
                    .filter((refund) => refund.sourceKind !== "OrdinaryRefund")
                    .reduce((sum, refund) => sum + refund.amountMinor, 0n),
                pendingMinor: ordinary.pendingMinor,
                handedBackMinor: handedBack,
              });
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
          // v15 batch 8: a counter cash payment's refunds go back in cash from the drawer.
          paidInCash: card.cash !== undefined,
          // v15 batch 8: the cash the drawer still holds of it (taken, rounding included, less
          // every refund given back), so the page names the whole nickels a new request gives back.
          cashLeftMinor:
            card.cash === undefined
              ? null
              : (() => {
                  const left = cardMachinePaymentTakenMinor(card) - handedBack;
                  return (left > 0n ? left : 0n).toString();
                })(),
          currencyCode: "CAD" as const,
          capturedAmountMinor: captured.toString(),
          confirmedRefundMinor: confirmed.toString(),
          pendingRefundMinor: pending.toString(),
          canRequest: viewer.canRequest,
          requestBlocked: viewer.requestBlocked,
          canSend: viewer.canSend,
          ...(await recoveryFacts(card.orderReference)),
        });
      }
      const binding = await createPostgresPaymentIntentBindingSource({
        scope: { ...scope, environment: configuration.environment },
        authorize: (tx) => allowed(tx),
      })(businessTransaction, { paymentIntentReference, observedAt: resolvedAt }).catch(
        (error: unknown) => {
          // M126 I.5: this Store has no such payment (it belongs to another Store): said so.
          if (error instanceof Error && error.message === "PAYMENT_INTENT_BINDING_NOT_FOUND")
            throw new Error("MERCHANT_REFUND_PAYMENT_NOT_FOUND", { cause: error });
          throw error;
        },
      );
      const observedAt = await observeOrder(binding.orderReference);
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
          terminal.orderReference !== binding.orderReference)
      )
        return deny();
      if (terminal && terminal.recordedAt > observedAt) return changed();
      if (terminal === null || terminal.outcome === "Failed") {
        return Object.freeze({
          ...binding,
          observedAt,
          paymentState: terminal === null ? ("Unresolved" as const) : ("Failed" as const),
          paymentMethod: "Online" as const,
          paidInCash: false,
          cashLeftMinor: null,
          currencyCode: null,
          capturedAmountMinor: null,
          confirmedRefundMinor: null,
          pendingRefundMinor: null,
          canRequest: viewer.canRequest,
          requestBlocked: viewer.requestBlocked,
          canSend: viewer.canSend,
          ...({ canRecover: false, recoveries: [] } as Awaited<ReturnType<typeof recoveryFacts>>),
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
        paidInCash: false,
        cashLeftMinor: null,
        currencyCode: "CAD" as const,
        capturedAmountMinor: terminal.amount.amountMinor.toString(),
        confirmedRefundMinor: position.confirmedMinor.toString(),
        pendingRefundMinor: position.pendingMinor.toString(),
        // WP-2423 Q5: only a Manager records a refund request; Owners/Finance read and approve.
        canRequest: viewer.canRequest,
        requestBlocked: viewer.requestBlocked,
        // WP-2423 M14: a cashier's request is recorded only; a manager or the owner sends it.
        canSend: viewer.canSend,
        ...(await recoveryFacts(binding.orderReference)),
      });
    }
  };
}
