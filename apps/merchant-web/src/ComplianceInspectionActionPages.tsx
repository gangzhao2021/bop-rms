import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ComplianceInspectionActionPageError,
  parseComplianceCorrectiveActionView,
  parseComplianceInspectionView,
  unavailableComplianceInspectionActionClient,
  type ComplianceCorrectiveActionView,
  type ComplianceInspectionActionClient,
  type ComplianceInspectionActionPageErrorCode,
  type ComplianceInspectionView,
} from "./compliance-inspection-action-pages.js";

type PageState<T> =
  | { readonly kind: "Loading" | ComplianceInspectionActionPageErrorCode }
  | { readonly kind: "Found"; readonly view: T };
export function ComplianceInspectionActionState({
  state,
}: {
  readonly state: "Loading" | ComplianceInspectionActionPageErrorCode;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading Compliance records", "Loading authorized append-only facts…", "neutral"],
    PermissionDenied: ["Permission denied", "Inspection or Action access is required.", "error"],
    NotFound: ["Record not found", "No authorized Inspection or Action exists.", "neutral"],
    Stale: ["Compliance projection stale", "Refresh owner-issued facts before acting.", "offline"],
    Conflict: ["Record changed", "Refresh the immutable revision before acting.", "offline"],
    CommandFailed: [
      "Action failed",
      "No Inspection, Finding, or Action fact was recorded.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached Compliance data cannot authorize actions.", "offline"],
    Unavailable: [
      "Compliance records unavailable",
      "No completion, verification, rating, or Evidence state is inferred.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
const label = (value: string) => value.replace(/([a-z])([A-Z])/gu, "$1 $2");

export function ComplianceInspectionList({ view }: { readonly view: ComplianceInspectionView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-INSPECTION · Compliance</p>
          <h1>Inspections</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
        {view.permissions.maySchedule ? <button>Schedule Inspection</button> : null}
      </header>
      <form className="list-filters" aria-label="Inspection filters">
        <label>
          Inspection reference
          <input value={view.filters.inspectionReference ?? ""} readOnly />
        </label>
        <label>
          Type
          <input value={view.filters.inspectionType ?? "All"} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.status ?? "All"} readOnly />
        </label>
        <label>
          Store
          <input value={view.filters.storeReference ?? "All authorized"} readOnly />
        </label>
        <label>
          Finding severity
          <input value={view.filters.findingSeverity ?? "All"} readOnly />
        </label>
      </form>
      {view.inspections.length === 0 ? (
        <StatePanel heading="No Inspections" tone="neutral" status>
          <p>No authorized Inspection matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Inspections">
          {view.inspections.map((item) => (
            <article className="summary-card" key={item.inspectionReference}>
              <p className="bop-eyebrow">
                {label(item.inspectionType)} · revision {item.recordVersion}
              </p>
              <h2>{label(item.status)}</h2>
              <p>
                Inspection {item.inspectionReference} · Case {item.caseReference}
              </p>
              <p>
                Scope {item.scopeCode} · Store {item.storeReference ?? "Brand scope"}
              </p>
              <p>
                Inspector {item.inspectorReference} · authority {item.authorityReference ?? "None"}
              </p>
              <p>
                Scheduled {item.scheduledAt ?? "Not scheduled"} · completed{" "}
                {item.completedAt ?? "No"}
              </p>
              <p>
                Findings {item.findingCount} · highest {item.highestSeverity ?? "None"} · Evidence
                refs {item.evidenceReferenceCount}
              </p>
              <div className="card-actions">
                {view.permissions.mayRecord && item.status !== "Finalized" ? (
                  <button>Record progress</button>
                ) : null}
                {view.permissions.mayAddFinding ? <button>Add Finding</button> : null}
                {view.permissions.mayFinalize && item.status === "InProgress" ? (
                  <button>Finalize immutable record</button>
                ) : null}
                {view.permissions.mayCorrect && item.status === "Finalized" ? (
                  <button>Append correction</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Checklist and Requirement Versions are pinned. Original Findings and authority ratings are
        never overwritten; corrections append a linked revision.
      </p>
    </main>
  );
}

export function ComplianceCorrectiveActionList({
  view,
}: {
  readonly view: ComplianceCorrectiveActionView;
}) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-CORRECTIVE-ACTION · Compliance</p>
          <h1>Corrective Actions</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
      </header>
      <form className="list-filters" aria-label="Corrective Action filters">
        <label>
          Action reference
          <input value={view.filters.actionReference ?? ""} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.status ?? "All"} readOnly />
        </label>
        <label>
          Owner
          <input value={view.filters.ownerReference ?? "All"} readOnly />
        </label>
        <label>
          Due
          <input value={view.filters.dueDisposition ?? "All"} readOnly />
        </label>
        <label>
          Severity
          <input value={view.filters.severity ?? "All"} readOnly />
        </label>
      </form>
      {view.actions.length === 0 ? (
        <StatePanel heading="No Corrective Actions" tone="neutral" status>
          <p>No authorized Action matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Corrective Actions">
          {view.actions.map((item) => (
            <article className="summary-card" key={item.actionReference}>
              <p className="bop-eyebrow">
                {item.severity === "ImmediateDanger" ? "Immediate Danger" : item.severity} ·{" "}
                {item.priority} priority
              </p>
              <h2>{label(item.status)}</h2>
              <p>
                Action {item.actionReference} · Case {item.caseReference} · Finding{" "}
                {item.findingReference}
              </p>
              <p>
                Required action {item.requiredActionCode} · owner {item.ownerReference}
              </p>
              <p>
                Due {item.dueAt} ({item.dueTimezone}) ·{" "}
                {item.overdue ? "Overdue / escalated" : "On time"}
              </p>
              <p>
                Evidence refs {item.completionEvidenceCount} · owner outcome{" "}
                {item.ownerOutcomeReference ?? "Pending"}
              </p>
              <p>
                Verification {item.verificationResult ?? "Not verified"} · verifier{" "}
                {item.verifierReference ?? "None"}
              </p>
              {item.independenceRequired ? <p>Independent verifier required</p> : null}
              {item.followUpTaskReference ? (
                <p>Follow-up Task {item.followUpTaskReference}</p>
              ) : null}
              <div className="card-actions">
                {view.permissions.mayAssign ? <button>Assign</button> : null}
                {view.permissions.mayStart &&
                ["Planned", "Blocked", "VerificationFailed"].includes(item.status) ? (
                  <button>Start / resume</button>
                ) : null}
                {view.permissions.maySubmitEvidence && item.status === "InProgress" ? (
                  <button>Submit Evidence reference</button>
                ) : null}
                {view.permissions.mayRequestVerification && item.status === "Completed" ? (
                  <button>Request verification</button>
                ) : null}
                {view.permissions.mayVerify && item.status === "Completed" ? (
                  <button>Verify</button>
                ) : null}
                {view.permissions.mayReject && item.status === "Completed" ? (
                  <button>Reject verification</button>
                ) : null}
                {view.permissions.mayClose && item.status === "Verified" ? (
                  <button>Close</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Completed is not Verified. Operational work remains in the owning Domain; this screen stores
        only opaque outcome and Evidence references.
      </p>
    </main>
  );
}

function usePage<T>(
  client: ComplianceInspectionActionClient,
  parse: (value: unknown) => T,
): PageState<T> {
  const [state, setState] = useState<PageState<T>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof ComplianceInspectionActionPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client, parse]);
  return state;
}
export function ComplianceInspectionPage({
  client = unavailableComplianceInspectionActionClient,
}: {
  readonly client?: ComplianceInspectionActionClient;
}) {
  const state = usePage(client, parseComplianceInspectionView);
  return state.kind === "Found" ? (
    <ComplianceInspectionList view={state.view} />
  ) : (
    <ComplianceInspectionActionState state={state.kind} />
  );
}
export function ComplianceCorrectiveActionPage({
  client = unavailableComplianceInspectionActionClient,
}: {
  readonly client?: ComplianceInspectionActionClient;
}) {
  const state = usePage(client, parseComplianceCorrectiveActionView);
  return state.kind === "Found" ? (
    <ComplianceCorrectiveActionList view={state.view} />
  ) : (
    <ComplianceInspectionActionState state={state.kind} />
  );
}
