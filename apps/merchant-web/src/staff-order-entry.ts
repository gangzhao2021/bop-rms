import { t } from "./i18n/i18n.js";
/**
 * WP-2423 Q7 (OPS-ORDER-ENTRY, DEC-COUNTER-PAYMENT-RECORD): the counter order client. Staff take a
 * pickup order for a guest at the counter (or enter a paper order taken during an outage); the
 * store's card machine takes the payment and staff record it. Every amount comes from the server.
 */
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const minorPattern = /^(0|[1-9][0-9]{0,15})$/u;

export class CounterOrderClientError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "StoreNotTakingOrders"
      | "TableUnavailable"
      | "TableHasNoQr"
      | "TableCartHasItems"
      | "TableCheckoutInProgress"
      | "ItemUnavailable"
      | "ItemShort"
      | "NotPriced"
      | "NotFinished"
      | "InProgress"
      | "AmountChanged"
      | "PaymentWindowClosed"
      | "AlreadyPaid"
      | "NotPayable"
      | "Invalid"
      | "Conflict"
      /** WP-2423: no pickup time covers now (the schedule ran out); nothing was placed. */
      | "NoPickupTimes"
      /** WP-2423: the server answered that it could not place the order (its own fault). */
      | "SystemProblem"
      | "Unavailable"
      | "OutcomeUnknown",
    /** ItemUnavailable: the line the store cannot sell now. ItemShort: the short item's first line. */
    readonly lineIndex: number | null = null,
    /** AmountChanged: the amount to charge now. */
    readonly totalMinor: string | null = null,
    /** TableCartHasItems: what guests put in the table's shared cart and haven't sent. */
    readonly pendingItems: readonly { readonly name: string; readonly quantity: number }[] = [],
    /** ItemShort: how many of the item the store's stock covers now. */
    readonly available: number | null = null,
    /**
     * WP-2423 ItemShort/ItemUnavailable: the item could be made on its own; other items in the
     * order use the same stock (two drinks using the same milk).
     */
    readonly sharedStock = false,
  ) {
    super(t("Counter order request failed"));
    this.name = "CounterOrderClientError";
  }
}
const invalid = (): never => {
  throw new CounterOrderClientError("Unavailable");
};
/**
 * WP-2423: the counter's or table round's refusal about one item (too few in stock, or not
 * sellable now); nothing was placed or charged. Null for any other reply.
 */
function itemRefusal(body: Record<string, unknown>): CounterOrderClientError | null {
  const { lineIndex, available } = body;
  const line =
    typeof lineIndex === "number" && Number.isSafeInteger(lineIndex) && lineIndex >= 0
      ? lineIndex
      : null;
  const sharedStock = body.sharedStock === true;
  if (
    body.error === "item_short" &&
    line !== null &&
    typeof available === "number" &&
    Number.isSafeInteger(available) &&
    available > 0
  )
    return new CounterOrderClientError("ItemShort", line, null, [], available, sharedStock);
  if (body.error === "item_unavailable")
    return new CounterOrderClientError("ItemUnavailable", line, null, [], null, sharedStock);
  return null;
}
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const own = Object.keys(value);
  if (own.some((key) => !keys.includes(key) && !optional.includes(key))) return invalid();
  if (keys.some((key) => !own.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
const text = (value: unknown, max = 200) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : invalid();
const ref = (value: unknown) =>
  typeof value === "string" && reference.test(value) ? value : invalid();
/** "12.50" display amount → "1250" minor units; money is never a float. */
function displayMinor(amount: unknown): string | null {
  if (typeof amount !== "string") return null;
  const match = /^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,2}))?$/u.exec(amount);
  if (!match) return null;
  return String(BigInt(match[1] as string) * 100n + BigInt((match[2] ?? "0").padEnd(2, "0")));
}

