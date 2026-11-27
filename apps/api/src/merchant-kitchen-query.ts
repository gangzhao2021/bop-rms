import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  buildKdsContinuityState,
  countUnfinishedKitchenTickets,
  createKitchenQueueProjectionService,
  createPostgresKitchenQueueQueries,
  lockPostgresKitchenQueueRead,
  KitchenQueueProjectionError,
  kitchenBoardOpenTicketLimit,
  kitchenStaleTicketClosePermission,
  listClosedKitchenTickets,
  listKitchenWorkChases,
  listKitchenWorkItemPreparationFacts,
  type KitchenQueueItemView,
  listKitchenWorkItemSections,
  loadKitchenSections,
} from "@rms/kitchen";
import {
  allergenDisclosureForChoice,
  listPublishedSellableAllergenDisclosures,
  listSellableAllergenChangesSince,
  sellableAllergenChangeKey,
  withSellableAllergenChange,
  sellableAllergenChangeForChoices,
  sellableAllergenChangeAnswersChoices,
  type SellableAllergenChange,
  sellableDisclosureKey,
  listAlcoholSkus,
} from "@rms/catalog";
import {
  createPostgresCounterOrderEntryStore,
  createPostgresStaffDiningRoundEntryStore,
  listStoreKitchenOrderLabels,
  listStoreOrderBusinessDates,
  listStoreOrderAutoAcceptanceSkipsByOrder,
  listStoreOrdersAwaitingAcceptance,
} from "@rms/ordering";
import {
  listDiningSessionMergedInto,
  listDiningSessionMovedFrom,
  listDiningSessionTableLabels,
  listSeatedDiningSessions,
} from "@rms/dining";
import {
  listOpenDiningTableAllergies,
  tableAllergenChoices,
} from "./merchant-dining-table-allergies.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  createMerchantRoundBusinessDates,
  withOptionalRead,
} from "./merchant-round-business-date.js";
import { createMerchantBusinessDayWindows } from "./merchant-business-day-window.js";
import { comboPartsByOrderItem, type ComboPart } from "./merchant-combo-parts.js";
import { readPaidOrderWatch } from "./merchant-paid-order-watch.js";
import { readPickupRefundDeadlines } from "./pickup-acceptance-deadline.js";
import { readRefundRequesterRoles, readRefundWithdrawnLines } from "./order-refund-withdrawal.js";
import { loadStoreMember } from "@bop/membership";
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
      /**
       * WP-2423 (M77, M167): a recipe bound or ended since the menu was listed changed what the
       * dish contains; `items` already include what it adds (or, when it could not be resolved,
       * the cook asks the manager). Absent otherwise.
       */
      readonly changedSinceListed?: true;
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
   * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): the table this party was merged from (it eats at
   * `tableLabel` now), or null.
   */
  readonly mergedFromTableLabel: string | null;
  /**
   * WP-2423 Q7 slice 2: staff entered this order or round for the guests (a counter order or a
   * table round entered by staff), so the kitchen reads "Entered by staff".
   */
  readonly enteredByStaff: boolean;
  /**
   * WP-2423 (M171): the allergens staff marked for this table (codes with their list names), only
   * while the table is open and marked.
   */
  readonly tableAllergies?: readonly { readonly code: string; readonly name: string }[];
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
  /**
   * merchant-outage-recovery M120: when the item's round was sent (Ordering's submittedAt), so
   * the kitchen counts the wait from the order, not from acceptance. Null when unknown (a remake,
   * an item without a round, or a round this read could not see).
   */
  readonly placedAt: string | null;
  /** Restricted (DEC-KDS-CUSTOMER-NOTE): displayed only; never logged or evented. */
  readonly customerNote: string | null;
  /** WP-2423 item 8 ⑧ (decision 5): the dish's kitchen section (档口); null: no section. */
  readonly kitchenSection: string | null;
  /**
   * Owner 2026-11-03: entered after an outage from a paper slip, so the kitchen may already have
   * made it. It still goes through the board so its records close.
   */
  readonly takenOnPaper?: boolean;
  /** WP-2423 (M93, Owner decision 18): the dish contains alcohol; check ID (19+) when serving. */
  readonly checkId?: boolean;
  /**
   * v15 b11: the dish is for a table whose guests are still seated (its dining session, or the
   * table it was merged into, is open). Its round stays that table's work on the board even after
   * the business day turned (late-night service), never an earlier day's ticket to close.
   */
  readonly atSeatedTable?: boolean;
}
const unavailableAllergens: KitchenItemAllergens = Object.freeze({ status: "Unavailable" });
const noPreparation: KitchenPreparation = Object.freeze({
  allergens: unavailableAllergens,
  orderLabel: null,
  businessDate: null,
  placedAt: null,
  customerNote: null,
  kitchenSection: null,
});
/**
 * A combo's dishes keep their five keys (a tablet still on the previous page reads them strictly);
 * each dish's section goes in a sibling field it ignores.
 */
