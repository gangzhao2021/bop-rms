import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  changeDiningRoundHoldSetting,
  DiningSessionError,
  loadDiningRoundHoldSetting,
} from "@rms/dining";
import { createPostgresOrderRoundStaffHoldStore, parseOrderingReference } from "@rms/ordering";
import type { createDiningBatchCancellation } from "./dining-batch-cancellation.js";
import type { DiningPayLaterRound } from "./dining-pay-later-round.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantDiningHeldRoundErrorCode =
  | "HELD_ROUND_INPUT_INVALID"
  | "HELD_ROUND_PERMISSION_DENIED"
  | "HELD_ROUND_NOT_WAITING"
  /** The setting changed since it was read: read it again. */
  | "HELD_ROUND_CHANGED"
  | "HELD_ROUND_UNAVAILABLE";
export class MerchantDiningHeldRoundError extends Error {
  constructor(readonly code: MerchantDiningHeldRoundErrorCode) {
    super("held round " + code);
    this.name = "MerchantDiningHeldRoundError";
  }
}
const fail = (code: MerchantDiningHeldRoundErrorCode): never => {
  throw new MerchantDiningHeldRoundError(code);
};

export function parseMerchantDiningHeldRoundCommand(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "action",
      "orderReference",
      "orderBatchReference",
      "operationReference",
    ]);
    if (raw.action !== "Confirm" && raw.action !== "Cancel")
      return fail("HELD_ROUND_INPUT_INVALID");
    return Object.freeze({
      action: raw.action,
      orderReference: String(parseOrderingReference(raw.orderReference)),
      orderBatchReference: String(parseOrderingReference(raw.orderBatchReference)),
      operationReference: String(parseOrderingReference(raw.operationReference)),
    });
  } catch {
    return fail("HELD_ROUND_INPUT_INVALID");
  }
}

/**
 * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN decisions 5–7: staff decide a guest round that waits for
 * them (Tables "needs action"). "Send to kitchen" records the release under the staff member and
 * sends the round as any pay-later round (its acceptance, confirmation and OrderConfirmed for the
 * kitchen). "Cancel this round" records the release and cancels the round with the existing unpaid
 * round cancellation (nothing was paid or made, so nothing is refunded; never sales). One
 * transaction each; the same operation again returns the same outcome. Staff who run tables
 * (`dining.operate`) decide; only a round still waiting can be decided this way.
 */
export function createMerchantDiningHeldRound(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  payLater(selected: {
    tenantReference: string;
    brandReference: string;
    storeReference: string;
  }): DiningPayLaterRound;
  cancellation: Pick<ReturnType<typeof createDiningBatchCancellation>, "cancelUnpaidForStaff">;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{ readonly status: "Sent" | "Cancelled" }> => {
    const authenticated = await options.authentication.authorize(input);
    const command = parseMerchantDiningHeldRoundCommand(input.command);
    try {
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                "dining.operate",
                authenticated.sessionReference,
              ).catch(() => fail("HELD_ROUND_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true) return fail("HELD_ROUND_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("HELD_ROUND_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const allowed = () => authority.guard();
            const selected = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const consumer = tx as unknown as ConsumerTransaction;
            await consumer.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [selected.tenantReference, selected.brandReference, selected.storeReference],
            );
            const actorReference = String(current.actorReference);
            const holds = createPostgresOrderRoundStaffHoldStore({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              authorize: async (candidate) => candidate === consumer && (await allowed()),
            });
            const hold = await holds.load({
              transaction: consumer,
              orderReference: command.orderReference,
              orderBatchReference: command.orderBatchReference,
            });
            if (hold === null) return fail("HELD_ROUND_NOT_WAITING");
            const outcome = command.action === "Confirm" ? "Confirmed" : "Cancelled";
            if (hold.release !== null && hold.release.outcome !== outcome)
              return fail("HELD_ROUND_NOT_WAITING");
            await holds.release({
              transaction: consumer,
              operationReference: command.operationReference,
              orderReference: command.orderReference,
              orderBatchReference: command.orderBatchReference,
              outcome,
              actorReference,
              observedAt: new Date(Date.parse(options.now())).toISOString(),
            });
            const authorize = async (candidate: ConsumerTransaction) =>
              candidate === consumer && (await allowed());
            if (command.action === "Confirm") {
              await options.payLater(selected).confirm(consumer, {
                submissionReference: hold.submissionReference,
                actorReference,
                operationReference: command.operationReference,
                correlationReference: command.operationReference,
                authorize,
              });
              return Object.freeze({ status: "Sent" as const });
            }
            const cancelled = await options.cancellation.cancelUnpaidForStaff(consumer, {
              operationReference: command.operationReference,
              orderReference: command.orderReference,
              orderBatchReference: command.orderBatchReference,
              actorReference,
              authorize: async () => allowed(),
            });
            if (cancelled.status === "NotEligible") return fail("HELD_ROUND_NOT_WAITING");
            return Object.freeze({ status: "Cancelled" as const });
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantDiningHeldRoundError) throw error;
      throw new MerchantDiningHeldRoundError("HELD_ROUND_UNAVAILABLE");
    }
  };
}

