import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import {
  createPostgresRefundRecoveryStore,
  listRefundRecoveriesByOrders,
  refundRecoveryMethods,
  refundRecoveryReasons,
  type RefundRecovery,
} from "@rms/payment";
import { MemberDirectoryError, loadStoreMember } from "@bop/membership";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { businessTransaction } from "./merchant-ordinary-refund-approval.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** WP-2423 M163: who may record money taken back (Owner, Store and Area Managers). */
export const refundRecoveryPermission = "payment.refund.recover" as const;
interface Scope {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}
const denied = (): never => {
  throw new Error("REFUND_RECOVERY_DENIED");
};
const invalid = (): never => {
  throw new Error("REFUND_RECOVERY_INPUT_INVALID");
};
/** One recovery for staff: amount, method, who took it back and when (names to staff only). */
export function refundRecoveryView(recovery: RefundRecovery, recordedByName: string | null) {
  return Object.freeze({
    recoveryReference: recovery.recoveryReference,
    method: recovery.method,
    amountMinor: recovery.amountMinor.toString(),
    currencyCode: recovery.currencyCode,
    reasonCode: recovery.reasonCode,
    businessDate: recovery.businessDate,
    recordedAt: recovery.recordedAt,
    recordedByName,
  });
}
async function memberName(tx: ConsumerTransaction, scope: Scope, actor: string) {
  try {
    return (await loadStoreMember(tx, scope, actor)).displayName;
  } catch (error) {
    if (!(error instanceof MemberDirectoryError)) throw error;
    return null;
  }
}

/**
 * WP-2423 M163 (DEC-OWNER-DEFAULTS-2026-11-06 item 5, Owner accepted): staff refunded too much by
 * mistake and the guest gives the money back. A Store Manager or the Owner records "money taken
 * back" on the same order, in their own name, on the business day it happens: taken in cash, or
 * charged on the Store's card machine with its slip reference. Never more than the order's
 * confirmed refunds less what was taken back already; the refund itself is never changed. A retry
 * with the same operation answers the same record.
 */
export function createMerchantRefundRecovery(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: Scope,
  ): Promise<{ providerAccountReference: string; environment: "Test" | "Live" }>;
  /** The Store's business date of an instant (the Store's published business day). */
  businessDate(tx: ConsumerTransaction, value: Scope & { occurredAt: string }): Promise<string>;
  nextReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const ref = (value: unknown) => String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const keys = ["orderReference", "operationReference", "method", "amountMinor", "reasonCode"];
    const withSlip =
      input.command !== null &&
      typeof input.command === "object" &&
      Object.prototype.hasOwnProperty.call(input.command, "slipReference");
    const raw = readClosedRecord(input.command, withSlip ? [...keys, "slipReference"] : keys);
    const orderReference = ref(raw.orderReference),
      operationReference = ref(raw.operationReference);
    if (
      !refundRecoveryMethods.includes(raw.method as never) ||
      !refundRecoveryReasons.includes(raw.reasonCode as never) ||
      typeof raw.amountMinor !== "string" ||
      // b13: "0" reaches the record, which answers that nothing was taken back (422).
      !/^(0|[1-9][0-9]{0,8})$/u.test(raw.amountMinor) ||
      (raw.method === "CardMachine") !== withSlip ||
      (withSlip &&
        (typeof raw.slipReference !== "string" ||
          !/^[A-Za-z0-9 -]{1,24}$/u.test(raw.slipReference.trim()) ||
          // Too many digits in a row could be a card number: never stored.
          /[0-9]{9,}/u.test(raw.slipReference.replace(/[ -]/gu, ""))))
    )
      return invalid();
    const slipReference = withSlip ? (raw.slipReference as string).trim() : null;
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const resolved = await resolve(
              transaction,
              input.sessionCookie,
              refundRecoveryPermission,
              authenticated.sessionReference,
            );
            if ((await resolved.allowed()) !== true) return denied();
            return resolved;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async (authority) => {
          const current = authority.scope;
          const tx = businessTransaction(transaction);
          const scope = {
            tenantReference: current.selected.tenantReference,
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
          };
          const configuration = await options.resolveConfiguration(tx, scope);
          const recordedAt = String(current.context.resolvedAt);
          const businessDate = await options.businessDate(tx, { ...scope, occurredAt: recordedAt });
          const recoveryReference = options.nextReference();
          const auditReference = options.nextReference();
          const result = await createPostgresRefundRecoveryStore({
            scope,
            providerAccountReference: configuration.providerAccountReference,
            environment: configuration.environment,
            authorize: async (_tx, query) =>
              query.orderReference === orderReference && (await authority.guard()),
          })(tx, {
            recoveryReference,
            operationReference,
            orderReference,
            method: raw.method as (typeof refundRecoveryMethods)[number],
            slipReference,
            amountMinor: BigInt(raw.amountMinor as string),
            reasonCode: raw.reasonCode as (typeof refundRecoveryReasons)[number],
            actorReference: String(current.actorReference),
            recordedAt,
            businessDate,
            audit: {
              auditId: auditReference,
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "User", reference: String(current.actorReference) },
              actionCode: "PAYMENT_REFUND_RECOVERY_RECORDED",
              targetType: "PaymentRefundRecovery",
              targetId: recoveryReference,
              reasonCode: raw.reasonCode as string,
              correlationId: operationReference,
              occurredAt: recordedAt,
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Restricted",
              retentionPolicyCode: options.retentionPolicyCode,
              retentionPolicyVersion: options.retentionPolicyVersion,
            },
          });
          return Object.freeze({
            status: result.status,
            orderReference,
            recovery: refundRecoveryView(
              result.recovery,
              await memberName(tx, scope, result.recovery.actorReference),
            ),
          });
        },
      ),
    );
  };
}

/** WP-2423 M163: the recoveries of one Order, for its payment page and order detail. */
export async function readOrderRefundRecoveries(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReference: string,
) {
  const recoveries = await listRefundRecoveriesByOrders(tx, scope, [orderReference]);
  const views = [];
  for (const recovery of recoveries)
    views.push(refundRecoveryView(recovery, await memberName(tx, scope, recovery.actorReference)));
  return Object.freeze(views);
}
