import { useEffect, useState } from "react";
import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import {
  StoreReportsClientError,
  type StoreReportsClient,
  type TonightSummary,
} from "./store-reports-client.js";

const money = (minor: string | bigint) =>
  orderMoney({ amountMinor: String(minor), currencyCode: "CAD" });

type Row =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly summary: TonightSummary }
  | { readonly kind: "Denied" | "Unavailable" };

/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 7 (Section 88 RPT-OPS-DASHBOARD, Brand scope):
 * tonight at each of the Brand's Stores this person works in — each Store read on its own, the
 * same figures as that Store's own Tonight — and their total. A Store whose sales this person may
 * not read, or that can't be read now, says so and is left out of the total, which names how many
 * Stores it covers. "Open this store" switches to it.
 */
export function BrandStoresReport({
  client,
  stores,
  currentStoreReference,
  revision,
  onSwitchStore,
}: {
  readonly client: Pick<StoreReportsClient, "storeTonight">;
  readonly stores: readonly { readonly storeReference: string; readonly storeLabel: string }[];
  readonly currentStoreReference: string;
  readonly revision: number;
  readonly onSwitchStore: (storeReference: string) => void;
}) {
  const [rows, setRows] = useState<ReadonlyMap<string, Row>>(new Map());
  useEffect(() => {
    const controller = new AbortController();
    setRows(new Map(stores.map((store) => [store.storeReference, { kind: "Loading" } as Row])));
    for (const store of stores)
      void client
        .storeTonight(store.storeReference, controller.signal)
        .then((summary): Row => ({ kind: "Ready", summary }))
        .catch((error: unknown): Row => ({
          kind:
            error instanceof StoreReportsClientError && error.code === "PermissionDenied"
              ? "Denied"
              : "Unavailable",
        }))
        .then((row) => {
          if (!controller.signal.aborted)
            setRows((previous) => new Map(previous).set(store.storeReference, row));
        });
    return () => controller.abort();
  }, [client, stores, revision]);
  const ready = stores.flatMap((store) => {
    const row = rows.get(store.storeReference);
    return row?.kind === "Ready" ? [row.summary] : [];
  });
  const total = (pick: (summary: TonightSummary) => string) =>
    ready.reduce((sum, summary) => sum + BigInt(pick(summary)), 0n);
  return (
    <section aria-labelledby="brand-stores" className="brand-stores">
      <h2 id="brand-stores">{t("Tonight at each store")}</h2>
      <table className="brand-stores__table">
        <thead>
          <tr>
            <th scope="col">{t("Store")}</th>
            <th scope="col">{t("Net sales")}</th>
            <th scope="col">{t("Tax")}</th>
            <th scope="col">{t("Tips")}</th>
            <th scope="col">{t("Taken")}</th>
            <th scope="col">{t("Still to take")}</th>
            <th scope="col">
              <span className="visually-hidden">{t("Actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {stores.map((store) => {
            const row = rows.get(store.storeReference) ?? { kind: "Loading" };
            const s = row.kind === "Ready" ? row.summary.report.summary : null;
            return (
              <tr key={store.storeReference}>
                <th scope="row" data-label={t("Store")}>
                  {store.storeLabel}
                  {row.kind === "Ready" && !row.summary.report.reconciliation.matchesSettlement ? (
                    <span className="brand-stores__note">
                      {t("Doesn't match the day-end settlement")}
                    </span>
                  ) : null}
                </th>
                {s === null || row.kind !== "Ready" ? (
                  <td colSpan={5} data-label={t("Tonight")}>
                    {row.kind === "Loading"
                      ? t("Reading…")
                      : row.kind === "Denied"
                        ? t("You don't see this store's sales")
                        : t("This store can't be read now. Refresh.")}
                  </td>
                ) : (
                  <>
                    <td data-label={t("Net sales")}>{money(s.netSalesMinor)}</td>
                    <td data-label={t("Tax")}>{money(s.taxMinor)}</td>
                    <td data-label={t("Tips")}>{money(s.tipsMinor)}</td>
                    <td data-label={t("Taken")}>{money(s.collectedMinor)}</td>
                    <td data-label={t("Still to take")}>
                      {money(row.summary.openTablesOwedMinor)}
                    </td>
                  </>
                )}
                <td>
                  {store.storeReference === currentStoreReference ? (
                    <span className="brand-stores__note">{t("You are here")}</span>
                  ) : (
                    <button type="button" onClick={() => onSwitchStore(store.storeReference)}>
                      {t("Open this store")}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" data-label={t("Store")}>
              {t("Total")}
              <span className="brand-stores__note">
                {t("{counted} of {all} stores", {
                  counted: String(ready.length),
                  all: String(stores.length),
                })}
              </span>
            </th>
            <td data-label={t("Net sales")}>
              {money(total((x) => x.report.summary.netSalesMinor))}
            </td>
            <td data-label={t("Tax")}>{money(total((x) => x.report.summary.taxMinor))}</td>
            <td data-label={t("Tips")}>{money(total((x) => x.report.summary.tipsMinor))}</td>
            <td data-label={t("Taken")}>{money(total((x) => x.report.summary.collectedMinor))}</td>
            <td data-label={t("Still to take")}>{money(total((x) => x.openTablesOwedMinor))}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
