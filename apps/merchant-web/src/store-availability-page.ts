/** WP-2423 8.5: CAT-AVAILABILITY view contract and same-origin client for the selected Store. */
import { storeDayTime } from "./StoreTime.js";
import type { KitchenBoardView } from "./kitchen-board.js";
export type AvailabilityErrorCode =
  "PermissionDenied" | "NotFound" | "Conflict" | "Invalid" | "Offline" | "Unavailable";
export class AvailabilityPageError extends Error {
  constructor(readonly code: AvailabilityErrorCode) {
    super("Item availability is unavailable");
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
}
const decimal = /^-?(0|[1-9][0-9]*)([.][0-9]{1,6})?$/u;
function validStockSoldOut(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const raw = value as { ingredients?: unknown };
  return (
    typeof value === "object" &&
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
const orders = (n: number) => (n === 1 ? "1 open order" : `${n} open orders`);
/**
 * WP-2423 (2026-10-16): why guests see an offered item as sold out, in staff words: "All 2.8 L of
 * Whole milk is set aside for 11 open orders." The page links to Orders (or Inventory).
 */
export function stockSoldOutText(stock: StockSoldOut): string {
  const reasons = stock.ingredients.map((entry) => {
    const amount = (value: string) => stockAmount(value, entry.unitCode, entry.displayPrecision);
    const onHand = micro(entry.onHand),
      reserved = micro(entry.reserved);
    if (onHand <= 0n) return `no ${entry.name} is in stock`;
    if (reserved > 0n && reserved >= onHand)
      return `all ${amount(entry.onHand)} of ${entry.name} is set aside for ${orders(entry.openOrderCount)}`;
    if (reserved > 0n)
      return `${amount(entry.onHand)} of ${entry.name} is in stock, but ${amount(entry.reserved)} is set aside for ${orders(entry.openOrderCount)} and one needs ${amount(entry.required)}`;
    return `only ${amount(entry.available)} of ${entry.name} can be used and one needs ${amount(entry.required)}`;
  });
  if (reasons.length === 0)
    return "The ingredients in stock are on hold or past their use-by date.";
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
  readonly items: readonly AvailabilityItem[];
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
  if (until === null) return "Sold out until brought back";
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
    return "Sold out for the rest of today";
  return `Sold out until ${storeDayTime(until, timeZone, now)}`;
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
