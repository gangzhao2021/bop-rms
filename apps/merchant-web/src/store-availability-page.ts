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
        statuses.has(String((item as { status?: unknown }).status)),
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
