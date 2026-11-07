import { t } from "./i18n/i18n.js";
import { useRef, useState } from "react";
import type { PickupQueueItem } from "./pickup.js";
import { serviceOperationReference } from "./service-control-client.js";
import { browserOffline } from "./stale-read.js";

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
  paused = false,
  onClosed,
}: {
  /** WP-2423: the order was closed; the queue re-reads at once (as after a handover). */
  readonly onClosed?: (() => void) | undefined;
  /** IDR-0039: offline or stale; nothing is sent and nothing is queued for later. */
  readonly paused?: boolean;
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
    if (!item.execution || outcome === "Pending" || paused || browserOffline()) return;
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
      const result = closeUncollectedOutcome(response.status);
      setOutcome(result);
      if (result === "Closed") {
        dialog.current?.close();
        onClosed?.();
      }
    } catch {
      setOutcome("Unknown");
    }
  };
  const message: Record<Exclude<Outcome, "Idle">, string> = {
    Pending: "Closing…",
    Closed: t("Closed as not collected."),
    Denied: t("Only a manager can close an uncollected order."),
    NotEligible: t("This order can no longer be closed. Refresh the queue."),
    Unknown: t("Result unknown. Retry the same close to recover its result."),
  };
  return (
    <>
      <button
        className="pickup-not-collected"
        data-variant="destructive"
        disabled={outcome === "Closed" || paused}
        onClick={() => dialog.current?.showModal()}
      >
        {t("Mark not collected")}
      </button>
      {outcome === "Closed" ? <p role="status">{message.Closed}</p> : null}
      <dialog
        className="order-cancel-dialog pickup-handoff-dialog"
        ref={dialog}
        aria-labelledby={"not-collected-" + item.fulfillmentReference}
      >
        <h2 id={"not-collected-" + item.fulfillmentReference}>{t("Close as not collected")}</h2>
        <p>
          {t(
            "Order {value} has waited more than {pickupHoldMinutes} minutes and nobody collected it. Closing it removes it from the pickup queue and the order cannot be handed over afterwards.",
            {
              value: item.publicOrderNumber ?? t("reference unavailable"),
              pickupHoldMinutes: pickupHoldMinutes,
            },
          )}
        </p>
        <p>
          {t(
            "The customer is not refunded automatically. If the Store decides to refund, a manager does it from the order's payments.",
          )}
        </p>
        {item.remakeQuantity ? (
          // DEC-PICKUP-NOT-COLLECTED-REMAKE: the closure also cancels the remake (server-side).
          <p className="pickup-queue__remake" role="note">
            {t(
              "The kitchen is still remaking {value} for this order. Closing it also cancels the remake and takes it off the Kitchen screen. Tell the kitchen to stop making it.",
              {
                value:
                  item.remakeQuantity === 1
                    ? t("1 item")
                    : t("{remakeQuantity} items", { remakeQuantity: item.remakeQuantity }),
              },
            )}
          </p>
        ) : null}
        {outcome === "Idle" || outcome === "Unknown" ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />
              {t("I checked the pickup shelf and nobody collected this order")}
            </label>
            <button
              data-variant="destructive"
              disabled={!confirmed || paused}
              onClick={() => void submit()}
            >
              {outcome === "Unknown" ? t("Retry same close") : t("Close as not collected")}
            </button>
          </>
        ) : null}
        {paused ? <p role="status">{t("Paused until the connection returns.")}</p> : null}
        <p role="status">{outcome === "Idle" ? null : message[outcome]}</p>
        <button disabled={outcome === "Pending"} onClick={() => dialog.current?.close()}>
          {t("Close")}
        </button>
      </dialog>
    </>
  );
}

/**
 * WP-2423 store-service-controls (v15 M46, Owner item 9): the Store's service for the day has
 * ended (its last period's end, or a day it does not open), so the closing checklist can be done.
 */
export function storeClosingNow(
  day: { readonly closesAt?: string | null; readonly closedToday?: boolean } | null,
  at: number,
): boolean {
  if (day === null) return false;
  if (day.closedToday === true) return true;
  return day.closesAt !== undefined && day.closesAt !== null && at >= Date.parse(day.closesAt);
}

type BulkState = "Pending" | "Closed" | "Failed";

/**
 * At closing, every ready pickup nobody collected is closed in one confirmation, each with its own
 * command and idempotency key (kept for a retry), recorded with the reason "store closing". What
 * failed stays listed with Retry. Not refunded; a manager may still refund.
 */
