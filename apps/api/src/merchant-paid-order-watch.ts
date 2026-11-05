import type { ConsumerTransaction } from "@bop/eventing";
import { listStoreKitchenBatchTouches, loadStoreLastKitchenStepAt } from "@rms/kitchen";
import {
  changeOrderAutoAcceptanceSetting,
  countStoreCantMakeRefundsSince,
  listStoreOpenAutoAcceptedBatches,
  loadOrderAutoAcceptanceSetting,
  orderAutoAcceptedPickupRefundAt,
  OrderAutoAcceptanceSettingConflictError,
} from "@rms/ordering";
import { readClosedRecord } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** One automatically accepted batch the kitchen has not touched. Never a Customer's details. */
export interface PaidOrderWatchItem {
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly acceptedAt: string;
  /** False: no ticket and no preparation decision, so its kitchen delivery failed or is late. */
  readonly reachedKitchen: boolean;
  /** A pickup closes and refunds at this time unless the kitchen starts it (null: a table round). */
  readonly refundAt: string | null;
}

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: what every screen needs to warn that a paid order is going
 * nowhere. It starts from Ordering's automatically accepted batches and takes away what Kitchen has
 * touched, so a batch that never got a ticket is seen too. Whether to raise anything is the screen's
 * (one Store-level alarm, by time); a busy kitchen working other tickets raises nothing.
 */
export interface PaidOrderWatch {
  /** The switch is on for at least one order type. */
  readonly on: boolean;
  readonly settingVersion: number;
  readonly lastKitchenStepAt: string | null;
  /** "Can't make it" refunds in the last 24 hours, for the manager's closing list. */
  readonly cantMakeRefunds: number;
  readonly waiting: readonly PaidOrderWatchItem[];
}

const windowMs = 24 * 60 * 60_000;

/** Null at a Store that never turned it on, or has nothing left from when it was on. */
export async function readPaidOrderWatch(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  observedAt: string,
): Promise<PaidOrderWatch | null> {
  const setting = await loadOrderAutoAcceptanceSetting(tx, scope);
  if (setting.version === 0) return null;
  const since = new Date(Date.parse(observedAt) - windowMs).toISOString();
  const batches = await listStoreOpenAutoAcceptedBatches(tx, scope, { since, limit: 200 });
  const on = setting.pickup.on || setting.dineIn.on;
  if (!on && batches.length === 0) return null;
  const touches = await listStoreKitchenBatchTouches(
    tx,
    scope,
    batches.map((batch) => batch.orderBatchReference),
  );
  return Object.freeze({
    on,
    settingVersion: setting.version,
    lastKitchenStepAt: await loadStoreLastKitchenStepAt(tx, scope, observedAt),
    cantMakeRefunds: await countStoreCantMakeRefundsSince(tx, scope, since),
    waiting: Object.freeze(
      batches
        .filter((batch) => touches.get(batch.orderBatchReference) !== "Touched")
        .map((batch) =>
          Object.freeze({
            orderNumber: batch.orderNumber,
            orderType: batch.orderType,
            acceptedAt: batch.acceptedAt,
            reachedKitchen: touches.has(batch.orderBatchReference),
            refundAt:
              batch.orderType === "Pickup" ? orderAutoAcceptedPickupRefundAt(batch.acceptedAt) : null,
          }),
        ),
    ),
  });
}

export type PaidOrderAutoAcceptOffErrorCode =
  | "PAID_ORDER_AUTO_ACCEPT_INPUT_INVALID"
  | "PAID_ORDER_AUTO_ACCEPT_DENIED"
  | "PAID_ORDER_AUTO_ACCEPT_CHANGED"
  | "PAID_ORDER_AUTO_ACCEPT_UNAVAILABLE";
export class PaidOrderAutoAcceptOffError extends Error {
  constructor(readonly code: PaidOrderAutoAcceptOffErrorCode) {
    super("paid order auto accept " + code);
    this.name = "PaidOrderAutoAcceptOffError";
  }
}

/**
 * The brake on a busy night: whoever may pause ordering may turn automatic sending off, from Orders
 * or Tables. It can only turn off; turning it on stays the owner's, on Store features. The same
 * append-only versions record who.
 */
export function createMerchantPaidOrderAutoAcceptOff(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const fail = (code: PaidOrderAutoAcceptOffErrorCode): never => {
    throw new PaidOrderAutoAcceptOffError(code);
  };
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{ readonly version: number }> => {
    const authenticated = await options.authentication.authorize(input);
    let operationReference: string, expectedVersion: number;
    try {
      const raw = readClosedRecord(input.command, ["operationReference", "expectedVersion"]);
      if (
        typeof raw.operationReference !== "string" ||
        !Number.isSafeInteger(raw.expectedVersion) ||
        Number(raw.expectedVersion) < 1
      )
        return fail("PAID_ORDER_AUTO_ACCEPT_INPUT_INVALID");
      operationReference = raw.operationReference;
      expectedVersion = Number(raw.expectedVersion);
    } catch (error) {
      if (error instanceof PaidOrderAutoAcceptOffError) throw error;
      return fail("PAID_ORDER_AUTO_ACCEPT_INPUT_INVALID");
    }
    try {
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                "store.service.pause",
                authenticated.sessionReference,
              ).catch(() => fail("PAID_ORDER_AUTO_ACCEPT_DENIED"));
              if ((await current.allowed()) !== true) return fail("PAID_ORDER_AUTO_ACCEPT_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("PAID_ORDER_AUTO_ACCEPT_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const next = await changeOrderAutoAcceptanceSetting(
              tx as unknown as ConsumerTransaction,
              {
                tenantReference: String(current.selected.tenantReference),
                brandReference: String(current.context.brand.brandReference),
                storeReference: String(current.store.storeReference),
              },
              {
                operationReference,
                expectedVersion,
                pickup: false,
                dineIn: false,
                actorReference: String(current.actorReference),
                observedAt: new Date(Date.parse(options.now())).toISOString(),
              },
            );
            return Object.freeze({ version: next.version });
          },
        ),
      );
    } catch (error) {
      if (error instanceof PaidOrderAutoAcceptOffError) throw error;
      if (error instanceof OrderAutoAcceptanceSettingConflictError)
        return fail("PAID_ORDER_AUTO_ACCEPT_CHANGED");
      return fail("PAID_ORDER_AUTO_ACCEPT_UNAVAILABLE");
    }
  };
}
