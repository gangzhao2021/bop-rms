import { useRef, useState } from "react";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";
import { storeTime } from "./StoreTime.js";

type Order = CurrentOrderQueue["items"][number];
type Hold = NonNullable<Order["acceptanceHold"]>;

/** WP-2423 Q9-G1: orders paid online while the Store was offline that still need a decision. */
export function heldOrders(view: CurrentOrderQueue): readonly Order[] {
  return view.items.filter(
    (order) => order.acceptanceHold !== null && !order.acceptanceHold.refundChosen,
  );
}

/** "Paid during an outage · decide" status text for the order row. */
export function acceptanceHoldText(hold: Hold, now: number): string {
  if (hold.refundChosen) return "Refund chosen · refund pending";
  if (hold.decideBy === null) return "Paid during an outage · decide";
  const left = Date.parse(hold.decideBy) - now;
  if (left <= 0) return "Decision time ended · refund pending";
  return `Paid during an outage · decide within ${Math.ceil(left / 60_000)} min`;
}

export function acceptanceHoldTier(hold: Hold, now: number): "warning" | "urgent" | "lapsed" {
  if (hold.refundChosen || (hold.decideBy !== null && Date.parse(hold.decideBy) <= now))
    return "lapsed";
  return hold.decideBy !== null && Date.parse(hold.decideBy) - now <= 5 * 60_000
    ? "urgent"
    : "warning";
}

/** WP-2423 Q9-G1: the banner above the Orders list while held orders wait for a decision. */
export function AcceptanceHoldNotice({
  view,
  onShow,
}: {
  readonly view: CurrentOrderQueue;
  readonly onShow: () => void;
}) {
  const held = heldOrders(view);
  if (held.length === 0) return null;
  return (
    <section className="order-hold-notice" role="status" aria-labelledby="order-hold-heading">
      <h2 id="order-hold-heading">Paid during an outage — decide</h2>
      <p>
        {held.length === 1
          ? "1 online order was paid while the store was offline. "
          : `${held.length} online orders were paid while the store was offline. `}
        They were not refunded automatically. Accept each one (also if you already made it from a
        paper ticket), or refund it. Once the store is back online you have 15 minutes; after that
        an order you have not accepted is refunded automatically.
      </p>
      <button type="button" onClick={onShow}>
        Show these orders
      </button>
    </section>
  );
}

type Outcome = "Idle" | "Pending" | "Done" | "NotHeld" | "Denied" | "Unknown";
const message: Record<Exclude<Outcome, "Idle">, string> = {
  Pending: "Refunding…",
  Done: "Refund chosen. The customer's payment is being refunded in full.",
  NotHeld: "This order was already accepted or closed. Refresh to see it.",
  Denied: "Only a store manager or owner can refund this order.",
  Unknown: "Result unknown. Try again; the refund is only made once.",
};

/**
 * WP-2423 Q9-G1: the decision for one held order. Accepting uses the ordinary Accept action
 * (rendered by the caller); this adds the explanation and the refund choice.
 */
export function AcceptanceHoldDecision({
  order,
  hold,
  csrf,
  timeZone,
  accept,
  onSettled,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly hold: Hold;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly accept: React.ReactNode;
  readonly onSettled: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [outcome, setOutcome] = useState<Outcome>("Idle");
  const titleId = "hold-refund-" + hold.holdReference;
  const refund = async () => {
    if (outcome === "Pending") return;
    setOutcome("Pending");
    let next: Exclude<Outcome, "Idle" | "Pending">;
    try {
      const response = await fetcher("/merchant/orders/acceptance-hold/refund", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify({
          orderReference: order.orderReference,
          orderBatchReference: hold.orderBatchReference,
          holdReference: hold.holdReference,
        }),
      });
      next = response.ok
        ? "Done"
        : response.status === 403
          ? "Denied"
          : response.status === 409 || response.status === 400
            ? "NotHeld"
            : "Unknown";
    } catch {
      next = "Unknown";
    }
    setOutcome(next);
    if (next === "Done" || next === "NotHeld") {
      dialog.current?.close();
      onSettled();
    }
  };
  if (hold.refundChosen)
    return (
      <div className="order-hold-decision">
        <p className="order-workbench-closed" role="note">
          You chose to refund this order. The customer&apos;s payment is being refunded in full to
          their original payment method.
        </p>
      </div>
    );
  return (
    <div className="order-hold-decision">
      <p className="order-workbench-closed" role="note">
        Paid online at a time the store was offline
        {hold.storeLastSeenAt === null
          ? ""
          : ` (staff screens last active ${storeTime(hold.storeLastSeenAt, timeZone, true)})`}
        . It was not refunded automatically.{" "}
        {hold.decideBy === null
          ? "Decide once the store is back online."
          : `Accept or refund it by ${storeTime(hold.decideBy, timeZone, true)}; otherwise it is refunded automatically.`}{" "}
        If you already made it from a paper ticket, accept it, then mark it ready and hand it over
        as usual.
      </p>
      <div className="card-actions">
        {accept}
        {hold.canRefund ? (
          <button
            type="button"
            className="order-cancel-open"
            disabled={outcome === "Done"}
            onClick={() => dialog.current?.showModal()}
          >
            Refund instead
          </button>
        ) : null}
      </div>
      {outcome === "Done" ? <p role="status">{message.Done}</p> : null}
      <dialog
        ref={dialog}
        className="order-cancel-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (outcome === "Pending") event.preventDefault();
        }}
      >
        <h2 id={titleId}>Refund order {order.orderNumber}</h2>
        <p>
          The order will not be made. The customer is refunded in full to their original payment
          method and sees that the store could not accept it.
        </p>
        {outcome !== "Idle" && outcome !== "Done" ? <p role="status">{message[outcome]}</p> : null}
        <div className="card-actions">
          <button type="button" onClick={() => void refund()} disabled={outcome === "Pending"}>
            Refund order
          </button>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            disabled={outcome === "Pending"}
          >
            Keep it
          </button>
        </div>
      </dialog>
    </div>
  );
}
