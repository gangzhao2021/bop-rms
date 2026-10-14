import { createContractParsers } from "./contract-parsers.js";

/** WP-2423 Q14 (RPT-OPS-DASHBOARD): the Store sales reports view and its strict reader. */
export class StoreReportsClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "Busy" | "Unavailable") {
    super(code);
    this.name = "StoreReportsClientError";
  }
}
const fail = (): never => {
  throw new StoreReportsClientError("Unavailable");
};
const { instant, text, minor, count, exact, oneOf, bool } = createContractParsers(fail);
/** Signed minor units (a day's net can be below zero when refunds exceed sales). */
const signed = (value: unknown): string =>
  typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value) && value !== "-0"
    ? value
    : fail();
const date = (value: unknown): string => {
  const parsed = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(parsed) ? parsed : fail();
};
const list = <T>(value: unknown, max: number, parse: (item: unknown) => T): readonly T[] =>
  Array.isArray(value) && value.length <= max ? Object.freeze(value.map(parse)) : fail();

export type StoreReportChannel = "Online" | "CardMachine";
export type StoreReportOrderType = "DineIn" | "Pickup" | "Counter";
export type StoreReportExportKind = "summary" | "items" | "hourly" | "tips";

export interface StoreReportSummary {
  readonly paymentCount: number;
  readonly orderCount: number;
  readonly grossSalesMinor: string;
  readonly discountsMinor: string;
  readonly netSalesMinor: string;
  readonly serviceChargesMinor: string;
  readonly taxMinor: string;
  readonly taxes: readonly { readonly label: string; readonly amountMinor: string }[];
  readonly tipsMinor: string;
  readonly unmatchedMinor: string;
  readonly unmatchedPaymentCount: number;
  readonly collectedMinor: string;
  readonly refundCount: number;
  readonly refundsMinor: string;
  readonly refunds: {
    readonly salesMinor: string;
    readonly taxMinor: string;
    readonly tipsMinor: string;
    readonly serviceChargesMinor: string;
    readonly notItemizedMinor: string;
  };
  readonly netSalesAfterRefundsMinor: string;
  readonly netCollectedMinor: string;
}
export interface StoreReportItemRow {
  readonly name: string;
  readonly quantitySold: number;
  readonly grossSalesMinor: string;
  readonly discountsMinor: string;
  readonly netSalesMinor: string;
  readonly refundedQuantity: number;
  readonly refundsMinor: string;
  readonly netAfterRefundsMinor: string;
}
export interface StoreReportHourRow {
  readonly hour: string;
  readonly paymentCount: number;
  readonly netSalesMinor: string;
  readonly taxMinor: string;
  readonly tipsMinor: string;
  readonly collectedMinor: string;
}
export interface StoreReportsView {
  readonly storeLabel: string;
  readonly timeZone: string;
  readonly currencyCode: "CAD";
  readonly from: string;
  readonly to: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly includesOpenDay: boolean;
  readonly summary: StoreReportSummary;
  readonly byChannel: readonly (StoreReportSummary & { readonly channel: StoreReportChannel })[];
  readonly byOrderType: readonly (StoreReportSummary & {
    readonly orderType: StoreReportOrderType;
  })[];
  readonly items: readonly StoreReportItemRow[];
  readonly hours: readonly StoreReportHourRow[];
  readonly tips: readonly {
    readonly businessDate: string;
    readonly channels: readonly {
      readonly channel: StoreReportChannel;
      readonly tipsMinor: string;
      readonly refundedMinor: string;
      readonly netMinor: string;
    }[];
  }[];
  readonly days: readonly {
    readonly businessDate: string;
    readonly status: "Open" | "Closed";
    readonly summary: StoreReportSummary;
  }[];
  readonly reconciliation: {
    readonly matchesSettlement: boolean;
    readonly settlementCollectedMinor: string;
    readonly settlementRefundedMinor: string;
    readonly reportCollectedMinor: string;
    readonly reportRefundedMinor: string;
    readonly pendingOnlineRefundCount: number;
  };
  readonly mayExport: boolean;
  readonly generatedAt: string;
}