export function PickupClosingAction({
  items,
  csrf,
  storeReference,
  fetcher = fetch,
  paused = false,
  onDone,
}: {
  readonly items: readonly PickupQueueItem[];
  readonly csrf: string;
  readonly storeReference: string;
  readonly fetcher?: typeof fetch;
  readonly paused?: boolean;
  readonly onDone?: (() => void) | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const intents = useRef(
    new Map<string, { idempotencyReference: string; correlationReference: string }>(),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [states, setStates] = useState<ReadonlyMap<string, BulkState>>(new Map());
  const open = items.filter(
    (item) => item.execution && states.get(item.fulfillmentReference) !== "Closed",
  );
  if (items.length === 0) return null;
  const label = (item: PickupQueueItem) => item.publicOrderNumber ?? t("reference unavailable");
  const closeAll = async () => {
    if (running || paused || browserOffline()) return;
    setRunning(true);
    let closed = 0;
    for (const item of open) {
      const key = item.fulfillmentReference;
      let intent = intents.current.get(key);
      if (!intent) {
        intent = {
          idempotencyReference: serviceOperationReference(),
          correlationReference: serviceOperationReference(),
        };
        intents.current.set(key, intent);
      }
      setStates((value) => new Map(value).set(key, "Pending"));
      let result: BulkState = "Failed";
      try {
        const response = await fetcher("/merchant/pickup/not-collected", {
          method: "POST",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          headers: { "content-type": "application/json", "x-bop-csrf": csrf },
          body: JSON.stringify({
            ...closeUncollectedBody(item, storeReference, intent),
            reason: "StoreClosing",
          }),
        });
        result = closeUncollectedOutcome(response.status) === "Closed" ? "Closed" : "Failed";
      } catch {
        result = "Failed";
      }
      if (result === "Closed") closed += 1;
      setStates((value) => new Map(value).set(key, result));
    }
    setRunning(false);
    if (closed > 0) onDone?.();
  };
  const done = items.filter((item) => states.get(item.fulfillmentReference) === "Closed").length;
  const failed = items.filter((item) => states.get(item.fulfillmentReference) === "Failed");
  return (
    <div className="pickup-closing">
      <button
        type="button"
        data-variant="destructive"
        disabled={paused || open.length === 0}
        onClick={() => dialog.current?.showModal()}
      >
        {t("Mark all not collected ({count})", { count: open.length })}
      </button>
      <dialog
        className="order-cancel-dialog pickup-handoff-dialog"
        ref={dialog}
        aria-labelledby="pickup-closing-title"
      >
        <h2 id="pickup-closing-title">{t("Close the pickups nobody collected")}</h2>
        <p>{t("The store has closed for today. These ready orders were not collected:")}</p>
        <ul className="pickup-closing__orders">
          {items.map((item) => (
            <li key={item.fulfillmentReference}>
              {t("Order {value}", { value: label(item) })}
              {states.get(item.fulfillmentReference) === "Closed"
                ? " · " + t("closed")
                : states.get(item.fulfillmentReference) === "Failed"
                  ? " · " + t("not closed yet")
                  : ""}
            </li>
          ))}
        </ul>
        <p>
          {t("Recorded with the reason: store closing. Not refunded; a manager can still refund.")}
        </p>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
          />
          {t("I checked the pickup shelf and nobody collected these orders")}
        </label>
        <button
          type="button"
          data-variant="destructive"
          disabled={!confirmed || paused || running || open.length === 0}
          onClick={() => void closeAll()}
        >
          {failed.length > 0
            ? t("Retry the {count} not closed", { count: failed.length })
            : t("Mark all not collected ({count})", { count: open.length })}
        </button>
        <p role="status">
          {running || done > 0
            ? t("Closed {done} of {count}.", { done, count: items.length })
            : null}
        </p>
        {failed.length > 0 && !running ? (
          <p role="alert">
            {t(
              "Some orders were not closed. They may have changed on another screen; retry, or close them one by one.",
            )}
          </p>
        ) : null}
        {paused ? <p role="status">{t("Paused until the connection returns.")}</p> : null}
        <button type="button" disabled={running} onClick={() => dialog.current?.close()}>
          {t("Close")}
        </button>
      </dialog>
    </div>
  );
}
