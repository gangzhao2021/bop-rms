import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ComplianceAllergenIncidentPageError,
  parseComplianceAllergenReviewView,
  parseComplianceIncidentView,
  unavailableComplianceAllergenIncidentClient,
  type ComplianceAllergenIncidentClient,
  type ComplianceAllergenIncidentPageErrorCode,
  type ComplianceAllergenReviewView,
  type ComplianceIncidentView,
} from "./compliance-allergen-incident-pages.js";
type PageState<T> =
  | { readonly kind: "Loading" | ComplianceAllergenIncidentPageErrorCode }
  | { readonly kind: "Found"; readonly view: T };
export function ComplianceAllergenIncidentState({
  state,
}: {
  readonly state: "Loading" | ComplianceAllergenIncidentPageErrorCode;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading Food Safety", "Loading authorized control records…", "neutral"],
    PermissionDenied: ["Permission denied", "Food Safety access is required.", "error"],
    NotFound: ["Record not found", "No authorized control record exists.", "neutral"],
    Stale: ["Food Safety projection stale", "Refresh owner facts before acting.", "offline"],
    Conflict: ["Record changed", "Refresh the immutable revision before acting.", "offline"],
    CommandFailed: [
      "Action failed",
      "No review, Incident, or block outcome was inferred.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached safety facts cannot authorize actions.", "offline"],
    Unavailable: [
      "Food Safety unavailable",
      "No allergen or Incident outcome is inferred.",
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
export function ComplianceAllergenReview({
  view,
}: {
  readonly view: ComplianceAllergenReviewView;
}) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-ALLERGEN-REVIEW · Food Safety</p>
          <h1>Allergen Control Review</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
      </header>
      <form className="list-filters" aria-label="Allergen review filters">
        <label>
          Subject
          <input value={view.filters.subjectReference ?? "All authorized"} readOnly />
        </label>
        <label>
          Kind
          <input value={view.filters.subjectKind ?? "All"} readOnly />
        </label>
        <label>
          Allergen
          <input value={view.filters.allergenReference ?? "All"} readOnly />
        </label>
        <label>
          Review / Evidence
          <input
            value={`${view.filters.reviewStatus ?? "All"} · ${view.filters.evidenceStatus ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Store
          <input value={view.filters.storeReference ?? "All"} readOnly />
        </label>
      </form>
      {view.records.length === 0 ? (
        <StatePanel heading="No Allergen Reviews" tone="neutral" status>
          <p>No authorized path matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Allergen reviews">
          {view.records.map((item) => (
            <article className="summary-card" key={item.reviewReference}>
              <p className="bop-eyebrow">
                {item.subjectKind} · {item.subjectCode} · {item.severity}
              </p>
              <h2>{label(item.reviewStatus)}</h2>
              <p>
                Policy {item.allergenPolicyVersionReference} · Recipe versions{" "}
                {item.recipeVersionReferenceCount}
              </p>
              {item.assertions.map((assertion) => (
                <p key={assertion.allergenReference}>
                  Allergen ref {assertion.allergenReference} · {label(assertion.classification)} ·
                  Evidence {assertion.evidenceStatus} until {assertion.validUntil}
                </p>
              ))}
              <p>
                Reviewer {item.reviewerReference ?? "Pending"} · Requirement{" "}
                {item.requirementVersionReference}
              </p>
              <p>
                Publication block {item.publicationBlockOutcomeReference ?? "None"} · Payment block{" "}
                {item.paymentBlockOutcomeReference ?? "None"}
              </p>
              <div className="card-actions">
                {view.permissions.mayReview && item.reviewStatus === "Pending" ? (
                  <button>Review exact path</button>
                ) : null}
                {view.permissions.mayApprove && item.reviewStatus === "Pending" ? (
                  <button>Approve exact path</button>
                ) : null}
                {view.permissions.mayInvalidate && item.reviewStatus !== "Invalidated" ? (
                  <button>Invalidate on source change</button>
                ) : null}
                {view.permissions.mayEnforceBlocks &&
                item.reviewStatus !== "Approved" &&
                item.publicationBlockOutcomeReference === null ? (
                  <button>Enforce owner blocks</button>
                ) : null}
                {view.permissions.mayOpenIncident &&
                ["Rejected", "Invalidated"].includes(item.reviewStatus) ? (
                  <button>Open Food Safety Incident</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Missing source data never means absence. This screen never creates an allergen-free claim
        and never writes Catalog publication or Payment state.
      </p>
    </main>
  );
}
export function ComplianceIncident({ view }: { readonly view: ComplianceIncidentView }) {
  const item = view.incident;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-INCIDENT · Restricted Food Safety</p>
          <h1>Food Safety Incident</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
      </header>
      <section className="detail-section">
        <p className="bop-eyebrow">
          {item.incidentType} · {item.severity}
        </p>
        <h2>{label(item.status)}</h2>
        <p>
          Incident {item.incidentReference} · Case {item.caseReference} · revision {item.revision}
        </p>
        <p>
          Occurred {item.occurredAt} · reported {item.reportedAt}
        </p>
        <p>
          Product {item.productReference ?? "None"} · Order {item.orderReference ?? "None"} · Lot{" "}
          {item.lotReference ?? "None"}
        </p>
        <p>
          Restricted snapshots {item.restrictedSnapshotReferenceCount} · Evidence refs{" "}
          {item.evidenceReferenceCount} · employee scope{" "}
          {item.employeeScopePresent ? "Present" : "None"}
        </p>
        <p>
          Containment outcomes {item.containmentOutcomeReferences.length} · Notification{" "}
          {item.notificationReference ?? "Pending"} · Investigation{" "}
          {item.investigationReference ?? "Pending"}
        </p>
        <p>
          Availability block {item.availabilityBlockOutcomeReference ?? "None"} · Payment block{" "}
          {item.paymentBlockOutcomeReference ?? "None"}
        </p>
        <p>
          Verification {item.verificationReference ?? "Pending"} · Outcome{" "}
          {item.outcomeCode ?? "Not established"}
        </p>
        <div className="card-actions">
          {view.permissions.mayEnforceBlocks &&
          item.availabilityBlockOutcomeReference === null &&
          item.status !== "Closed" &&
          item.status !== "Cancelled" ? (
            <button>Trigger owner safety blocks</button>
          ) : null}
          {view.permissions.mayAssign && item.status !== "Closed" ? (
            <button>Assign Incident owner</button>
          ) : null}
          {view.permissions.mayRecordNotificationDecision ? (
            <button>Record notification decision</button>
          ) : null}
          {view.permissions.mayLinkCases ? <button>Link related Cases</button> : null}
          {view.permissions.mayCloseAfterVerification &&
          item.status === "Verification" &&
          item.verificationReference !== null ? (
            <button>Close after Verification</button>
          ) : null}
        </div>
      </section>
      <p role="note">
        Reports do not establish liability. Medical narrative, contacts, Customer notes, Evidence
        bytes, and Payment data are partitioned outside this projection.
      </p>
    </main>
  );
}
function usePage<T>(
  client: ComplianceAllergenIncidentClient,
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
            kind: error instanceof ComplianceAllergenIncidentPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client, parse]);
  return state;
}
export function ComplianceAllergenReviewPage({
  client = unavailableComplianceAllergenIncidentClient,
}: {
  readonly client?: ComplianceAllergenIncidentClient;
}) {
  const state = usePage(client, parseComplianceAllergenReviewView);
  return state.kind === "Found" ? (
    <ComplianceAllergenReview view={state.view} />
  ) : (
    <ComplianceAllergenIncidentState state={state.kind} />
  );
}
export function ComplianceIncidentPage({
  client = unavailableComplianceAllergenIncidentClient,
}: {
  readonly client?: ComplianceAllergenIncidentClient;
}) {
  const state = usePage(client, parseComplianceIncidentView);
  return state.kind === "Found" ? (
    <ComplianceIncident view={state.view} />
  ) : (
    <ComplianceAllergenIncidentState state={state.kind} />
  );
}
