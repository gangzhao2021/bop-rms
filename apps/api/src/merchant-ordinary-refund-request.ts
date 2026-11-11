import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresCapturedBatchPaymentSource,
  createPostgresCardMachinePaymentStore,
  createPostgresOrdinaryRefundRequestRuntime,
  createOrdinaryRefundRoleResolver,
  observeOrdinaryRefundOrderAfterFence,
} from "@rms/payment";
import {
  createPostgresOrderAcceptanceReader,
  orderItemRefundWithdrawalMaximumLines,
  recordOrderItemRefundWithdrawals,
} from "@rms/ordering";
import { cardMachineWholeRefundSource } from "./merchant-card-machine-refund.js";
import {
  everyBatchUnitClaimed,
  readBatchUnits,
  readClaimedRefundUnits,
  type BatchUnits,
} from "./order-batch-refund-coverage.js";
import { createRoundCancellationRefundSource } from "./merchant-round-cancellation-refund.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { MerchantRefundSoleOperatorResolver } from "./merchant-sole-operator.js";
/** WP-2423 Q5 (DEC-REFUND-ESCALATION-PILOT): the reasons staff choose from, recorded on the
 * request and its Audit. "Other" requires a short staff note, kept in Payment's Confidential note
 * record (never in Audit, logs or URLs) and shown to the approver. */
