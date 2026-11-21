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
        // b13 (DEC-TAX-WHOLE-RECEIPT): one Tax line, the tax worked out once on the whole bill
        // (its rounding included), as checkout and the paid bill print it.
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

/**
 * b40 (v15 b39 live): on a table with tables merged into it, each round's number on the whole
 * bill (by round reference), read from checkout's bill (rounds numbered across every merged order in the order they
 * were sent, as checkout, the split and the guest show them). "Reading" until the first answer, so
 * no round is shown under one number and then another; null when the read fails (each order then
 * keeps its own numbers) or when nothing was merged in.
 */
export function useBillRoundNumbers(input: {
  readonly diningSessionReference: string | null;
  readonly merged: boolean;
  readonly csrf: string;
  readonly refreshKey: string;
  readonly fetcher?: typeof fetch | undefined;
}): ReadonlyMap<string, number> | null | "Reading" {
  const { diningSessionReference, merged, csrf, refreshKey, fetcher } = input;
  const [read, setRead] = useState<{
    readonly session: string;
    readonly rounds: ReadonlyMap<string, number> | null;
  } | null>(null);
  useEffect(() => {
    if (!merged || diningSessionReference === null) return;
    const controller = new AbortController();
    createTableCheckoutClient(fetcher)
      .bill(csrf, diningSessionReference, controller.signal)
      .then((bill) => {
        if (controller.signal.aborted) return;
        const rounds = new Map<string, number>();
        for (const round of bill.rounds)
          if (round.orderBatchReference !== undefined)
            rounds.set(round.orderBatchReference, round.roundNumber);
        setRead({ session: diningSessionReference, rounds });
      })
      .catch(() => {
        // A failed reread keeps the last numbers; a failed first read: each order's own.
        if (!controller.signal.aborted)
          setRead((last) =>
            last !== null && last.session === diningSessionReference
              ? last
              : { session: diningSessionReference, rounds: null },
          );
      });
    return () => controller.abort();
  }, [csrf, diningSessionReference, merged, fetcher, refreshKey]);
  if (!merged || diningSessionReference === null) return null;
  return read !== null && read.session === diningSessionReference ? read.rounds : "Reading";
}
