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
  listKitchenWorkItemPreparationFacts,
  type KitchenQueueItemView,
} from "@rms/kitchen";
import { listPublishedSellableAllergenDisclosures, sellableDisclosureKey } from "@rms/catalog";
import { listStoreKitchenOrderLabels, listStoreOrderBusinessDates } from "@rms/ordering";
import { listDiningSessionTableLabels } from "@rms/dining";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
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
    }
  | { readonly status: "Unavailable" };
/** WP-2423 Q2: how the kitchen names the Order (no Customer identity). */
export interface KitchenOrderLabel {
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly tableLabel: string | null;
}
export interface KitchenPreparation {
  readonly allergens: KitchenItemAllergens;
  readonly orderLabel: KitchenOrderLabel | null;
  /**
   * DEC-KITCHEN-STALE-TICKETS: the Order's business day (Ordering), so a ticket left from an
   * earlier day is never mistaken for today's ticket with the same number. Null when unknown.
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
const itemView = (item: KitchenQueueItemView, preparation: KitchenPreparation) => ({
  ...item,
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
  items: readonly { readonly workItemReference: string; readonly orderReference: string }[],
): Promise<ReadonlyMap<string, KitchenPreparation>> {
  const allergens = await kitchenAllergens(
    transaction,
    scope,
    items.map((item) => item.workItemReference),
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
  const tables = await listDiningSessionTableLabels(transaction, scope, [
    ...new Set(
      [...orders.values()].flatMap((order) =>
        order.diningSessionReference === null ? [] : [order.diningSessionReference],
      ),
    ),
  ]);
  return new Map(
    items.map((item) => {
      const order = orders.get(item.orderReference);
      const facts = allergens.get(item.workItemReference);
      return [
        item.workItemReference,
        Object.freeze({
          allergens: facts?.allergens ?? unavailableAllergens,
          customerNote: facts?.customerNote ?? null,
          businessDate: businessDates.get(item.orderReference) ?? null,
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
                }),
        }),
      ] as const;
    }),
  );
}
async function kitchenAllergens(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  workItemReferences: readonly string[],
): Promise<ReadonlyMap<string, { allergens: KitchenItemAllergens; customerNote: string | null }>> {
  const keys = await listKitchenWorkItemPreparationFacts(transaction, scope, workItemReferences);
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
      return [
        workItem,
        {
          customerNote: key.customerNote,
          allergens: Object.freeze({
            status: "Declared" as const,
            items: Object.freeze(
              disclosure.items.map((item) => {
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
            const preparation = await kitchenPreparation(tx, authority, items);
            const canCloseEarlierDayTickets =
              (await scope.authorizeAction(kitchenStaleTicketClosePermission))?.effect === "Allow";
            return {
              ...result,
              operatorStatus: operatorStatus(result),
              storeReference: authority.storeReference,
              canCloseEarlierDayTickets,
              items: items.map((item) =>
                itemView(item, preparation.get(item.workItemReference) ?? noPreparation),
              ),
            };
          }
          const result = await service.get({
            ...authority,
            workItemReference: query.workItemReference,
          });
          const preparation = await kitchenPreparation(tx, authority, [result.item]);
          return {
            ...result,
            operatorStatus: operatorStatus(result),
            storeReference: authority.storeReference,
            item: itemView(
              result.item,
              preparation.get(result.item.workItemReference) ?? noPreparation,
            ),
          };
        },
      ),
    );
  };
}
