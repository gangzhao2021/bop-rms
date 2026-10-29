import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningSessionReadStore,
  loadDiningPartySizes,
  loadDiningTeaChargeSetting,
  parseDiningReference,
} from "@rms/dining";
import { listOrderSkuLines } from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { readDiningTableBill, scopeOf } from "./merchant-dining-table-checkout.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantDiningTeaChargeErrorCode =
  | "DINING_TEA_CHARGE_INPUT_INVALID"
  | "DINING_TEA_CHARGE_PERMISSION_DENIED"
  | "DINING_TEA_CHARGE_UNAVAILABLE";
export class MerchantDiningTeaChargeError extends Error {
  constructor(readonly code: MerchantDiningTeaChargeErrorCode) {
    super("dining tea charge " + code);
    this.name = "MerchantDiningTeaChargeError";
  }
}
const fail = (code: MerchantDiningTeaChargeErrorCode): never => {
  throw new MerchantDiningTeaChargeError(code);
};

/** What the table's tea charge is now (after a sync, what it became). */
export interface DiningTeaChargeView {
  readonly status:
    /** Tea charged for every guest counted. */
    | "Charged"
    /** The Store has no tea charge. */
    | "NoTeaCharge"
    /** This table pays each round: no tea is added (known limit, WP-2423). */
    | "PaysEachRound"
    /** No party size recorded yet. */
    | "NoPartySize"
    /** The table already paid (or was written off): a change is a refund or adjustment. */
    | "Paid"
    /** The tea on the bill doesn't match: adding or taking off didn't go through. */
    | "Mismatch";
  /** Tea charged now (servings on the bill). */
  readonly charged: number;
  /** Guests to charge (the party size). */
  readonly expected: number | null;
  /** Why it didn't match, when a step was refused. */
  readonly problem: "NeedsManager" | "Unavailable" | null;
}

type Step = (input: {
  sessionCookie: unknown;
  csrf: unknown;
  command: Record<string, unknown>;
}) => Promise<unknown>;

/** A stable operation reference for one step of a sync (a retry repeats, never adds). */
function stepReference(base: string, purpose: string): string {
  const digest = createHash("sha256")
    .update("tea-charge:" + base + ":" + purpose)
    .digest("hex");
  return (
    base.slice(0, 8) +
    "-" +
    digest.slice(0, 4) +
    "-7" +
    digest.slice(4, 7) +
    "-8" +
    digest.slice(7, 10) +
    "-" +
    digest.slice(10, 22)
  );
}

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2, coordinator 2026-10-29): the
 * per-head tea charge follows the party size at a table that pays at the end, until it pays.
 * "Read" says where it stands; "Sync" (after staff recorded the party size) adds the missing tea as
 * a staff round — attributed to the staff member — or takes tea off with "guests left", newest
 * lines first and the original lines kept with the record of who took them off and when (then the
 * difference is added back). Every step has an operation reference fixed by the sync's own, so a
 * retry repeats rather than adds; a step refused (a server may not take dishes off) leaves the
 * table showing the mismatch for a manager. A paid table's tea changes by refund or adjustment.
 */
