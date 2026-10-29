import { staffNameLocales } from "./staff-content-locale.js";
import { readStoreFeatures } from "./merchant-store-features.js";
import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresFulfillmentReadinessStore,
  parseReadinessReference,
  FulfillmentReadinessError,
} from "@rms/fulfillment";
import {
  createPostgresStaffOrderCancellationReader,
  listStoreCounterOrders,
  listStoreOrderBusinessDates,
  listStoreOrderNumbers,
  loadMerchantOrderLines,
} from "@rms/ordering";
import { listOpenKitchenReworkItems } from "@rms/kitchen";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { runMerchantSnapshotRead } from "./merchant-snapshot-read.js";
type StoreOptions = Parameters<typeof createPostgresFulfillmentReadinessStore>[0];
function invalid(): never {
  throw new FulfillmentReadinessError("FULFILLMENT_READINESS_INPUT_INVALID");
}
export function createMerchantPickupQuery(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  store: Pick<StoreOptions, "sha256" | "validateCurrentSource">;
  /** The language item names are shown in (the Orders page's default when not configured). */
  locale?: string;
  /** Configured workstation for this authenticated session; not completion authority. */
  resolveWorkstation?(
    transaction: ConsumerTransaction,
    context: {
      actorReference: string;
      sessionReference: string;
      brandReference: string;
      storeReference: string;
    },
  ): Promise<{ deviceReference: string; pickupLocationReference: string } | null>;

  installContext(
    transaction: ConsumerTransaction,
    scope: { brandReference: string; storeReference: string },
  ): Promise<void>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const session = await options.authentication.authorize(input);
    let raw: Readonly<Record<string, unknown>>;
    try {
      raw = readClosedRecord(input.query, [
        "afterFulfillmentReference",
        "limit",
        "includeCompleted",
      ]);
    } catch {
      return invalid();
    }
    const afterFulfillmentReference =
      raw.afterFulfillmentReference === null
        ? null
        : parseReadinessReference(raw.afterFulfillmentReference);
    if (
      typeof raw.limit !== "number" ||
      !Number.isSafeInteger(raw.limit) ||
      raw.limit < 1 ||
      raw.limit > 50 ||
      typeof raw.includeCompleted !== "boolean"
    )
      return invalid();
    const limit = raw.limit,
      includeCompleted = raw.includeCompleted;
    const denied = (): never => {
      throw new FulfillmentReadinessError("FULFILLMENT_READINESS_PERMISSION_DENIED");
    };
    // WP-2423 (v15 2026-10-18, 55P03): the pickup queue is polled by every pickup screen; it reads
    // one snapshot and takes no Order fence or pickup lock, so it never waits for or holds up a
    // handoff, a cancellation or another screen's read (snapshot-read).
    return runMerchantSnapshotRead(options.persistence.transactions, (transaction) =>
      // WP-2423: the caller is resolved in full at the start and once before the reply; the owner
      // reads in between only confirm they run in this authorized transaction.
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const scope = await resolveScope(
              transaction,
              input.sessionCookie,
              "fulfillment.operate",
              session.sessionReference,
            );
            if (!(await scope.allowed())) return denied();
            return scope;
          },
          recheck: async (scope) => (await scope.allowed()) === true,
          denied,
        },
        (authority) => read(transaction, authority),
      ),
    );
    async function read(
      transaction: Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0],
      authority: MerchantTransactionAuthority<Awaited<ReturnType<typeof resolveScope>>>,
    ) {
      const scope = authority.scope;
      const tx: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await transaction.query(sql, values);
          if (!result || typeof result !== "object") return invalid();
          const rows = Object.getOwnPropertyDescriptor(result, "rows"),
            count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
          )
            return invalid();
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };

      const selected = {
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
      };
      await options.installContext(tx, selected);
      const store = createPostgresFulfillmentReadinessStore({
        ...options.store,
        ...selected,
        now: options.persistence.now,
        authorizeQueue: () => authority.guard(),
        authorize: async (_tx, access) => access.access === "Current" && (await authority.guard()),
      });
      const result = await store.listPickupQueue({
        transaction: tx,
        afterFulfillmentReference,
        limit,
        includeCompleted,
      });
      const configured = options.resolveWorkstation
        ? await options.resolveWorkstation(tx, {
            ...selected,
            actorReference: scope.actorReference,
            sessionReference: session.sessionReference,
          })
        : null;
      const workstation =
        configured === null
          ? null
          : Object.freeze({
              deviceReference: parseReadinessReference(configured.deviceReference),
              pickupLocationReference: parseReadinessReference(configured.pickupLocationReference),
            });
      // The order number staff call out and customers see (WP-2423).
      const numbers = await listStoreOrderNumbers(
        tx,
        selected,
        result.items.map((item) => String(item.orderReference)),
      );
      // WP-2423 Q26: the business day of each order (numbers restart daily), so an earlier day's
      // order is never mistaken for today's order with the same number.
      const businessDates = await listStoreOrderBusinessDates(
        tx,
        selected,
        result.items.map((item) => String(item.orderReference)),
      );
      // WP-2423: orders staff took at the counter get no guest pickup code; staff hand them over
      // in person by name or order number as soon as they are ready (Ordering's own read).
      const counterOrders = await listStoreCounterOrders(
        tx,
        selected,
        result.items.map((item) => String(item.orderReference)),
      );
      // WP-2423 Q6: an order the Store cancelled before the kitchen started is never handed over.
      const cancelled = new Set(
        result.items.length === 0
          ? []
          : (
              await createPostgresStaffOrderCancellationReader(selected).listByOrders(
                tx,
                result.items.map((item) => String(item.orderReference)),
              )
            ).map((record) => String(record.orderReference)),
      );
      // WP-2423 Q26: a dish the kitchen is remaking (dropped, wrong, marked done too early) is
      // flagged so staff wait before handing the order over. Kitchen's public Query, matched on the
      // Order and on this pickup's own Order items (never on the order number, which repeats daily).
      const remakes = await listOpenKitchenReworkItems(tx, selected, [
        ...new Set(result.items.map((item) => String(item.orderReference))),
      ]);
      const remakeQuantity = (item: (typeof result.items)[number]) => {
        const lines = new Set(item.items.map((line) => String(line.orderItemReference)));
        return remakes
          .filter(
            (remake) =>
              remake.orderReference === String(item.orderReference) &&
              lines.has(remake.orderItemReference),
          )
          .reduce((sum, remake) => sum + remake.openQuantity, 0);
      };
      // WP-2423: what staff hand over, by name: Ordering's own read of each order's immutable item
      // snapshots (the Orders page's order detail), only for pickups still to be handed over.
      const lineLabels = new Map<
        string,
        { readonly name: string; readonly options: readonly { name: string; quantity: number }[] }
      >();
      for (const order of new Set(
        result.items
          .filter(
            (item) => item.phase !== "Completed" && !cancelled.has(String(item.orderReference)),
          )
          .map((item) => String(item.orderReference)),
      )) {
        // A snapshot that can't be read leaves that order's items unnamed ("Item 1"), never the
        // whole queue unavailable: staff can still match the order ticket.
        const lines = await loadMerchantOrderLines(
          tx,
          selected,
          order,
          staffNameLocales(options.locale ?? "en-CA"),
        ).catch(() => null);
        for (const line of lines?.items ?? [])
          if (line.name.length > 0)
            lineLabels.set(
              line.orderItemReference,
              Object.freeze({
                name: line.name,
                options: Object.freeze(
                  line.options.map((option) =>
                    Object.freeze({ name: option.name, quantity: option.quantity }),
                  ),
                ),
              }),
            );
      }
      // WP-2423 item 8 ⑦ (v15 finding v): guests' pickup ordering is off; staff still hand over
      // the orders already placed here. Unreadable: not said.
      const features = await readStoreFeatures(
        tx,
        {
          brandReference: String(selected.brandReference),
          storeReference: String(selected.storeReference),
        },
        "AllModules",
      );
      return Object.freeze({
        ...result,
        workstation,
        storeReference: selected.storeReference,
        guestPickupOff: !features.pickup,
        items: result.items
          .filter((item) => !cancelled.has(String(item.orderReference)))
          .map((item) =>
            Object.freeze({
              ...item,
              aggregateVersion: item.aggregateVersion.toString(),
              orderNumber: numbers.get(String(item.orderReference)) ?? null,
              businessDate: businessDates.get(String(item.orderReference)) ?? null,
              remakeInProgress: remakeQuantity(item),
              takenAtCounter: counterOrders.has(String(item.orderReference)),
              // Order items are only for matching remakes; the pickup screen's contract omits them.
              items: item.items.map((line) => {
                const label =
                  line.orderItemReference === undefined
                    ? undefined
                    : lineLabels.get(String(line.orderItemReference));
                return Object.freeze({
                  fulfillmentItemReference: line.fulfillmentItemReference,
                  orderedQuantity: line.orderedQuantity,
                  readyQuantity: line.readyQuantity,
                  handedOverQuantity: line.handedOverQuantity,
                  // WP-2423: the item's name and options, so staff match what they hand over.
                  ...(label === undefined ? {} : { name: label.name, options: label.options }),
                });
              }),
            }),
          ),
      });
    }
  };
}

