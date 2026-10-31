import { FULL_SIGN_IN_REQUIRED, isFullSignInRequired } from "./full-sign-in.js";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE segment 9 (coordinator 2026-10-31 rule 1): at a Brand with several
 * Stores, the Store's manager, an area manager or the owner changes this Store's price for an item
 * directly (after confirming the old and new price), here only. At a Brand with one Store there is
 * one price, the Brand's (the one-page menu).
 */
export type StorePriceErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Invalid"
  | "Changed"
  | "NoPriceBook"
  | "NotMultiStore"
  | "NotCovered"
  | typeof FULL_SIGN_IN_REQUIRED
  | "Offline"
  | "Unavailable";
export class StorePriceError extends Error {
  constructor(readonly code: StorePriceErrorCode) {
    super(code);
    this.name = "StorePriceError";
  }
}
export interface StorePrice {
  readonly sellableReference: string;
  /** The Brand price, in cents. */
  readonly brandPriceMinor: string | null;
  /** This Store's own price, in cents (null: it charges the Brand price). */
  readonly storePriceMinor: string | null;
}
export interface StorePriceChange {
  readonly sellableReference: string | null;
  readonly previousAmountMinor: string | null;
  /** null: back to the Brand price. */
  readonly amountMinor: string | null;
  readonly changedBy: string;
  readonly changedAt: string;
}
export interface StorePricesView {
  readonly multiStore: boolean;
  readonly mayChange: boolean;
  readonly prices: ReadonlyMap<string, StorePrice>;
  readonly changes: readonly StorePriceChange[];
}
export interface ChangeStorePrice {
  readonly action: "ChangeStorePrice";
  readonly operationReference: string;
  readonly sellableReference: string;
  readonly expectedAmountMinor: string;
  readonly amountMinor: string | null;
}
export interface StorePricesClient {
  load(): Promise<unknown>;
  command(command: ChangeStorePrice): Promise<unknown>;
}

const minor = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,17})$/u.test(value))
    throw new StorePriceError("Unavailable");
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new StorePriceError("Unavailable");
  return value;
};
export function parseStorePricesView(value: unknown): StorePricesView {
  const raw = value as Record<string, unknown> | null;
  if (
    raw === null ||
    typeof raw !== "object" ||
    typeof raw.multiStore !== "boolean" ||
    typeof (raw.permissions as { mayChange?: unknown } | null)?.mayChange !== "boolean" ||
    !Array.isArray(raw.prices) ||
    !Array.isArray(raw.changes)
  )
    throw new StorePriceError("Unavailable");
  const prices = new Map<string, StorePrice>();
  for (const entry of raw.prices as Record<string, unknown>[]) {
    const sellableReference = text(entry.sellableReference);
    prices.set(sellableReference, {
      sellableReference,
      brandPriceMinor: minor(entry.brandPriceMinor),
      storePriceMinor: minor(entry.storePriceMinor),
    });
  }
  return {
    multiStore: raw.multiStore,
    mayChange: (raw.permissions as { mayChange: boolean }).mayChange,
    prices,
    changes: (raw.changes as Record<string, unknown>[]).map((change) => ({
      sellableReference: change.sellableReference === null ? null : text(change.sellableReference),
      previousAmountMinor: minor(change.previousAmountMinor),
      amountMinor: minor(change.amountMinor),
      changedBy: text(change.changedBy),
      changedAt: text(change.changedAt),
    })),
  };
}
/** What the Store charges for the item now (cents), or null when it is not priced. */
export const chargedHere = (price: StorePrice | undefined): string | null =>
  price?.storePriceMinor ?? price?.brandPriceMinor ?? null;

/** Dollars typed by staff ("7.25", "7", "$7.25") as cents, or null when it is not a price. */
export function centsFromDollars(value: string): string | null {
  const match = /^\$?\s*(\d{1,5})(?:\.(\d{1,2}))?$/u.exec(value.trim());
  if (match === null) return null;
  const cents = BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return cents.toString();
}

const codes = new Set<StorePriceErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Invalid",
  "Changed",
  "NoPriceBook",
  "NotMultiStore",
  "NotCovered",
]);
export function createStorePricesClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): StorePricesClient {
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
      throw new StorePriceError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (isFullSignInRequired(response.status, payload))
        throw new StorePriceError(FULL_SIGN_IN_REQUIRED);
      const code = String(payload?.error) as StorePriceErrorCode;
      throw new StorePriceError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: () => post("/merchant/commerce/store-prices/query", {}),
    command: (command) => post("/merchant/commerce/store-prices/command", command),
  };
}
