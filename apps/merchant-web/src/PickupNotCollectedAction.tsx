import { useRef, useState } from "react";
import type { PickupQueueItem } from "./pickup.js";
import { serviceOperationReference } from "./service-control-client.js";

/** One hour after an order is ready the pickup hold ends (pickup code validity). */
export const pickupHoldMinutes = 60;

type Outcome = "Idle" | "Pending" | "Closed" | "Denied" | "NotEligible" | "Unknown";

/** The close command: intent only; staff identity, time and eligibility are server-owned. */
export function closeUncollectedBody(
  item: PickupQueueItem,
  storeReference: string,
  intent: { readonly idempotencyReference: string; readonly correlationReference: string },
) {
  if (!item.execution) throw new Error("PICKUP_NOT_COLLECTED_UNAVAILABLE");
  return {
    orderReference: item.orderReference,
    storeReference,
    expectedAggregateVersion: item.execution.aggregateVersion,
    idempotencyReference: intent.idempotencyReference,
    correlationReference: intent.correlationReference,
  };
}
/** Closed, a manager-only denial, no longer eligible, or unknown (retry the same intent). */
export function closeUncollectedOutcome(status: number): Exclude<Outcome, "Idle" | "Pending"> {
  return status >= 200 && status < 300
    ? "Closed"
    : status === 403
      ? "Denied"
      : status === 409 || status === 422
        ? "NotEligible"
        : "Unknown";
}

/**
 * WP-2423: close a ready pickup nobody collected after the pickup hold. It is not refunded; a
 * manager may still grant an ordinary refund. One intent keeps its idempotency key so a lost
 * response is retried safely.
 */
export function PickupNotCollectedAction({
  item,
  csrf,
  storeReference,
  fetcher = fetch,
}: {
  readonly item: PickupQueueItem;
  readonly csrf: string;
  readonly storeReference: string;
  readonly fetcher?: typeof fetch;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const intent = useRef<{ idempotencyReference: string; correlationReference: string } | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("Idle");
  const submit = async () => {
    if (!item.execution || outcome === "Pending") return;
    intent.current ??= {
      idempotencyReference: serviceOperationReference(),
      correlationReference: serviceOperationReference(),
    };
    setOutcome("Pending");
    try {
      const response = await fetcher("/merchant/pickup/not-collected", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(closeUncollectedBody(item, storeReference, intent.current)),
      });
      setOutcome(closeUncollectedOutcome(response.status));
    } catch {
      setOutcome("Unknown");
    }
  };
  const message: Record<Exclude<Outcome, "Idle">, string> = {
    Pending: "Closing…",
    Closed: "Closed as not collected. Refresh the queue.",
    Denied: "Only a manager can close an uncollected order.",
    NotEligible: "This order can no longer be closed. Refresh the queue.",
    Unknown: "Result unknown. Retry the same close to recover its result.",
  };
  return (
    <>
      <button disabled={outcome === "Closed"} onClick={() => dialog.current?.showModal()}>
        Mark not collected
      </button>
      {outcome === "Closed" ? <p role="status">{message.Closed}</p> : null}
      <dialog ref={dialog} aria-labelledby={"not-collected-" + item.fulfillmentReference}>
        <h2 id={"not-collected-" + item.fulfillmentReference}>Close as not collected</h2>
        <p>
          Order {item.publicOrderNumber ?? "reference unavailable"} has waited more than{" "}
          {pickupHoldMinutes} minutes and nobody collected it. Closing it removes it from the pickup
          queue and the order cannot be handed over afterwards.
        </p>
        <p>
          The customer is not refunded automatically. If the Store decides to refund, a manager does
          it from the order&apos;s payments.
        </p>
        {outcome === "Idle" || outcome === "Unknown" ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />
              I checked the pickup shelf and nobody collected this order
            </label>
            <button disabled={!confirmed} onClick={() => void submit()}>
              {outcome === "Unknown" ? "Retry same close" : "Close as not collected"}
            </button>
          </>
        ) : null}
        <p role="status">{outcome === "Idle" ? null : message[outcome]}</p>
        <button disabled={outcome === "Pending"} onClick={() => dialog.current?.close()}>
          Close
        </button>
      </dialog>
    </>
  );
}
