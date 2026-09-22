import { useEffect, useId, useRef, useState } from "react";
import {
  createReconciliationFollowUpClient,
  ReconciliationFollowUpClientError,
  type FollowUpView,
  type CaptureEvidenceSummary,
} from "./reconciliation-follow-up-client.js";
import { serviceOperationReference } from "./service-control-client.js";
const client = createReconciliationFollowUpClient();
export function ReconciliationFollowUpAction({
  exceptionReference,
  csrf,
  readOnly,
}: {
  exceptionReference: string;
  csrf: string;
  readOnly: boolean;
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
          "Current follow-up unavailable. Restore your connection and access, then review again.",
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
        setMessage("Capture evidence unavailable. Check your access and try again.");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function loadAssignees(after: string | null) {
    if (pending.current || unknown || !online || readOnly || !view) return;
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
    if (pending.current || !view || readOnly || !online) return;
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
          "Follow-up recorded. Review current follow-up to see the latest state. The financial exception remains open.",
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
              ? "Another action changed this exception. Review the current state before trying again."
              : "Action was not accepted. Check your access and review the current state before trying again.",
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
  const disabled = busy || readOnly || !online || unknown;
  return (
    <section aria-label="Payment reconciliation follow-up">
      <button disabled={busy || unknown || !online} onClick={() => void load()}>
        Review current follow-up
      </button>
      <button disabled={busy || unknown || !online} onClick={() => void loadEvidence()}>
        View capture evidence
      </button>
      {evidence === null ? (
        <p>
          No provider-only capture evidence is recorded for this exception. This does not mean the
          difference is resolved.
        </p>
      ) : evidence ? (
        <section aria-label="Capture evidence summary">
          <p>
            Captured amount: CAD {(BigInt(evidence.amountMinor) / 100n).toString()}.
            {(BigInt(evidence.amountMinor) % 100n).toString().padStart(2, "0")}
          </p>
          <p>
            Environment: {evidence.environment === "Test" ? "Test — simulated payment" : "Live"}
          </p>
          <p>
            Captured at (UTC): <time dateTime={evidence.occurredAt}>{evidence.occurredAt}</time>
          </p>
          <p>
            Evidence observed at (UTC):{" "}
            <time dateTime={evidence.observedAt}>{evidence.observedAt}</time>
          </p>
          <p>
            No internal payment operation was found when this evidence was recorded. This historical
            evidence does not establish the current financial outcome.
          </p>
        </section>
      ) : null}
      {!online ? <p role="status">Offline — follow-up is read-only.</p> : null}
      {readOnly ? <p>Refresh the workbench before changing follow-up.</p> : null}
      {view ? (
        <>
          <p>
            Follow-up: {view.followUpStatus} · version {view.version}
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
