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
type Intent = ReturnType<typeof client.prepare>;
export function PickupProofForm({
  item,
  csrf,
  storeReference,
  workstation,
  paused = false,
}: {
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
    "Idle" | "Pending" | "Verified" | "OutcomeUnknown" | "Rejected"
  >("Idle");
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
      status === "Rejected"
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
          setVerification(result);
          setStatus("Verified");
        }
      } catch (error) {
        if (!active.signal.aborted)
          setStatus(
            error instanceof PickupProofClientError && error.code === "OutcomeUnknown"
              ? "OutcomeUnknown"
              : "Rejected",
          );
      } finally {
        if (controller.current === active) controller.current = null;
      }
    } catch {
      setCredential("");
      setStatus("Rejected");
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
        Ask the customer for the pickup code shown on their order page. A matching code does not
        hand the order over by itself.
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
              type="password"
              autoComplete="off"
              spellCheck={false}
              inputMode={item.execution?.proof?.kind === "HumanCode" ? "numeric" : "text"}
              maxLength={item.execution?.proof?.kind === "HumanCode" ? 6 : 22}
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
        {status === "Rejected"
          ? "That code was not accepted. Refresh the list, then ask the customer to check the code."
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