const summaryKeys = [
  "paymentCount",
  "orderCount",
  "grossSalesMinor",
  "discountsMinor",
  "netSalesMinor",
  "serviceChargesMinor",
  "taxMinor",
  "taxes",
  "tipsMinor",
  "unmatchedMinor",
  "unmatchedPaymentCount",
  "collectedMinor",
  "refundCount",
  "refundsMinor",
  "refunds",
  "netSalesAfterRefundsMinor",
  "netCollectedMinor",
] as const;
function summary(value: Record<string, unknown>): StoreReportSummary {
  const refunds = exact(value.refunds, [
    "salesMinor",
    "taxMinor",
    "tipsMinor",
    "serviceChargesMinor",
    "notItemizedMinor",
  ]);
  return Object.freeze({
    paymentCount: count(value.paymentCount),
    orderCount: count(value.orderCount),
    grossSalesMinor: minor(value.grossSalesMinor),
    discountsMinor: minor(value.discountsMinor),
    netSalesMinor: signed(value.netSalesMinor),
    serviceChargesMinor: minor(value.serviceChargesMinor),
    taxMinor: minor(value.taxMinor),
    taxes: list(value.taxes, 20, (item) => {
      const tax = exact(item, ["label", "amountMinor"]);
      return Object.freeze({ label: text(tax.label, 64), amountMinor: minor(tax.amountMinor) });
    }),
    tipsMinor: minor(value.tipsMinor),
    unmatchedMinor: minor(value.unmatchedMinor),
    unmatchedPaymentCount: count(value.unmatchedPaymentCount),
    collectedMinor: minor(value.collectedMinor),
    refundCount: count(value.refundCount),
    refundsMinor: minor(value.refundsMinor),
    refunds: Object.freeze({
      salesMinor: minor(refunds.salesMinor),
      taxMinor: minor(refunds.taxMinor),
      tipsMinor: minor(refunds.tipsMinor),
      serviceChargesMinor: minor(refunds.serviceChargesMinor),
      notItemizedMinor: minor(refunds.notItemizedMinor),
    }),
    netSalesAfterRefundsMinor: signed(value.netSalesAfterRefundsMinor),
    netCollectedMinor: signed(value.netCollectedMinor),
  });
}
const channels: readonly StoreReportChannel[] = ["Online", "CardMachine"];
const orderTypes: readonly StoreReportOrderType[] = ["DineIn", "Pickup", "Counter"];
const itemRow = (value: unknown): StoreReportItemRow => {
  const row = exact(value, [
    "name",
    "quantitySold",
    "grossSalesMinor",
    "discountsMinor",
    "netSalesMinor",
    "refundedQuantity",
    "refundsMinor",
    "netAfterRefundsMinor",
  ]);
  return Object.freeze({
    name: text(row.name, 240),
    quantitySold: count(row.quantitySold),
    grossSalesMinor: minor(row.grossSalesMinor),
    discountsMinor: minor(row.discountsMinor),
    netSalesMinor: signed(row.netSalesMinor),
    refundedQuantity: count(row.refundedQuantity),
    refundsMinor: minor(row.refundsMinor),
    netAfterRefundsMinor: signed(row.netAfterRefundsMinor),
  });
};
const hourRow = (value: unknown): StoreReportHourRow => {
  const row = exact(value, [
    "hour",
    "paymentCount",
    "netSalesMinor",
    "taxMinor",
    "tipsMinor",
    "collectedMinor",
  ]);
  const hour = text(row.hour, 5);
  if (!/^(?:[01]\d|2[0-3]):00$/u.test(hour)) return fail();
  return Object.freeze({
    hour,
    paymentCount: count(row.paymentCount),
    netSalesMinor: signed(row.netSalesMinor),
    taxMinor: minor(row.taxMinor),
    tipsMinor: minor(row.tipsMinor),
    collectedMinor: minor(row.collectedMinor),
  });
};

