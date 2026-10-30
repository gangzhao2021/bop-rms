import { useEffect, useState } from "react";
import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { createTableCheckoutClient } from "./table-checkout-client.js";

/**
 * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): a table with tables merged into it pays one bill —
 * every group's rounds together (Payment's own figure), so the cashier never adds them up.
 */
export function TableBillTotal({
  diningSessionReference,
  csrf,
  refreshKey,
  fetcher,
}: {
  readonly diningSessionReference: string;
  readonly csrf: string;
  readonly refreshKey: string;
  readonly fetcher?: typeof fetch;
}) {
  const [bill, setBill] = useState<{
    subtotalMinor: string;
    taxMinor: string;
    totalMinor: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    createTableCheckoutClient(fetcher)
      .bill(csrf, diningSessionReference, controller.signal)
      .then((read) => {
        if (controller.signal.aborted) return;
        const subtotal = read.rounds.reduce((sum, round) => sum + BigInt(round.subtotalMinor), 0n);
        const tax = read.rounds.reduce((sum, round) => sum + BigInt(round.taxMinor), 0n);
        const total = read.rounds.reduce((sum, round) => sum + BigInt(round.totalMinor), 0n);
        setBill({
          subtotalMinor: subtotal.toString(),
          taxMinor: tax.toString(),
          totalMinor: total.toString(),
        });
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [csrf, diningSessionReference, fetcher, refreshKey]);
  const cad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });
  return (
    <section className="table-panel__bill-total" aria-label={t("The table's whole bill")}>
      {bill === null ? (
        <p role="status">
          {failed ? t("The table's whole bill could not be read.") : t("Reading the whole bill…")}
        </p>
      ) : (
        <dl>
          <div>
            <dt>{t("Whole bill, before tax")}</dt>
            <dd>{cad(bill.subtotalMinor)}</dd>
          </div>
          <div>
            <dt>{t("Tax")}</dt>
            <dd>{cad(bill.taxMinor)}</dd>
          </div>
          <div>
            <dt>{t("Whole bill")}</dt>
            <dd>{cad(bill.totalMinor)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
