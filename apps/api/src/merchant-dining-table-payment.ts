import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresDiningTableSettlementStore,
  DiningTableSettlementStoreError,
  diningTableCashRefundReasons,
  type DiningTableCashRefundReason,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { runMerchantSnapshotRead } from "./merchant-snapshot-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: a table's one payment as the Orders page shows it (method,
 * rounds, tip, cash rounding, total, cash given back) and cash given back from a cash payment.
 * Giving cash back is a manager's decision (`payment.refund.approve`, PIN-confirmed): it records
 * the amount, who, why and when as a compensating record; the payment itself never changes.
 */
export const tablePaymentReadPermission = "ordering.operate" as const;
export const tableCashRefundPermission = "payment.refund.approve" as const;

export type TablePaymentErrorCode =
  | "TABLE_PAYMENT_INPUT_INVALID"
  | "TABLE_PAYMENT_PERMISSION_DENIED"
  | "TABLE_PAYMENT_NOT_CASH"
  | "TABLE_PAYMENT_NOT_PAID"
  | "TABLE_PAYMENT_TOO_MUCH"
  | "TABLE_PAYMENT_IDEMPOTENCY_CONFLICT"
  | "TABLE_PAYMENT_UNAVAILABLE";
export class TablePaymentError extends Error {
  constructor(readonly code: TablePaymentErrorCode) {
    super(code);
    this.name = "TablePaymentError";
  }
}
const fail = (code: TablePaymentErrorCode): never => {
  throw new TablePaymentError(code);
};
const reference = (value: unknown) => String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
interface Scope {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}
const scopeOf = (current: {
  selected: { tenantReference: unknown };
  context: { brand: { brandReference: unknown } };
  store: { storeReference: unknown };
}): Scope => ({
  tenantReference: String(current.selected.tenantReference),
  brandReference: String(current.context.brand.brandReference),
  storeReference: String(current.store.storeReference),
});

async function view(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReference: string,
  allowed: () => Promise<boolean>,
) {
  const store = createPostgresDiningTableSettlementStore({
    scope,
    authorize: async (_tx, value) =>
      value.orderReference === orderReference && (await allowed()) === true,
  });
  const settlements = await store.listByOrders(tx, [orderReference]);
  const allRefunds = await store.listCashRefundsByOrders(tx, [orderReference]);
  // WP-2423 item 8 ④: each payment of the table — the whole table's, or one per part of a split
  // bill — with its own cash refunds; a refund comes from one payment's cash.
  const describe = (settlement: (typeof settlements)[number]) => {
    const refunds = allRefunds.filter(
      (refund) => refund.settlementReference === settlement.settlementReference,
    );
    const refunded = refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n);
    return Object.freeze({
      partNumber: settlement.part?.partNumber ?? null,
      method: settlement.method,
      roundsMinor: settlement.roundsMinor.toString(),
      tipMinor: settlement.tipMinor.toString(),
      roundingMinor: settlement.roundingMinor.toString(),
      totalMinor: settlement.totalMinor.toString(),
      takenAt: settlement.takenAt,
      recordedAfterOutage: settlement.recordingReason === "RecordedAfterOutage",
      cashRefunds: Object.freeze(
        refunds.map((refund) =>
          Object.freeze({
            amountMinor: refund.amountMinor.toString(),
            reasonCode: refund.reasonCode,
            refundedAt: refund.refundedAt,
          }),
        ),
      ),
      refundableMinor: (settlement.method === "Cash"
        ? settlement.totalMinor - refunded
        : 0n
      ).toString(),
    });
  };
  const whole = settlements.find((settlement) => settlement.part === null);
  return Object.freeze({
    orderReference,
    payment: whole === undefined ? null : describe(whole),
    parts: Object.freeze(
      settlements
        .filter((settlement) => settlement.part !== null)
        .sort((a, b) => (a.part?.partNumber ?? 0) - (b.part?.partNumber ?? 0))
        .map(describe),
    ),
  });
}

export function createMerchantDiningTablePaymentRead(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    let orderReference: string;
    try {
      orderReference = reference(readClosedRecord(input.query, ["orderReference"]).orderReference);
    } catch {
      return fail("TABLE_PAYMENT_INPUT_INVALID");
    }
    return runMerchantSnapshotRead(options.persistence.transactions, (tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(
              tx,
              input.sessionCookie,
              tablePaymentReadPermission,
              authenticated.sessionReference,
            ).catch(() => fail("TABLE_PAYMENT_PERMISSION_DENIED"));
            if ((await current.allowed()) !== true) return fail("TABLE_PAYMENT_PERMISSION_DENIED");
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied: () => fail("TABLE_PAYMENT_PERMISSION_DENIED"),
        },
        async (authority) =>
          view(tx as unknown as ConsumerTransaction, scopeOf(authority.scope), orderReference, () =>
            authority.guard(),
          ),
      ),
    );
  };
}