export interface CounterMenuOption {
  readonly optionReference: string;
  readonly name: string;
  readonly priceMinor: string | null;
  readonly maximumQuantity: number;
  readonly selectedByDefault: boolean;
  readonly defaultQuantity: number;
  readonly conflictOptionReferences: readonly string[];
}
export interface CounterMenuRule {
  readonly bindingReference: string;
  readonly name: string;
  readonly minimumSelections: number;
  readonly maximumSelections: number;
  readonly options: readonly CounterMenuOption[];
}
export interface CounterMenuItem {
  readonly sellableReference: string;
  /**
   * The Product version this sellable is a SKU of: the sizes of one Product share it (the catalog's
   * Product → SKU relation). Null when the menu does not say.
   */
  readonly productVersionReference: string | null;
  readonly name: string;
  readonly available: boolean;
  readonly priceMinor: string | null;
  readonly rules: readonly CounterMenuRule[];
}
export interface CounterMenu {
  readonly sections: readonly {
    readonly sectionReference: string;
    readonly name: string;
    readonly items: readonly CounterMenuItem[];
  }[];
}

/** The pickup menu customers see now: items, options, prices and sold-out state. */
export function parseCounterMenu(value: unknown): CounterMenu {
  const raw = record(value, ["screenId", "menu"]);
  if (raw.screenId !== "OPS-ORDER-ENTRY") return invalid();
  const found = record(raw.menu, ["status", "schemaVersion", "projection", "scope", "menu"]);
  if (found.status !== "Found") return invalid();
  const menu = record(found.menu, [
    "menuReference",
    "menuVersionReference",
    "releaseReference",
    "locale",
    "name",
    "effectiveFrom",
    "effectiveUntil",
    "sections",
  ]);
  if (!Array.isArray(menu.sections) || menu.sections.length > 200) return invalid();
  return Object.freeze({
    sections: Object.freeze(
      menu.sections.map((value: unknown) => {
        const section = record(value, ["sectionReference", "name", "sellables"]);
        if (!Array.isArray(section.sellables) || section.sellables.length > 500) return invalid();
        return Object.freeze({
          sectionReference: ref(section.sectionReference),
          name: text(section.name),
          items: Object.freeze(
            section.sellables.map((value: unknown) => {
              const item = record(
                value,
                [
                  "sellableReference",
                  "productVersionReference",
                  "name",
                  "presentationRole",
                  "pinned",
                  "availability",
                  "optionRules",
                  "allergenDisclosure",
                  "displayPrice",
                  "taxDisplayContext",
                ],
                // The customer description and photo; the counter does not show them.
                ["description", "photo"],
              );
              const price = record(item.displayPrice, ["status", "amount", "currency", "reason"]);
              if (
                (item.availability !== "Available" && item.availability !== "SoldOut") ||
                !Array.isArray(item.optionRules)
              )
                return invalid();
              return Object.freeze({
                sellableReference: ref(item.sellableReference),
                productVersionReference:
                  item.productVersionReference === null ? null : ref(item.productVersionReference),
                name: text(item.name),
                available: item.availability === "Available",
                priceMinor: price.status === "Available" ? displayMinor(price.amount) : null,
                rules: Object.freeze(
                  item.optionRules.map((value: unknown) => {
                    const rule = record(
                      value,
                      [
                        "name",
                        "bindingReference",
                        "optionSetVersionReference",
                        "minimumSelections",
                        "maximumSelections",
                        "enabledOptionReferences",
                        "defaultOptionReferences",
                        "options",
                      ],
                      ["semanticsVersion", "activationOptionReferences"],
                    );
                    if (
                      !Number.isInteger(rule.minimumSelections) ||
                      !Number.isInteger(rule.maximumSelections) ||
                      !Array.isArray(rule.options) ||
                      !Array.isArray(rule.enabledOptionReferences)
                    )
                      return invalid();
                    const enabled = new Set(rule.enabledOptionReferences as unknown[]);
                    return Object.freeze({
                      bindingReference: ref(rule.bindingReference),
                      name: rule.name === null ? "Options" : text(rule.name),
                      minimumSelections: rule.minimumSelections as number,
                      maximumSelections: rule.maximumSelections as number,
                      options: Object.freeze(
                        rule.options
                          .map((value: unknown) => {
                            const option = record(
                              value,
                              [
                                "optionReference",
                                "name",
                                "maximumQuantity",
                                "conflictOptionReferences",
                                "selectedByDefault",
                                "incrementalPrice",
                              ],
                              ["defaultQuantity"],
                            );
                            const increment = record(option.incrementalPrice, [
                              "status",
                              "amount",
                              "currency",
                              "reason",
                            ]);
                            return Object.freeze({
                              optionReference: ref(option.optionReference),
                              name: text(option.name),
                              priceMinor:
                                increment.status === "Available"
                                  ? displayMinor(increment.amount)
                                  : null,
                              maximumQuantity: Number(option.maximumQuantity),
                              selectedByDefault: option.selectedByDefault === true,
                              defaultQuantity:
                                typeof option.defaultQuantity === "number" &&
                                Number.isInteger(option.defaultQuantity) &&
                                option.defaultQuantity > 0
                                  ? option.defaultQuantity
                                  : 1,
                              conflictOptionReferences: Object.freeze(
                                Array.isArray(option.conflictOptionReferences)
                                  ? option.conflictOptionReferences.map(ref)
                                  : invalid(),
                              ),
                            });
                          })
                          .filter((option: CounterMenuOption) =>
                            enabled.has(option.optionReference),
                          ),
                      ),
                    });
                  }),
                ),
              });
            }),
          ),
        });
      }),
    ),
  });
}

