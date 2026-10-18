import { useEffect, useRef, useState } from "react";
import {
  createDiningHostTransferClient,
  DiningHostClientError,
  type DiningHostSelection,
} from "./dining-host-transfer-client.js";
import { serviceOperationReference } from "./service-control-client.js";
type Operation = ReturnType<ReturnType<typeof createDiningHostTransferClient>["prepare"]>;
export function DiningHostTransferAction({
  diningSessionReference,
  csrf,
  disabled,
  onLocked,
}: {
  readonly diningSessionReference: string;
  readonly csrf: string;
  readonly disabled: boolean;
  readonly onLocked: (locked: boolean) => void;
}) {
  const [source, setSource] = useState<DiningHostSelection | null>(null),
    [target, setTarget] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [state, setState] = useState<"Idle" | "Loading" | "Submitting" | "Unknown">("Idle"),
    [message, setMessage] = useState("");
  const pending = useRef<AbortController | null>(null),
    operation = useRef<Operation | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const locked = disabled || state !== "Idle";
  const load = async () => {
    if (disabled || pending.current || operation.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Loading");
    onLocked(true);
    setSource(null);
    setTarget("");
    setConfirmed(false);
    setMessage("");
    try {
      const result = await createDiningHostTransferClient().selection(
        diningSessionReference,
        csrf,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setSource(result);
        if (!result.participants.some((p) => !p.isHost))
          setMessage(
            "No other active participants are available. Ask the guest to join this table first.",
          );
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(
          error instanceof DiningHostClientError && error.code === "Denied"
            ? "Your current permissions do not allow host transfer."
            : "Participants unavailable. Refresh to try again.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!controller.signal.aborted) {
          setState("Idle");
          onLocked(false);
        }
      }
    }
  };
  const execute = async () => {
    if (
      disabled ||
      pending.current ||
      (!operation.current && (!source || !target || !confirmed || state !== "Idle"))
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    onLocked(true);
    setMessage("");
    let unresolved = false;
    try {
      if (!operation.current) {
        if (!source) return;
        operation.current = createDiningHostTransferClient().prepare(
          source,
          target,
          serviceOperationReference(),
        );
      }
      const result = await operation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        operation.current = null;
        setSource(null);
        setTarget("");
        setConfirmed(false);
        setMessage(
          `Host transfer recorded at ${new Date(result.transferredAt).toLocaleString()}. Refresh participants to see the current host.`,
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        unresolved = error instanceof DiningHostClientError && error.code === "Unknown";
        if (!unresolved) {
          operation.current = null;
          setSource(null);
          setTarget("");
          setConfirmed(false);
        }
        setMessage(
          unresolved
            ? "The result is unknown. Retry the same host transfer before choosing another table or operation."
            : "Host transfer was not confirmed. Refresh participants and check your permissions.",
        );
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!controller.signal.aborted) {
          setState(unresolved ? "Unknown" : "Idle");
          onLocked(unresolved);
        }
      }
    }
  };
  return (
    <section aria-label="Dining host transfer">
      <h4>Order host</h4>
      <p>
        The host manages the shared cart. A transfer changes future permissions and preserves
        previous actions.
      </p>
      <button disabled={locked} onClick={() => void load()}>
        Refresh participants
      </button>
      {source ? (
        <>
          <ul>
            {source.participants.map((p, index) => (
              <li key={p.participantReference}>
                Participant {index + 1} · Joined {new Date(p.joinedAt).toLocaleString()}
                {p.isHost ? " · Current host" : ""}
              </li>
            ))}
          </ul>
          <label>
            New order host
            <select
              value={target}
              disabled={locked}
              onChange={(event) => {
                setTarget(event.target.value);
                setConfirmed(false);
              }}
            >
              <option value="">Select a participant</option>
              {source.participants.map((p, index) =>
                p.isHost ? null : (
                  <option key={p.participantReference} value={p.participantReference}>
                    Participant {index + 1} · Joined {new Date(p.joinedAt).toLocaleString()}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked || !target}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I have identified the selected guest and confirm the host transfer
          </label>
        </>
      ) : null}
      <button
        disabled={
          disabled ||
          state === "Loading" ||
          state === "Submitting" ||
          (state !== "Unknown" && (!source || !target || !confirmed))
        }
        onClick={() => void execute()}
      >
        {state === "Unknown"
          ? "Retry same host transfer"
          : state === "Submitting"
            ? "Transferring…"
            : "Transfer order host"}
      </button>
      <p role="status">{state === "Loading" ? "Loading participants…" : message}</p>
    </section>
  );
}
