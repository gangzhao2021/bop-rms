import { createPostgresReceiptOrderSource } from "@rms/ordering";
import { MemberDirectoryError, loadStoreMember } from "@bop/membership";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresOrdinaryRefundRequestStatusSource,
  createPostgresOrdinaryRefundRequestContextSource,
  createPostgresCapturedBatchPaymentSource,
  createPostgresCardMachinePaymentStore,
  createOrdinaryRefundRoleResolver,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";
import { refundReadAccess } from "./merchant-refund-read-authority.js";
import type { MerchantRefundSoleOperatorResolver } from "./merchant-sole-operator.js";
import {
  ordinaryRefundProgress,
  type OrdinaryRefundProgress,
} from "./merchant-ordinary-refund-progress.js";
import { createRoundCancellationRefundSource } from "./merchant-round-cancellation-refund.js";
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
  /** WP-2423 Q19: lets an Owner start a request while sole operator is in effect for them. */
  soleOperator?: MerchantRefundSoleOperatorResolver;
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
    return options.persistence.transactions.run((transaction) =>
      // WP-2423: the caller is resolved in full at the start and once before the reply (its
      // workspace access here, its refund read access below); the owner reads in between only
      // confirm they run in this authorized transaction for this order.
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
                    { context: current.context, authorize: () => authorized.guard() },
                  );
                  return (await soleOperatorStatus) === "Effective";
                };
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
              query.observedAt !== String(current.context.resolvedAt)
            )
              return false;
            return authorized.guard();
          };
          // WP-2423 Q5: Owners/Finance read refunds too; only a Manager records requests.
          const readAccess = () =>
            refundReadAccess(
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
          const access = await readAccess();
          if (!access.canRead) return deny();
          authorized.recheckBeforeReply(async () => (await readAccess()).canRead);
          const viewer = { canRequest: access.canRequest };
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
          // WP-2423 item 4: rounds paid on the Store's card machine are refunded on that machine.
          const cards = createPostgresCardMachinePaymentStore({
            scope,
            authorize: async (_tx, query) =>
              query.orderReference === orderReference && (await allowed()),
          });
          const onMachine = new Set<string>();
          // Rounds refunded whole by their cancellation (online compensation or the recorded
          // card-machine refund): no unit of them is offered again.
          const refundedByCancellation = new Set<string>();
          const cancellationRefund = createRoundCancellationRefundSource(
            businessTransaction,
            scope,
            orderReference,
          );
          for (const batch of order.batches) {
            const payment = await captured.load(businessTransaction, {
              orderReference,
              orderBatchReference: batch.orderBatchReference,
              observedAt,
            });
            if (payment) {
              paid.set(batch.orderBatchReference, payment.paymentIntentReference);
              if (
                await cancellationRefund({
                  orderBatchReference: String(batch.orderBatchReference),
                  paymentEventReference: String(payment.paymentEvent.eventId),
                })
              )
                refundedByCancellation.add(batch.orderBatchReference);
              if (
                (await cards.loadByBatch(
                  businessTransaction,
                  orderReference,
                  batch.orderBatchReference,
                )) !== null
              )
                onMachine.add(batch.orderBatchReference);
            }
          }
          const items = order.items.map(({ snapshot }) => {
            // WP-2423 Q5: units of a declined request are refundable again.
            const occupied = context.occupying.flatMap((request) =>
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
            const cancelledWithRefund =
              paymentCaptured && refundedByCancellation.has(snapshot.orderBatchReference);
            return Object.freeze({
              orderBatchReference: String(snapshot.orderBatchReference),
              orderItemReference: String(snapshot.orderItemReference),
              label,
              quantity: snapshot.quantity,
              unclaimedQuantity:
                paymentCaptured && !cancelledWithRefund ? snapshot.quantity - occupied.length : 0,
              paymentCaptured,
              refundedByCancellation: cancelledWithRefund,
              paymentIntentReference: paid.get(snapshot.orderBatchReference) ?? null,
              paymentMethod: !paymentCaptured
                ? null
                : onMachine.has(snapshot.orderBatchReference)
                  ? ("CardMachine" as const)
                  : ("Online" as const),
            });
          });
          // WP-2423 Q5: who declined a request, when and why (names are shown to staff only).
          const names = new Map<string, string | null>();
          const name = async (actor: string) => {
            if (!names.has(actor))
              try {
                names.set(
                  actor,
                  (await loadStoreMember(businessTransaction, scope, actor)).displayName,
                );
              } catch (error) {
                if (!(error instanceof MemberDirectoryError)) throw error;
                names.set(actor, null);
              }
            return names.get(actor) ?? null;
          };
          const recent = context.history.slice(-20);
          const declines = new Map<
            string,
            {
              reasonCode: string;
              declinedAt: string;
              declinerName: string | null;
              declinedByYou: boolean;
            }
          >();
          for (const request of recent) {
            const decline = context.declines.get(request.requestReference);
            if (decline)
              declines.set(
                request.requestReference,
                Object.freeze({
                  reasonCode: decline.reasonCode,
                  declinedAt: decline.declinedAt,
                  declinerName: await name(decline.declinerReference),
                  declinedByYou: decline.declinerReference === String(current.actorReference),
                }),
              );
          }
          // WP-2423 Q5: each recent request's progress from committed Payment facts, so staff see
          // Recorded / ReadyToSend / Sending / Refunded without a separate status check.
          const status = createPostgresOrdinaryRefundRequestStatusSource({
            scope,
            providerAccountReference: configuration.providerAccountReference,
            environment: configuration.environment,
            authorize: () => allowed(),
          });
          const progress = new Map<string, OrdinaryRefundProgress>();
          const methods = new Map<string, "Online" | "CardMachine">();
          for (const request of recent) {
            if (declines.has(request.requestReference)) {
              progress.set(request.requestReference, "Declined");
              continue;
            }
            const current = await status(businessTransaction, {
              orderReference,
              operationReference: String(request.operationReference),
              observedAt,
            });
            // WP-2423 item 4: a card-machine refund request names that one payment.
            if (current.payments.some((payment) => payment.method === "CardMachine"))
              methods.set(request.requestReference, "CardMachine");
            progress.set(
              request.requestReference,
              ordinaryRefundProgress(
                false,
                current.payments.map((payment) => payment.state),
              ),
            );
          }
          return Object.freeze({
            orderReference,
            canRequest: viewer.canRequest,
            orderNumber: order.orderNumber,
            claimVersion: context.history.length,
            items: Object.freeze(items),
            recentRequests: Object.freeze(
              recent.map((request) =>
                Object.freeze({
                  requestReference: String(request.requestReference),
                  operationReference: String(request.operationReference),
                  claimVersion: request.expectedClaimVersion + 1,
                  requestedAt: String(request.requestedAt),
                  reasonCode: request.reasonCode,
                  currencyCode: request.currencyCode,
                  amountMinor: request.amountMinor.toString(),
                  decline: declines.get(request.requestReference) ?? null,
                  progress: progress.get(request.requestReference) ?? "Recorded",
                  paymentMethod: methods.get(request.requestReference) ?? ("Online" as const),
                }),
              ),
            ),
          });
        },
      ),
    );
  };
}