export interface CounterOrderLine {
  readonly sellableReference: string;
  readonly quantity: number;
  readonly optionSelections: readonly { optionReference: string; quantity: number }[];
}
/** WP-2423 Q7 slice 2: a table round's line may carry the guest's note for the kitchen. */
export interface TableRoundLine extends CounterOrderLine {
  readonly note: string | null;
}
export type CounterTip =
  | { readonly kind: "None" }
  | { readonly kind: "Percent"; readonly percent: 10 | 15 | 18 | 20 }
  | { readonly kind: "Amount"; readonly amountMinor: string };

export interface PlacedCounterOrder {
  readonly status: "Placed" | "AlreadyPlaced";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderNumber: string;
  readonly orderVersion: number;
  readonly orderMinor: string;
  readonly tipMinor: string;
  readonly totalMinor: string;
  /** Null when the table pays later: nothing is charged now. */
  readonly payBy: string | null;
  /**
   * DEC-DINE-IN-PAY-LATER: the round went to the kitchen unpaid and goes on the table's bill
   * (no tip now; the table pays once at the end). Always false at the counter.
   */
  readonly payLater: boolean;
  readonly recordedAfterOutage: boolean;
  /** WP-2423 Q7 slice 2: the table a staff-entered round joined (null at the counter). */
  readonly tableLabel: string | null;
}
export function parsePlacedCounterOrder(value: unknown, table = false): PlacedCounterOrder {
  const raw = record(
    value,
    [
      ...(table ? ["tableLabel"] : []),
      "status",
      "orderReference",
      "orderBatchReference",
      "orderNumber",
      "orderVersion",
      "orderMinor",
      "tipMinor",
      "totalMinor",
      "payBy",
      "recordedAfterOutage",
    ],
    table ? ["payLater"] : [],
  );
  if (
    (raw.status !== "Placed" && raw.status !== "AlreadyPlaced") ||
    !Number.isInteger(raw.orderVersion) ||
    typeof raw.recordedAfterOutage !== "boolean" ||
    ![raw.orderMinor, raw.tipMinor, raw.totalMinor].every(
      (value) => typeof value === "string" && minorPattern.test(value),
    ) ||
    BigInt(raw.orderMinor as string) + BigInt(raw.tipMinor as string) !==
      BigInt(raw.totalMinor as string)
  )
    return invalid();
  // Absent from an older server (it never sends a round unpaid).
  const payLater = table && raw.payLater === true;
  if (raw.payLater !== undefined && typeof raw.payLater !== "boolean") return invalid();
  // A pay-later round has no payment window and no tip; any other has a window.
  if (
    payLater
      ? raw.payBy !== null || raw.tipMinor !== "0"
      : typeof raw.payBy !== "string" || !Number.isFinite(Date.parse(raw.payBy))
  )
    return invalid();
  return Object.freeze({
    status: raw.status,
    orderReference: ref(raw.orderReference),
    orderBatchReference: ref(raw.orderBatchReference),
    orderNumber: text(raw.orderNumber, 40),
    orderVersion: raw.orderVersion as number,
    orderMinor: raw.orderMinor as string,
    tipMinor: raw.tipMinor as string,
    totalMinor: raw.totalMinor as string,
    payBy: payLater ? null : (raw.payBy as string),
    payLater,
    recordedAfterOutage: raw.recordedAfterOutage,
    tableLabel: table && raw.tableLabel !== null ? text(raw.tableLabel, 120) : null,
  });
}

