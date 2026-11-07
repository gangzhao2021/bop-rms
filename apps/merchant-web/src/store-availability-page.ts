import { listSeparator, t } from "./i18n/i18n.js";
/** WP-2423 8.5: CAT-AVAILABILITY view contract and same-origin client for the selected Store. */
import { storeDayTime } from "./StoreTime.js";
import type { KitchenBoardView } from "./kitchen-board.js";
export type AvailabilityErrorCode =
  "PermissionDenied" | "NotFound" | "Conflict" | "Invalid" | "Offline" | "Unavailable";
export class AvailabilityPageError extends Error {
  constructor(readonly code: AvailabilityErrorCode) {
    super(t("Item availability is unavailable"));
    this.name = "AvailabilityPageError";
  }
}
export type ItemAvailabilityStatus =
  "Available" | "SoldOut" | "Unavailable" | "NotOffered" | "Varies";
export interface AvailabilityItem {
  readonly skuReference: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly sizeName: string;
  readonly status: ItemAvailabilityStatus;
  readonly soldOutUntil: string | null;
  /**
   * WP-2423 (2026-10-16): offered, but guests see it sold out because stock cannot cover one
   * (absent from an older server, null when stock covers it or is unknown).
   */
  readonly stockSoldOut?: StockSoldOut | null;
  /**
   * WP-2423 (M78): what the stock read says — "Short" (guests see it sold out), "Enough", or
   * "Unknown" (no recipe stock, or not read). Absent from an older server.
   */
  readonly stock?: "Short" | "Enough" | "Unknown";
}
export interface StockShortIngredient {
  readonly name: string;
  readonly unitCode: string;
  readonly displayPrecision: number;
  readonly required: string;
  readonly onHand: string;
  readonly reserved: string;
  readonly available: string;
  readonly openOrderCount: number;
}
export interface StockSoldOut {
  readonly ingredients: readonly StockShortIngredient[];
  /** A new Store before its first delivery: no stock was ever received there. */
  readonly noStockReceived?: true;
}
const decimal = /^-?(0|[1-9][0-9]*)([.][0-9]{1,6})?$/u;
function validStockSoldOut(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const raw = value as { ingredients?: unknown; noStockReceived?: unknown };
  return (
    typeof value === "object" &&
    (raw.noStockReceived === undefined || raw.noStockReceived === true) &&
    Array.isArray(raw.ingredients) &&
    raw.ingredients.length <= 50 &&
    raw.ingredients.every((entry: unknown) => {
      const e = entry as Record<string, unknown> | null;
      return (
        e !== null &&
        typeof e === "object" &&
        typeof e.name === "string" &&
        typeof e.unitCode === "string" &&
        Number.isInteger(e.displayPrecision) &&
        ["required", "onHand", "reserved", "available"].every(
          (key) => typeof e[key] === "string" && decimal.test(e[key] as string),
        ) &&
        Number.isInteger(e.openOrderCount) &&
        (e.openOrderCount as number) >= 0
      );
    })
  );
}
const micro = (value: string) => {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const magnitude = BigInt(whole + fraction.padEnd(6, "0").slice(0, 6));
  return negative ? -magnitude : magnitude;
};
const unitLabel: Readonly<Record<string, string>> = {
  KG: "kg",
  G: "g",
  L: "L",
  ML: "mL",
  EA: "",
  EACH: "",
  PCS: "",
};
/** "2.8 L", "0.5 kg", "12" — the ingredient's own display precision, trailing zeros dropped. */
export function stockAmount(value: string, unitCode: string, displayPrecision: number): string {
  const m = micro(value);
  const negative = m < 0n;
  const abs = negative ? -m : m;
  const precision = Math.max(0, Math.min(6, displayPrecision));
  const step = 10n ** BigInt(6 - precision);
  const rounded = (abs + step / 2n) / step;
  const scale = 10n ** BigInt(precision);
  const whole = (rounded / scale).toString();
  const fraction =
    precision === 0
      ? ""
      : (rounded % scale).toString().padStart(precision, "0").replace(/0+$/u, "");
  const unit = unitLabel[unitCode] ?? unitCode.toLowerCase();
  return (
    (negative ? "-" : "") + whole + (fraction ? "." + fraction : "") + (unit ? " " + unit : "")
  );
}
const orders = (n: number) => (n === 1 ? t("1 open order") : t("{n} open orders", { n: n }));
/**
 * WP-2423 (2026-10-16): why guests see an offered item as sold out, in staff words: "All 2.8 L of
 * Whole milk is set aside for 11 open orders." The page links to Orders (or Inventory).
 */
