import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  buildKdsContinuityState,
  createKitchenQueueProjectionService,
  createPostgresKitchenQueueQueries,
  lockPostgresKitchenQueueRead,
  KitchenQueueProjectionError,
  kitchenStaleTicketClosePermission,
  listClosedKitchenTickets,
  listKitchenWorkChases,
  listKitchenWorkItemPreparationFacts,
  type KitchenQueueItemView,
} from "@rms/kitchen";
import {
  allergenDisclosureForChoice,
  listPublishedSellableAllergenDisclosures,
  sellableDisclosureKey,
} from "@rms/catalog";
import {
  createPostgresCounterOrderEntryStore,
  createPostgresStaffDiningRoundEntryStore,
  listStoreKitchenOrderLabels,
  listStoreOrderBusinessDates,
  listStoreOrdersAwaitingAcceptance,
} from "@rms/ordering";
import { listDiningSessionMovedFrom, listDiningSessionTableLabels } from "@rms/dining";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  createMerchantRoundBusinessDates,
  withOptionalRead,
} from "./merchant-round-business-date.js";
import { createMerchantBusinessDayWindows } from "./merchant-business-day-window.js";
import { comboPartsByOrderItem, type ComboPart } from "./merchant-combo-parts.js";
import { readPickupRefundDeadlines } from "./pickup-acceptance-deadline.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const unavailable = async (): Promise<never> => {
  throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
};
type OperatorStatus = "Named" | "Locked" | "Unavailable" | "Unverified";
interface ProjectionMetadata {
  projectionGenerationReference: string;
  sourceCheckpointReference: string;
  freshnessStatus: "Fresh" | "Stale";
  asOfUtc: string;
}

/** IDR-0039 named-operator browser KDS: only a current NamedKdsOperator Session can operate.
 * Kitchen owns the continuity decision; projection staleness stays a separate UI gate. */
export function kdsOperatorStatus(input: {
  session: Awaited<ReturnType<MerchantBffService["authorize"]>>;
  actorReference: string;
  brandReference: string;
  storeReference: string;
  observedAt: string;
  projection: ProjectionMetadata;
}): OperatorStatus {
  const { session } = input;
  if (session?.policy?.code !== "NamedKdsOperator") return "Unverified";
  try {
    const validUntil =
      Date.parse(session.idleExpiresAt) < Date.parse(session.absoluteExpiresAt)
        ? session.idleExpiresAt
        : session.absoluteExpiresAt;
    const state = buildKdsContinuityState({
      session: {
        sessionReference: session.sessionReference,
        actorReference: input.actorReference,
        brandReference: input.brandReference,
        storeReference: input.storeReference,
        sessionVersion: session.version,
        sessionKind: "NamedKdsOperator",
        state: session.status === "Active" ? "Active" : "Ended",
        observedAt: input.observedAt,
        validUntil,
      },
      projection: {
        projectionGenerationReference: input.projection.projectionGenerationReference,
        sourceCheckpointReference: input.projection.sourceCheckpointReference,
        freshnessStatus: input.projection.freshnessStatus,
        partial: false,
        asOfUtc: input.projection.asOfUtc,
      },
      connection: "Online",
      observedAt: input.observedAt,
      recoveryRequired: false,
      // Kitchen re-parses every reference and instant at runtime before deciding.
    } as unknown as Parameters<typeof buildKdsContinuityState>[0]);
    if (state.mode === "Locked") return "Locked";
    return state.mode === "Live" || state.mode === "StaleReadOnly" ? "Named" : "Unavailable";
  } catch {
    return "Unavailable";
  }
}
/** WP-2423 Q3: the menu's published allergen disclosure for one work item, or Unavailable. */
export type KitchenItemAllergens =
  | {
      readonly status: "Declared";
      readonly items: readonly {
        readonly code: string;
        readonly name: string;
        readonly classification: "Contains" | "CrossContactPossible";
      }[];
      /**
       * WP-2423 ⑪: true when `items` are for exactly the options chosen on this item (reviewed
       * for the published menu); false when they cover every choice, so choices may add more.
       */
      readonly forChoices: boolean;
    }
  | { readonly status: "Unavailable" };
