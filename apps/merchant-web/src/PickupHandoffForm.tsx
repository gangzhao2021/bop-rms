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
  /** Null when staff verify the customer in person (the pickup code expired or was never sent). */
  readonly verification: PickupVerification | null;
  readonly workstation: PickupWorkstation;
  readonly csrf: string;
  readonly storeReference: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    resultAnnouncement = useRef<HTMLParagraphElement>(null),
    controller = useRef<AbortController | null>(null);
  const intent = useRef<ReturnType<typeof client.prepare> | null>(null);
  const [status, setStatus] = useState<
    "Idle" | "Pending" | "Unknown" | "Rejected" | "Completed" | "InProgress"
  >("Idle");
  const inPerson = verification === null;
  const [identityCheck, setIdentityCheck] = useState<
    "" | "OrderNumberAndName" | "OrderNumberAndPhoneLast4"
  >("");
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
    if (
      controller.current ||
      (!retry &&
        (status !== "Idle" || !confirmed || !recipient || !mask || (inPerson && !identityCheck)))
    )
      return;
    try {
      if (!retry) {
        if (intent.current || !recipient) return;
        intent.current = client.prepare({
          item,
          verification,
          ...(identityCheck ? { identityCheck } : {}),
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
        {inPerson ? "Hand over after checking in person" : "Review pickup handoff"}
      </button>
      {status === "Completed" || status === "InProgress" ? (
        <p ref={resultAnnouncement} role="status" tabIndex={-1}>
          Handoff recorded. Refresh the queue to see current status.
        </p>
      ) : status === "Rejected" ? (
        <p ref={resultAnnouncement} role="status" tabIndex={-1}>
          Handoff was not confirmed. Refresh the queue before another attempt.
        </p>
      ) : null}
      <dialog
        ref={dialog}
        aria-labelledby={"handoff-" + item.fulfillmentReference}
        onClose={() => {
          if (status === "Rejected" || status === "Completed" || status === "InProgress")
            resultAnnouncement.current?.focus();
        }}
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
        {inPerson ? (
          <p>
            {item.proofReadiness === "Expired"
              ? "The customer's pickup code has expired."
              : "No pickup code was sent for this order."}{" "}
            Ask for the order number and check it with the name or the last four digits of the phone
            on the order before handing over.
          </p>
        ) : null}
        {status === "Idle" ? (
          <form
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
          >
            {inPerson ? (
              <label>
                Checked in person
                <select
                  value={identityCheck}
                  onChange={(event) =>
                    setIdentityCheck(event.currentTarget.value as typeof identityCheck)
                  }
                >
                  <option value="">Select what you checked</option>
                  <option value="OrderNumberAndName">Order number and name on the order</option>
                  <option value="OrderNumberAndPhoneLast4">
                    Order number and last four digits of the phone
                  </option>
                </select>
              </label>
            ) : null}
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
            <button
              type="submit"
              disabled={!confirmed || !recipient || !mask || (inPerson && !identityCheck)}
            >
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
