import { PickupHandoffForm } from "./PickupHandoffForm.js";
import { useEffect, useRef, useState } from "react";
import {
  createPickupProofClient,
  PickupProofClientError,
  type PickupVerification,
} from "./pickup-proof-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import type { PickupQueueItem, PickupWorkstation } from "./pickup.js";
import { browserOffline } from "./stale-read.js";

const client = createPickupProofClient();
/** WP-2423: said when five wrong codes lock code checks, and kept on the order's card after. */
export const pickupCodeLockedText =
  "Too many wrong codes for this order. Check the customer in person instead: the order number with the name or the last four digits of the phone on the order.";
type Intent = ReturnType<typeof client.prepare>;
export function PickupProofForm({
  item,
  csrf,
  storeReference,
  workstation,
  paused = false,
  onRecorded,
  onLocked,
}: {
  /** WP-2423: the handover was recorded (the queue re-reads and confirms it). */
  readonly onRecorded?: (() => void) | undefined;
  /** WP-2423: five wrong codes locked code checks; the queue re-reads to offer the in-person check. */
  readonly onLocked?: (() => void) | undefined;
  /** IDR-0039: offline or stale; nothing is sent and nothing is queued for later. */
  readonly paused?: boolean;
  readonly workstation?: PickupWorkstation | null | undefined;
  readonly item: PickupQueueItem;
  readonly csrf: string;
  readonly storeReference: string;
}) {
  const [verification, setVerification] = useState<PickupVerification | null>(null);
  const [open, setOpen] = useState(false),
    [credential, setCredential] = useState("");
  const [status, setStatus] = useState<
    "Idle" | "Pending" | "Verified" | "OutcomeUnknown" | "Rejected" | "Locked"
  >("Idle");
  // WP-2423: a wrong code is said plainly and staff can ask again (each wrong code counts).
  const [wrongCode, setWrongCode] = useState<"Mismatch" | "Format" | null>(null);
  const intent = useRef<Intent | null>(null),
    controller = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null),
    formRef = useRef<HTMLFormElement>(null),
    retryButtonRef = useRef<HTMLButtonElement>(null),
    restoreRetryFocus = useRef(false);
  useEffect(
    () => () => {
      controller.current?.abort();
      intent.current?.dispose();
    },
    [],
  );
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (status === "Idle" && wrongCode) inputRef.current?.focus();
  }, [status, wrongCode]);
  useEffect(() => {
    if (status !== "OutcomeUnknown" || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    if (document.activeElement === document.body) retryButtonRef.current?.focus();
  }, [status]);
  const submit = async (retry: boolean) => {
    if (
      paused ||
      browserOffline() ||
      controller.current ||
      status === "Verified" ||
      status === "Rejected" ||
      status === "Locked"
    )
      return;
    restoreRetryFocus.current = retry
      ? document.activeElement === retryButtonRef.current
      : Boolean(formRef.current?.contains(document.activeElement));
    try {
      if (!retry) {
        if (intent.current) return;
        intent.current = client.prepare({
          item,
          storeReference,
          credential,
          idempotencyReference: serviceOperationReference(),
          correlationReference: serviceOperationReference(),
        });
        setCredential("");
      }
      if (!intent.current) return;
      const active = new AbortController();
      controller.current = active;
      setStatus("Pending");
      try {
        const result = await intent.current.execute(csrf, active.signal);
        if (!active.signal.aborted) {
          setWrongCode(null);
          setVerification(result);
          setStatus("Verified");
        }
      } catch (error) {
        if (!active.signal.aborted) {
          const code = error instanceof PickupProofClientError ? error.code : "Rejected";
          if (code === "OutcomeUnknown") setStatus("OutcomeUnknown");
          else if (code === "Locked") {
            setStatus("Locked");
            onLocked?.();
          } else if (code === "Rejected" || code === "Invalid") {
            // Ask again with a fresh check; the server counts each wrong code.
            intent.current?.dispose();
            intent.current = null;
            setWrongCode("Mismatch");
            setStatus("Idle");
            restoreRetryFocus.current = false;
          } else setStatus("Rejected");
        }
      } finally {
        if (controller.current === active) controller.current = null;
      }
    } catch {
      // The typed text is not a pickup code at all: nothing was sent.
      intent.current?.dispose();
      intent.current = null;
      setCredential("");
      setWrongCode("Format");
      setStatus("Idle");
    }
  };
  if (!open)
    return (
      <button disabled={paused} onClick={() => setOpen(true)}>
        Check pickup code
      </button>
    );
  return (
    <section aria-label="Pickup code check">
      <p>
        Ask the customer to read the 6-digit pickup code on their order page. A matching code does
        not hand the order over by itself.
      </p>
      {status === "Idle" ? (
        <form
          ref={formRef}
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(false);
          }}
        >
          <label>
            Pickup code
            <input
              ref={inputRef}
              type="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="numeric"
              maxLength={24}
              aria-invalid={wrongCode ? true : undefined}
              value={credential}
              onChange={(event) => setCredential(event.currentTarget.value)}
            />
          </label>
          <button type="submit" disabled={!credential || paused}>
            Check code
          </button>
        </form>
      ) : null}
      {paused ? <p role="status">Paused until the connection returns.</p> : null}
      <div role="status">
        {status === "Pending" ? "Checking the code…" : null}
        {status === "Verified"
          ? workstation
            ? "The code matches. Hand over the order below, then confirm."
            : "The code matches, but this device is not set up as the pickup counter, so the handover cannot be recorded here. Record it on the pickup counter device."
          : null}
        {status === "Idle" && wrongCode === "Mismatch"
          ? "That code doesn't match this order. Check the order number, then ask the customer to read the code again."
          : null}
        {status === "Idle" && wrongCode === "Format"
          ? "Pickup codes have 6 digits. Ask the customer to read the code again."
          : null}
        {status === "Locked" ? pickupCodeLockedText : null}
        {status === "Rejected"
          ? "That code could not be checked. Refresh the list, then try again."
          : null}
        {status === "OutcomeUnknown"
          ? "The check could not be confirmed. Try the same check again before asking for the code again."
          : null}
      </div>
      {status === "Verified" && verification && workstation ? (
        <PickupHandoffForm
          paused={paused}
          item={item}
          verification={verification}
          workstation={workstation}
          csrf={csrf}
          storeReference={storeReference}
          onRecorded={onRecorded}
        />
      ) : null}
      {status === "OutcomeUnknown" ? (
        <button ref={retryButtonRef} disabled={paused} onClick={() => void submit(true)}>
          Try the check again
        </button>
      ) : null}
    </section>
  );
}
