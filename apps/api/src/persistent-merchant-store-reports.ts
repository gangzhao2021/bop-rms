import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresStoreSalesOrderSource } from "@rms/ordering";
import { createPostgresStoreSalesPaymentLedger } from "@rms/payment";
import { createMerchantBusinessDayWindows } from "./merchant-business-day-window.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import {
  computeStoreSalesReport,
  storeSalesReportCsv,
  type StoreSalesReportExportKind,
  type StoreSalesReportView,
} from "./store-sales-report.js";

/** WP-2423 Q14: read the Store's sales reports. */
export const storeReportsReadPermission = "reporting.sales.read" as const;
/** WP-2423 Q14: download them; reading never implies exporting (Handoff Section 72). */
export const storeReportsExportPermission = "reporting.sales.export" as const;
/** The longest range one request may cover. */
export const storeReportsMaximumDays = 31;
export const merchantStoreReportsBusy = "MERCHANT_STORE_REPORTS_BUSY" as const;
const businessDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

const unavailable = (): never => {
  throw new Error("MERCHANT_STORE_REPORTS_UNAVAILABLE");
};
const conflicted = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "TENANT_DATABASE_TRANSACTION_CONFLICT";

/** Calendar dates from `from` to `to` inclusive ("2026-10-01".."2026-10-03"), at most `limit`. */
export function businessDatesBetween(from: string, to: string, limit: number): readonly string[] {
  if (!businessDatePattern.test(from) || !businessDatePattern.test(to) || from > to)
    return unavailable();
  const dates: string[] = [];
  for (let at = Date.parse(from + "T00:00:00.000Z"); ; at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (Number.isNaN(at) || dates.length >= limit) return unavailable();
    dates.push(date);
    if (date === to) return dates;
    if (date > to) return unavailable();
  }
}

/**
 * WP-2423 Q14 (Section 88 RPT-OPS-DASHBOARD): the Store's sales, item, hourly and tip reports for a
 * range of business days, composed in one transaction from the owners' public reads — Store (the
 * business-day windows), Payment (payments and refunds as the day-end settlement counts them) and
 * Ordering (the priced items those payments paid for). Owner and Store Manager only; the scope is
 * re-resolved before the reply.
 */
