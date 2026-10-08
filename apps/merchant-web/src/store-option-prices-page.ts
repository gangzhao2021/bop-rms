/** WP-2423 slice 4.3: PRICE-OPTION-LIST view contract, money text and same-origin client. */
export type OptionPriceErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "ApprovalRequired"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class OptionPricePageError extends Error {
  constructor(readonly code: OptionPriceErrorCode) {
    super("Option prices are unavailable");
    this.name = "OptionPricePageError";
  }
}
export interface OptionPriceRow {
  readonly optionReference: string;
  readonly name: string;
  readonly offered: boolean;
  readonly ruleReference: string | null;
  readonly aggregateVersion: number | null;
  /** The published price in minor units; null when none is published. */
  readonly priceMinor: string | null;
  readonly pending: { readonly priceMinor: string; readonly byViewer: boolean } | null;
}
export interface OptionPriceProduct {
  readonly productReference: string;
  readonly name: string;
  readonly optionSets: readonly {
    readonly bindingReference: string;
    readonly name: string;
    readonly options: readonly OptionPriceRow[];
  }[];
}
export interface OptionPriceView {
  readonly screenId: "PRICE-OPTION-LIST";
  readonly sourceAsOf: string;
  readonly currency: { readonly code: string; readonly minorUnitExponent: number };
  readonly permissions: { readonly mayEdit: boolean; readonly mayApprove: boolean };
  readonly products: readonly OptionPriceProduct[];
}
export type OptionPriceCommand =
  | {
      readonly action: "SetPrices";
      readonly operationReference: string;
      readonly prices: readonly {
        readonly bindingReference: string;
        readonly optionReference: string;
        readonly amountMinor: string;
        readonly expectedAggregateVersion: number | null;
        readonly replacesPending: boolean;
      }[];
    }
  | {
      readonly action: "Publish";
      readonly operationReference: string;
      readonly rules: readonly {
        readonly ruleReference: string;
        readonly expectedAggregateVersion: number;
      }[];
    };
export interface OptionPriceClient {
  load(): Promise<unknown>;
  command?(command: OptionPriceCommand): Promise<unknown>;
}
export function parseOptionPriceView(value: unknown): OptionPriceView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "PRICE-OPTION-LIST" ||
    !Array.isArray(r.products) ||
    typeof (r.currency as { minorUnitExponent?: unknown } | null)?.minorUnitExponent !== "number"
  )
    throw new Error("OPTION_PRICE_PAGE_INVALID");
  return r as unknown as OptionPriceView;
}
/** "0.75" from 75 minor units (exponent 2); "0.00" for 0. */
export function moneyText(minor: string, exponent: number): string {
  const digits = minor.padStart(exponent + 1, "0");
  return exponent === 0 ? digits : digits.slice(0, -exponent) + "." + digits.slice(-exponent);
}
/** Minor units from "0.75", ".5", "1" or "0"; null when not a price (negative, too precise). */
export function parseMoney(text: string, exponent: number): string | null {
  const trimmed = text.trim();
  const match = new RegExp(`^(\\d{0,6})(?:\\.(\\d{0,${exponent}}))?$`, "u").exec(trimmed);
  if (match === null || trimmed === "" || trimmed === ".") return null;
  const whole = match[1] ?? "";
  const fraction = (match[2] ?? "").padEnd(exponent, "0");
  return BigInt((whole || "0") + fraction).toString();
}
export const unavailableOptionPriceClient: OptionPriceClient = {
  load: async () => {
    throw new OptionPricePageError("Unavailable");
  },
};
const codes = new Set<OptionPriceErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "ApprovalRequired",
  "Invalid",
]);
export function createOptionPriceClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): OptionPriceClient {
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
      throw new OptionPricePageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const code = String(payload?.error) as OptionPriceErrorCode;
      throw new OptionPricePageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: () => post("/merchant/commerce/option-prices/query", {}),
    command: (command) => post("/merchant/commerce/option-prices/command", command),
  };
}