export function createMerchantDiningTableCashRefund(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    let command: {
      orderReference: string;
      operationReference: string;
      amountMinor: bigint;
      reasonCode: DiningTableCashRefundReason;
      partNumber: number | null;
    };
    try {
      const value = input.command;
      const raw = readClosedRecord(value, [
        "orderReference",
        "operationReference",
        "amountMinor",
        "reasonCode",
        ...(value !== null && typeof value === "object" && Object.hasOwn(value, "partNumber")
          ? ["partNumber"]
          : []),
      ]);
      if (
        raw.partNumber !== undefined &&
        raw.partNumber !== null &&
        !(
          Number.isSafeInteger(raw.partNumber) &&
          (raw.partNumber as number) >= 1 &&
          (raw.partNumber as number) <= 20
        )
      )
        throw new Error();
      if (
        typeof raw.amountMinor !== "string" ||
        !/^[1-9][0-9]{0,8}$/u.test(raw.amountMinor) ||
        !diningTableCashRefundReasons.includes(raw.reasonCode as DiningTableCashRefundReason)
      )
        throw new Error();
      command = {
        orderReference: reference(raw.orderReference),
        operationReference: reference(raw.operationReference),
        amountMinor: BigInt(raw.amountMinor),
        reasonCode: raw.reasonCode as DiningTableCashRefundReason,
        partNumber: (raw.partNumber as number | null | undefined) ?? null,
      };
    } catch {
      return fail("TABLE_PAYMENT_INPUT_INVALID");
    }
    const intentDigest =
      "sha256:" +
      createHash("sha256")
        .update(
          canonicalizeRfc8785({
            kind: "DiningTableCashRefund/v1",
            orderReference: command.orderReference,
            amountMinor: command.amountMinor.toString(),
            reasonCode: command.reasonCode,
            ...(command.partNumber === null ? {} : { partNumber: command.partNumber }),
          }),
        )
        .digest("hex");
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolve(
                transaction,
                input.sessionCookie,
                tableCashRefundPermission,
                authenticated.sessionReference,
              ).catch(() => fail("TABLE_PAYMENT_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true)
                return fail("TABLE_PAYMENT_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("TABLE_PAYMENT_PERMISSION_DENIED"),
          },
          async (authority) => {
            const tx = transaction as unknown as ConsumerTransaction;
            const scope = scopeOf(authority.scope);
            const guard = () => authority.guard();
            const store = createPostgresDiningTableSettlementStore({
              scope,
              authorize: async (_tx, value) =>
                value.orderReference === command.orderReference && (await guard()) === true,
            });
            // The whole table's payment, or the part's (WP-2423 item 8 ④) — only from that cash.
            const settlement = (await store.listByOrders(tx, [command.orderReference])).find(
              (entry) => (entry.part?.partNumber ?? null) === command.partNumber,
            );
            if (settlement === undefined) return fail("TABLE_PAYMENT_NOT_PAID");
            if (settlement.method !== "Cash") return fail("TABLE_PAYMENT_NOT_CASH");
            const prior = (await store.listCashRefundsByOrders(tx, [command.orderReference])).find(
              (refund) => refund.operationReference === command.operationReference,
            );
            if (prior === undefined) {
              const refunded = (await store.listCashRefundsByOrders(tx, [command.orderReference]))
                .filter((refund) => refund.settlementReference === settlement.settlementReference)
                .reduce((sum, refund) => sum + refund.amountMinor, 0n);
              if (refunded + command.amountMinor > settlement.totalMinor)
                return fail("TABLE_PAYMENT_TOO_MUCH");
            }
            const now = new Date(Date.parse(options.persistence.now())).toISOString();
            const recorded = await store.recordCashRefund(tx, {
              cashRefundReference: options.nextReference(),
              operationReference: command.operationReference,
              intentDigest,
              settlementReference: settlement.settlementReference,
              orderReference: command.orderReference,
              amountMinor: command.amountMinor,
              reasonCode: command.reasonCode,
              approvedByActorReference: String(authority.scope.actorReference),
              refundedAt: now,
              recordedAt: now,
              auditReference: options.nextReference(),
              correlationReference: command.operationReference,
            });
            return Object.freeze({
              status: recorded.status,
              ...(await view(tx, scope, command.orderReference, guard)),
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof TablePaymentError) throw error;
      if (
        error instanceof DiningTableSettlementStoreError &&
        error.code === "DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT"
      )
        return fail("TABLE_PAYMENT_IDEMPOTENCY_CONFLICT");
      return fail("TABLE_PAYMENT_UNAVAILABLE");
    }
  };
}
