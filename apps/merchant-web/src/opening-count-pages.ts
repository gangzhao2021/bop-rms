/** WP-2423 / DEC-INV-OPENING: INV-OPENING-COUNT view contract, money helpers and client. */
export type OpeningCountErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "AlreadyPosted"
  | "StockExists"
  | "LineInvalid"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class OpeningCountPageError extends Error {
  constructor(
    readonly code: OpeningCountErrorCode,
    readonly lineReference: string | null = null,
  ) {
    super("Opening count is unavailable");
    this.name = "OpeningCountPageError";
  }
}
export type LotTracking = "NoLot" | "LotOptional" | "LotRequired" | "LotExpiryRequired";
export interface OpeningLine {
  readonly lineReference: string;
  readonly itemReference: string;
  readonly locationReference: string;
  readonly lotCode: string | null;
  readonly expiryDate: string | null;
  readonly quantity: string;
  readonly unitCostMinor: number | null;
}
export interface OpeningCountPageView {
  readonly screenId: "INV-OPENING-COUNT";
  readonly sourceAsOf: string;
  readonly permissions: { readonly mayCount: boolean; readonly mayPost: boolean };
  readonly postedCountReference: string | null;
  readonly counts: readonly {
    readonly countReference: string;
    readonly lifecycle: "Draft" | "Submitted" | "Posted" | "Cancelled";
    readonly version: number;
    readonly lineCount: number;
    readonly updatedAt: string;
    readonly submittedBySelf: boolean;
  }[];
  readonly selected: {
    readonly countReference: string;
    readonly lifecycle: "Draft" | "Submitted" | "Posted" | "Cancelled";
    readonly version: number;
    readonly lines: readonly OpeningLine[];
  } | null;
  readonly items: readonly {
    readonly itemReference: string;
    readonly internalCode: string;
    readonly name: string;
    readonly unitCode: string;
    readonly ledgerPrecision: number;
    readonly lotTracking: LotTracking;
  }[];
  readonly locations: readonly {
    readonly locationReference: string;
    readonly code: string;
    readonly name: string;
  }[];
}
export interface OpeningCountClient {
  load(countReference: string | null): Promise<unknown>;
  command?(body: {
    readonly action: "Create" | "SaveLines" | "Submit" | "Reopen" | "Cancel" | "Post";
    readonly operationReference: string;
    readonly countReference: string;
    readonly expectedVersion: number | null;
    readonly lines: readonly OpeningLine[] | null;
  }): Promise<unknown>;
}

/** Exact CAD dollars text ("12", "12.5", "12.50") to integer cents, without binary floating point. */
export function dollarsToCents(value: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/u.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
export function centsToDollars(value: number | null): string {
  if (value === null) return "";
  return `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

const lifecycles = ["Draft", "Submitted", "Posted", "Cancelled"];
const invalid = (): never => {
  throw new Error("OPENING_COUNT_PAGE_INVALID");
};
/** Structural check of the server view; the server validates every value it accepts. */
export function parseOpeningCountPageView(value: unknown): OpeningCountPageView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "INV-OPENING-COUNT" ||
    !Array.isArray(r.counts) ||
    !Array.isArray(r.items) ||
    !Array.isArray(r.locations) ||
    typeof r.permissions !== "object" ||
    r.permissions === null
  )
    return invalid();
  for (const count of r.counts as Record<string, unknown>[])
    if (!lifecycles.includes(String(count.lifecycle))) invalid();
  const selected = r.selected as Record<string, unknown> | null;
  if (
    selected !== null &&
    (!lifecycles.includes(String(selected.lifecycle)) || !Array.isArray(selected.lines))
  )
    invalid();
  return r as unknown as OpeningCountPageView;
}
export const unavailableOpeningCountClient: OpeningCountClient = {
  load: async () => {
    throw new OpeningCountPageError("Unavailable");
  },
};
const codes: Record<string, OpeningCountErrorCode> = {
  PermissionDenied: "PermissionDenied",
  NotFound: "NotFound",
  Conflict: "Conflict",
  AlreadyPosted: "AlreadyPosted",
  StockExists: "StockExists",
  LineInvalid: "LineInvalid",
  Invalid: "Invalid",
  Unavailable: "Unavailable",
};
export function createOpeningCountClient(csrf: string, fetcher: typeof fetch = fetch) {
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
      throw new OpeningCountPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
        lineReference?: unknown;
      } | null;
      throw new OpeningCountPageError(
        codes[String(payload?.error)] ??
          (response.status === 403 ? "PermissionDenied" : "Unavailable"),
        typeof payload?.lineReference === "string" ? payload.lineReference : null,
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (countReference: string | null) =>
      post("/merchant/supply/opening-count/query", { countReference }),
    command: (body: Parameters<NonNullable<OpeningCountClient["command"]>>[0]) =>
      post("/merchant/supply/opening-count/command", body),
  } satisfies OpeningCountClient;
}
