import { t } from "./i18n/i18n.js";
import { useRef, useState } from "react";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";
import { serviceOperationReference } from "./service-control-client.js";

type Order = CurrentOrderQueue["items"][number];

/**
 * WP-2423 (2026-10-16 v15 stock leak): what staff read on an Order of an earlier business day that
 * still has stock set aside, so stock is never held unseen and staff know what to do with it.
 */
export function heldStockText(order: Pick<Order, "heldStock" | "orderType">): string | null {
  const held = order.heldStock;
  if (held === null) return null;
  if (held.state === "Ended")
    return held.productionStarted
      ? t(
          "This order from an earlier day is finished, but ingredients are still set aside for it because the kitchen started it and never marked it done. Mark it done on the kitchen board.",
        )
      : t(
          "This order from an earlier day is finished, but ingredients are still set aside for it, so they cannot be sold. Release them to put them back into stock.",
        );
  if (held.productionStarted)
    return t(
      "Still open from an earlier day: the kitchen started it, and its ingredients stay set aside until it is done. Finish and hand it over, or mark it done on the kitchen board.",
    );
  return order.orderType === "Pickup"
    ? t(
        "Still open from an earlier day and holding ingredients that cannot be sold. Make it and hand it over if the guest comes back; otherwise cancel it — the guest is refunded and the ingredients go back into stock.",
      )
    : t(
        "Still open from an earlier day and holding ingredients that cannot be sold. Serve it, or cancel the round — the guest is refunded and the ingredients go back into stock.",
      );
}

export function HeldStockNotice({ order }: { readonly order: Order }) {
  const text = heldStockText(order);
  return text === null ? null : (
    <p className="order-held-stock" role="note">
      {text}
    </p>
  );
}

type Outcome = "Idle" | "Pending" | "Released" | "NotReleasable" | "Started" | "Denied" | "Unknown";
const outcomeText: Record<Exclude<Outcome, "Idle">, string> = {
  Pending: t("Releasing…"),
  Released: t("Released. The ingredients are back in stock."),
  NotReleasable: t("Nothing was released: this order changed. The list is refreshed."),
  Started: t(
    "Nothing was released: the kitchen started this order. Mark it done on the kitchen board.",
  ),
  Denied: t("Only a store manager or owner can release stock held by an order."),
  Unknown: t("Result unknown. Release again to recover the result — nothing is released twice."),
};

/** The release request: intent only; staff identity, time and eligibility are server-owned. */
/**
 * WP-2423 (2026-10-16 v15): the confirmation the page keeps after a release, since the order leaves
 * the list once its stock is back ("Ingredients for Order 7 (Sat, Oct 10) returned to stock.").
 */
export function heldStockReleasedText(
  order: Pick<Order, "orderNumber">,
  dayLabel: string | null,
): string {
  return t("Ingredients for Order {orderNumber}{value} returned to stock.", {
    orderNumber: order.orderNumber,
    value: dayLabel === null ? "" : ` (${dayLabel})`,
  });
}

export function heldStockReleaseBody(order: Order, operationReference: string) {
  if (order.heldStock === null || order.heldStock.state !== "Ended")
    throw new Error("HELD_STOCK_RELEASE_UNAVAILABLE");
  return {
    orderReference: order.orderReference,
    orderBatchReference: order.heldStock.orderBatchReference,
    operationReference,
  };
}

export function heldStockReleaseOutcome(status: number, error: string | null): Outcome {
  if (status >= 200 && status < 300) return "Released";
  if (status === 403) return "Denied";
  if (status === 409) return error === "order_preparation_started" ? "Started" : "NotReleasable";
  if (status === 400 || status === 404) return "NotReleasable";
  return "Unknown";
}

/** "Release stock" for an ended earlier-day Order; an unknown result retries the same operation. */
export function HeldStockReleaseAction({
  order,
  csrf,
  onSettled,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly csrf: string;
  /** Released: the page confirms it (the order then leaves the list); NotReleasable: rereads. */
  readonly onSettled: (outcome: "Released" | "NotReleasable") => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const operation = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("Idle");
  const release = async () => {
    if (outcome === "Pending") return;
    operation.current ??= serviceOperationReference();
    setOutcome("Pending");
    let next: Outcome;
    try {
      const response = await fetcher("/merchant/orders/release-stock", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(heldStockReleaseBody(order, operation.current)),
      });
      let error: string | null = null;
      if (!response.ok)
        try {
          const body = (await response.json()) as { error?: unknown } | null;
          error = typeof body?.error === "string" ? body.error : null;
        } catch {
          error = null;
        }
      next = heldStockReleaseOutcome(response.status, error);
    } catch {
      next = "Unknown";
    }
    if (next !== "Unknown") operation.current = null;
    setOutcome(next);
    if (next === "Released" || next === "NotReleasable") onSettled(next);
  };
  return (
    <div className="order-held-stock-action">
      <button type="button" disabled={outcome === "Pending"} onClick={() => void release()}>
        {outcome === "Unknown" ? t("Release again") : t("Release held ingredients")}
      </button>
      {outcome === "Idle" ? null : <p role="status">{outcomeText[outcome]}</p>}
    </div>
  );
}
