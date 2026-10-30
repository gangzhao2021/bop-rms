import { t } from "./i18n/i18n.js";
import { useEffect, useMemo, useState } from "react";
import {
  CurrentOrderLines,
  failedPaymentBatches,
  orderRefundRows,
  removedUnpaidItems,
  storeCancelledBatches,
  unpaidCancelledBatches,
} from "./CurrentOrderQueuePage.js";
import { DiningRoundsProvider } from "./DiningRounds.js";
import { PayLaterItemRemoveAction } from "./PayLaterItemRemoveAction.js";
import { compedText, ItemCompAction } from "./ItemCompAction.js";
import { orderMoney } from "./order-money.js";
import { useStoreBusinessDay } from "./StoreBusinessDay.js";
import {
  createCurrentOrderQueueClient,
  type CurrentOrderDetail,
} from "./current-order-queue-client.js";

/**
 * Orders v3 (Owner 2026-10-26): the table's order on the Tables page, round by round, the same as
 * on Orders — each round's dishes, when it was sent, how far the kitchen and serving are, its
 * amount — with "Served" and "All served" right there. Read with the table and again whenever the
 * Tables page rereads it (`refreshKey`).
 */
export function TableOrderRounds({
  orderReference,
  csrf,
  timeZone,
  refreshKey,
  locked = false,
  onBusy,
  onChanged,
  fetcher,
  roundPhones,
}: {
  readonly orderReference: string;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly refreshKey: string;
  readonly locked?: boolean;
  readonly onBusy?: ((busy: boolean) => void) | undefined;
  readonly onChanged?: (() => void) | undefined;
  readonly fetcher?: typeof fetch | undefined;
  /** WP-2423 item 8 ⑤: which phone sent each round (by round reference). */
  readonly roundPhones?: ReadonlyMap<string, number | null> | undefined;
}) {
  const client = useMemo(() => createCurrentOrderQueueClient(fetcher), [fetcher]);
  const today = useStoreBusinessDay()?.businessDate ?? null;
  const [state, setState] = useState<
    | { readonly kind: "Loading" | "Unavailable" | "PermissionDenied" }
    | { readonly kind: "Ready"; readonly detail: CurrentOrderDetail }
  >({ kind: "Loading" });
  const [served, setServed] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .loadDetail(orderReference, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setState({ kind: "Ready", detail });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A failed reread keeps the rounds already shown.
        setState((previous) =>
          previous.kind === "Ready"
            ? previous
            : {
                kind:
                  (error as { code?: string } | null)?.code === "PermissionDenied"
                    ? "PermissionDenied"
                    : "Unavailable",
              },
        );
      });
    return () => controller.abort();
  }, [client, orderReference, refreshKey, served]);
  if (state.kind === "PermissionDenied") return null;
  if (state.kind !== "Ready")
    return (
      <p className="order-lines-state" role="status">
        {state.kind === "Loading"
          ? t("Reading the table's order…")
          : t("The table's order could not be read. It is read again with the table.")}
      </p>
    );
  const { detail } = state;
  return (
    <section className="table-order-rounds" aria-label={t("This table's order")}>
      <DiningRoundsProvider
        orderReference={orderReference}
        csrf={csrf}
        refreshKey={refreshKey + ":" + String(served)}
        locked={locked}
        onBusy={onBusy}
        onChanged={() => {
          setServed((count) => count + 1);
          onChanged?.();
        }}
        fetcher={fetcher}
        closeActions={false}
      >
        <CurrentOrderLines
          lines={detail.lines}
          cancelledBatches={storeCancelledBatches(detail.view)}
          unpaidCancelledBatches={unpaidCancelledBatches(detail.view)}
          removedItems={removedUnpaidItems(detail.view)}
          failedPaymentBatches={failedPaymentBatches(detail.view)}
          refundRows={orderRefundRows(detail.order, detail.lines, detail.paymentPosition)}
          rounds={{ batches: detail.order.batches, timeZone, today, phones: roundPhones }}
        />
      </DiningRoundsProvider>
      {detail.order.batches
        .filter((batch) => batch.unpaidRemovableItems.length > 0)
        .map((batch) => (
          // DEC-DINE-IN-PAY-LATER (rule 2), item 8 ①: dishes come off the unpaid bill right here.
          <fieldset
            key={batch.orderBatchReference}
            disabled={locked}
            className="order-cancel-actions table-order-rounds__remove"
          >
            <PayLaterItemRemoveAction
              order={detail.order}
              batch={batch}
              lines={detail.lines.items}
              csrf={csrf}
              fetcher={fetcher}
              onSettled={() => {
                setServed((count) => count + 1);
                onChanged?.();
              }}
            />
          </fieldset>
        ))}
      {(() => {
        // WP-2423 item 8 ① segment 2: comps and discounts, kept on the record (never removed).
        const comps = detail.order.batches.flatMap((batch) => batch.compedItems);
        if (comps.length === 0) return null;
        // The table's bill (Payment's own figure): what is left to pay after the comps.
        const bill = detail.order.tableBill;
        const names = new Map(detail.lines.items.map((line) => [line.orderItemReference, line]));
        return (
          <ul className="table-order-rounds__comps" aria-label={t("Comps and discounts")}>
            {comps.map((comp) => (
              <li key={comp.orderItemReference}>
                <span>
                  {names.get(comp.orderItemReference)?.name ?? t("Dish")} ·{" "}
                  {compedText(comp.kind, comp.percent)}
                </span>
                <span>−{orderMoney({ amountMinor: comp.amountMinor, currencyCode: "CAD" })}</span>
              </li>
            ))}
            {bill !== null && bill.paid === null ? (
              <li className="table-order-rounds__owed">
                <span>{t("To pay after comps")}</span>
                <span>{orderMoney({ amountMinor: bill.totalMinor, currencyCode: "CAD" })}</span>
              </li>
            ) : null}
          </ul>
        );
      })()}
      {detail.order.batches.some((batch) => batch.compableItems.length > 0) ? (
        <fieldset disabled={locked} className="order-cancel-actions table-order-rounds__comp">
          <ItemCompAction
            order={detail.order}
            lines={detail.lines.items}
            csrf={csrf}
            fetcher={fetcher}
            onSettled={() => {
              setServed((count) => count + 1);
              onChanged?.();
            }}
          />
        </fieldset>
      ) : null}
    </section>
  );
}