/**
 * WP-2423 item 8 ⑦ (v15 finding v): how many pickup orders Fulfillment's current pickup queue
 * still has to hand over (the Pickup page's own read, without handed-over orders), inside another
 * read (the workspace's navigation), in a savepoint that restores the Brand and Store context it
 * changes. Only the number leaves; null when it cannot be read. The caller has authorized the
 * Store; this read names no order.
 */
export async function waitingPickupOrders(
  transaction: { query(sql: string, values: readonly unknown[]): Promise<unknown> },
  options: Pick<StoreOptions, "sha256" | "validateCurrentSource" | "now"> & {
    readonly brandReference: string;
    readonly storeReference: string;
  },
): Promise<number | null> {
  const tx: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      const result = (await transaction.query(sql, values)) as {
        rows: readonly Row[];
        rowCount: number | null;
      };
      return { rows: result.rows, rowCount: result.rowCount ?? null };
    },
  };
  const before = (
    (await transaction.query(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )) as { rows: { brand: string | null; store: string | null }[] }
  ).rows[0];
  await transaction.query("SAVEPOINT waiting_pickup_orders", []);
  try {
    const store = createPostgresFulfillmentReadinessStore({
      ...options,
      authorizeQueue: async () => true,
      authorize: async () => true,
    });
    let after: string | null = null;
    let count = 0;
    for (let page = 0; page < 20; page++) {
      const result = await store.listPickupQueue({
        transaction: tx,
        afterFulfillmentReference: after,
        limit: 50,
        includeCompleted: false,
      });
      count += result.items.length;
      if (result.nextAfterFulfillmentReference === null) {
        await transaction.query("RELEASE SAVEPOINT waiting_pickup_orders", []);
        return count;
      }
      after = result.nextAfterFulfillmentReference;
    }
    await transaction.query("RELEASE SAVEPOINT waiting_pickup_orders", []);
    return null;
  } catch {
    await transaction.query("ROLLBACK TO SAVEPOINT waiting_pickup_orders", []);
    await transaction.query("RELEASE SAVEPOINT waiting_pickup_orders", []);
    return null;
  } finally {
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [before?.brand ?? "", before?.store ?? ""],
    );
  }
}
