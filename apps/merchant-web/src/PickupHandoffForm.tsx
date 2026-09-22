import { useEffect, useRef, useState } from "react";
import { createPickupHandoffClient, PickupHandoffClientError } from "./pickup-handoff-client.js";
import type { PickupVerification } from "./pickup-proof-client.js";
import type { PickupQueueItem, PickupWorkstation } from "./pickup.js";
import { serviceOperationReference } from "./service-control-client.js";
const client = createPickupHandoffClient();
export function PickupHandoffForm({
  item,
  verification,
  workstation,
  csrf,
  storeReference,
}: {
  readonly item: PickupQueueItem;
  readonly verification: PickupVerification;
  readonly workstation: PickupWorkstation;
  readonly csrf: string;
  readonly storeReference: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    controller = useRef<AbortController | null>(null);
  const intent = useRef<ReturnType<typeof client.prepare> | null>(null);
  const [status, setStatus] = useState<
    "Idle" | "Pending" | "Unknown" | "Rejected" | "Completed" | "InProgress"
  >("Idle");
  const [recipient, setRecipient] = useState<"" | "Customer" | "Delegate">(""),
    [mask, setMask] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const locked = status === "Pending" || status === "Unknown";
  useEffect(
    () => () => {
      controller.current?.abort();
      intent.current?.dispose();
    },
    [],
  );
  useEffect(() => {
    if (!locked) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [locked]);
  const submit = async (retry: boolean) => {
    if (controller.current || (!retry && (status !== "Idle" || !confirmed || !recipient || !mask)))
      return;
    try {
      if (!retry) {
        if (intent.current || !recipient) return;
        intent.current = client.prepare({
          item,
          verification,
          workstation,
          storeReference,
          recipientType: recipient,
          recipientDisplayMask: mask,
          idempotencyReference: serviceOperationReference(),
          correlationReference: serviceOperationReference(),
        });
        setMask("");
      }
      if (!intent.current) return;
      const active = new AbortController();
      controller.current = active;
      setStatus("Pending");
      try {
        const result = await intent.current.execute(csrf, active.signal);
        if (!active.signal.aborted) setStatus(result.nextPhase);
      } catch (error) {
        if (!active.signal.aborted)
          setStatus(
            error instanceof PickupHandoffClientError && error.code === "OutcomeUnknown"
              ? "Unknown"
              : "Rejected",
          );
      } finally {
        if (controller.current === active) controller.current = null;
      }
    } catch {
      setMask("");
      setStatus("Rejected");
    }
  };
  const lines =
    item.execution?.items.filter((line) => line.readyQuantity > line.handedOverQuantity) ?? [];
  return (
    <>
      <button disabled={status !== "Idle"} onClick={() => dialog.current?.showModal()}>
        Review pickup handoff
      </button>
      {status === "Completed" || status === "InProgress" ? (
        <p role="status">Handoff recorded. Refresh the queue to see current status.</p>
      ) : null}
      <dialog
        ref={dialog}
        aria-labelledby={"handoff-" + item.fulfillmentReference}
        onCancel={(event) => {
          if (locked) event.preventDefault();
        }}
      >
        <h2 id={"handoff-" + item.fulfillmentReference}>Confirm pickup handoff</h2>
        <p>
          Order{" "}
          {item.publicOrderNumber ??
            item.execution?.publicOrderReference ??
            "reference unavailable"}
        </p>
        <ul>
          {lines.map((line, index) => (
            <li key={line.fulfillmentItemReference}>
              Order line {index + 1}: {line.readyQuantity - line.handedOverQuantity} remaining ready
              units
            </li>
          ))}
        </ul>
        <p>Hand over all quantities shown only after matching them to this order.</p>
        {status === "Idle" ? (
          <form
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
          >
            <label>
              Recipient type
              <select
                value={recipient}
                onChange={(event) => setRecipient(event.currentTarget.value as typeof recipient)}
              >
                <option value="">Select recipient</option>
                <option value="Customer">Customer</option>
                <option value="Delegate">Delegate</option>
              </select>
            </label>
            <label>
              Masked recipient label
              <input
                value={mask}
                maxLength={64}
                autoComplete="off"
                placeholder="S***"
                onChange={(event) => setMask(event.currentTarget.value)}
              />
            </label>
            <p>Use a masked label only. Do not enter a full name, phone number or pickup code.</p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />
              I matched this order, recipient and all quantities shown
            </label>
            <button type="submit" disabled={!confirmed || !recipient || !mask}>
              Confirm and record handoff
            </button>
          </form>
        ) : null}
        <div role="status">
          {status === "Pending" ? "Recording handoff…" : null}
          {status === "Unknown"
            ? "Handoff result unknown. Do not hand over again. Retry this same operation to recover its result."
            : null}
          {status === "Rejected"
            ? "Handoff was not confirmed. Close and refresh the queue before another attempt."
            : null}
          {status === "Completed" || status === "InProgress"
            ? "Handoff recorded. Close and refresh the queue."
            : null}
        </div>
        {status === "Unknown" ? (
          <button onClick={() => void submit(true)}>Retry same handoff</button>
        ) : null}
        <button disabled={locked} onClick={() => dialog.current?.close()}>
          Close handoff confirmation
        </button>
      </dialog>
    </>
  );
}