export function createPersistentMerchantStoreReports(options: {
  persistence: PersistentMerchantBffOptions;
  /** The Provider account and environment whose captures and refunds this Store settles. */
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<{ readonly providerAccountReference: string; readonly environment: "Test" | "Live" }>;
  retryDelaysMs?: readonly number[];
}) {
  const persistence = options.persistence,
    resolve = createMerchantStoreScope(persistence);
  const read = (input: {
    readonly sessionCookie: unknown;
    readonly from: string | null;
    readonly to: string | null;
    readonly permission: typeof storeReportsReadPermission | typeof storeReportsExportPermission;
  }): Promise<StoreSalesReportView> =>
    persistence.transactions.run(async (original) => {
      const tx: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await original.query(sql, values);
          const rows = (result as { rows?: unknown } | null)?.rows,
            count = (result as { rowCount?: unknown } | null)?.rowCount;
          if (
            !Array.isArray(rows) ||
            (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0))
          )
            return unavailable();
          return { rows: rows as readonly Row[], rowCount: count as number | null };
        },
      };
      // The caller's Session, Store and permission are resolved in full at the start of the
      // transaction and re-resolved in full once more before the reply. In between, the owner
      // reads only confirm they run in this same authorized transaction: re-resolving the scope
      // for every owner read (each one a Session, membership and permission-policy read of ~30
      // queries) made a range cost ~900 queries per business day and a week's report ~16 s.
      return withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const value = await resolve(original, input.sessionCookie, input.permission);
            if (!(await value.allowed())) return unavailable();
            return value;
          },
          recheck: async (value) => {
            const again = await resolve(original, input.sessionCookie, input.permission);
            return (
              String(again.sessionReference) === String(value.sessionReference) &&
              String(again.store.storeReference) === String(value.store.storeReference) &&
              String(again.context.brand.brandReference) ===
                String(value.context.brand.brandReference) &&
              (await again.allowed())
            );
          },
          denied: unavailable,
        },
        async (authority) => {
          const value = authority.scope;
          const scope = Object.freeze({
            tenantReference: String(value.selected.tenantReference),
            brandReference: String(value.context.brand.brandReference),
            storeReference: String(value.store.storeReference),
          });
          const storeLabel = String(value.store.displayName),
            timeZone = String(value.store.timeZone);
          if (!/^[^\p{Cc}\p{Cf}]{1,100}$/u.test(storeLabel)) return unavailable();
          const sameTransaction = (t: ConsumerTransaction) => authority.guard(t);
          const windows = createMerchantBusinessDayWindows({
            persistence,
            scope,
            timeZone,
            authorize: sameTransaction,
          });
          const now = persistence.now();
          const current = await windows.today(tx, now);
          const today = current.businessDate;
          const to = input.to ?? today,
            from = input.from ?? to;
          if (to > today) return unavailable();
          const days = await windows.range(
            tx,
            businessDatesBetween(from, to, storeReportsMaximumDays),
            { now, current },
          );
          const first = days[0] ?? unavailable(),
            last = days.at(-1) ?? unavailable();
          if (days.some((day, index) => index > 0 && day.startsAt !== days[index - 1]?.endsAt))
            return unavailable();
          const configuration = await options.resolveConfiguration(tx, scope);
          const ledger = await createPostgresStoreSalesPaymentLedger({
            scope: { ...scope, ...configuration },
            authorize: sameTransaction,
          })(tx, { startsAt: first.startsAt, endsAt: last.endsAt, observedAt: persistence.now() });
          const orderReferences = [
            ...ledger.payments.map((payment) => payment.orderReference),
            ...ledger.refunds.map((refund) => refund.orderReference),
          ];
          const locale = /^[a-z]{2}-[A-Z]{2}$/u.test(String(value.store.locale))
            ? String(value.store.locale)
            : "en-CA";
          const orders = await createPostgresStoreSalesOrderSource({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            locale,
            authorize: sameTransaction,
          })(tx, orderReferences);
          const mayExport =
            input.permission === storeReportsExportPermission ||
            (await value.authorizeAction(storeReportsExportPermission))?.effect === "Allow";
          return computeStoreSalesReport({
            storeLabel,
            timeZone,
            days,
            payments: ledger.payments,
            refundedPayments: ledger.refundedPayments,
            refunds: ledger.refunds,
            settlement: ledger.settlement,
            unresolvedOnlineRefundCount: ledger.unresolvedOnlineRefundCount,
            unpaidWriteOffs: ledger.unpaidWriteOffs,
            orders,
            mayExport,
            generatedAt: persistence.now(),
          });
        },
      );
    });
  const retrying = async <T>(work: () => Promise<T>): Promise<T> => {
    // Live ordering and payment work shares these records; a read that lost a lock wait is rerun
    // a few times before staff are told to try again shortly. The read writes nothing.
    const delays = options.retryDelaysMs ?? [250, 1000, 2500];
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (!conflicted(error)) throw error;
        const delay = delays[attempt];
        if (delay === undefined) {
          const busy = new Error(merchantStoreReportsBusy);
          Object.assign(busy, { code: merchantStoreReportsBusy });
          throw busy;
        }
        await new Promise((done) => setTimeout(done, delay));
      }
    }
  };
  return Object.freeze({
    read: (input: { sessionCookie: unknown; from: string | null; to: string | null }) =>
      retrying(() => read({ ...input, permission: storeReportsReadPermission })),
    /** The CSV for one report, under the export permission; a file name without Store data. */
    export: async (input: {
      sessionCookie: unknown;
      from: string | null;
      to: string | null;
      report: StoreSalesReportExportKind;
    }) => {
      const view = await retrying(() =>
        read({ ...input, permission: storeReportsExportPermission }),
      );
      const fileName = String(
        `${input.report}-${view.from}${view.to === view.from ? "" : "-to-" + view.to}.csv`,
      );
      return Object.freeze({
        fileName,
        body: storeSalesReportCsv(view, input.report),
      });
    },
  });
}
