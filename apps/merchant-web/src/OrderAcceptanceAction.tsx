import { useEffect, useRef, useState } from "react";
import {
  OrderAcceptanceClientError,
  type createOrderAcceptanceClient,
} from "./order-acceptance-client.js";
type Operation = ReturnType<ReturnType<typeof createOrderAcceptanceClient>["prepare"]>;
export function OrderAcceptanceAction({
  orderNumber,
  csrf,
  operation,
  onAccepted,
  onRejected,
}: {
  readonly orderNumber: string;
  readonly csrf: string;
  readonly operation: () => Operation;
  readonly onAccepted: () => void;
  readonly onRejected: () => void;
}) {
  const [state, setState] = useState<"Idle" | "Submitting" | "Unknown" | "Denied">("Idle");
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
      if (!controller.signal.aborted)
        setState(
          error instanceof OrderAcceptanceClientError && error.code === "OutcomeUnknown"
            ? "Unknown"
            : "Denied",
        );
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  return (
    <div className="card-actions">
      {state !== "Denied" ? (
        <button disabled={state === "Submitting"} onClick={() => void accept()}>
          {state === "Unknown"
            ? "Retry acceptance for "
            : state === "Submitting"
              ? "Accepting "
              : "Accept "}
          {orderNumber}
        </button>
      ) : null}
      {state === "Unknown" ? (
        <p role="status">
          Acceptance could not be confirmed. Retry the same request to recover its result.
        </p>
      ) : state === "Denied" ? (
        <p role="status">
          Acceptance was not confirmed. Refresh orders to check the current state and permissions.
        </p>
      ) : null}
    </div>
  );
}
