/** WP-2423 / DEC-INV-STOCK-COUNT: INV-COUNT-LIST / INV-COUNT-WORKBENCH contract and client. */
export type StockCountErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "AlreadyOpen"
  | "StockChanged"
  | "Incomplete"
  | "NotIndependent"
  | "State"
  | "LineInvalid"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class StockCountPageError extends Error {
  constructor(
    readonly code: StockCountErrorCode,
    readonly lineReferences: readonly string[] = [],
  ) {
    super("Stock counts are unavailable");
    this.name = "StockCountPageError";
  }
}
export type StockCountStatus =
  "Draft" | "Assigned" | "InProgress" | "Submitted" | "Approved" | "Cancelled" | "Posted";
export interface StockCountLineView {
  readonly lineReference: string;
  readonly itemReference: string;
  readonly lotReference: string | null;
  readonly locationReference: string;
  readonly unitCode: string;
  /** Null while counting blind. */
  readonly expectedQuantity: string | null;
  readonly countedQuantity: string | null;
  readonly variance: string | null;
  readonly varianceReasonCode: string | null;
  readonly recountNumber: number;
  readonly movementReference: string | null;
}
export interface StockCountView {
  readonly countReference: string;
  readonly stockScope: { readonly scopeType: string; readonly scopeReference: string };
  readonly countType: "Full" | "Cycle" | "Spot";
  readonly status: StockCountStatus;
  readonly assigneeReference: string | null;
  readonly submittedBy: string | null;
  readonly approvedBy: string | null;
  readonly aggregateVersion: number;
  readonly lines: readonly StockCountLineView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface StockCountSummaryView {
  readonly countReference: string;
  readonly locationReference: string;
  readonly status: StockCountStatus;
  readonly countType: "Full" | "Cycle" | "Spot";
  readonly assigneeReference: string | null;
  readonly lineCount: number;
  readonly countedLines: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
}
/**
 * DEC-INV-COUNT-SHORT (2026-10-18): an item a count found short against open orders (with those
 * orders), or that the kitchen then used beyond the count. Quantities in the item's base unit.
 */
export interface StockShortageView {
  readonly itemReference: string;
  readonly locationReference: string;
  readonly lotCode: string | null;
  readonly unitCode: string;
  readonly onHand: string;
  readonly reserved: string;
  /** Held by open orders beyond what is on hand ("0" when not short for orders). */
  readonly shortQuantity: string;
  /** Used by the kitchen beyond the count since it was last counted ("0" when none). */
  readonly usedBeyondCount: string;
  readonly orders: readonly {
    readonly orderReference: string;
    readonly orderNumber: string;
    readonly orderType: "Pickup" | "DineIn";
    readonly businessDate: string;
    readonly quantity: string;
    readonly ended: boolean;
  }[];
}
interface Base {
  readonly sourceAsOf: string;
  readonly viewer: string;
  readonly permissions: {
    readonly mayCreate: boolean;
    readonly mayCount: boolean;
    readonly mayApprove: boolean;
  };
  readonly varianceReasons: readonly string[];
  readonly items: readonly {
    readonly itemReference: string;
    readonly internalCode: string;
    readonly name: string;
    readonly unitCode: string;
    readonly ledgerPrecision: number;
  }[];
  readonly locations: readonly {
    readonly locationReference: string;
    readonly code: string;
    readonly name: string;
  }[];
  readonly staff: readonly { readonly actorReference: string; readonly label: string }[];
  /** People a count names who are not on the Store's staff list (a Brand Owner, a past member). */
  readonly people?: readonly { readonly actorReference: string; readonly label: string }[];
  /** DEC-INV-COUNT-SHORT: absent from an older server. */
  readonly shortages?: readonly StockShortageView[];
}
export interface StockCountListView extends Base {
  readonly screenId: "INV-COUNT-LIST";
  readonly counts: readonly StockCountSummaryView[];
  readonly hasMore: boolean;
}
export interface StockCountWorkbenchView extends Base {
  readonly screenId: "INV-COUNT-WORKBENCH";
  readonly count: StockCountView;
  readonly lots: Readonly<
    Record<string, { readonly lotCode: string; readonly expiryDate: string | null }>
  >;
  /**
   * v15 2026-10-18 D2: lines (of a count being counted) whose stock moved after their snapshot;
   * "Refresh lines where stock moved" is offered only when there are some.
   */
  readonly movedLineReferences?: readonly string[];
}
export type StockCountCommand =
  | {
      readonly action: "Create";
      readonly operationReference: string;
      readonly locationReference: string;
      readonly countType: "Full" | "Cycle" | "Spot";
      readonly assigneeReference: string;
    }
  | {
      readonly action: "Start" | "Submit" | "Refresh" | "SendBack" | "Cancel";
      readonly operationReference: string;
      readonly countReference: string;
      readonly expectedVersion: number;
    }
  | {
      readonly action: "SaveLine";
      readonly operationReference: string;
      readonly countReference: string;
      readonly expectedVersion: number;
      readonly lineReference: string;
      readonly countedQuantity: string;
    }
  | {
      readonly action: "ExplainVariance";
      readonly operationReference: string;
      readonly countReference: string;
      readonly expectedVersion: number;
      readonly lineReference: string;
      readonly varianceReasonCode: string;
    }
  | {
      readonly action: "ApproveAndPost";
      readonly operationReference: string;
      readonly postOperationReference: string;
      readonly countReference: string;
      readonly expectedVersion: number;
    };
export interface StockCountClient {
  load(countReference: string | null): Promise<unknown>;
  command?(command: StockCountCommand): Promise<unknown>;
}
const invalid = (): never => {
  throw new Error("STOCK_COUNT_PAGE_INVALID");
};
export function parseStockCountListView(value: unknown): StockCountListView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "INV-COUNT-LIST" ||
    !Array.isArray(r.counts)
  )
    return invalid();
  return r as unknown as StockCountListView;
}
export function parseStockCountWorkbenchView(value: unknown): StockCountWorkbenchView {
  const r = value as Record<string, unknown> | null;
  const count = r?.count as Record<string, unknown> | undefined;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "INV-COUNT-WORKBENCH" ||
    typeof count !== "object" ||
    count === null ||
    !Array.isArray(count.lines)
  )
    return invalid();
  return r as unknown as StockCountWorkbenchView;
}
/** A count entry fits the item's ledger precision (non-negative, at most that many decimals). */
export function validCountedQuantity(value: string, precision: number): boolean {
  const match = /^(?:0|[1-9]\d{0,11})(?:\.(\d{1,6}))?$/u.exec(value.trim());
  return match !== null && (match[1]?.length ?? 0) <= precision;
}
export const unavailableStockCountClient: StockCountClient = {
  load: async () => {
    throw new StockCountPageError("Unavailable");
  },
};
const codes = new Set<StockCountErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "AlreadyOpen",
  "StockChanged",
  "Incomplete",
  "NotIndependent",
  "State",
  "LineInvalid",
  "Invalid",
  "Unavailable",
]);
export function createStockCountClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): StockCountClient {
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
      throw new StockCountPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
        lineReferences?: unknown;
      } | null;
      const code = String(payload?.error) as StockCountErrorCode;
      throw new StockCountPageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
        Array.isArray(payload?.lineReferences)
          ? payload.lineReferences.filter((item): item is string => typeof item === "string")
          : [],
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (countReference) =>
      post("/merchant/supply/counts/query", { countReference, before: null }),
    command: (command) => post("/merchant/supply/counts/command", command),
  };
}
