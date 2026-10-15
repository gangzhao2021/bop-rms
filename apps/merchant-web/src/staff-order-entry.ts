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
      | "TableCartHasItems"
      | "TableCheckoutInProgress"
      | "ItemUnavailable"
      | "NotPriced"
      | "NotFinished"
      | "InProgress"
      | "AmountChanged"
      | "PaymentWindowClosed"
      | "AlreadyPaid"
      | "NotPayable"
      | "Invalid"
      | "Conflict"
      | "Unavailable"
      | "OutcomeUnknown",
    /** ItemUnavailable: the line the store cannot sell now. */
    readonly lineIndex: number | null = null,
    /** AmountChanged: the amount to charge now. */
    readonly totalMinor: string | null = null,
    /** TableCartHasItems: what guests put in the table's shared cart and haven't sent. */
    readonly pendingItems: readonly { readonly name: string; readonly quantity: number }[] = [],
  ) {
    super("Counter order request failed");
    this.name = "CounterOrderClientError";
  }
}
const invalid = (): never => {
  throw new CounterOrderClientError("Unavailable");
};
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
              const item = record(value, [
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
              ]);
              const price = record(item.displayPrice, ["status", "amount", "currency", "reason"]);
              if (
                (item.availability !== "Available" && item.availability !== "SoldOut") ||
                !Array.isArray(item.optionRules)
              )
                return invalid();
              return Object.freeze({
                sellableReference: ref(item.sellableReference),
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
  readonly payBy: string;
  readonly recordedAfterOutage: boolean;
  /** WP-2423 Q7 slice 2: the table a staff-entered round joined (null at the counter). */
  readonly tableLabel: string | null;
}
export function parsePlacedCounterOrder(value: unknown, table = false): PlacedCounterOrder {
  const raw = record(value, [
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
  ]);
  if (
    (raw.status !== "Placed" && raw.status !== "AlreadyPlaced") ||
    !Number.isInteger(raw.orderVersion) ||
    typeof raw.recordedAfterOutage !== "boolean" ||
    ![raw.orderMinor, raw.tipMinor, raw.totalMinor].every(
      (value) => typeof value === "string" && minorPattern.test(value),
    ) ||
    BigInt(raw.orderMinor as string) + BigInt(raw.tipMinor as string) !==
      BigInt(raw.totalMinor as string) ||
    typeof raw.payBy !== "string" ||
    !Number.isFinite(Date.parse(raw.payBy))
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
    payBy: raw.payBy,
    recordedAfterOutage: raw.recordedAfterOutage,
    tableLabel: table && raw.tableLabel !== null ? text(raw.tableLabel, 120) : null,
  });
}

export interface RecordedCardPayment {
  readonly status: "Recorded" | "AlreadyRecorded";
  readonly amountMinor: string;
  readonly recordingReason: "AtCounter" | "RecordedAfterOutage";
  readonly takenAt: string;
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
      if (code === "item_unavailable")
        throw new CounterOrderClientError(
          "ItemUnavailable",
          typeof body.lineIndex === "number" ? body.lineIndex : null,
        );
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
      if (code === "store_not_taking_dine_in_orders")
        throw new CounterOrderClientError("StoreNotTakingOrders");
      if (code === "order_not_priced") throw new CounterOrderClientError("NotPriced");
      if (code === "staff_round_not_finished") throw new CounterOrderClientError("NotFinished");
      if (code === "staff_round_in_progress") throw new CounterOrderClientError("InProgress");
      if (code === "staff_round_conflict") throw new CounterOrderClientError("Conflict");
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
      if (code === "item_unavailable")
        throw new CounterOrderClientError(
          "ItemUnavailable",
          typeof body.lineIndex === "number" ? body.lineIndex : null,
        );
      if (code === "store_not_taking_pickup_orders")
        throw new CounterOrderClientError("StoreNotTakingOrders");
      if (code === "order_not_priced") throw new CounterOrderClientError("NotPriced");
      if (code === "counter_order_not_finished") throw new CounterOrderClientError("NotFinished");
      if (code === "counter_order_in_progress") throw new CounterOrderClientError("InProgress");
      if (code === "counter_order_conflict") throw new CounterOrderClientError("Conflict");
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
        ]);
        if (
          (raw.status !== "Recorded" && raw.status !== "AlreadyRecorded") ||
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
