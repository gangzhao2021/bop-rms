export type InventoryTransferClientErrorCode =
  | "Empty"
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class InventoryTransferClientError extends Error {
  constructor(readonly code: InventoryTransferClientErrorCode) {
    super("Inventory Transfer is unavailable");
    this.name = "InventoryTransferClientError";
  }
}
export interface InventoryTransferSummary {
  readonly transferReference: string;
  readonly sourceLabel: string;
  readonly destinationLabel: string;
  readonly status: string;
  readonly itemCount: number;
  readonly requestedQuantity: string;
  readonly dispatchedQuantity: string;
  readonly receivedQuantity: string;
  readonly discrepancyQuantity: string;
  readonly ownerDisplay: string;
  readonly updatedAt: string;
}
export interface InventoryTransferListView {
  readonly screenId: "INV-TRANSFER-LIST";
  readonly projectionName: "inventory_transfer_list_v1";
  readonly projectionVersion: 1;
  readonly stockScope: {
    readonly scopeType: "Store" | "StockSite" | "Location";
    readonly scopeReference: string;
    readonly scopeLabel: string;
  };
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly transfers: readonly InventoryTransferSummary[];
}
export interface InventoryTransferDetailView {
  readonly screenId: "INV-TRANSFER-DETAIL";
  readonly projectionName: "inventory_transfer_detail_v1";
  readonly projectionVersion: 1;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly transfer: InventoryTransferSummary & {
    readonly revision: number;
    readonly sourceScopeReference: string;
    readonly destinationScopeReference: string;
    readonly submittedByDisplay: string | null;
    readonly approvedByDisplay: string | null;
    readonly lines: readonly {
      readonly lineReference: string;
      readonly itemDisplay: string;
      readonly lotReference: string | null;
      readonly expiryDate: string | null;
      readonly requestedQuantity: string;
      readonly dispatchedQuantity: string;
      readonly receivedQuantity: string;
      readonly inTransitQuantity: string;
      readonly discrepancyQuantity: string;
      readonly cancelledQuantity: string;
      readonly warnings: readonly string[];
      readonly unitCode: string;
    }[];
    readonly timeline: readonly {
      readonly action: string;
      readonly actorDisplay: string;
      readonly occurredAt: string;
      readonly reasonCode: string;
    }[];
  };
}
export interface InventoryTransferProjectionClient {
  list(): Promise<unknown>;
  detail(transferReference: string): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const quantityPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;
const statuses = [
  "Draft",
  "Submitted",
  "Approved",
  "PartiallyDispatched",
  "InTransit",
  "PartiallyReceived",
  "Received",
  "Exception",
  "Cancelled",
  "Closed",
] as const;
function object(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new InventoryTransferClientError("Unavailable");
  return value as Record<string, unknown>;
}
function ref(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new InventoryTransferClientError("Unavailable");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !safe.test(value))
    throw new InventoryTransferClientError("Unavailable");
  return value;
}
function quantity(value: unknown): string {
  if (typeof value !== "string" || !quantityPattern.test(value))
    throw new InventoryTransferClientError("Unavailable");
  return value;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new InventoryTransferClientError("Unavailable");
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new InventoryTransferClientError("Unavailable");
  return value as number;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InventoryTransferClientError("Unavailable");
  return value as T;
}
function nullableRef(value: unknown) {
  return value === null ? null : ref(value);
}
function nullableText(value: unknown) {
  return value === null ? null : text(value);
}
function nullableDate(value: unknown) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !datePattern.test(value) ||
    new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) !== value
  )
    throw new InventoryTransferClientError("Unavailable");
  return value;
}
function summary(value: unknown): InventoryTransferSummary {
  const raw = object(value, [
    "transferReference",
    "sourceLabel",
    "destinationLabel",
    "status",
    "itemCount",
    "requestedQuantity",
    "dispatchedQuantity",
    "receivedQuantity",
    "discrepancyQuantity",
    "ownerDisplay",
    "updatedAt",
  ]);
  return Object.freeze({
    transferReference: ref(raw.transferReference),
    sourceLabel: text(raw.sourceLabel),
    destinationLabel: text(raw.destinationLabel),
    status: oneOf(raw.status, statuses),
    itemCount: integer(raw.itemCount),
    requestedQuantity: quantity(raw.requestedQuantity),
    dispatchedQuantity: quantity(raw.dispatchedQuantity),
    receivedQuantity: quantity(raw.receivedQuantity),
    discrepancyQuantity: quantity(raw.discrepancyQuantity),
    ownerDisplay: text(raw.ownerDisplay),
    updatedAt: instant(raw.updatedAt),
  });
}
function header(value: unknown, screenId: string, projectionName: string, contentField: string) {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "asOfUtc",
    "freshness",
    "partial",
    contentField,
  ]);
  if (
    raw.screenId !== screenId ||
    raw.projectionName !== projectionName ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean"
  )
    throw new InventoryTransferClientError("Unavailable");
  return raw;
}
export function parseInventoryTransferListView(value: unknown): InventoryTransferListView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "stockScope",
    "asOfUtc",
    "freshness",
    "partial",
    "transfers",
  ]);
  if (
    raw.screenId !== "INV-TRANSFER-LIST" ||
    raw.projectionName !== "inventory_transfer_list_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.transfers) ||
    raw.transfers.length > 200
  )
    throw new InventoryTransferClientError("Unavailable");
  const stockScope = object(raw.stockScope, ["scopeType", "scopeReference", "scopeLabel"]);
  return Object.freeze({
    screenId: "INV-TRANSFER-LIST",
    projectionName: "inventory_transfer_list_v1",
    projectionVersion: 1,
    stockScope: Object.freeze({
      scopeType: oneOf(stockScope.scopeType, ["Store", "StockSite", "Location"]),
      scopeReference: ref(stockScope.scopeReference),
      scopeLabel: text(stockScope.scopeLabel),
    }),
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial,
    transfers: Object.freeze(raw.transfers.map(summary)),
  });
}
export function parseInventoryTransferDetailView(value: unknown): InventoryTransferDetailView {
  const raw = header(value, "INV-TRANSFER-DETAIL", "inventory_transfer_detail_v1", "transfer");
  const transfer = object(raw.transfer, [
    "transferReference",
    "sourceLabel",
    "destinationLabel",
    "status",
    "itemCount",
    "requestedQuantity",
    "dispatchedQuantity",
    "receivedQuantity",
    "discrepancyQuantity",
    "ownerDisplay",
    "updatedAt",
    "revision",
    "sourceScopeReference",
    "destinationScopeReference",
    "submittedByDisplay",
    "approvedByDisplay",
    "lines",
    "timeline",
  ]);
  if (
    !Array.isArray(transfer.lines) ||
    transfer.lines.length < 1 ||
    transfer.lines.length > 100 ||
    !Array.isArray(transfer.timeline) ||
    transfer.timeline.length < 1 ||
    transfer.timeline.length > 500
  )
    throw new InventoryTransferClientError("Unavailable");
  const base = summary(
    Object.fromEntries(
      Object.entries(transfer).filter(([key]) =>
        [
          "transferReference",
          "sourceLabel",
          "destinationLabel",
          "status",
          "itemCount",
          "requestedQuantity",
          "dispatchedQuantity",
          "receivedQuantity",
          "discrepancyQuantity",
          "ownerDisplay",
          "updatedAt",
        ].includes(key),
      ),
    ),
  );
  return Object.freeze({
    screenId: "INV-TRANSFER-DETAIL",
    projectionName: "inventory_transfer_detail_v1",
    projectionVersion: 1,
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial as boolean,
    transfer: Object.freeze({
      ...base,
      revision: integer(transfer.revision),
      sourceScopeReference: ref(transfer.sourceScopeReference),
      destinationScopeReference: ref(transfer.destinationScopeReference),
      submittedByDisplay: nullableText(transfer.submittedByDisplay),
      approvedByDisplay: nullableText(transfer.approvedByDisplay),
      lines: Object.freeze(
        transfer.lines.map((entry) => {
          const line = object(entry, [
            "lineReference",
            "itemDisplay",
            "lotReference",
            "expiryDate",
            "requestedQuantity",
            "dispatchedQuantity",
            "receivedQuantity",
            "inTransitQuantity",
            "discrepancyQuantity",
            "cancelledQuantity",
            "warnings",
            "unitCode",
          ]);
          return Object.freeze({
            lineReference: ref(line.lineReference),
            itemDisplay: text(line.itemDisplay),
            lotReference: nullableRef(line.lotReference),
            expiryDate: nullableDate(line.expiryDate),
            requestedQuantity: quantity(line.requestedQuantity),
            dispatchedQuantity: quantity(line.dispatchedQuantity),
            receivedQuantity: quantity(line.receivedQuantity),
            inTransitQuantity: quantity(line.inTransitQuantity),
            discrepancyQuantity: quantity(line.discrepancyQuantity),
            cancelledQuantity: quantity(line.cancelledQuantity),
            warnings:
              Array.isArray(line.warnings) &&
              line.warnings.length <= 20 &&
              line.warnings.every((entry) => typeof entry === "string" && codePattern.test(entry))
                ? Object.freeze(line.warnings as string[])
                : (() => {
                    throw new InventoryTransferClientError("Unavailable");
                  })(),
            unitCode: oneOf(line.unitCode, [text(line.unitCode)]),
          });
        }),
      ),
      timeline: Object.freeze(
        transfer.timeline.map((entry) => {
          const row = object(entry, ["action", "actorDisplay", "occurredAt", "reasonCode"]);
          return Object.freeze({
            action: text(row.action),
            actorDisplay: text(row.actorDisplay),
            occurredAt: instant(row.occurredAt),
            reasonCode: oneOf(row.reasonCode, [
              typeof row.reasonCode === "string" && codePattern.test(row.reasonCode)
                ? row.reasonCode
                : "__INVALID__",
            ]),
          });
        }),
      ),
    }),
  });
}
export const unavailableInventoryTransferClient: InventoryTransferProjectionClient = Object.freeze({
  async list() {
    throw new InventoryTransferClientError("Unavailable");
  },
  async detail() {
    throw new InventoryTransferClientError("Unavailable");
  },
});