/** WP-2423 Q2: how the kitchen names the Order (no Customer identity). */
export interface KitchenOrderLabel {
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly tableLabel: string | null;
  /** WP-2423 item 8 ⑧ (Owner decision 3): the table the party was moved from, or null. */
  readonly movedFromTableLabel: string | null;
  /**
   * WP-2423 Q7 slice 2: staff entered this order or round for the guests (a counter order or a
   * table round entered by staff), so the kitchen reads "Entered by staff".
   */
  readonly enteredByStaff: boolean;
}
export interface KitchenPreparation {
  readonly allergens: KitchenItemAllergens;
  readonly orderLabel: KitchenOrderLabel | null;
  /**
   * DEC-KITCHEN-STALE-TICKETS: the business day of the item's round (WP-2423 D4: a table's later
   * round is work of the day it was submitted on; the first round's day is the Order's), so a
   * ticket left from an earlier day is never mistaken for today's ticket with the same number,
   * and today's round of an older table is never shown as an earlier day's. Null when unknown.
   */
  readonly businessDate: string | null;
  /** Restricted (DEC-KDS-CUSTOMER-NOTE): displayed only; never logged or evented. */
  readonly customerNote: string | null;
}
const unavailableAllergens: KitchenItemAllergens = Object.freeze({ status: "Unavailable" });
const noPreparation: KitchenPreparation = Object.freeze({
  allergens: unavailableAllergens,
  orderLabel: null,
  businessDate: null,
  customerNote: null,
});
const itemView = (
  item: KitchenQueueItemView,
  preparation: KitchenPreparation,
  parts: ReadonlyMap<string, readonly ComboPart[]> = new Map(),
  chases: ReadonlyMap<string, { count: number; lastChasedAt: string }> = new Map(),
) => ({
  ...item,
  // WP-2423 item 8 ⑦: a server chased this dish (the ticket turns red and sounds).
  ...(chases.has(String(item.workItemReference))
    ? { chase: chases.get(String(item.workItemReference)) }
    : {}),
  // WP-2423 item 8 ⑥ part 4: a combo's chosen dishes, each made and marked done on its own.
  ...(parts.has(String(item.orderItemReference))
    ? { comboParts: parts.get(String(item.orderItemReference)) }
    : {}),
  ticketAggregateVersion: item.ticketAggregateVersion.toString(10),
  workItemVersion: item.workItemVersion.toString(10),
  allergens: preparation.allergens,
  orderLabel: preparation.orderLabel,
  businessDate: preparation.businessDate,
  customerNote: preparation.customerNote,
});
/**
 * WP-2423 Q3: Kitchen gives each work item's menu keys, Catalog the disclosure published for them.
 * Product facts only; no Customer note or health fact. Missing sources read as Unavailable.
 */