export function kitchenComboPartFields(parts: readonly ComboPart[] | undefined) {
  if (parts === undefined) return {};
  return {
    comboParts: parts.map((part) => ({
      optionReference: part.optionReference,
      nameZh: part.nameZh,
      name: part.name,
      done: part.done,
      served: part.served,
    })),
    comboPartSections: Object.fromEntries(
      parts.map((part) => [part.optionReference, part.kitchenSection ?? null]),
    ),
  };
}
/**
 * WP-2423 M10: refunded units of one dish, the names of who refunded them, and the refund role of
 * those whose name can't be read (either may be empty).
 */
interface RefundedLine {
  readonly quantity: number;
  readonly names: readonly string[];
  readonly roles?: readonly RefunderRole[];
}
type RefunderRole = "Owner" | "Manager" | "Staff";
const refundedFields = (
  line: RefundedLine | undefined,
  requiredQuantity: number,
): {
  refundedQuantity?: number;
  refundedBy?: readonly string[];
  refundedByRoles?: readonly RefunderRole[];
} =>
  line === undefined || line.quantity < 1
    ? {}
    : {
        refundedQuantity: Math.min(line.quantity, requiredQuantity),
        ...(line.names.length > 0 ? { refundedBy: line.names } : {}),
        // v15 batch 5: an owner with no name in the member directory refunded a dish and the
        // ticket said nobody; the ticket names them by role instead ("the owner").
        ...(line.roles !== undefined && line.roles.length > 0
          ? { refundedByRoles: line.roles }
          : {}),
      };
