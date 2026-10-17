import { useEffect, useId, useRef, useState } from "react";
import {
  createReconciliationFollowUpClient,
  ReconciliationFollowUpClientError,
  type FollowUpView,
  type CaptureEvidenceSummary,
} from "./reconciliation-follow-up-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { SourceTime } from "./StoreTime.js";
import { formatCad } from "./order-money.js";
const client = createReconciliationFollowUpClient();
/** Staff words for the follow-up states (never the record's version). */
const followUpLabel: Record<FollowUpView["followUpStatus"], string> = {
  Open: "not yet acknowledged",
  Acknowledged: "acknowledged",
  Assigned: "assigned",
};
export function ReconciliationFollowUpAction({
  exceptionReference,
  csrf,
  readOnly,
  closed = false,
  showChargeDetails = true,
}: {
  exceptionReference: string;
  csrf: string;
  readOnly: boolean;
  /**
   * WP-2423: the difference is resolved, so its follow-up is closed: its last state is shown as
   * history and nothing can be acknowledged or assigned any more.
   */
  closed?: boolean;
  /** WP-2423: only a charge that matches no order has the payment provider's charge to show. */
  showChargeDetails?: boolean;
}) {
  const fieldId = useId(),
    [evidence, setEvidence] = useState<CaptureEvidenceSummary | null | undefined>(undefined),
    [view, setView] = useState<FollowUpView | null>(null),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [message, setMessage] = useState(""),
    [selection, setSelection] = useState(""),
    [assignees, setAssignees] = useState<readonly { reference: string; label: string }[]>([]),
    [nextAssignee, setNextAssignee] = useState<string | null>(null),
    [directoryMessage, setDirectoryMessage] = useState(
      "Load eligible employees to select another person.",
    ),
    [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const pending = useRef<AbortController | null>(null),
    intent = useRef<ReturnType<typeof client.prepare> | null>(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      pending.current?.abort();
    };
  }, []);
  async function load() {
    if (pending.current || unknown || !online) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setView(null);
    setMessage("");
    try {
      const result = await client.query(exceptionReference, csrf, controller.signal);
      if (!controller.signal.aborted) {
        setView(result);
        intent.current = null;
      }
    } catch {
      if (!controller.signal.aborted)
        setMessage(
          "The follow-up could not be read. Restore your connection and access, then review again.",
        );
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function loadEvidence() {
    if (pending.current || unknown || !online) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    setEvidence(undefined);
    try {
      const result = await client.evidence(exceptionReference, csrf, controller.signal);
      if (!controller.signal.aborted) setEvidence(result);
    } catch {
      if (!controller.signal.aborted)
        setMessage("The charge details could not be read. Check your access and try again.");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function loadAssignees(after: string | null) {
    if (pending.current || unknown || !online || readOnly || closed || !view) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setSelection("");
    setAssignees([]);
    setNextAssignee(null);
    setDirectoryMessage("");
    try {
      const result = await client.assignees(exceptionReference, after, csrf, controller.signal);
      if (!controller.signal.aborted) {
        setAssignees(result.items);
        setNextAssignee(result.nextAfterActorReference);
        setDirectoryMessage(
          result.items.length === 0
            ? "No eligible employees on this page."
            : "Eligibility is checked again when assigning.",
        );
      }
    } catch {
      if (!controller.signal.aborted)
        setDirectoryMessage("Employee directory unavailable. Check your access and try again.");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function submit(action: "Acknowledge" | "Assign" | "AssignSelf" | "Retry") {
    if (pending.current || !view || readOnly || closed || !online) return;
    if (unknown ? action !== "Retry" : action === "Retry") return;
    if (action === "Acknowledge" && view.acknowledged) return;
    if (action === "Assign" && !assignees.some((person) => person.reference === selection)) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    try {
      if (action !== "Retry")
        intent.current = client.prepare({
          exceptionReference,
          action,
          assigneeReference: action === "Assign" ? selection : null,
          expectedVersion: view.version,
          operationReference: serviceOperationReference(),
        });
      if (!intent.current) throw Error("FOLLOW_UP_UNAVAILABLE");
      await intent.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        setUnknown(false);
        setView(null);
        intent.current = null;
        setMessage(
          "Follow-up recorded. Review current follow-up to see the latest. The payment difference stays open until it is resolved.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof ReconciliationFollowUpClientError && error.kind !== "Unknown") {
          setUnknown(false);
          setView(null);
          intent.current = null;
          setMessage(
            error.kind === "Conflict"
              ? "Someone else changed this follow-up. Review it again before trying again."
              : "Action was not accepted. Check your access and review the follow-up again before trying again.",
          );
        } else {
          setUnknown(true);
          setMessage(
            "Result unknown. Keep this page open and retry the same action after restoring your connection and access.",
          );
        }
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const disabled = busy || readOnly || closed || !online || unknown;
  if (closed)
    return (
      <section aria-label="Payment reconciliation follow-up">
        <p>Follow-up closed: this difference is resolved.</p>
        <button disabled={busy || !online} onClick={() => void load()}>
          Show follow-up history
        </button>
        {showChargeDetails ? (
          <button disabled={busy || !online} onClick={() => void loadEvidence()}>
            View charge details
          </button>
        ) : null}
        {evidence !== undefined ? <ChargeDetails evidence={evidence} /> : null}
        {view ? (
          <p>
            Last follow-up before it closed: {followUpLabel[view.followUpStatus]} ·{" "}
            <SourceTime instant={view.updatedAt} />
          </p>
        ) : null}
        <p role="status" aria-live="polite">
          {busy ? "Working…" : message}
        </p>
      </section>
    );
  return (
    <section aria-label="Payment reconciliation follow-up">
      <button disabled={busy || unknown || !online} onClick={() => void load()}>
        Review current follow-up
      </button>
      {showChargeDetails ? (
        <button disabled={busy || unknown || !online} onClick={() => void loadEvidence()}>
          View charge details
        </button>
      ) : null}
      {evidence !== undefined ? <ChargeDetails evidence={evidence} /> : null}
      {!online ? <p role="status">Offline — follow-up is read-only.</p> : null}
      {readOnly ? <p>Refresh the page before acknowledging or assigning this difference.</p> : null}
      {view ? (
        <>
          <p>
            Follow-up: {followUpLabel[view.followUpStatus]} · last changed{" "}
            <SourceTime instant={view.updatedAt} />
          </p>
          <button
            disabled={disabled || view.acknowledged}
            onClick={() => void submit("Acknowledge")}
          >
            Acknowledge payment difference
          </button>
          <button disabled={disabled} onClick={() => void submit("AssignSelf")}>
            Assign to me
          </button>
          <button disabled={disabled} onClick={() => void loadAssignees(null)}>
            Load eligible employees
          </button>
          {nextAssignee ? (
            <button disabled={disabled} onClick={() => void loadAssignees(nextAssignee)}>
              Next employee page
            </button>
          ) : null}
          <label htmlFor={fieldId}>Assign to</label>
          <select
            id={fieldId}
            value={selection}
            disabled={disabled || assignees.length === 0}
            onChange={(event) => setSelection(event.target.value)}
          >
            <option value="">Select an employee</option>
            {assignees.map((person) => (
              <option key={person.reference} value={person.reference}>
                {person.label}
              </option>
            ))}
          </select>
          <p role="status">{directoryMessage}</p>
          <button
            disabled={disabled || !assignees.some((person) => person.reference === selection)}
            onClick={() => void submit("Assign")}
          >
            Assign payment difference
          </button>
        </>
      ) : null}
      {unknown ? (
        <button disabled={busy || readOnly || !online} onClick={() => void submit("Retry")}>
          Retry same follow-up
        </button>
      ) : null}
      <p role="status" aria-live="polite">
        {busy ? "Working…" : message}
      </p>
    </section>
  );
}

/** The charge the payment provider reported that matches no order, in the Store's time. */
function ChargeDetails({ evidence }: { evidence: CaptureEvidenceSummary | null }) {
  if (evidence === null)
    return (
      <p>
        No charge without a matching order is recorded for this difference. That alone does not mean
        the difference is resolved.
      </p>
    );
  return (
    <section aria-label="Charge details">
      <p>
        Charge of {formatCad(evidence.amountMinor)} taken{" "}
        <SourceTime instant={evidence.occurredAt} />
        {evidence.environment === "Test" ? " (test payment, no real money)" : ""}.
      </p>
      <p>
        Recorded <SourceTime instant={evidence.observedAt} />. When it was recorded, no order or
        payment of this store matched it. This record alone does not show whether it has since been
        refunded.
      </p>
    </section>
  );
}
