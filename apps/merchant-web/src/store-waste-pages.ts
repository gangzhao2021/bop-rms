import { t } from "./i18n/i18n.js";
/** WP-2423 / DEC-INV-WASTE: waste recording and review contract and client. */
export type StoreWasteErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "NotEnoughStock"
  | "AlreadyReviewed"
  | "NotIndependent"
  | "LineInvalid"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class StoreWastePageError extends Error {
  constructor(
    readonly code: StoreWasteErrorCode,
    readonly lineReference: string | null = null,
  ) {
    super(t("Waste is unavailable"));
    this.name = "StoreWastePageError";
  }
}
export interface WasteLineInput {
  readonly lineReference: string;
  readonly itemReference: string;
  readonly locationReference: string;
  readonly lotReference: string | null;
  readonly quantity: string;
  readonly reasonCode: string;
  readonly note: string | null;
}
export interface WasteRecordView {
  readonly wasteReference: string;
  readonly lines: readonly (WasteLineInput & {
    readonly unitCode: string;
    readonly unitCostMinor: number | null;
    readonly valueMinor: number;
  })[];
  readonly valueMinor: number;
  readonly costUnknown: boolean;
  readonly needsReview: boolean;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /**
   * WP-2423 (2026-10-18): a Kitchen remake used more than stock showed as available. The food was
   * thrown away; this much did not leave stock and the item needs counting.
   */
  readonly shortfalls?: readonly {
    readonly itemReference: string;
    readonly locationReference: string;
    readonly unitCode: string;
    readonly wastedQuantity: string;
    readonly recordedQuantity: string;
    readonly missingQuantity: string;
  }[];
  readonly review: {
    readonly decision: "Accepted" | "Voided";
    readonly reasonCode: string;
    readonly reviewedBy: string;
    readonly reviewedAt: string;
  } | null;
}
export interface StoreWasteView {
  readonly screenId: "INV-WASTE-LIST" | "INV-WASTE-DETAIL";
  readonly sourceAsOf: string;
  readonly viewer: string;
  readonly permissions: {
    readonly mayRecord: boolean;
    readonly mayRead: boolean;
    readonly mayReview: boolean;
  };
  readonly reasons: readonly string[];
  readonly acceptReasons: readonly string[];
  readonly voidReasons: readonly string[];
  readonly reviewThresholdMinor: number;
  readonly items: readonly {
    readonly itemReference: string;
    readonly name: string;
    readonly unitCode: string;
    readonly ledgerPrecision: number;
    readonly lotTracking: string;
  }[];
  readonly locations: readonly { readonly locationReference: string; readonly name: string }[];
  readonly stock: readonly {
    readonly itemReference: string;
    readonly locationReference: string;
    readonly lotReference: string | null;
    readonly lotCode: string | null;
    readonly expiryDate: string | null;
    readonly unitCode: string;
    /** What is physically there: the most a waste line can take. */
    readonly onHand: string;
    /** Held by open orders. */
    readonly reserved: string;
    /** on hand − held; zero or below when open orders hold all of it or are short. */
    readonly available: string;
  }[];
  readonly people: Readonly<Record<string, string>>;
  readonly records: readonly WasteRecordView[];
  readonly hasMore: boolean;
}
export type StoreWasteCommand =
  | {
      readonly action: "Record";
      readonly operationReference: string;
      readonly wasteReference: string;
      readonly lines: readonly WasteLineInput[];
    }
  | {
      readonly action: "Review";
      readonly operationReference: string;
      readonly wasteReference: string;
      readonly decision: "Accepted" | "Voided";
      readonly reasonCode: string;
    };
export interface StoreWasteClient {
  load(input: {
    readonly wasteReference: string | null;
    readonly needsReviewOnly: boolean;
  }): Promise<unknown>;
  command?(command: StoreWasteCommand): Promise<unknown>;
}
export function parseStoreWasteView(
  value: unknown,
  screenId: StoreWasteView["screenId"],
): StoreWasteView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== screenId ||
    !Array.isArray(r.records) ||
    !Array.isArray(r.stock) ||
    (screenId === "INV-WASTE-DETAIL" && r.records.length !== 1)
  )
    throw new Error("STORE_WASTE_PAGE_INVALID");
  return r as unknown as StoreWasteView;
}
/** Quantity entry within the item's precision and the stock on hand (exact decimals). */
export function wasteQuantityAllowed(value: string, precision: number, onHand: string): boolean {
  const match = /^(?:0|[1-9]\d{0,11})(?:\.(\d{1,6}))?$/u.exec(value.trim());
  if (!match || (match[1]?.length ?? 0) > precision || /^0(?:\.0+)?$/u.test(value.trim()))
    return false;
  const scaled = (text: string) => {
    const [whole = "0", fraction = ""] = text.split(".");
    return BigInt(whole + fraction.padEnd(6, "0").slice(0, 6));
  };
  return scaled(value.trim()) <= scaled(onHand);
}
/**
 * DEC-INV-COUNT-SHORT amendment (2026-10-18): whether recording `value` takes stock open orders hold
 * (more than is free, or nothing is free). The waste is still recorded — it is gone — and those
 * orders become (more) short. Exact decimals; `available` may be negative.
 */
export function wasteTakesHeldStock(value: string, available: string): boolean {
  const scaled = (text: string) => {
    const negative = text.startsWith("-");
    const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
    return (negative ? -1n : 1n) * BigInt(whole + fraction.padEnd(6, "0").slice(0, 6));
  };
  if (!/^-?\d+(?:\.\d+)?$/u.test(available)) return false;
  if (scaled(available) <= 0n) return true;
  return /^\d+(?:\.\d+)?$/u.test(value.trim()) && scaled(value.trim()) > scaled(available);
}
/**
 * v15 store-day L3: an available stock quantity as staff read it: at most two decimals, trailing
 * zeros dropped ("100.6959" -> "100.69", "4.500" -> "4.5"). It rounds down, so the amount shown can
 * always be recorded; a non-zero amount below 0.01 is shown exactly rather than as "0". Display
 * only: what staff type is sent exactly as typed.
 */
export function availableQuantityText(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (!match) return value;
  const whole = match[1] as string;
  const fraction = (match[2] ?? "").replace(/0+$/u, "");
  const shown = fraction.slice(0, 2).replace(/0+$/u, "");
  if (fraction.length > 2 && /^0+$/u.test(whole) && shown === "") return `${whole}.${fraction}`;
  return shown === "" ? whole : `${whole}.${shown}`;
}
export const centsText = (minor: number) =>
  (minor < 0 ? "-" : "") +
  Math.floor(Math.abs(minor) / 100) +
  "." +
  String(Math.abs(minor) % 100).padStart(2, "0");
export const unavailableStoreWasteClient: StoreWasteClient = {
  load: async () => {
    throw new StoreWastePageError("Unavailable");
  },
};
const codes = new Set<StoreWasteErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "NotEnoughStock",
  "AlreadyReviewed",
  "NotIndependent",
  "LineInvalid",
  "Invalid",
]);
export function createStoreWasteClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): StoreWasteClient {
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
      throw new StoreWastePageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
        lineReference?: unknown;
      } | null;
      const code = String(payload?.error) as StoreWasteErrorCode;
      throw new StoreWastePageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
        typeof payload?.lineReference === "string" ? payload.lineReference : null,
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (input) => post("/merchant/supply/waste/query", { ...input, before: null }),
    command: (command) => post("/merchant/supply/waste/command", command),
  };
}