const itemView = (
  item: KitchenQueueItemView,
  preparation: KitchenPreparation,
  parts: ReadonlyMap<string, readonly ComboPart[]> = new Map(),
  chases: ReadonlyMap<string, { count: number; lastChasedAt: string }> = new Map(),
  withdrawn: ReadonlyMap<string, RefundedLine> = new Map(),
) => ({
  ...item,
  // WP-2423 M10: units of this dish staff refunded and said not to make ("1 refunded – don't
  // make it"; all of them: "Refunded – stop"), and who refunded them. Absent when none.
  ...refundedFields(withdrawn.get(String(item.orderItemReference)), item.requiredQuantity),
  // WP-2423 item 8 ⑦: a server chased this dish (the ticket turns red and sounds).
  ...(chases.has(String(item.workItemReference))
    ? { chase: chases.get(String(item.workItemReference)) }
    : {}),
  // WP-2423 item 8 ⑥ part 4: a combo's chosen dishes, each made and marked done on its own.
  ...kitchenComboPartFields(parts.get(String(item.orderItemReference))),
  ticketAggregateVersion: item.ticketAggregateVersion.toString(10),
  workItemVersion: item.workItemVersion.toString(10),
  allergens: preparation.allergens,
  orderLabel: preparation.orderLabel,
  businessDate: preparation.businessDate,
  // Only when known: an item without it reads as before (the board counts from creation).
  ...(preparation.placedAt === null ? {} : { placedAt: preparation.placedAt }),
  customerNote: preparation.customerNote,
  kitchenSection: preparation.kitchenSection,
  ...(preparation.takenOnPaper === true ? { takenOnPaper: true as const } : {}),
  ...(preparation.checkId === true ? { checkId: true as const } : {}),
  ...(preparation.atSeatedTable === true ? { atSeatedTable: true as const } : {}),
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
  ) => Promise<
    ReadonlyMap<string, string> & { readonly submittedAt?: ReadonlyMap<string, string> }
  >,
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
  const roundDates: ReadonlyMap<string, string> & {
    readonly submittedAt?: ReadonlyMap<string, string>;
  } =
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
  const mergedInto = await listDiningSessionMergedInto(transaction, scope, diningSessions);
  const seatedSessions = await listSeatedDiningSessions(
    transaction as never,
    scope,
    diningSessions,
  );
  const seated = (session: string | null) => {
    if (session === null) return false;
    const host = mergedInto.get(session);
    return host !== undefined
      ? host.phase === "Active" || host.phase === "Closing"
      : seatedSessions.has(session);
  };
  // WP-2423 (M171, Owner decision 17): what each open table must avoid, named from the Brand's
  // allergen list (only when any table is marked).
  const tableAllergyCodes = await listOpenDiningTableAllergies(
    transaction as never,
    scope,
    diningSessions,
  );
  const allergyNames =
    tableAllergyCodes.size === 0
      ? new Map<string, string>()
      : new Map(
          (await tableAllergenChoices(transaction as never, scope)).map(
            (choice) => [choice.code, choice.name] as const,
          ),
        );
  const tableAllergiesOf = (session: string | null) => {
    const codes = session === null ? undefined : tableAllergyCodes.get(session);
    return codes === undefined
      ? {}
      : {
          tableAllergies: Object.freeze(
            codes.map((code) => Object.freeze({ code, name: allergyNames.get(code) ?? code })),
          ),
        };
  };
  // WP-2423 item 8 ⑧ (decision 5): each dish's kitchen section, for the screen's section filter.
  const sections = await listKitchenWorkItemSections(
    transaction,
    scope,
    items.map((item) => item.workItemReference),
  );
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
      const takenOnPaper =
        counterOrders.get(item.orderReference)?.recordedAfterOutage === true ||
        (item.orderBatchReference !== undefined &&
          staffRounds.get(item.orderBatchReference)?.entry.recordedAfterOutage === true);
      return [
        item.workItemReference,
        Object.freeze({
          ...(takenOnPaper ? { takenOnPaper: true } : {}),
          ...(facts?.checkId === true ? { checkId: true } : {}),
          ...(seated(order?.diningSessionReference ?? null) ? { atSeatedTable: true } : {}),
          allergens: facts?.allergens ?? unavailableAllergens,
          customerNote: facts?.customerNote ?? null,
          kitchenSection: sections.get(item.workItemReference) ?? null,
          businessDate:
            (item.orderBatchReference === undefined
              ? undefined
              : roundDates.get(item.orderBatchReference)) ??
            businessDates.get(item.orderReference) ??
            null,
          placedAt:
            (item.orderBatchReference === undefined
              ? undefined
              : roundDates.submittedAt?.get(item.orderBatchReference)) ?? null,
          orderLabel:
            order === undefined
              ? null
              : Object.freeze({
                  orderNumber: order.orderNumber,
                  orderType: order.orderType,
                  tableLabel:
                    order.diningSessionReference === null
                      ? null
                      : (mergedInto.get(order.diningSessionReference)?.tableLabel ??
                        tables.get(order.diningSessionReference) ??
                        null),
                  movedFromTableLabel:
                    order.diningSessionReference === null ||
                    mergedInto.has(order.diningSessionReference)
                      ? null
                      : (movedFrom.get(order.diningSessionReference) ?? null),
                  mergedFromTableLabel:
                    order.diningSessionReference === null
                      ? null
                      : (mergedInto.get(order.diningSessionReference)?.fromTableLabel ?? null),
                  enteredByStaff,
                  ...tableAllergiesOf(order.diningSessionReference),
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
  /** DEC-PAID-ORDER-AUTO-ACCEPT: why it was not sent automatically (only when it applies). */
  readonly notSent?: { readonly reason: string; readonly itemCount: number | null };
  /** WP-2423 M04: accepted, and not in the kitchen yet (only when so). */
  readonly acceptedNotInKitchen?: true;
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
    readonly accepted?: boolean;
  }[],
  refundDeadlines: ReadonlyMap<string, string> = new Map(),
  notSent: ReadonlyMap<string, NonNullable<KitchenAwaitingAcceptanceLabel["notSent"]>> = new Map(),
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
        // A merged table's rounds are paid at the end: none of them waits for acceptance.
        mergedFromTableLabel: null,
        acceptBy:
          order.orderType === "Pickup" ? (refundDeadlines.get(order.orderReference) ?? null) : null,
        ...((reason) => (reason === undefined ? {} : { notSent: reason }))(
          notSent.get(order.orderReference),
        ),
        ...(order.accepted === true ? { acceptedNotInKitchen: true as const } : {}),
      }),
    ),
  );
}
async function kitchenAllergens(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  /** Work item → the options chosen on it, or null when unknown. */
  chosenOptions: ReadonlyMap<string, readonly string[] | null>,
): Promise<
  ReadonlyMap<
    string,
    { allergens: KitchenItemAllergens; customerNote: string | null; checkId?: boolean }
  >