export function stockSoldOutText(stock: StockSoldOut): string {
  if (stock.noStockReceived === true)
    return t(
      "No stock has been received at this store yet. Record its first delivery and guests can order it.",
    );
  const reasons = stock.ingredients.map((entry) => {
    const amount = (value: string) => stockAmount(value, entry.unitCode, entry.displayPrecision);
    const onHand = micro(entry.onHand),
      reserved = micro(entry.reserved);
    if (onHand <= 0n) return t("no {name} is in stock", { name: entry.name });
    if (reserved > 0n && reserved >= onHand)
      return t("all {onHand} of {name} is set aside for {openOrderCount}", {
        onHand: amount(entry.onHand),
        name: entry.name,
        openOrderCount: orders(entry.openOrderCount),
      });
    if (reserved > 0n)
      return t(
        "{onHand} of {name} is in stock, but {reserved} is set aside for {openOrderCount} and one needs {required}",
        {
          onHand: amount(entry.onHand),
          name: entry.name,
          reserved: amount(entry.reserved),
          openOrderCount: orders(entry.openOrderCount),
          required: amount(entry.required),
        },
      );
    return t("only {available} of {name} can be used and one needs {required}", {
      available: amount(entry.available),
      name: entry.name,
      required: amount(entry.required),
    });
  });
  if (reasons.length === 0)
    return t("The ingredients in stock are on hold or past their use-by date.");
  const text = reasons.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}
/** Whether the reason names stock set aside for open orders (the page then links to Orders). */
export function stockHeldByOrders(stock: StockSoldOut): boolean {
  return stock.ingredients.some((entry) => micro(entry.reserved) > 0n && entry.openOrderCount > 0);
}
export interface StoreAvailabilityView {
  readonly screenId: "CAT-AVAILABILITY";
  readonly sourceAsOf: string;
  readonly viewer: string;
  readonly timeZone: string;
  readonly permissions: {
    readonly mayOffer: boolean;
    readonly mayMarkSoldOut: boolean;
    /** WP-2423 Q17: false for floor staff, who mark items sold out for today only. */
    readonly mayMarkUntilBack?: boolean;
  };
  /** WP-2423 (M78): "NotChecked" when stock could not be read, so short items are not marked. */
  readonly stockCheck?: "Checked" | "NotChecked";
  readonly items: readonly AvailabilityItem[];
  /** WP-2423 (M24): choices and extras dishes on sale offer (absent from an older server). */
  readonly options?: readonly AvailabilityOption[];
}
/** WP-2423 (M24): one choice or extra; a mark stops it in every dish that offers it, here only. */
export interface AvailabilityOption {
  readonly optionReference: string;
  readonly name: string;
  readonly dishNames: readonly string[];
  readonly status: "Available" | "SoldOut";
  readonly soldOutUntil: string | null;
}
export type AvailabilityCommand =
  | {
      readonly action: "Offer" | "StopOffering" | "BackInStock";
      readonly operationReference: string;
      readonly skuReference: string;
    }
  | {
      readonly action: "SoldOut";
      readonly operationReference: string;
      readonly skuReference: string;
      readonly until: "EndOfDay" | "UntilBack";
    }
  | {
      readonly action: "OptionSoldOut";
      readonly operationReference: string;
      readonly optionReference: string;
      readonly until: "EndOfDay" | "UntilBack";
    }
  | {
      readonly action: "OptionBackOn";
      readonly operationReference: string;
      readonly optionReference: string;
    };
/** The item or choice a command is about (a retry reuses the operation for the same one). */
export const commandTarget = (command: AvailabilityCommand): string =>
  "skuReference" in command ? command.skuReference : command.optionReference;
/** "In: Milk tea, Taro milk tea +4" — at most three dishes named. */
export function optionDishesText(dishNames: readonly string[]): string {
  const shown = dishNames.slice(0, 3).join(listSeparator());
  const more = dishNames.length - 3;
  return t("In: {list}", { list: more > 0 ? shown + " +" + more : shown });
}
/** Choices whose name or dishes contain the search text (either language, as typed). */
export function optionMatches(option: AvailabilityOption, search: string): boolean {
  const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
  const query = fold(search.trim());
  return (
    query === "" ||
    fold(option.name).includes(query) ||
    option.dishNames.some((dish) => fold(dish).includes(query))
  );
}
const validOption = (value: unknown): boolean => {
  const o = value as Record<string, unknown> | null;
  return (
    o !== null &&
    typeof o === "object" &&
    typeof o.optionReference === "string" &&
    typeof o.name === "string" &&
    Array.isArray(o.dishNames) &&
    o.dishNames.every((dish) => typeof dish === "string") &&
    (o.status === "Available" || o.status === "SoldOut") &&
    (o.soldOutUntil === null || typeof o.soldOutUntil === "string")
  );
};
export interface AvailabilityClient {
  load(): Promise<unknown>;
  command?(command: AvailabilityCommand): Promise<unknown>;
}
const statuses = new Set(["Available", "SoldOut", "Unavailable", "NotOffered", "Varies"]);
export function parseStoreAvailabilityView(value: unknown): StoreAvailabilityView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "CAT-AVAILABILITY" ||
    (r.stockCheck !== undefined && r.stockCheck !== "Checked" && r.stockCheck !== "NotChecked") ||
    (r.options !== undefined && (!Array.isArray(r.options) || !r.options.every(validOption))) ||
    !Array.isArray(r.items) ||
    !r.items.every(
      (item: unknown) =>
        item !== null &&
        typeof item === "object" &&
        statuses.has(String((item as { status?: unknown }).status)) &&
        validStockSoldOut((item as { stockSoldOut?: unknown }).stockSoldOut),
    )
  )
    throw new Error("AVAILABILITY_PAGE_INVALID");
  return r as unknown as StoreAvailabilityView;
}
/**
 * How long an item stays sold out, in the Store's time and staff words (WP-2423): "Sold out for
 * the rest of today" when the mark ends at the Store's midnight, "Sold out until 4:00 AM tomorrow"
 * when it ends with a late business day; null means until someone brings it back.
 */
