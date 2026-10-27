import { t } from "./i18n/i18n.js";
import { useEffect, useMemo, useState } from "react";
import {
  CurrentOrderLines,
  failedPaymentBatches,
  orderRefundRows,
  storeCancelledBatches,
  unpaidCancelledBatches,
} from "./CurrentOrderQueuePage.js";
import { DiningRoundsProvider } from "./DiningRounds.js";
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
}: {
  readonly orderReference: string;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly refreshKey: string;
  readonly locked?: boolean;
  readonly onBusy?: ((busy: boolean) => void) | undefined;
  readonly onChanged?: (() => void) | undefined;
  readonly fetcher?: typeof fetch | undefined;
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
          failedPaymentBatches={failedPaymentBatches(detail.view)}
          refundRows={orderRefundRows(detail.order, detail.lines, detail.paymentPosition)}
          rounds={{ batches: detail.order.batches, timeZone, today }}
        />
      </DiningRoundsProvider>
    </section>
  );
}