export interface RecordedCardPayment {
  readonly status: "Recorded" | "AlreadyRecorded";
  readonly amountMinor: string;
  readonly recordingReason: "AtCounter" | "RecordedAfterOutage";
  readonly takenAt: string;
  /** WP-2423 D1: the server accepted it with the payment (it is in the kitchen), or not. */
  readonly acceptance: "Accepted" | "NotAccepted";
}

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await response.json()) as unknown;
    return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createCounterOrderClient(csrf: string, fetcher: typeof fetch = fetch) {
  const post = async (path: string, body: unknown, signal?: AbortSignal) => {
    try {
      return await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        ...(signal ? { signal } : {}),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify(body),
      });
    } catch {
      // The request may have reached the server: retry with the same operation.
      throw new CounterOrderClientError("OutcomeUnknown");
    }
  };
  return Object.freeze({
    /** The menu customers see now; `DineIn` for a staff-entered table round. */
    async loadMenu(
      signal?: AbortSignal,
      orderType: "Pickup" | "DineIn" = "Pickup",
    ): Promise<CounterMenu> {
      let response: Response;
      try {
        response = await fetcher(
          orderType === "DineIn"
            ? "/merchant/counter/menu?orderType=DineIn"
            : "/merchant/counter/menu",
          {
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
            ...(signal ? { signal } : {}),
            headers: { Accept: "application/json" },
          },
        );
      } catch {
        throw new CounterOrderClientError("Unavailable");
      }
      if (response.status === 403) throw new CounterOrderClientError("PermissionDenied");
      if (!response.ok) throw new CounterOrderClientError("Unavailable");
      return parseCounterMenu(await response.json());
    },
    /**
     * WP-2423 Q7 slice 2: a round for a table on behalf of its guests (or a paper round after an
     * outage), sent to the table's order; the reply is the amount to charge on the card machine.
     */
    async placeTableRound(command: {
      readonly operationReference: string;
      readonly tableReference: string;
      readonly lines: readonly TableRoundLine[];
      readonly tip: CounterTip;
      readonly recordedAfterOutage: boolean;
    }): Promise<PlacedCounterOrder> {
      const response = await post("/merchant/dining/staff-rounds", command);
      if (response.ok) return parsePlacedCounterOrder(await response.json(), true);
      const body = await errorOf(response);
      const code = body.error;
      if (response.status === 403) throw new CounterOrderClientError("PermissionDenied");
      // WP-2423: an item is short (or can't be sold); nothing was sent or charged.
      const refusal = itemRefusal(body);
      if (refusal !== null) throw refusal;
      if (code === "table_cart_has_items")
        throw new CounterOrderClientError(
          "TableCartHasItems",
          null,
          null,
          Array.isArray(body.items)
            ? body.items.flatMap((item: unknown) => {
                const entry = item as { name?: unknown; quantity?: unknown } | null;
                return typeof entry?.name === "string" &&
                  entry.name.length > 0 &&
                  entry.name.length <= 200 &&
                  Number.isSafeInteger(entry.quantity)
                  ? [{ name: entry.name, quantity: entry.quantity as number }]
                  : [];
              })
            : [],
        );
      if (code === "table_checkout_in_progress")
        throw new CounterOrderClientError("TableCheckoutInProgress");
      if (code === "table_unavailable") throw new CounterOrderClientError("TableUnavailable");
      if (code === "table_qr_missing") throw new CounterOrderClientError("TableHasNoQr");
      if (code === "store_not_taking_dine_in_orders")
        throw new CounterOrderClientError("StoreNotTakingOrders");
      if (code === "order_not_priced") throw new CounterOrderClientError("NotPriced");
      if (code === "staff_round_not_finished") throw new CounterOrderClientError("NotFinished");
      if (code === "staff_round_in_progress") throw new CounterOrderClientError("InProgress");
      if (code === "staff_round_conflict") throw new CounterOrderClientError("Conflict");
      // WP-2423: the server's own answer that it could not send the round (nothing was ordered or
      // charged; the next send is a new attempt), as opposed to no answer at all (OutcomeUnknown).
      if (code === "staff_round_unavailable") throw new CounterOrderClientError("SystemProblem");
      if (response.status === 400) throw new CounterOrderClientError("Invalid");
      throw new CounterOrderClientError(response.status >= 500 ? "OutcomeUnknown" : "Unavailable");
    },
    async placeOrder(command: {
      readonly operationReference: string;
      readonly lines: readonly CounterOrderLine[];
      readonly tip: CounterTip;
      readonly recordedAfterOutage: boolean;
    }): Promise<PlacedCounterOrder> {
      const response = await post("/merchant/counter/orders", command);
      if (response.ok) return parsePlacedCounterOrder(await response.json());
      const body = await errorOf(response);
      const code = body.error;
      if (response.status === 403) throw new CounterOrderClientError("PermissionDenied");
      // v15 run: too few in stock for the quantity ordered (or not sellable now); nothing was
      // placed or charged.
      const refusal = itemRefusal(body);
      if (refusal !== null) throw refusal;
      if (code === "store_not_taking_pickup_orders")
        throw new CounterOrderClientError("StoreNotTakingOrders");
      if (code === "order_not_priced") throw new CounterOrderClientError("NotPriced");
      if (code === "counter_order_not_finished") throw new CounterOrderClientError("NotFinished");
      if (code === "counter_order_in_progress") throw new CounterOrderClientError("InProgress");
      if (code === "counter_order_conflict") throw new CounterOrderClientError("Conflict");
      if (code === "counter_order_no_pickup_times")
        throw new CounterOrderClientError("NoPickupTimes");
      // WP-2423: a definite answer from the server that it could not place the order, as opposed
      // to no answer at all (a gateway or network failure keeps OutcomeUnknown).
      if (code === "counter_order_unavailable") throw new CounterOrderClientError("SystemProblem");
      if (response.status === 400) throw new CounterOrderClientError("Invalid");
      throw new CounterOrderClientError(response.status >= 500 ? "OutcomeUnknown" : "Unavailable");
    },
    async recordPayment(command: {
      readonly operationReference: string;
      readonly orderReference: string;
      readonly orderBatchReference: string;
      readonly expectedTotalMinor: string;
      readonly slipReference: string | null;
      readonly takenAt: string | null;
    }): Promise<RecordedCardPayment> {
      const response = await post("/merchant/orders/card-machine-payment", command);
      if (response.ok) {
        const raw = record(await response.json(), [
          "status",
          "orderReference",
          "orderBatchReference",
          "amountMinor",
          "recordingReason",
          "takenAt",
          "recordedAt",
          "acceptance",
        ]);
        if (
          (raw.status !== "Recorded" && raw.status !== "AlreadyRecorded") ||
          (raw.acceptance !== "Accepted" && raw.acceptance !== "NotAccepted") ||
          raw.orderReference !== command.orderReference ||
          (raw.recordingReason !== "AtCounter" && raw.recordingReason !== "RecordedAfterOutage") ||
          typeof raw.amountMinor !== "string" ||
          !minorPattern.test(raw.amountMinor) ||
          typeof raw.takenAt !== "string"
        )
          return invalid();
        return Object.freeze({
          status: raw.status,
          amountMinor: raw.amountMinor,
          recordingReason: raw.recordingReason,
          takenAt: raw.takenAt,
          acceptance: raw.acceptance,
        });
      }
      const body = await errorOf(response);
      const code = body.error;
      if (response.status === 403) throw new CounterOrderClientError("PermissionDenied");
      if (code === "amount_changed")
        throw new CounterOrderClientError(
          "AmountChanged",
          null,
          typeof body.totalMinor === "string" && minorPattern.test(body.totalMinor)
            ? body.totalMinor
            : null,
        );
      if (code === "payment_window_closed")
        throw new CounterOrderClientError("PaymentWindowClosed");
      if (code === "already_paid") throw new CounterOrderClientError("AlreadyPaid");
      if (code === "order_not_payable" || code === "counter_order_not_found")
        throw new CounterOrderClientError("NotPayable");
      if (code === "card_machine_conflict") throw new CounterOrderClientError("Conflict");
      if (response.status === 400) throw new CounterOrderClientError("Invalid");
      throw new CounterOrderClientError(response.status >= 500 ? "OutcomeUnknown" : "Unavailable");
    },
  });
}

