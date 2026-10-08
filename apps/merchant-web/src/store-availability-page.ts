/** WP-2423 8.5: CAT-AVAILABILITY view contract and same-origin client for the selected Store. */
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
  readonly permissions: { readonly mayOffer: boolean; readonly mayMarkSoldOut: boolean };
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
/** "Sold out until 23:59" style text in the Store's time zone; null means until brought back. */
export function soldOutText(until: string | null, timeZone: string): string {
  if (until === null) return "Sold out until brought back";
  const end = new Date(Date.parse(until) - 1);
  const time = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(end);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(end);
  return `Sold out through ${day} ${time}`;
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