> {
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
  // WP-2423 (M77, M167): what a recipe change since the listing brought, by menu version and dish.
  const changeKeys = [
    ...new Map(
      [...keys.values()].map((key) => [
        sellableAllergenChangeKey(key.menuVersionReference, key.skuReference),
        { menuVersionReference: key.menuVersionReference, skuReference: key.skuReference },
      ]),
    ).values(),
  ];
  const changes = new Map<string, SellableAllergenChange>();
  for (let at = 0; at < changeKeys.length; at += 200)
    for (const [key, change] of await listSellableAllergenChangesSince(
      transaction as never,
      scope,
      changeKeys.slice(at, at + 200),
    ))
      changes.set(key, change);
  const named = (names: Readonly<Record<string, string>>, code: string) =>
    names["en-CA"] ?? names.en ?? Object.values(names)[0] ?? code;
  // WP-2423 (M93, Owner decision 18): a dish that contains alcohol tells the cook or bar to check ID.
  const alcohol =
    keys.size === 0
      ? new Set<string>()
      : await listAlcoholSkus(transaction as never, scope, [
          ...new Set([...keys.values()].map((key) => key.skuReference)),
        ]);
  const facts = new Map(
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
      const listed = (forChoice ?? disclosure.items).map((item) =>
        Object.freeze({
          code: String(item.code),
          name: named(item.localizedNames, String(item.code)),
          classification: item.classification,
        }),
      );
      // b7: a choice's staff-answered allergen reaches the ticket only when it was chosen.
      const change = changes.get(
        sellableAllergenChangeKey(key.menuVersionReference, key.skuReference),
      );
      const merged = withSellableAllergenChange(
        listed,
        sellableAllergenChangeForChoices(change, chosen),
        (allergen) =>
          Object.freeze({
            code: allergen.code,
            name: named(allergen.localizedNames, allergen.code),
            classification: allergen.classification,
          }),
      );
      return [
        workItem,
        {
          customerNote: key.customerNote,
          allergens: Object.freeze({
            status: "Declared" as const,
            // b9: also when staff answered every chosen choice since listing (the dish's listed
            // list with those answers names everything they add).
            forChoices: forChoice !== null || sellableAllergenChangeAnswersChoices(change, chosen),
            items: Object.freeze(merged.items),
            ...(merged.changed ? { changedSinceListed: true as const } : {}),
          }),
        },
      ] as const;
    }),
  );
  return new Map(
    [...facts].map(([workItem, value]) => [
      workItem,
      alcohol.has(String(keys.get(workItem)?.skuReference)) ? { ...value, checkId: true } : value,
    ]),
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
      if (kind !== "List" && kind !== "Get" && kind !== "Watch") throw new Error("invalid query");
      // DEC-PAID-ORDER-AUTO-ACCEPT: a kitchen sign-in's screen-wide warnings: the first ticket and
      // what comes with the first page. Not the board's own read, so not a sign a board is open.
      query =
        kind === "Watch"
          ? (readClosedRecord(input.query, ["kind"]),
            Object.freeze({
              kind: "List",
              filters: Object.freeze({
                orderReference: null,
                ticketReference: null,
                workItemReference: null,
                stationReference: null,
                status: null,
              }),
              cursor: null,
              limit: 1,
            }))
          : readClosedRecord(
              input.query,
              kind === "List"
                ? ["kind", "filters", "cursor", "limit"]
                : ["kind", "workItemReference"],
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
                  { withSections: true },
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
          // WP-2423 M10: refunded units not to be made, and who refunded them; without the read
          // nothing is marked, and a name that can't be read is left out.
          const withdrawnOf = async (items: readonly KitchenQueueItemView[]) => {
            const lines = await withOptionalRead(
              tx,
              () =>
                readRefundWithdrawnLines(tx, authority, [
                  ...new Set(items.map((item) => String(item.orderReference))),
                ]),
              new Map<
                string,
                {
                  quantity: number;
                  actorReferences: readonly string[];
                  requestByActor: ReadonlyMap<string, string>;
                }
              >(),
            );
            const names = new Map<string, string | null>();
            for (const line of lines.values())
              for (const actor of line.actorReferences)
                if (!names.has(actor))
                  names.set(
                    actor,
                    await withOptionalRead(
                      tx,
                      async () => (await loadStoreMember(tx, authority, actor)).displayName,
                      null,
                    ),
                  );
            const named = (actor: string) => {
              const name = names.get(actor);
              return typeof name === "string" && name.length > 0 ? name : null;
            };
            // Without a name: the refund role they held when they asked (unread: left out).
            const unnamed = [...lines.values()].flatMap((line) =>
              line.actorReferences.flatMap((actor) =>
                named(actor) === null && line.requestByActor.has(actor)
                  ? [line.requestByActor.get(actor) as string]
                  : [],
              ),
            );
            const roles =
              unnamed.length === 0
                ? new Map<string, RefunderRole>()
                : await withOptionalRead(
                    tx,
                    () => readRefundRequesterRoles(tx, authority, unnamed),
                    new Map<string, RefunderRole>(),
                  );
            return new Map<string, RefundedLine>(
              [...lines].map(([item, line]) => [
                item,
                {
                  quantity: line.quantity,
                  names: line.actorReferences.flatMap((actor) => {
                    const name = named(actor);
                    return name === null ? [] : [name];
                  }),
                  roles: [
                    ...new Set(
                      line.actorReferences.flatMap((actor) => {
                        const request = line.requestByActor.get(actor);
                        const role =
                          named(actor) === null && request !== undefined
                            ? roles.get(request)
                            : undefined;
                        return role === undefined ? [] : [role];
                      }),
                    ),
                  ],
                },
              ]),
            );
          };
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
            const withdrawn = await withdrawnOf(items);
            const canCloseEarlierDayTickets =
              (await scope.authorizeAction(kitchenStaleTicketClosePermission))?.effect === "Allow";
            // DEC-PAID-ORDER-AUTO-ACCEPT: at a Store sending paid orders straight here, what waits
            // for a person and why, and whether what was sent is going anywhere. Left out elsewhere.
            const paidOrderWatch =
              query.cursor === null
                ? await withOptionalRead(
                    tx,
                    () => readPaidOrderWatch(tx, authority, authority.observedAt),
                    null,
                  )
                : null;
            const canAcceptOrders =
              paidOrderWatch !== null &&
              (await scope.authorizeAction("order.accept"))?.effect === "Allow";
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
                      const notSent: ReadonlyMap<
                        string,
                        { readonly reason: string; readonly itemCount: number | null }
                      > =
                        paidOrderWatch === null
                          ? new Map()
                          : await withOptionalRead<
                              ReadonlyMap<
                                string,
                                { readonly reason: string; readonly itemCount: number | null }
                              >
                            >(
                              tx,
                              () =>
                                listStoreOrderAutoAcceptanceSkipsByOrder(
                                  tx,
                                  authority,
                                  waiting.map((order) => order.orderReference),
                                ),
                              new Map(),
                            );
                      return kitchenAwaitingAcceptance(
                        tx,
                        authority,
                        waiting,
                        refundDeadlines,
                        notSent,
                      );
                    },
                    null,
                  )
                : undefined;
            // WP-2423 item 8 ⑧: the Store's kitchen sections, so a screen can be set to one before
            // it has work. Read with the first page; left out when it cannot be read.
            const kitchenSections =
              query.cursor === null
                ? await withOptionalRead(
                    tx,
                    async () =>
                      (await loadKitchenSections(tx, authority)).sections.map(
                        (section) => section.name,
                      ),
                    null,
                  )
                : null;
            // DEC-KITCHEN-ONE-TAP: more open tickets than the board carries: it says so.
            const moreWaitingTickets =
              query.cursor === null
                ? await withOptionalRead(
                    tx,
                    async () =>
                      Math.max(
                        0,
                        (await countUnfinishedKitchenTickets(tx as never, authority)) -
                          kitchenBoardOpenTicketLimit,
                      ),
                    0,
                  )
                : 0;
            return {
              ...result,
              operatorStatus: operatorStatus(result),
              ...(moreWaitingTickets > 0 ? { moreWaitingTickets } : {}),
              ...(kitchenSections === null ? {} : { kitchenSections }),
              storeReference: authority.storeReference,
              canCloseEarlierDayTickets,
              ...(awaitingAcceptance === undefined ? {} : { awaitingAcceptance }),
              ...(paidOrderWatch === null
                ? {}
                : { paidOrderWatch: { ...paidOrderWatch, canTurnOff: false, canAcceptOrders } }),
              items: items.map((item) =>
                itemView(
                  item,
                  preparation.get(item.workItemReference) ?? noPreparation,
                  parts,
                  chases,
                  withdrawn,
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
          const withdrawn = await withdrawnOf([result.item]);
          return {
            ...result,
            operatorStatus: operatorStatus(result),
            storeReference: authority.storeReference,
            item: itemView(
              result.item,
              preparation.get(result.item.workItemReference) ?? noPreparation,
              parts,
              chases,
              withdrawn,
            ),
          };
        },
      ),
    );
  };
}