export async function kitchenPreparation(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  items: readonly {
    readonly workItemReference: string;
    readonly orderReference: string;
    readonly orderBatchReference?: string;
    /**
     * WP-2423 ⑪: the options chosen on the item. Absent means unknown (never "none"): the
     * disclosure then covers every choice, so no allergen is left out.
     */
    readonly selectedOptions?: readonly { readonly optionReference: string }[];
  }[],
  /**
   * WP-2423 D4: each round's own business date (a table's later round is work of the day it was
   * submitted on, not of the day the table's Order was opened). Without it, the Order's date.
   */
  roundBusinessDates?: (
    transaction: ConsumerTransaction,
    orderBatchReferences: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>,
): Promise<ReadonlyMap<string, KitchenPreparation>> {
  const allergens = await kitchenAllergens(
    transaction,
    scope,
    new Map(
      items.map((item) => [
        item.workItemReference,
        item.selectedOptions === undefined
          ? null
          : item.selectedOptions.map((option) => String(option.optionReference)),
      ]),
    ),
  );
  // WP-2423 Q2: Ordering names the Order; Dining gives a dine-in session's current table.
  const orders = await listStoreKitchenOrderLabels(transaction, scope, [
    ...new Set(items.map((item) => item.orderReference)),
  ]);
  const orderReferences = [...new Set(items.map((item) => item.orderReference))];
  const businessDates = new Map<string, string>();
  for (let start = 0; start < orderReferences.length; start += 100)
    for (const [order, date] of await listStoreOrderBusinessDates(
      transaction,
      scope,
      orderReferences.slice(start, start + 100),
    ))
      businessDates.set(order, date);
  const rounds = [
    ...new Set(
      items.flatMap((item) =>
        item.orderBatchReference === undefined ? [] : [item.orderBatchReference],
      ),
    ),
  ];
  const roundDates =
    roundBusinessDates === undefined || rounds.length === 0
      ? new Map<string, string>()
      : await roundBusinessDates(transaction, rounds);
  const diningSessions = [
    ...new Set(
      [...orders.values()].flatMap((order) =>
        order.diningSessionReference === null ? [] : [order.diningSessionReference],
      ),
    ),
  ];
  const tables = await listDiningSessionTableLabels(transaction, scope, diningSessions);
  const movedFrom = await listDiningSessionMovedFrom(transaction, scope, diningSessions);
  // WP-2423 Q7 slice 2: counter orders and table rounds staff entered (Ordering's staff records).
  const staffOwners = { ...scope, authorize: async () => true };
  const counterOrders = await createPostgresCounterOrderEntryStore(staffOwners).listByOrders(
    transaction,
    orderReferences,
  );
  const staffRounds = await createPostgresStaffDiningRoundEntryStore(staffOwners).listByOrders(
    transaction,
    orderReferences,
  );
  return new Map(
    items.map((item) => {
      const order = orders.get(item.orderReference);
      const enteredByStaff =
        counterOrders.has(item.orderReference) ||
        (item.orderBatchReference !== undefined && staffRounds.has(item.orderBatchReference));
      const facts = allergens.get(item.workItemReference);
      return [
        item.workItemReference,
        Object.freeze({
          allergens: facts?.allergens ?? unavailableAllergens,
          customerNote: facts?.customerNote ?? null,
          businessDate:
            (item.orderBatchReference === undefined
              ? undefined
              : roundDates.get(item.orderBatchReference)) ??
            businessDates.get(item.orderReference) ??
            null,
          orderLabel:
            order === undefined
              ? null
              : Object.freeze({
                  orderNumber: order.orderNumber,
                  orderType: order.orderType,
                  tableLabel:
                    order.diningSessionReference === null
                      ? null
                      : (tables.get(order.diningSessionReference) ?? null),
                  movedFromTableLabel:
                    order.diningSessionReference === null
                      ? null
                      : (movedFrom.get(order.diningSessionReference) ?? null),
                  enteredByStaff,
                }),
        }),
      ] as const;
    }),
  );
}
/** WP-2423: a paid order the kitchen has no work for yet because staff have not accepted it. */
export interface KitchenAwaitingAcceptanceLabel extends Omit<KitchenOrderLabel, "enteredByStaff"> {
  /**
   * Warn before timeouts (WP-2423 2026-10-17): when a paid pickup order is refunded automatically
   * unless someone accepts it, so the kitchen display warns too. Null for dine-in rounds (never
   * refunded for waiting), while an order is held for an outage, or when the deadline is unknown.
   */
  readonly acceptBy: string | null;
}
/**
 * WP-2423 (v15 2026-10-16): how the kitchen names today's orders waiting for acceptance — number,
 * type, a dine-in order's current table and a pickup's refund deadline. No Customer identity.
 */
export async function kitchenAwaitingAcceptance(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orders: readonly {
    readonly orderReference: string;
    readonly orderNumber: string;
    readonly orderType: "Pickup" | "DineIn";
    readonly diningSessionReference: string | null;
  }[],
  refundDeadlines: ReadonlyMap<string, string> = new Map(),
): Promise<readonly KitchenAwaitingAcceptanceLabel[]> {
  const sessions = [
    ...new Set(
      orders.flatMap((order) =>
        order.diningSessionReference === null ? [] : [order.diningSessionReference],
      ),
    ),
  ];
  const tables =
    sessions.length === 0
      ? new Map<string, string>()
      : await listDiningSessionTableLabels(transaction, scope, sessions);
  const movedFrom =
    sessions.length === 0
      ? new Map<string, string>()
      : await listDiningSessionMovedFrom(transaction, scope, sessions);
  return Object.freeze(
    orders.map((order) =>
      Object.freeze({
        orderNumber: order.orderNumber,
        orderType: order.orderType,
        tableLabel:
          order.diningSessionReference === null
            ? null
            : (tables.get(order.diningSessionReference) ?? null),
        movedFromTableLabel:
          order.diningSessionReference === null
            ? null
            : (movedFrom.get(order.diningSessionReference) ?? null),
        acceptBy:
          order.orderType === "Pickup" ? (refundDeadlines.get(order.orderReference) ?? null) : null,
      }),
    ),
  );
}
async function kitchenAllergens(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  /** Work item → the options chosen on it, or null when unknown. */
  chosenOptions: ReadonlyMap<string, readonly string[] | null>,
): Promise<ReadonlyMap<string, { allergens: KitchenItemAllergens; customerNote: string | null }>> {
  const keys = await listKitchenWorkItemPreparationFacts(transaction, scope, [
    ...chosenOptions.keys(),
  ]);
  const disclosures = await listPublishedSellableAllergenDisclosures(
    transaction,
    scope,
    [...keys.values()].map((key) => ({
      menuVersionReference: key.menuVersionReference,
      sellableReference: key.skuReference,
      productVersionReference: key.productVersionReference,
    })),
  );
  return new Map(
    [...keys].map(([workItem, key]) => {
      const disclosure = disclosures.get(
        sellableDisclosureKey({
          menuVersion: key.menuVersionReference,
          sellable: key.skuReference,
          productVersion: key.productVersionReference,
        }),
      );
      if (!disclosure)
        return [
          workItem,
          { allergens: unavailableAllergens, customerNote: key.customerNote },
        ] as const;
      const chosen = chosenOptions.get(workItem) ?? null;
      const forChoice = chosen === null ? null : allergenDisclosureForChoice(disclosure, chosen);
      return [
        workItem,
        {
          customerNote: key.customerNote,
          allergens: Object.freeze({
            status: "Declared" as const,
            forChoices: forChoice !== null,
            items: Object.freeze(
              (forChoice ?? disclosure.items).map((item) => {
                const names = item.localizedNames;
                return Object.freeze({
                  code: item.code,
                  name: names["en-CA"] ?? names.en ?? Object.values(names)[0] ?? item.code,
                  classification: item.classification,
                });
              }),
            ),
          }),
        },
      ] as const;
    }),
  );
}

/** Selected scope and authority never come from browser query fields. */
export function createMerchantKitchenQuery(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  sha256(value: string): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const session = await options.authentication.authorize(input);
    let query: Readonly<Record<string, unknown>>;
    try {
      if (typeof input.query !== "object" || input.query === null) throw new Error("invalid query");
      const descriptor = Object.getOwnPropertyDescriptor(input.query, "kind");
      const kind = descriptor && "value" in descriptor ? descriptor.value : null;
      if (kind !== "List" && kind !== "Get") throw new Error("invalid query");
      query = readClosedRecord(
        input.query,
        kind === "List" ? ["kind", "filters", "cursor", "limit"] : ["kind", "workItemReference"],
      );
    } catch {
      throw new KitchenQueueProjectionError("KITCHEN_QUEUE_INPUT_INVALID");
    }
    const denied = (): never => {
      throw new KitchenQueueProjectionError("KITCHEN_QUEUE_PERMISSION_DENIED");
    };
    return options.persistence.transactions.run((transaction) =>
      // WP-2423: the caller is resolved in full at the start and once before the reply; the owner
      // reads in between only confirm they run in this authorized transaction.
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const scope = await resolveScope(
              transaction,
              input.sessionCookie,
              "kitchen.operate",
              session.sessionReference,
            );
            if (!(await scope.allowed())) return denied();
            return scope;
          },
          recheck: async (scope) => (await scope.allowed()) === true,
          denied,
        },
        async (authorized) => {
          const scope = authorized.scope;
          const authority = {
            actorReference: scope.actorReference,
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.store.storeReference,
            observedAt: options.persistence.now(),
          };
          const tx: ConsumerTransaction = {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              const result = await transaction.query(sql, values);
              if (!result || typeof result !== "object") return unavailable();
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
                return unavailable();
              return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
            },
          };
          await lockPostgresKitchenQueueRead({ ...authority, transaction: tx });
          const service = createKitchenQueueProjectionService({
            authorization: {
              authorize: async (candidate) =>
                candidate.brandReference === authority.brandReference &&
                candidate.storeReference === authority.storeReference &&
                "actorReference" in candidate &&
                candidate.actorReference === authority.actorReference &&
                (await authorized.guard()),
            },
            trustedContext: { resolveQueryAuthority: async () => authority },
            transactions: { withTransaction: (work) => work(tx) },
            tenantContext: {
              install: async (candidate) => {
                if (
                  candidate.brandReference !== authority.brandReference ||
                  candidate.storeReference !== authority.storeReference ||
                  !(await authorized.guard())
                )
                  throw new KitchenQueueProjectionError("KITCHEN_QUEUE_PERMISSION_DENIED");
              },
            },
            queries: createPostgresKitchenQueueQueries({
              ...authority,
              authorize: async () => authorized.guard(),
            }),
            locks: { acquireStoreProjection: unavailable },
            checkpoints: {
              compareIncremental: unavailable,
              compareRebuild: unavailable,
              compareLifecycleIncremental: unavailable,
            },
            sources: {
              loadIncremental: unavailable,
              loadRebuild: unavailable,
              loadLifecycleIncremental: unavailable,
            },
            projections: {
              loadActive: unavailable,
              loadByRebuildReference: unavailable,
              replaceActive: unavailable,
            },
            references: {
              nextGenerationReference: () => {
                throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
              },
            },
            clock: { now: () => authority.observedAt },
            digests: { sha256: options.sha256 },
          });
          // WP-2423 D4: a round's own business date, by the Store's published business day.
          const roundDates = (
            transaction: ConsumerTransaction,
            orderBatchReferences: readonly string[],
          ) =>
            createMerchantRoundBusinessDates({
              persistence: options.persistence,
              scope: {
                tenantReference: String(scope.selected.tenantReference),
                brandReference: String(authority.brandReference),
                storeReference: String(authority.storeReference),
              },
              timeZone: scope.store.timeZone,
              authorize: async () => authorized.guard(),
            })(transaction, orderBatchReferences);
          // A combo's dishes; without them the combo still shows with its choices.
          const comboParts = (items: readonly KitchenQueueItemView[]) =>
            withOptionalRead(
              tx,
              () =>
                comboPartsByOrderItem(
                  tx,
                  authority,
                  "en-CA",
                  items.map((item) => ({
                    orderItemReference: String(item.orderItemReference),
                    optionReferences: item.selectedOptions.map((o) => String(o.optionReference)),
                  })),
                ),
              new Map<string, readonly ComboPart[]>(),
            );
          // WP-2423 item 8 ⑦: how often servers chased each dish; without it nothing is shown red.
          const chasesOf = (items: readonly KitchenQueueItemView[]) =>
            withOptionalRead(
              tx,
              async () =>
                new Map(
                  (
                    await listKitchenWorkChases(tx as never, authority, {
                      orderItemReferences: [
                        ...new Set(items.map((item) => String(item.orderItemReference))),
                      ],
                    })
                  ).map((chase) => [
                    chase.workItemReference,
                    { count: chase.count, lastChasedAt: chase.lastChasedAt },
                  ]),
                ),
              new Map<string, { count: number; lastChasedAt: string }>(),
            );
          const operatorStatus = (projection: ProjectionMetadata) =>
            kdsOperatorStatus({ session, ...authority, projection });
          if (query.kind === "List") {
            const result = await service.list({
              ...authority,
              filters: query.filters,
              cursor: query.cursor,
              limit: query.limit,
            });
            // DEC-KITCHEN-STALE-TICKETS: a ticket a manager closed is gone at once, even before the
            // queue projection has caught up with the closure.
            const closed = await listClosedKitchenTickets(tx, authority, [
              ...new Set(result.items.map((item) => item.ticketReference)),
            ]);
            const items = result.items.filter((item) => !closed.has(item.ticketReference));
            const preparation = await kitchenPreparation(tx, authority, items, roundDates);
            const parts = await comboParts(items);
            const chases = await chasesOf(items);
            const canCloseEarlierDayTickets =
              (await scope.authorizeAction(kitchenStaleTicketClosePermission))?.effect === "Allow";
            // WP-2423 (v15 2026-10-16): today's paid orders still waiting for acceptance have no
            // kitchen work yet; the board's order search names them instead of matching an
            // earlier day's order with the same number. Read with the first page only; null when
            // the Store's business day cannot be read (the search then says nothing about them).
            const awaitingAcceptance =
              query.cursor === null
                ? await withOptionalRead(
                    tx,
                    async () => {
                      const today = await createMerchantBusinessDayWindows({
                        persistence: options.persistence,
                        scope: {
                          tenantReference: String(scope.selected.tenantReference),
                          brandReference: String(authority.brandReference),
                          storeReference: String(authority.storeReference),
                        },
                        timeZone: scope.store.timeZone,
                        authorize: async () => authorized.guard(),
                      }).today(tx, authority.observedAt);
                      const waiting = await listStoreOrdersAwaitingAcceptance(tx, authority, {
                        since: today.startsAt,
                        businessDate: today.businessDate,
                        limit: 100,
                      });
                      // Warn before timeouts: the kitchen display also warns before a paid pickup
                      // nobody accepted is refunded. Without the deadline the names still show.
                      const pickups = waiting
                        .filter((order) => order.orderType === "Pickup")
                        .map((order) => order.orderReference);
                      const refundDeadlines = await withOptionalRead(
                        tx,
                        () => readPickupRefundDeadlines(tx, authority, pickups),
                        new Map<string, string>(),
                      );
                      return kitchenAwaitingAcceptance(tx, authority, waiting, refundDeadlines);
                    },
                    null,
                  )
                : undefined;
            return {
              ...result,
              operatorStatus: operatorStatus(result),
              storeReference: authority.storeReference,
              canCloseEarlierDayTickets,
              ...(awaitingAcceptance === undefined ? {} : { awaitingAcceptance }),
              items: items.map((item) =>
                itemView(
                  item,
                  preparation.get(item.workItemReference) ?? noPreparation,
                  parts,
                  chases,
                ),
              ),
            };
          }
          const result = await service.get({
            ...authority,
            workItemReference: query.workItemReference,
          });
          const preparation = await kitchenPreparation(tx, authority, [result.item], roundDates);
          const parts = await comboParts([result.item]);
          const chases = await chasesOf([result.item]);
          return {
            ...result,
            operatorStatus: operatorStatus(result),
            storeReference: authority.storeReference,
            item: itemView(
              result.item,
              preparation.get(result.item.workItemReference) ?? noPreparation,
              parts,
              chases,
            ),
          };
        },
      ),
    );
  };
}
