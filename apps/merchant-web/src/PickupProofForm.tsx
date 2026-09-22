import { PickupHandoffForm } from "./PickupHandoffForm.js";
import { useEffect, useRef, useState } from "react";
import {
  createPickupProofClient,
  PickupProofClientError,
  type PickupVerification,
} from "./pickup-proof-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import type { PickupQueueItem, PickupWorkstation } from "./pickup.js";

const client = createPickupProofClient();
type Intent = ReturnType<typeof client.prepare>;
export function PickupProofForm({
  item,
  csrf,
  storeReference,
  workstation,
}: {
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
  const inputRef = useRef<HTMLInputElement>(null);
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
  const submit = async (retry: boolean) => {
    if (controller.current || status === "Verified" || status === "Rejected") return;
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
  if (!open) return <button onClick={() => setOpen(true)}>Open proof verification</button>;
  return (
    <section aria-label="Pickup proof verification">
      <p>Verify the code for this exact order. Verification does not complete handoff.</p>
      {status === "Idle" ? (
        <form
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(false);
          }}
        >
          <label>
            Pickup credential
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
          <button type="submit" disabled={!credential}>
            Verify pickup proof
          </button>
        </form>
      ) : null}
      <div role="status">
        {status === "Pending" ? "Verifying pickup proof…" : null}
        {status === "Verified"
          ? "Proof verified. Handoff is not completed. A configured workstation and explicit confirmation are required."
          : null}
        {status === "Rejected"
          ? "Verification could not be accepted. Refresh the queue before trying again."
          : null}
        {status === "OutcomeUnknown"
          ? "Verification result unknown. Retry this same verification to recover its result."
          : null}
      </div>
      {status === "Verified" && verification && workstation ? (
        <PickupHandoffForm
          item={item}
          verification={verification}
          workstation={workstation}
          csrf={csrf}
          storeReference={storeReference}
        />
      ) : null}
      {status === "OutcomeUnknown" ? (
        <button onClick={() => void submit(true)}>Retry same verification</button>
      ) : null}
    </section>
  );
}
