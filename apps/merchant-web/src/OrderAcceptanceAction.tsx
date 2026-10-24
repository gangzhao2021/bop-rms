import { t } from "./i18n/i18n.js";
import { useEffect, useRef, useState } from "react";
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
}: {
  readonly orderNumber: string;
  readonly csrf: string;
  readonly operation: () => Operation;
  readonly onAccepted: () => void;
  readonly onRejected: () => void;
  /** WP-2423 D1: the order changed or was accepted meanwhile; the list reloads its current state. */
  readonly onChanged?: () => void;
}) {
  const [state, setState] = useState<
    "Idle" | "Submitting" | "Unknown" | "Denied" | OrderAcceptanceConflict
  >("Idle");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const accept = async () => {
    if (pending.current !== null) return;
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
        } else
          setState(
            error instanceof OrderAcceptanceClientError && error.code === "OutcomeUnknown"
              ? "Unknown"
              : "Denied",
          );
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  return (
    <div className="card-actions">
      {state === "Idle" || state === "Submitting" || state === "Unknown" || state === "Changed" ? (
        <button disabled={state === "Submitting"} onClick={() => void accept()}>
          {state === "Unknown"
            ? t("Retry acceptance for ")
            : state === "Submitting"
              ? t("Accepting ")
              : t("Accept ")}
          {orderNumber}
        </button>
      ) : null}
      {state === "Unknown" ? (
        <p role="status">
          {t("Acceptance could not be confirmed. Retry the same request to recover its result.")}
        </p>
      ) : state === "Changed" ? (
        <p role="status">
          {t(
            "This order changed since the list was loaded. The list is refreshing; accept again if it still waits.",
          )}
        </p>
      ) : state === "AlreadyAccepted" ? (
        <p role="status">{t("Already accepted by someone else. It is in the kitchen.")}</p>
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
