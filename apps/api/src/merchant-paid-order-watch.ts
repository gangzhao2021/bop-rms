import type { ConsumerTransaction } from "@bop/eventing";
import {
  listStoreKitchenBatchTouches,
  loadKitchenScreenSeenAt,
  loadStoreLastKitchenStepAt,
} from "@rms/kitchen";
import {
  changeOrderAutoAcceptanceSetting,
  countStoreCantMakeRefundsSince,
  keepOrderAutoAcceptedPickup,
  listStoreOpenAutoAcceptedBatches,
  loadOrderAutoAcceptanceSetting,
  OrderAutoAcceptanceSettingConflictError,
  OrderAutoAcceptedKeepError,
} from "@rms/ordering";
import { readClosedRecord } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { readOrderAutoAcceptedPickupRefund } from "./order-auto-accepted-pickup-expiry.js";
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
  /**
   * A pickup closes and refunds at this time unless the kitchen marks it. Null: a table round, one
   * staff said they are making by hand, or the Store is offline past its time.
   */
  readonly refundAt: string | null;
  /** Staff said they are making it by hand (only when so). */
  readonly kept?: true;
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
  /** Off, but it was on in the last 24 hours: staff who stopped watching Orders are still told. */
  readonly recentlyOn: boolean;
  readonly settingVersion: number;
  readonly lastKitchenStepAt: string | null;
  /** When a kitchen board was last read here: a dead screen is said sooner than a busy cook. */
  readonly kitchenScreenSeenAt: string | null;
  /** "Can't make it" refunds in the last 24 hours, for the manager's closing list. */
  readonly cantMakeRefunds: number;
  readonly waiting: readonly PaidOrderWatchItem[];
}

const windowMs = 24 * 60 * 60_000;

/** Null at a Store that never turned it on: nothing about it reaches that Store's screens. */
export async function readPaidOrderWatch(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  observedAt: string,
): Promise<PaidOrderWatch | null> {
  const setting = await loadOrderAutoAcceptanceSetting(tx, scope);
  if (setting.version === 0) return null;
  const since = new Date(Date.parse(observedAt) - windowMs).toISOString();
  const batches = await listStoreOpenAutoAcceptedBatches(tx, scope, {
    since,
    limit: 200,
    newestFirst: true,
  });
  const on = setting.pickup.on || setting.dineIn.on;
  const touches = await listStoreKitchenBatchTouches(
    tx,
    scope,
    batches.map((batch) => batch.orderBatchReference),
  );
  const lastKitchenStepAt = await loadStoreLastKitchenStepAt(tx, scope, observedAt);
  const waiting: PaidOrderWatchItem[] = [];
  for (const batch of batches) {
    const touch = touches.get(batch.orderBatchReference);
    if (touch === "Touched") continue;
    const reachedKitchen = touch !== undefined;
    const refund =
      batch.orderType === "Pickup" && !batch.kept
        ? await readOrderAutoAcceptedPickupRefund(tx, scope, {
            acceptedAt: batch.acceptedAt,
            reachedKitchen,
            lastKitchenStepAt,
            observedAt,
          })
        : null;
    waiting.push(
      Object.freeze({
        orderNumber: batch.orderNumber,
        orderType: batch.orderType,
        acceptedAt: batch.acceptedAt,
        reachedKitchen,
        refundAt: refund?.refundAt ?? null,
        ...(batch.kept ? { kept: true as const } : {}),
      }),
    );
  }
  return Object.freeze({
    on,
    recentlyOn: !on && setting.changedAt !== null && setting.changedAt >= since,
    settingVersion: setting.version,
    lastKitchenStepAt,
    kitchenScreenSeenAt: await loadKitchenScreenSeenAt(tx, scope),
    cantMakeRefunds: await countStoreCantMakeRefundsSince(tx, scope, since),
    waiting: Object.freeze(waiting),
  });
}

/**
 * Refund times for a screen with no sign-in to read with (a registered Store tablet's re-check): the
 * untouched automatically accepted pickups, numbers and times only.
 */
export async function readPaidOrderRefundTimes(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  observedAt: string,
): Promise<
  readonly {
    readonly orderNumber: string;
    readonly acceptBy: string;
    readonly reachedKitchen: boolean;
  }[]
> {
  const watch = await readPaidOrderWatch(tx, scope, observedAt);
  return Object.freeze(
    (watch?.waiting ?? []).flatMap((item) =>
      item.refundAt === null
        ? []
        : [
            Object.freeze({
              orderNumber: item.orderNumber,
              acceptBy: item.refundAt,
              reachedKitchen: item.reachedKitchen,
            }),
          ],
    ),
  );
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

export type PaidOrderKeepErrorCode =
  | "PAID_ORDER_KEEP_INPUT_INVALID"
  | "PAID_ORDER_KEEP_DENIED"
  | "PAID_ORDER_KEEP_NOT_KEEPABLE"
  | "PAID_ORDER_KEEP_UNAVAILABLE";
export class PaidOrderKeepError extends Error {
  constructor(readonly code: PaidOrderKeepErrorCode) {
    super("paid order keep " + code);
    this.name = "PaidOrderKeepError";
  }
}

/**
 * "Making it by hand": for a pickup being made without the kitchen screen (a dead board, or a ticket
 * that never arrived), whoever can accept says so and the automatic refund stops. The first name is
 * the one recorded, on the record and in the audit; no money moves. Without this, the System would
 * give away food the guest may already have.
 */
export function createMerchantPaidOrderKeep(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
  nextReference(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const fail = (code: PaidOrderKeepErrorCode): never => {
    throw new PaidOrderKeepError(code);
  };
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{ readonly status: "Kept" | "AlreadyKept" }> => {
    const authenticated = await options.authentication.authorize(input);
    let orderReference: string, orderBatchReference: string;
    try {
      const raw = readClosedRecord(input.command, ["orderReference", "orderBatchReference"]);
      if (typeof raw.orderReference !== "string" || typeof raw.orderBatchReference !== "string")
        return fail("PAID_ORDER_KEEP_INPUT_INVALID");
      orderReference = raw.orderReference;
      orderBatchReference = raw.orderBatchReference;
    } catch (error) {
      if (error instanceof PaidOrderKeepError) throw error;
      return fail("PAID_ORDER_KEEP_INPUT_INVALID");
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
                "order.accept",
                authenticated.sessionReference,
              ).catch(() => fail("PAID_ORDER_KEEP_DENIED"));
              if ((await current.allowed()) !== true) return fail("PAID_ORDER_KEEP_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("PAID_ORDER_KEEP_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const status = await keepOrderAutoAcceptedPickup(
              tx as unknown as ConsumerTransaction,
              {
                brandReference: String(current.context.brand.brandReference),
                storeReference: String(current.store.storeReference),
              },
              {
                decisionReference: options.nextReference(),
                auditReference: options.nextReference(),
                orderReference,
                orderBatchReference,
                actorReference: String(current.actorReference),
                observedAt: new Date(Date.parse(options.now())).toISOString(),
              },
            );
            return Object.freeze({ status });
          },
        ),
      );
    } catch (error) {
      if (error instanceof PaidOrderKeepError) throw error;
      if (error instanceof OrderAutoAcceptedKeepError) return fail("PAID_ORDER_KEEP_NOT_KEEPABLE");
      const code = (error as { code?: unknown } | null)?.code;
      // Being changed by someone else right now: staff look again.
      if (code === "40P01" || code === "40001" || code === "55P03")
        return fail("PAID_ORDER_KEEP_NOT_KEEPABLE");
      return fail("PAID_ORDER_KEEP_UNAVAILABLE");
    }
  };
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
