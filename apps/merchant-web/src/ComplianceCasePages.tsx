import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ComplianceCasePageError,
  parseComplianceCaseDetailView,
  parseComplianceCaseListView,
  unavailableComplianceCaseClient,
  type ComplianceCaseClient,
  type ComplianceCaseDetailView,
  type ComplianceCaseListView,
  type ComplianceCasePageErrorCode,
} from "./compliance-case-pages.js";
type PageState<T> =
  | { readonly kind: "Loading" | ComplianceCasePageErrorCode }
  | { readonly kind: "Found"; readonly view: T };
export function ComplianceCaseState({
  state,
}: {
  readonly state: "Loading" | ComplianceCasePageErrorCode;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading Compliance Cases", "Loading authorized Case facts…", "neutral"],
    PermissionDenied: ["Permission denied", "Compliance Case access is required.", "error"],
    NotFound: ["Case not found", "No authorized Compliance Case exists.", "neutral"],
    Stale: ["Case projection stale", "Refresh owner-issued Case facts before acting.", "offline"],
    Conflict: ["Case changed", "Refresh the immutable Case revision before acting.", "offline"],
    CommandFailed: [
      "Action failed",
      "No Case, containment, or notification fact was recorded.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached Case data cannot authorize actions.", "offline"],
    Unavailable: [
      "Compliance Cases unavailable",
      "No Case, containment, notification, or closure state is inferred.",
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
export function ComplianceCaseList({ view }: { readonly view: ComplianceCaseListView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-CASE-LIST · Compliance</p>
          <h1>Compliance Cases</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayCreate ? <button>Create Case</button> : null}
      </header>
      <form className="list-filters" aria-label="Compliance Case filters">
        <label>
          Case reference
          <input value={view.filters.caseReference ?? ""} readOnly />
        </label>
        <label>
          Type
          <input value={view.filters.caseType ?? "All"} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.lifecycle ?? "All"} readOnly />
        </label>
        <label>
          Severity
          <input value={view.filters.severity ?? "All"} readOnly />
        </label>
        <label>
          Store
          <input value={view.filters.storeReference ?? "All authorized"} readOnly />
        </label>
        <label>
          Owner
          <input value={view.filters.ownerReference ?? "All"} readOnly />
        </label>
      </form>
      {view.cases.length === 0 ? (
        <StatePanel heading="No Compliance Cases" tone="neutral" status>
          <p>No authorized Case matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Compliance Cases">
          {view.cases.map((item) => (
            <article className="summary-card" key={item.caseReference}>
              <p className="bop-eyebrow">
                {label(item.caseType)} ·{" "}
                {item.severity === "ImmediateDanger" ? "Immediate Danger" : item.severity}
              </p>
              <h2>{label(item.lifecycle)}</h2>
              <p>
                Case {item.caseReference} · Store {item.storeReference ?? "Brand scope"}
              </p>
              <p>
                Owner {item.ownerReference ?? "Unassigned"} · deadline {item.deadlineAt ?? "None"}
              </p>
              <p>
                Containment {item.containmentStatus} · notification {item.notificationStatus} · open
                actions {item.openActionCount}
              </p>
              <div className="card-actions">
                <button>View Case</button>
                {view.permissions.mayAssign ? <button>Assign</button> : null}
                {view.permissions.mayReviewMergeSplit ? (
                  <button>Review merge / split</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Merge and split are review intent only. Original Case identities, Evidence and Audit history
        remain append-only.
      </p>
    </main>
  );
}
export function ComplianceCaseDetail({ view }: { readonly view: ComplianceCaseDetailView }) {
  const item = view.case;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-CASE-DETAIL · {label(item.caseType)}</p>
          <h1>
            {item.severity === "ImmediateDanger" ? "Immediate Danger" : item.severity} ·{" "}
            {label(item.lifecycle)}
          </h1>
          <p>
            Case {item.caseReference} · source as of {view.sourceAsOf}
          </p>
        </div>
      </header>
      {view.legalHoldActive ? (
        <StatePanel heading="Legal Hold active" tone="offline" status>
          <p>Retention or deletion actions remain unavailable; Case facts are unchanged.</p>
        </StatePanel>
      ) : null}
      <section className="detail-grid">
        <article className="summary-card">
          <h2>Scope and requirements</h2>
          <p>
            Owner {item.ownerReference ?? "Unassigned"} · deadline {item.deadlineAt ?? "None"}
          </p>
          <p>Requirements {view.requirementVersionReferences.join(", ")}</p>
          {view.relatedScopes.map((scope) => (
            <p key={`${scope.kind}:${scope.reference}`}>
              {label(scope.kind)} · {scope.reference} · snapshot {scope.snapshotCode}
            </p>
          ))}
        </article>
        <article className="summary-card">
          <h2>Closure gates</h2>
          <p>
            Open findings {view.gateCounts.openFindings} · mandatory actions incomplete{" "}
            {view.gateCounts.mandatoryActionsIncomplete}
          </p>
          <p>
            Evidence missing {view.gateCounts.evidenceMissing} · verification pending{" "}
            {view.gateCounts.verificationPending}
          </p>
        </article>
      </section>
      <section className="card-list" aria-label="Containment records">
        {view.containment.map((record) => (
          <article className="summary-card" key={record.containmentReference}>
            <h2>
              {label(record.action)} · {record.status}
            </h2>
            <p>
              {record.hardBlock ? "Hard Block" : "Advisory"} · owner action{" "}
              {record.ownerActionReference ?? "Pending"}
            </p>
            <p>{record.occurredAt}</p>
          </article>
        ))}
      </section>
      <section className="card-list" aria-label="Regulatory notifications">
        {view.notifications.map((record) => (
          <article
            className="summary-card"
            key={`${record.notificationReference}:${record.occurredAt}`}
          >
            <h2>Regulatory Notification · {label(record.status)}</h2>
            <p>
              Authority {record.authorityReference} · requirement{" "}
              {record.requirementVersionReference}
            </p>
            <p>
              Deadline {record.deadlineAt} · submission{" "}
              {record.submissionReference ?? "Not submitted"}
            </p>
          </article>
        ))}
      </section>
      <div className="card-actions">
        {view.permissions.mayTransition ? <button>Acknowledge / transition</button> : null}
        {view.permissions.mayContain ? <button>Request owning-Domain containment</button> : null}
        {view.permissions.mayRecordNotification ? (
          <button>Record notification decision</button>
        ) : null}
        {view.permissions.mayClose ? <button>Verify closure gates</button> : null}
      </div>
      <section aria-label="Case timeline">
        {view.timeline.map((entry) => (
          <p key={entry.entryReference}>
            {entry.occurredAt} · {entry.eventCode}
          </p>
        ))}
      </section>
      <p role="note">
        This page stores opaque references only. Owning Domains execute operational actions;
        Notification delivery and raw Evidence remain outside this screen.
      </p>
    </main>
  );
}
function usePage<T>(client: ComplianceCaseClient, parse: (value: unknown) => T): PageState<T> {
  const [state, setState] = useState<PageState<T>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof ComplianceCasePageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client, parse]);
  return state;
}
export function ComplianceCaseListPage({
  client = unavailableComplianceCaseClient,
}: {
  readonly client?: ComplianceCaseClient;
}) {
  const state = usePage(client, parseComplianceCaseListView);
  return state.kind === "Found" ? (
    <ComplianceCaseList view={state.view} />
  ) : (
    <ComplianceCaseState state={state.kind} />
  );
}
export function ComplianceCaseDetailPage({
  client = unavailableComplianceCaseClient,
}: {
  readonly client?: ComplianceCaseClient;
}) {
  const state = usePage(client, parseComplianceCaseDetailView);
  return state.kind === "Found" ? (
    <ComplianceCaseDetail view={state.view} />
  ) : (
    <ComplianceCaseState state={state.kind} />
  );
}