export const ordinaryRefundReasonCodes = Object.freeze([
  "CUSTOMER_REQUEST",
  "WRONG_ITEM",
  "MISSING_ITEM",
  "QUALITY_ISSUE",
  "LONG_WAIT",
  "DUPLICATE_CHARGE",
  "STORE_ERROR",
  "OTHER",
] as const);
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
  /** WP-2423 Q5: Store Business Date (owner composition) so the result says whether an
   * Owner/Finance approval is needed and why. Absent: approval need is not reported. */
  businessDate?: Parameters<typeof createPostgresOrdinaryRefundRequestRuntime>[0]["businessDate"];
  /** WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): an Owner may request while sole operator is in
   * effect for them; absent, only a Manager may request (unchanged). */
  soleOperator?: MerchantRefundSoleOperatorResolver;
  /** WP-2423 M10: references for the "stop making it too" withdrawals; absent: none accepted. */
  nextReference?: () => string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const deny = (): never => {
    throw new Error("ORDINARY_REFUND_REQUEST_DENIED");
  };
  /** Refused like any other denial; the message names the cause for logs and tests only. */
  const roundRefunded = (): never => {
    throw new Error("ORDINARY_REFUND_ROUND_REFUNDED_BY_CANCELLATION");
  };
  /**
   * WP-2423 M10: every dish of a paid order nobody accepted yet would be refunded. That is a
   * refusal of the order, recorded as one ("Can't make it"), so the kitchen never gets it.
   */
  const notAccepted = (): never => {
    throw new Error("ORDINARY_REFUND_ORDER_NOT_ACCEPTED");
  };
  /**
   * WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4): "stop making it too" asked by someone who
   * may not take dishes off an order (`ordering.order.cancel`), or for more units than this request
   * refunds. Refused before anything is written.
   */
  const withdrawNotAllowed = (): never => {
    throw new Error("ORDINARY_REFUND_WITHDRAW_DENIED");
  };
  const parseWithdraw = (value: unknown) => {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > orderItemRefundWithdrawalMaximumLines
    )
      return deny();
    const lines = value.map((entry: unknown) => {
      const line = readClosedRecord(entry, ["orderItemReference", "quantity"]);
      if (
        typeof line.quantity !== "number" ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 999
      )
        return deny();
      return Object.freeze({
        orderItemReference: String(
          parseOpaqueUuidV7(line.orderItemReference, "ACTOR_REFERENCE_INVALID"),
        ),
        quantity: line.quantity,
      });
    });
    if (new Set(lines.map((line) => line.orderItemReference)).size !== lines.length) return deny();
    return lines;
  };
  const resolveCommand = async (
    input: { sessionCookie: unknown; csrf: unknown; command: unknown },
    preview: boolean,
  ) => {
    const authenticated = await options.authentication.authorize(input);
    const keys = [
      "orderReference",
      "requestReference",
      "operationReference",
      "expectedClaimVersion",
      "reasonCode",
      "items",
    ];
    const has = (key: string) =>
      input.command !== null &&
      typeof input.command === "object" &&
      Object.prototype.hasOwnProperty.call(input.command, key);
    const withNote = has("note"),
      withWithdraw = has("withdraw");
    const commandRecord = readClosedRecord(input.command, [
      ...keys,
      ...(withNote ? ["note"] : []),
      ...(withWithdraw ? ["withdraw"] : []),
    ]);
    const { withdraw: rawWithdraw, ...raw } = commandRecord as Record<string, unknown>;
    const withdraw = withWithdraw ? parseWithdraw(rawWithdraw) : null;
    if (withdraw !== null && options.nextReference === undefined) return withdrawNotAllowed();
    const orderReference = String(parseOpaqueUuidV7(raw.orderReference, "ACTOR_REFERENCE_INVALID"));
    if (!ordinaryRefundReasonCodes.includes(raw.reasonCode as never)) return deny();
    // "Other" needs a note of 1–200 characters; no other reason carries one.
    if (
      (raw.reasonCode === "OTHER") !== withNote ||
      (withNote &&
        (typeof raw.note !== "string" ||
          raw.note.trim().length < 1 ||
          [...raw.note.trim()].length > 200 ||
          /[\p{Cc}]/u.test(raw.note.trim())))
    )
      return deny();
    // WP-2423: one authorized run. The staff member and `payment.refund.request` are resolved in
    // full once at the start and once more before the commit (inside this transaction: a
    // permission withdrawn or Session ended meanwhile records no request). The Payment owner
    // checks in between take the run's no-query guard; the requester's role (Manager, or Owner
    // as sole operator) is read once and read again before the commit.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const resolved = await resolve(
              transaction,
              input.sessionCookie,
              "payment.refund.request",
              authenticated.sessionReference,
            );
            if (!(await resolved.allowed())) return deny();
            return resolved;
          },
          recheck: async (resolved) => (await resolved.allowed()) === true,
          denied: deny,
        },
        async (authority) => {
          const current = authority.scope;
          const allowed = () => authority.guard();
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
          // WP-2423 M10: taking dishes off the order is Ordering's `ordering.order.cancel`, checked
          // with the request and again before the commit.
          if (withdraw !== null) {
            const mayCancel = async () =>
              (await current.authorizeAction("ordering.order.cancel"))?.effect === "Allow";
            if (!(await mayCancel())) return withdrawNotAllowed();
            authority.recheckBeforeReply(mayCancel);
          }
          const configuration = await options.resolveConfiguration(businessTransaction, scope);
          const workforce = createMerchantWorkforcePermissionSource({
            resolveContext: async () => ({
              tenantReference: scope.tenantReference,
              context: current.context,
            }),
          });
          const role = createOrdinaryRefundRoleResolver(configuration.roleMapping);
          // Read once per command at the command instant; preparation and approval recheck it.
          let soleOperatorStatus: Promise<string> | null = null;
          const soleOperator = options.soleOperator;
          const soleOperatorEffective = async () => {
            if (soleOperator === undefined) return false;
            soleOperatorStatus ??= soleOperator(
              businessTransaction,
              {
                ...scope,
                actorReference: String(current.actorReference),
                observedAt: String(current.context.resolvedAt),
              },
              { context: current.context, authorize: allowed },
            );
            return (await soleOperatorStatus) === "Effective";
          };
          /** The requester's role from their current workforce authority (Manager, or an Owner
           * while sole operator is in effect for them). */
          const requesterRole = async () => {
            const decided = await workforce(businessTransaction, {
              ...scope,
              actorReference: String(current.actorReference),
              observedAt: current.context.resolvedAt,
              permissionCode: "payment.refund.request",
            });
            if (decided.decision.effect !== "Allow") return false;
            const requestRole = role("payment.refund.request", decided.activeRoleCodes);
            return (
              requestRole === "Manager" ||
              // WP-2423 M14 (DEC-OWNER-DEFAULTS-2026-11-06 item 2): a cashier records a request
              // with a reason; a manager or the owner sends it.
              requestRole === "Staff" ||
              (requestRole === "Owner" && (await soleOperatorEffective()))
            );
          };
          // Read once for this run (Payment asks several times per request) and again before commit.
          let requester: Promise<boolean> | null = null;
          const requesterAuthorized = () => {
            if (requester === null) {
              requester = requesterRole();
              authority.recheckBeforeReply(requesterRole);
            }
            return requester;
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
              query.observedAt !== String(current.context.resolvedAt) ||
              !(await allowed())
            )
              return false;
            return requesterAuthorized();
          };
          // WP-2423 item 4: a round paid on the Store's card machine that the store cancelled (or that
          // could not be fulfilled) is refunded in full from the order page, not by an item request.
          const cards = createPostgresCardMachinePaymentStore({
            scope,
            // Checked in full at the start and again before the reply.
            authorize: async (_tx, query) => query.orderReference === orderReference,
          });
          const batches = new Set(
            (Array.isArray(raw.items) ? raw.items : []).flatMap((item: unknown) => {
              const batch =
                item !== null && typeof item === "object"
                  ? (item as { orderBatchReference?: unknown }).orderBatchReference
                  : undefined;
              return typeof batch === "string" ? [batch] : [];
            }),
          );
          // A round the store cancelled is refunded whole by that cancellation (online compensation or
          // the card-machine cancellation refund); an item request on it would refund it twice.
          const cancellationRefund = createRoundCancellationRefundSource(
            businessTransaction,
            scope,
            orderReference,
          );
          const captured = createPostgresCapturedBatchPaymentSource({
            scope: {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              providerAccountReference: configuration.providerAccountReference,
              environment: configuration.environment,
            },
            authorize: async (_tx, query) => query.orderReference === orderReference,
          });
          // WP-2423 M10: paid rounds nobody accepted yet, with their units (Ordering is read before
          // Payment's refund fence, the canonical cross-owner lock order).
          const acceptances = createPostgresOrderAcceptanceReader({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            authorize: async (_tx, query) => query.orderReference === orderReference && allowed(),
          });
          const unaccepted: BatchUnits[] = [];
          for (const batch of batches) {
            const orderBatchReference = String(parseOpaqueUuidV7(batch, "ACTOR_REFERENCE_INVALID"));
            const card = await cards.loadByBatch(
              businessTransaction,
              orderReference,
              orderBatchReference,
            );
            if (
              card !== null &&
              (await cardMachineWholeRefundSource(businessTransaction, scope, card))
            )
              return roundRefunded();
            const payment = await captured.load(businessTransaction, {
              orderReference,
              orderBatchReference,
              observedAt: String(current.context.resolvedAt),
            });
            if (
              payment !== null &&
              (await cancellationRefund({
                orderBatchReference,
                paymentEventReference: String(payment.paymentEvent.eventId),
              }))
            )
              return roundRefunded();
            if (
              (payment !== null || card !== null) &&
              (await acceptances.loadByBatch({
                transaction: businessTransaction,
                orderReference,
                orderBatchReference,
              })) === null
            )
              unaccepted.push(
                await readBatchUnits(
                  businessTransaction,
                  scope,
                  {
                    orderReference,
                    orderBatchReference,
                    observedAt: String(current.context.resolvedAt),
                  },
                  allowed,
                ),
              );
          }
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
            ...(options.businessDate === undefined ? {} : { businessDate: options.businessDate }),
          });
          const result = await (preview ? runtime.preview : runtime)(businessTransaction, {
            ...raw,
            orderReference,
            actorReference: String(current.actorReference),
          });
          if (unaccepted.length > 0 && result.status !== "AlreadyCommitted") {
            // The units still claimed after this request (recorded in this transaction, or only
            // previewed), counted in units: refunding every dish but not the tip is all of it.
            const claimed = await readClaimedRefundUnits(
              businessTransaction,
              scope,
              {
                orderReference,
                observedAt: await observeOrdinaryRefundOrderAfterFence(
                  businessTransaction,
                  scope,
                  orderReference,
                  String(result.request.requestedAt),
                  options.persistence.now,
                ),
                operationReference: String(result.request.operationReference),
              },
              allowed,
            );
            const asked = result.request.payments.flatMap((payment) =>
              payment.items.map((item) => ({
                orderItemReference: String(item.orderItemReference),
                refundUnitOrdinals: item.refundUnitOrdinals,
              })),
            );
            if (unaccepted.some((units) => everyBatchUnitClaimed(units, claimed, asked)))
              return notAccepted();
          }
          // WP-2423 M10: "stop making it too", for units this request refunds, recorded with it.
          if (withdraw !== null) {
            const lines = withdraw.map((entry) => {
              const claimed = result.request.payments.flatMap((payment) =>
                payment.items.filter(
                  (item) => String(item.orderItemReference) === entry.orderItemReference,
                ),
              );
              const units = claimed.reduce((sum, item) => sum + item.refundUnitOrdinals.length, 0);
              const asked = (Array.isArray(raw.items) ? raw.items : []).find(
                (item: unknown) =>
                  item !== null &&
                  typeof item === "object" &&
                  (item as { orderItemReference?: unknown }).orderItemReference ===
                    entry.orderItemReference,
              ) as { orderBatchReference?: unknown } | undefined;
              if (
                claimed.length === 0 ||
                entry.quantity > units ||
                typeof asked?.orderBatchReference !== "string"
              )
                return withdrawNotAllowed();
              return {
                orderBatchReference: asked.orderBatchReference,
                orderItemReference: entry.orderItemReference,
                quantity: entry.quantity,
              };
            });
            if (!preview)
              await recordOrderItemRefundWithdrawals(businessTransaction, scope, {
                orderReference,
                refundRequestReference: String(result.request.requestReference),
                operationReference: String(result.request.operationReference),
                actorReference: String(current.actorReference),
                recordedAt: String(result.request.requestedAt),
                nextReference: options.nextReference as () => string,
                lines,
              });
          }
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
            approvalRequired: result.escalation?.requiresIndependentApproval ?? null,
            escalationReasons: Object.freeze([...(result.escalation?.reasons ?? [])]),
            // WP-2423 Q19: the requester may approve this escalated refund themself (sole operator in
            // effect for them now); the approval itself rechecks everything.
            approveAlone:
              result.escalation?.requiresIndependentApproval === true &&
              (await soleOperatorEffective()),
          });
        },
      ),
    );
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
      approvalRequired: result.approvalRequired,
      escalationReasons: result.escalationReasons,
      approveAlone: result.approveAlone,
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
