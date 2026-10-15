import { useEffect, useRef, useState } from "react";
import { createPickupHandoffClient, PickupHandoffClientError } from "./pickup-handoff-client.js";
import type { PickupVerification } from "./pickup-proof-client.js";
import type { PickupQueueItem, PickupWorkstation } from "./pickup.js";
import { serviceOperationReference } from "./service-control-client.js";
import { browserOffline } from "./stale-read.js";
import {
  readPickupIdentityCheck,
  type PickupIdentityOutcome,
} from "./pickup-identity-check-client.js";
const client = createPickupHandoffClient();

/**
 * WP-2423: what staff compare in person: the name on the order and the phone's last four digits
 * (the rest of the phone is never sent to this device). Shown only in the open dialog.
 */
export function PickupIdentityDetails({
  details,
  onRetry,
}: {
  readonly details: PickupIdentityOutcome | "Loading" | null;
  readonly onRetry: () => void;
}) {
  if (details === null) return null;
  if (details === "Loading") return <p role="status">Loading the name and phone on the order…</p>;
  if (details.status === "Available")
    return (
      <dl className="pickup-identity" aria-label="Details on the order">
        <div>
          <dt>Name on the order</dt>
          <dd>{details.name}</dd>
        </div>
        <div>
          <dt>Phone ends in</dt>
          <dd>
            {details.phoneLast4 === null ? (
              "No phone on the order"
            ) : (
              <>
                <span aria-hidden="true">•••• </span>
                <span className="pickup-identity__digits">{details.phoneLast4}</span>
              </>
            )}
          </dd>
        </div>
      </dl>
    );
  if (details.status === "Removed" || details.status === "NotGiven")
    return (
      <p role="status">
        {details.status === "Removed"
          ? "The customer's name and phone were deleted after the retention period."
          : "The customer did not leave a name or phone for this order."}{" "}
        Check the order number and ask the customer what they ordered. If you are not sure, ask a
        manager before handing it over.
      </p>
    );
  if (details.status === "NotEligible")
    return (
      <p role="status">This order changed. Close this and refresh the list before handing over.</p>
    );
  return (
    <p role="status">
      The name and phone on the order can&apos;t be shown right now.{" "}
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}
export function PickupHandoffForm({
  item,
  verification,
  workstation,
  csrf,
  storeReference,
  paused = false,
  onRecorded,
}: {
  /**
   * WP-2423: called once the handover is recorded; the queue closes this dialog, re-reads at once
   * so the order leaves Waiting, and says so plainly.
   */
  readonly onRecorded?: (() => void) | undefined;
  /** IDR-0039: offline or stale; nothing is sent and nothing is queued for later. */
  readonly paused?: boolean;
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
  // WP-2423: the name and phone digits to compare, read when the in-person dialog opens and
  // dropped when it closes.
  const [details, setDetails] = useState<PickupIdentityOutcome | "Loading" | null>(null);
  const detailsRequest = useRef<AbortController | null>(null);
  const loadDetails = () => {
    if (!inPerson || browserOffline()) return;
    detailsRequest.current?.abort();
    const active = new AbortController();
    detailsRequest.current = active;
    setDetails("Loading");
    void readPickupIdentityCheck({ item, storeReference, csrf, signal: active.signal }).then(
      (result) => {
        if (!active.signal.aborted) setDetails(result);
      },
    );
  };
  // No phone on the order to compare: only the name check can be chosen.
  const phoneUnavailable =
    details !== null &&
    details !== "Loading" &&
    (details.status === "Removed" ||
      details.status === "NotGiven" ||
      (details.status === "Available" && details.phoneLast4 === null));
  useEffect(
    () => () => {
      controller.current?.abort();
      detailsRequest.current?.abort();
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
      paused ||
      browserOffline() ||
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
        if (!active.signal.aborted) {
          setStatus(result.nextPhase);
          if (onRecorded) {
            dialog.current?.close();
            onRecorded();
          }
        }
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
      <button
        disabled={status !== "Idle" || paused}
        onClick={() => {
          dialog.current?.showModal();
          loadDetails();
        }}
      >
        {inPerson ? "Hand over after checking in person" : "Review pickup handoff"}
      </button>
      {status === "Completed" || status === "InProgress" ? (
        <p ref={resultAnnouncement} role="status" tabIndex={-1}>
          Handed over. The list is updating.
        </p>
      ) : status === "Rejected" ? (
        <p ref={resultAnnouncement} role="status" tabIndex={-1}>
          Handoff was not confirmed. Refresh the queue before another attempt.
        </p>
      ) : null}
      <dialog
        className="order-cancel-dialog pickup-handoff-dialog"
        ref={dialog}
        aria-labelledby={"handoff-" + item.fulfillmentReference}
        onClose={() => {
          detailsRequest.current?.abort();
          setDetails(null);
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
              Item {index + 1}: {line.readyQuantity - line.handedOverQuantity} to hand over
            </li>
          ))}
        </ul>
        <p>Match every item to the order ticket before handing it over.</p>
        {inPerson ? (
          <p>
            {item.proofReadiness === "Expired"
              ? "The customer's pickup code has expired."
              : item.proofReadiness === "Locked"
                ? "Too many wrong pickup codes were entered for this order, so code checks are locked."
                : "No pickup code was sent for this order."}{" "}
            Ask for the order number and check it with the name or the last four digits of the phone
            on the order before handing over.
          </p>
        ) : null}
        {inPerson ? <PickupIdentityDetails details={details} onRetry={loadDetails} /> : null}
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
                  <option value="OrderNumberAndPhoneLast4" disabled={phoneUnavailable}>
                    Order number and last four digits of the phone
                  </option>
                </select>
              </label>
            ) : null}
            <label>
              Collected by
              <select
                value={recipient}
                onChange={(event) => setRecipient(event.currentTarget.value as typeof recipient)}
              >
                <option value="">Choose who collected it</option>
                <option value="Customer">The customer</option>
                <option value="Delegate">Someone collecting for them</option>
              </select>
            </label>
            <label>
              Collector&rsquo;s initial
              <input
                value={mask}
                maxLength={64}
                autoComplete="off"
                placeholder="S***"
                onChange={(event) => setMask(event.currentTarget.value)}
              />
            </label>
            <p>
              Enter only an initial, such as S***, so the record shows who collected it. Do not
              enter a full name, phone number or pickup code.
            </p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />
              I matched this order, the person collecting it and every item shown
            </label>
            <button
              type="submit"
              data-variant="primary"
              disabled={paused || !confirmed || !recipient || !mask || (inPerson && !identityCheck)}
            >
              Confirm and record handoff
            </button>
          </form>
        ) : null}
        {paused ? <p role="status">Paused until the connection returns.</p> : null}
        <div role="status">
          {status === "Pending" ? "Recording handoff…" : null}
          {status === "Unknown"
            ? "The handover could not be confirmed. Do not hand anything over again; try confirming the same handover again."
            : null}
          {status === "Rejected"
            ? "Handoff was not confirmed. Close and refresh the queue before another attempt."
            : null}
          {status === "Completed" || status === "InProgress" ? "Handed over." : null}
        </div>
        {status === "Unknown" ? (
          <button disabled={paused} onClick={() => void submit(true)}>
            Try confirming again
          </button>
        ) : null}
        <button disabled={locked} onClick={() => dialog.current?.close()}>
          Close handoff confirmation
        </button>
      </dialog>
    </>
  );
}