export function createMerchantDiningTeaCharge(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
  /** The staff dine-in round command (adds tea to the table's order). */
  placeRound: Step;
  /** Taking unpaid dishes off a table's bill (pay-later item cancellation). */
  removeItems: Step;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const read = (sessionCookie: unknown, diningSessionReference: string) =>
    options.persistence.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(tx, sessionCookie, "dining.operate").catch(() =>
              fail("DINING_TEA_CHARGE_PERMISSION_DENIED"),
            );
            if ((await current.allowed()) !== true)
              return fail("DINING_TEA_CHARGE_PERMISSION_DENIED");
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied: () => fail("DINING_TEA_CHARGE_PERMISSION_DENIED"),
        },
        async (authority) => {
          const scope = scopeOf(authority.scope);
          const runner = tx as unknown as Parameters<typeof loadDiningTeaChargeSetting>[0];
          const setting = await loadDiningTeaChargeSetting(runner, scope);
          const [session] = await createPostgresDiningSessionReadStore(
            { run: (work) => work(tx as never) },
            scope,
          ).loadSessions([diningSessionReference]);
          if (session === undefined || session === null)
            return fail("DINING_TEA_CHARGE_INPUT_INVALID");
          const bill = await readDiningTableBill(tx as unknown as ConsumerTransaction, scope, {
            diningSessionReference,
            observedAt: new Date(Date.parse(options.now())).toISOString(),
            authorize: () => authority.guard(),
          });
          const party = (await loadDiningPartySizes(runner, scope, [diningSessionReference])).get(
            diningSessionReference,
          );
          const tea = setting.teaSellableReference;
          const order =
            tea === null || bill.orderReference === null
              ? { orderVersion: 0, lines: [] }
              : await listOrderSkuLines(tx as unknown as ConsumerTransaction, scope, {
                  orderReference: bill.orderReference,
                  sellableReference: tea,
                });
          return Object.freeze({
            tea,
            tableReference: String(session.tableReference),
            payLater: bill.paymentTiming === "PayLater",
            paid: bill.settlement !== null || bill.writeOff !== null,
            orderReference: bill.orderReference,
            orderVersion: order.orderVersion,
            open: order.lines.filter((line) => !line.takenOff),
            expected: party?.partySize ?? null,
          });
        },
      ),
    );
  const viewOf = (
    state: Awaited<ReturnType<typeof read>>,
    problem: DiningTeaChargeView["problem"] = null,
  ): DiningTeaChargeView => {
    const charged = state.open.reduce((sum, line) => sum + line.quantity, 0);
    return Object.freeze({
      status:
        state.tea === null
          ? "NoTeaCharge"
          : !state.payLater
            ? "PaysEachRound"
            : state.expected === null
              ? "NoPartySize"
              : state.paid
                ? "Paid"
                : charged === state.expected
                  ? "Charged"
                  : "Mismatch",
      charged,
      expected: state.expected,
      problem,
    });
  };
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<DiningTeaChargeView> => {
    await options.authentication.authorize(input);
    let command: { action: "Read" | "Sync"; session: string; operation: string | null };
    try {
      const action =
        input.command !== null && typeof input.command === "object"
          ? Object.getOwnPropertyDescriptor(input.command, "action")?.value
          : undefined;
      const raw = readClosedRecord(
        input.command,
        action === "Sync"
          ? ["action", "diningSessionReference", "operationReference"]
          : ["action", "diningSessionReference"],
      );
      if (raw.action !== "Read" && raw.action !== "Sync") throw new Error();
      command = {
        action: raw.action,
        session: String(parseDiningReference(raw.diningSessionReference)),
        operation:
          raw.action === "Sync" ? String(parseDiningReference(raw.operationReference)) : null,
      };
    } catch {
      return fail("DINING_TEA_CHARGE_INPUT_INVALID");
    }
    try {
      let state = await read(input.sessionCookie, command.session);
      if (command.action === "Read") return viewOf(state);
      const base = command.operation as string;
      const target = state.expected;
      if (state.tea === null || !state.payLater || target === null || state.paid)
        return viewOf(state);
      let problem: DiningTeaChargeView["problem"] = null;
      const step = async (run: () => Promise<unknown>) => {
        try {
          await run();
          return true;
        } catch (error) {
          problem = /PERMISSION_DENIED/u.test(String((error as { code?: unknown })?.code))
            ? "NeedsManager"
            : "Unavailable";
          return false;
        }
      };
      // Fewer guests: take tea lines off (newest first) until no more than the guests are charged.
      let charged = state.open.reduce((sum, line) => sum + line.quantity, 0);
      for (const line of [...state.open].reverse()) {
        if (charged <= target) break;
        const done = await step(() =>
          options.removeItems({
            sessionCookie: input.sessionCookie,
            csrf: input.csrf,
            command: {
              orderReference: state.orderReference,
              orderBatchReference: line.orderBatchReference,
              orderItemReferences: [line.orderItemReference],
              expectedOrderVersion: state.orderVersion,
              operationReference: stepReference(base, "remove:" + line.orderItemReference),
              reasonCode: "GUEST_LEFT",
            },
          }),
        );
        if (!done) break;
        state = await read(input.sessionCookie, command.session);
        charged = state.open.reduce((sum, item) => sum + item.quantity, 0);
      }
      // More guests (or what a removed line held beyond the guests): add the difference.
      if (problem === null && charged < target)
        await step(() =>
          options.placeRound({
            sessionCookie: input.sessionCookie,
            csrf: input.csrf,
            command: {
              operationReference: stepReference(base, "add:" + charged + ":" + target),
              tableReference: state.tableReference,
              lines: [
                {
                  sellableReference: state.tea,
                  quantity: target - charged,
                  optionSelections: [],
                  note: null,
                },
              ],
              tip: { kind: "None" },
              recordedAfterOutage: false,
            },
          }),
        );
      return viewOf(await read(input.sessionCookie, command.session), problem);
    } catch (error) {
      if (error instanceof MerchantDiningTeaChargeError) throw error;
      throw new MerchantDiningTeaChargeError("DINING_TEA_CHARGE_UNAVAILABLE");
    }
  };
}