/**
 * Owner 2026-10-26 (counter): one tile per drink, its sizes as buttons on it. The sizes of a Product
 * are its SKUs, published as separate sellables that share the Product version and are named by the
 * server as "<Product> — <Size>" ("Latte — Small (8 oz)"). Sellables are grouped only when both
 * agree — the same Product version and the same "<Product> — " prefix, every size different — as on
 * the customer menu; anything else stays its own tile.
 */
export interface CounterMenuFamily {
  readonly key: string;
  /** "Latte" for a sized Product; the item's own name otherwise. */
  readonly name: string;
  /** Each size with its label ("Small (8 oz)"); one entry, labelled with the full name, otherwise. */
  readonly sizes: readonly { readonly label: string; readonly item: CounterMenuItem }[];
}

const sizeSeparator = " — ";
function splitSizeName(name: string): readonly [string, string] | null {
  const index = name.indexOf(sizeSeparator);
  if (index < 1) return null;
  const product = name.slice(0, index).trim();
  const size = name.slice(index + sizeSeparator.length).trim();
  return product === "" || size === "" ? null : [product, size];
}

export function counterMenuFamilies(
  items: readonly CounterMenuItem[],
): readonly CounterMenuFamily[] {
  const byVersion = new Map<string, CounterMenuItem[]>();
  for (const item of items) {
    if (item.productVersionReference === null) continue;
    const group = byVersion.get(item.productVersionReference);
    if (group) group.push(item);
    else byVersion.set(item.productVersionReference, [item]);
  }
  const families: CounterMenuFamily[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    if (placed.has(item.sellableReference)) continue;
    const group =
      item.productVersionReference === null
        ? undefined
        : byVersion.get(item.productVersionReference);
    const parts =
      group && group.length > 1 ? group.map((entry) => splitSizeName(entry.name)) : null;
    const product = parts?.[0]?.[0];
    if (
      group &&
      parts &&
      product !== undefined &&
      parts.every((part) => part !== null && part[0] === product) &&
      new Set(parts.map((part) => part?.[1])).size === parts.length
    ) {
      group.forEach((entry) => placed.add(entry.sellableReference));
      families.push(
        Object.freeze({
          key: item.sellableReference,
          name: product,
          sizes: Object.freeze(
            group.map((entry, index) =>
              Object.freeze({ label: parts[index]?.[1] ?? entry.name, item: entry }),
            ),
          ),
        }),
      );
      continue;
    }
    placed.add(item.sellableReference);
    families.push(
      Object.freeze({
        key: item.sellableReference,
        name: item.name,
        sizes: Object.freeze([Object.freeze({ label: item.name, item })]),
      }),
    );
  }
  return Object.freeze(families);
}