export function parseStoreReportsView(value: unknown): StoreReportsView {
  const raw = exact(value, [
    "screenId",
    "queryName",
    "storeLabel",
    "timeZone",
    "currencyCode",
    "from",
    "to",
    "startsAt",
    "endsAt",
    "includesOpenDay",
    "summary",
    "byChannel",
    "byOrderType",
    "items",
    "hours",
    "tips",
    "days",
    "reconciliation",
    "permissions",
    "generatedAt",
  ]);
  if (
    raw.screenId !== "RPT-OPS-DASHBOARD" ||
    raw.queryName !== "store_sales_reports_v1" ||
    raw.currencyCode !== "CAD"
  )
    return fail();
  const from = date(raw.from),
    to = date(raw.to);
  if (from > to) return fail();
  const reconciliation = exact(raw.reconciliation, [
    "matchesSettlement",
    "settlementCollectedMinor",
    "settlementRefundedMinor",
    "reportCollectedMinor",
    "reportRefundedMinor",
    "pendingOnlineRefundCount",
  ]);
  const permissions = exact(raw.permissions, ["mayExport"]);
  return Object.freeze({
    storeLabel: text(raw.storeLabel, 100),
    timeZone: text(raw.timeZone, 64),
    currencyCode: "CAD",
    from,
    to,
    startsAt: instant(raw.startsAt),
    endsAt: instant(raw.endsAt),
    includesOpenDay: bool(raw.includesOpenDay),
    summary: summary(exact(raw.summary, summaryKeys)),
    byChannel: list(raw.byChannel, 2, (item) => {
      const entry = exact(item, ["channel", ...summaryKeys]);
      return Object.freeze({ channel: oneOf(entry.channel, channels), ...summary(entry) });
    }),
    byOrderType: list(raw.byOrderType, 3, (item) => {
      const entry = exact(item, ["orderType", ...summaryKeys]);
      return Object.freeze({ orderType: oneOf(entry.orderType, orderTypes), ...summary(entry) });
    }),
    items: list(raw.items, 5000, itemRow),
    hours: list(raw.hours, 24, hourRow),
    tips: list(raw.tips, 31, (item) => {
      const day = exact(item, ["businessDate", "channels"]);
      return Object.freeze({
        businessDate: date(day.businessDate),
        channels: list(day.channels, 2, (entry) => {
          const tip = exact(entry, ["channel", "tipsMinor", "refundedMinor", "netMinor"]);
          return Object.freeze({
            channel: oneOf(tip.channel, channels),
            tipsMinor: minor(tip.tipsMinor),
            refundedMinor: minor(tip.refundedMinor),
            netMinor: signed(tip.netMinor),
          });
        }),
      });
    }),
    days: list(raw.days, 31, (item) => {
      const day = exact(item, [
        "businessDate",
        "status",
        "startsAt",
        "endsAt",
        "summary",
        "byChannel",
        "items",
        "hours",
      ]);
      return Object.freeze({
        businessDate: date(day.businessDate),
        status: oneOf(day.status, ["Open", "Closed"] as const),
        summary: summary(exact(day.summary, summaryKeys)),
      });
    }),
    reconciliation: Object.freeze({
      matchesSettlement: bool(reconciliation.matchesSettlement),
      settlementCollectedMinor: minor(reconciliation.settlementCollectedMinor),
      settlementRefundedMinor: minor(reconciliation.settlementRefundedMinor),
      reportCollectedMinor: minor(reconciliation.reportCollectedMinor),
      reportRefundedMinor: minor(reconciliation.reportRefundedMinor),
      pendingOnlineRefundCount: count(reconciliation.pendingOnlineRefundCount),
    }),
    mayExport: bool(permissions.mayExport),
    generatedAt: instant(raw.generatedAt),
  });
}

const query = (from: string, to: string) =>
  "from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
const validRange = (from: string, to: string) =>
  /^\d{4}-\d{2}-\d{2}$/u.test(from) && /^\d{4}-\d{2}-\d{2}$/u.test(to) && from <= to;

async function request(
  fetcher: typeof fetch,
  url: string,
  accept: string,
  signal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  // A month of reports reads every payment and refund in it; allow longer than a single day.
  const timer = setTimeout(abort, 30000);
  try {
    const response = await fetcher(url, {
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: accept },
    });
    if (response.status === 401 || response.status === 403)
      throw new StoreReportsClientError("PermissionDenied");
    if (response.status === 503) {
      const busy = await response
        .json()
        .then((value: unknown) => (value as { error?: unknown } | null)?.error)
        .catch(() => null);
      if (busy === "reports_busy") throw new StoreReportsClientError("Busy");
    }
    if (!response.ok || response.headers.get("cache-control") !== "no-store") return fail();
    return response;
  } catch (error) {
    if (error instanceof StoreReportsClientError) throw error;
    return fail();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function createStoreReportsClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    async load(from: string, to: string, signal: AbortSignal): Promise<StoreReportsView> {
      if (!validRange(from, to)) return fail();
      const response = await request(
        fetcher,
        "/merchant/reports?" + query(from, to),
        "application/json",
        signal,
      );
      try {
        if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
          return fail();
        const body = await response.text();
        if (body.length > 4_194_304) return fail();
        return parseStoreReportsView(JSON.parse(body) as unknown);
      } catch (error) {
        if (error instanceof StoreReportsClientError) throw error;
        return fail();
      }
    },
    /** The CSV file for one report: its server-chosen name and bytes. */
    async download(
      report: StoreReportExportKind,
      from: string,
      to: string,
      signal: AbortSignal,
    ): Promise<{ readonly fileName: string; readonly blob: Blob }> {
      if (!validRange(from, to)) return fail();
      const response = await request(
        fetcher,
        "/merchant/reports/export?report=" + encodeURIComponent(report) + "&" + query(from, to),
        "text/csv",
        signal,
      );
      try {
        if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/csv"))
          return fail();
        const name = /filename="([a-z0-9-]{1,80}\.csv)"/u.exec(
          response.headers.get("content-disposition") ?? "",
        )?.[1];
        const blob = await response.blob();
        if (name === undefined || blob.size > 8_388_608) return fail();
        return Object.freeze({ fileName: name, blob });
      } catch (error) {
        if (error instanceof StoreReportsClientError) throw error;
        return fail();
      }
    },
  });
}
export type StoreReportsClient = ReturnType<typeof createStoreReportsClient>;
