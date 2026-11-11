import { t } from "./i18n/i18n.js";
import { useEffect, useRef, useState } from "react";
import { acceptanceUnknownText } from "./failure-words.js";
import { SlowWaitNotice } from "./slow-wait.js";
import {
  OrderAcceptanceClientError,
  type OrderAcceptanceConflict,
  type createOrderAcceptanceClient,
} from "./order-acceptance-client.js";
type Operation = ReturnType<ReturnType<typeof createOrderAcceptanceClient>["prepare"]>;
export function OrderAcceptanceAction({
  orderNumber,
  csrf,
  operation,
  onAccepted,
  onRejected,
  onChanged,
  onUnknown,
  resumeUnknown = false,
  paused = false,
  held = false,
  closeWith = null,
}: {
  /**
   * Accept all is sending this list's accepts right now: a row's own Accept waits for it, so the
   * same round is never sent twice at once (staff would see a "changed" answer for nothing).
   */
  readonly held?: boolean;
  /**
   * merchant-outage-recovery M100: this device has no network, so an Accept could not be sent.
   * Only offline pauses it: a list that could not be refreshed still accepts, because the server
   * refuses an outdated accept (Changed, AlreadyAccepted) and a paid order's refund deadline runs.
   */
  readonly paused?: boolean;
  readonly orderNumber: string;
  /**
   * Orders v2: this round's earlier attempt is still unresolved (its operation is kept only until
   * the outcome is known), so the button shown again — in the panel, or back in the row — offers
   * the same retry instead of a fresh "Accept".
   */
  readonly resumeUnknown?: boolean;
  readonly csrf: string;
  readonly operation: () => Operation;
  readonly onAccepted: () => void;
  readonly onRejected: () => void;
  /**
   * v15 2026-11-11: this attempt ended with no answer, so the round's other copies of the button
   * (and this one, shown again) offer "Accept again" for the same operation.
   */
  readonly onUnknown?: () => void;
  /** WP-2423 D1: the order changed or was accepted meanwhile; the list reloads its current state. */
  readonly onChanged?: () => void;
  /**
   * WP-2423 M10: the control this reader has to close an order already refunded in full — the
   * general "Refuse and refund" (a manager), "Can't make it" (whoever may accept), a refund
   * through the outage hold's "Refund instead", or none (ask a manager).
   */
  readonly closeWith?: "RefuseAndRefund" | "CantMake" | "RefundInstead" | null;
}) {
  const [state, setState] = useState<
    "Idle" | "Submitting" | "Unknown" | "Denied" | OrderAcceptanceConflict
  >(resumeUnknown ? "Unknown" : "Idle");
  // Another copy of this button (row or panel) may have left the attempt unresolved meanwhile.
  if (state === "Idle" && resumeUnknown) setState("Unknown");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const accept = async () => {
    if (pending.current !== null || paused || held) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    try {
      await operation().execute(csrf, controller.signal);
      if (!controller.signal.aborted) onAccepted();
    } catch (error) {
      if (
        !controller.signal.aborted &&
        error instanceof OrderAcceptanceClientError &&
        error.code !== "OutcomeUnknown"
      )
        onRejected();
      if (!controller.signal.aborted) {
        if (error instanceof OrderAcceptanceClientError && error.conflict !== null) {
          setState(error.conflict);
          onChanged?.();
        } else if (error instanceof OrderAcceptanceClientError && error.code === "OutcomeUnknown") {
          onUnknown?.();
          setState("Unknown");
        } else setState("Denied");
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  return (
    <div className="card-actions order-accept-action">
      {state === "Idle" || state === "Submitting" || state === "Unknown" || state === "Changed" ? (
        <button
          data-state={state}
          disabled={state === "Submitting" || paused || held}
          onClick={() => void accept()}
        >
          {state === "Unknown"
            ? t("Accept again ")
            : state === "Submitting"
              ? t("Accepting ")
              : t("Accept ")}
          {/* Orders v3: on a list row the number is already beside the button; it stays in the
              button's name for screen readers. */}
          <span className="order-accept-action__number">{orderNumber}</span>
        </button>
      ) : null}
      <SlowWaitNotice busy={state === "Submitting"} />
      {paused ? <p role="status">{t("Accept is paused until the connection is back.")}</p> : null}
      {state === "Unknown" ? (
        <p role="status">{acceptanceUnknownText}</p>
      ) : state === "Changed" ? (
        <p role="status">
          {t(
            "This order changed since the list was loaded. The list is refreshing; accept again if it still waits.",
          )}
        </p>
      ) : state === "AlreadyAccepted" ? (
        <p role="status">{t("Already accepted by someone else. It is in the kitchen.")}</p>
      ) : state === "FullyRefunded" ? (
        <p role="status">
          {closeWith === "RefuseAndRefund"
            ? t("This order was refunded in full. Close it with Refuse and refund.")
            : closeWith === "CantMake"
              ? t("This order was refunded in full. Close it with Can't make it.")
              : closeWith === "RefundInstead"
                ? t("This order was refunded in full. Close it with Refund instead.")
                : t("This order was refunded in full. Ask a manager to close it.")}
        </p>
      ) : state === "NotAcceptable" ? (
        <p role="status">
          {t(
            "This can no longer be accepted as it is (its time ran out or an item ran out). Refresh orders to see what to do.",
          )}
        </p>
      ) : state === "Denied" ? (
        <p role="status">
          {t(
            "Acceptance was not confirmed. Refresh orders to check the current state and permissions.",
          )}
        </p>
      ) : null}
    </div>
  );
}