/**
 * WP-2423 item 8 ⑤ decision 5: the Store's "a new phone's first round waits for staff" (tables
 * that pay at the end; off until a manager turns it on). Anyone running tables reads it; a manager
 * (`dining.session.close`) changes it, each change the next recorded version.
 */
export function createMerchantDiningRoundHoldSetting(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{
    readonly version: number;
    readonly firstRoundNeedsStaff: boolean;
    readonly canChange: boolean;
  }> => {
    const authenticated = await options.authentication.authorize(input);
    let change: null | {
      operationReference: string;
      expectedVersion: number;
      firstRoundNeedsStaff: boolean;
    } = null;
    try {
      const action =
        input.command !== null && typeof input.command === "object"
          ? Object.getOwnPropertyDescriptor(input.command, "action")?.value
          : undefined;
      if (action === "Read") readClosedRecord(input.command, ["action"]);
      else {
        const raw = readClosedRecord(input.command, [
          "action",
          "operationReference",
          "expectedVersion",
          "firstRoundNeedsStaff",
        ]);
        if (
          raw.action !== "Change" ||
          typeof raw.firstRoundNeedsStaff !== "boolean" ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0
        )
          return fail("HELD_ROUND_INPUT_INVALID");
        change = {
          operationReference: String(parseOrderingReference(raw.operationReference)),
          expectedVersion: Number(raw.expectedVersion),
          firstRoundNeedsStaff: raw.firstRoundNeedsStaff,
        };
      }
    } catch {
      return fail("HELD_ROUND_INPUT_INVALID");
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
                "dining.operate",
                authenticated.sessionReference,
              ).catch(() => fail("HELD_ROUND_PERMISSION_DENIED"));
              const decisions = await current.authorizeActions([
                "dining.operate",
                "dining.session.close",
              ]);
              if (decisions.get("dining.operate")?.effect !== "Allow")
                return fail("HELD_ROUND_PERMISSION_DENIED");
              return {
                current,
                canChange: decisions.get("dining.session.close")?.effect === "Allow",
              };
            },
            recheck: async ({ current }) => (await current.allowed()) === true,
            denied: () => fail("HELD_ROUND_PERMISSION_DENIED"),
          },
          async (authority) => {
            const { current, canChange } = authority.scope;
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const runner = tx as unknown as Parameters<typeof loadDiningRoundHoldSetting>[0];
            let setting = await loadDiningRoundHoldSetting(runner, scope);
            if (change !== null) {
              if (!canChange) return fail("HELD_ROUND_PERMISSION_DENIED");
              setting = await changeDiningRoundHoldSetting(runner, scope, {
                ...change,
                actorReference: String(current.actorReference),
                observedAt: new Date(Date.parse(options.now())).toISOString(),
              });
            }
            return Object.freeze({
              version: setting.version,
              firstRoundNeedsStaff: setting.firstRoundNeedsStaff,
              canChange,
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantDiningHeldRoundError) throw error;
      if (
        error instanceof DiningSessionError &&
        error.code === "DINING_SESSION_IDEMPOTENCY_CONFLICT"
      )
        throw new MerchantDiningHeldRoundError("HELD_ROUND_CHANGED");
      throw new MerchantDiningHeldRoundError("HELD_ROUND_UNAVAILABLE");
    }
  };
}
