/** WP-2423 / DEC-INV-DIRECT-RECEIPT: Store receipt view contract and same-origin client. */
export type StoreReceiptErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "AlreadyVoided"
  | "StockUsed"
  | "LineInvalid"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class StoreReceiptPageError extends Error {
  constructor(
    readonly code: StoreReceiptErrorCode,
    readonly lineReference: string | null = null,
  ) {
    super("Receiving is unavailable");
    this.name = "StoreReceiptPageError";
  }
}
export interface ReceiptLine {
  readonly lineReference: string;
  readonly itemReference: string;
  readonly locationReference: string;
  readonly lotCode: string | null;
  readonly expiryDate: string | null;
  readonly acceptedQuantity: string;
  readonly rejectedQuantity: string;
  readonly damagedQuantity: string;
  readonly discrepancyReason: string | null;
  readonly unitCostMinor: number;
  readonly temperatureCelsius: string | null;
}
export interface StoreReceiptView {
  readonly receiptReference: string;
  readonly supplierName: string;
  readonly supplierDocument: string | null;
  readonly receivedAt: string;
  readonly lines: readonly ReceiptLine[];
  readonly voided: { readonly reasonCode: string; readonly voidedAt: string } | null;
}
export interface StoreReceiptPageView {
  readonly screenId: "INV-RECEIPT-LIST" | "INV-RECEIPT-DETAIL";
  readonly sourceAsOf: string;
  readonly permissions: { readonly mayReceive: boolean; readonly mayVoid: boolean };
  readonly discrepancyReasons: readonly string[];
  readonly voidReasons: readonly string[];
  readonly receipts: readonly StoreReceiptView[];
  readonly hasMore: boolean;
  readonly items: readonly {
    readonly itemReference: string;
    readonly internalCode: string;
    readonly name: string;
    readonly unitCode: string;
    readonly ledgerPrecision: number;
    readonly lotTracking: "NoLot" | "LotOptional" | "LotRequired" | "LotExpiryRequired";
  }[];
  readonly locations: readonly {
    readonly locationReference: string;
    readonly code: string;
    readonly name: string;
  }[];
}
export type StoreReceiptCommand =
  | {
      readonly action: "Post";
      readonly operationReference: string;
      readonly receiptReference: string;
      readonly supplierName: string;
      readonly supplierDocument: string | null;
      readonly lines: readonly ReceiptLine[];
    }
  | {
      readonly action: "Void";
      readonly operationReference: string;
      readonly receiptReference: string;
      readonly reasonCode: string;
    };
export interface StoreReceiptClient {
  load(input: {
    readonly receiptReference: string | null;
    readonly before: string | null;
  }): Promise<unknown>;
  command?(command: StoreReceiptCommand): Promise<unknown>;
}
export function parseStoreReceiptPageView(
  value: unknown,
  screenId: StoreReceiptPageView["screenId"],
): StoreReceiptPageView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== screenId ||
    !Array.isArray(r.receipts) ||
    !Array.isArray(r.items) ||
    !Array.isArray(r.locations) ||
    (screenId === "INV-RECEIPT-DETAIL" && r.receipts.length !== 1)
  )
    throw new Error("STORE_RECEIPT_PAGE_INVALID");
  return r as unknown as StoreReceiptPageView;
}
/** Extended line cost in cents, rounding half to even on the exact decimal product. */
export function lineCostCents(quantity: string, unitCostMinor: number): number {
  const [whole = "0", fraction = ""] = quantity.split(".");
  const scaled = BigInt(whole + fraction) * BigInt(unitCostMinor);
  const divisor = 10n ** BigInt(fraction.length);
  const quotient = scaled / divisor,
    remainder = scaled % divisor;
  const twice = remainder * 2n;
  const rounded =
    twice > divisor || (twice === divisor && quotient % 2n === 1n) ? quotient + 1n : quotient;
  return Number(rounded);
}
export const unavailableStoreReceiptClient: StoreReceiptClient = {
  load: async () => {
    throw new StoreReceiptPageError("Unavailable");
  },
};
const codes: Record<string, StoreReceiptErrorCode> = {
  PermissionDenied: "PermissionDenied",
  NotFound: "NotFound",
  Conflict: "Conflict",
  AlreadyVoided: "AlreadyVoided",
  StockUsed: "StockUsed",
  LineInvalid: "LineInvalid",
  Invalid: "Invalid",
};
export function createStoreReceiptClient(csrf: string, fetcher: typeof fetch = fetch) {
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
      throw new StoreReceiptPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
        lineReference?: unknown;
      } | null;
      throw new StoreReceiptPageError(
        codes[String(payload?.error)] ??
          (response.status === 403 ? "PermissionDenied" : "Unavailable"),
        typeof payload?.lineReference === "string" ? payload.lineReference : null,
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (input: { readonly receiptReference: string | null; readonly before: string | null }) =>
      post("/merchant/supply/receipts/query", input),
    command: (command: StoreReceiptCommand) => post("/merchant/supply/receipts/command", command),
  } satisfies StoreReceiptClient;
}