export function soldOutText(
  until: string | null,
  timeZone: string,
  now: Date = new Date(),
): string {
  if (until === null) return t("Sold out until brought back");
  const end = new Date(until);
  const local = (at: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
  // Ends exactly at the start of the next calendar day: the rest of today.
  const lastMinute = local(new Date(end.getTime() - 60_000));
  if (local(end).endsWith("00:00") && lastMinute.slice(0, 10) === local(now).slice(0, 10))
    return t("Sold out for the rest of today");
  return t("Sold out until {until}", { until: storeDayTime(until, timeZone, now) });
}
/** What a viewer may do with one item (WP-2423 Q17: floor staff mark sold out for today only). */
export type AvailabilityAction =
  | "SoldOutToday"
  | "SoldOutUntilBack"
  | "BackInStock"
  | "ManagerBringsBack"
  | "Offer"
  | "StopOffering";
/** Kitchen and Front of House: sold out for today and back in stock, nothing else. */
export function floorStaffOnly(permissions: StoreAvailabilityView["permissions"]): boolean {
  return (
    permissions.mayMarkSoldOut &&
    !(permissions.mayMarkUntilBack ?? permissions.mayMarkSoldOut) &&
    !permissions.mayOffer
  );
}
/**
 * WP-2423 Q17 / IDR-0039: on the kitchen display, what the page offers is today's sold-out mark and
 * bringing it back, whatever the person's roles allow elsewhere. Presentation only: the server
 * still checks every request. The signal is the operator status the kitchen board read reports for
 * this sign-in; only a counter or office sign-in ("Unverified") that opened this route sees its own
 * reported permissions. While that status is unknown, the page stays with the kitchen's actions.
 */
export function kitchenDisplayPermissions(
  permissions: StoreAvailabilityView["permissions"],
  operator: KitchenBoardView["operatorStatus"] | null,
): StoreAvailabilityView["permissions"] {
  if (operator === "Unverified") return permissions;
  return { mayOffer: false, mayMarkSoldOut: permissions.mayMarkSoldOut, mayMarkUntilBack: false };
}
export function availabilityActions(
  item: Pick<AvailabilityItem, "status" | "soldOutUntil">,
  permissions: StoreAvailabilityView["permissions"],
): AvailabilityAction[] {
  const untilBack = permissions.mayMarkUntilBack ?? permissions.mayMarkSoldOut;
  const selling = item.status === "Available" || item.status === "Varies";
  const actions: AvailabilityAction[] = [];
  if (permissions.mayMarkSoldOut && selling) actions.push("SoldOutToday");
  if (untilBack && selling) actions.push("SoldOutUntilBack");
  if (permissions.mayMarkSoldOut && item.status === "SoldOut")
    actions.push(!untilBack && item.soldOutUntil === null ? "ManagerBringsBack" : "BackInStock");
  if (permissions.mayOffer && (item.status === "NotOffered" || item.status === "Unavailable"))
    actions.push("Offer");
  if (permissions.mayOffer && selling) actions.push("StopOffering");
  return actions;
}
export const unavailableAvailabilityClient: AvailabilityClient = {
  load: async () => {
    throw new AvailabilityPageError("Unavailable");
  },
};
const codes = new Set<AvailabilityErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "Invalid",
]);
export function createAvailabilityClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): AvailabilityClient {
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AvailabilityPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const code = String(payload?.error) as AvailabilityErrorCode;
      throw new AvailabilityPageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: () => post("/merchant/commerce/availability/query", {}),
    command: (command) => post("/merchant/commerce/availability/command", command),
  };
}
