import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ComplianceQualificationPageError,
  parseComplianceQualificationView,
  unavailableComplianceQualificationClient,
  type ComplianceQualificationClient,
  type ComplianceQualificationPageErrorCode,
  type ComplianceQualificationView,
} from "./compliance-qualification-page.js";
type PageState =
  | { readonly kind: "Loading" | ComplianceQualificationPageErrorCode }
  | { readonly kind: "Found"; readonly view: ComplianceQualificationView };
export function ComplianceQualificationState({
  state,
}: {
  readonly state: "Loading" | ComplianceQualificationPageErrorCode;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading Qualifications", "Loading authorized qualification records…", "neutral"],
    PermissionDenied: ["Permission denied", "Qualification access is required.", "error"],
    NotFound: ["Record not found", "No authorized qualification record exists.", "neutral"],
    Stale: ["Qualification projection stale", "Refresh owner records before acting.", "offline"],
    Conflict: ["Record changed", "Refresh the immutable revision before acting.", "offline"],
    CommandFailed: ["Action failed", "No qualification or owner outcome was inferred.", "error"],
    Offline: ["Offline read-only", "Cached qualifications cannot authorize actions.", "offline"],
    Unavailable: [
      "Qualifications unavailable",
      "No permit, employee, supplier, or device eligibility is inferred.",
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
export function ComplianceQualification({ view }: { readonly view: ComplianceQualificationView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-QUALIFICATION · Compliance</p>
          <h1>Permits and Qualifications</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayAddVerifiedRecord ? <button>Add verified record</button> : null}
      </header>
      <form className="list-filters" aria-label="Qualification filters">
        <label>
          Subject
          <input value={view.filters.subjectReference ?? "All authorized"} readOnly />
        </label>
        <label>
          Kind / Type
          <input
            value={`${view.filters.subjectKind ?? "All"} · ${view.filters.qualificationTypeCode ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Status / Expiry
          <input
            value={`${view.filters.status ?? "All"} · ${view.filters.expiryDisposition ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Store
          <input value={view.filters.storeReference ?? "Brand scope"} readOnly />
        </label>
        <label>
          Requirement
          <input value={view.filters.requirementVersionReference ?? "All"} readOnly />
        </label>
      </form>
      {view.records.length === 0 ? (
        <StatePanel heading="No Qualification Records" tone="neutral" status>
          <p>No authorized permit or qualification matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Qualification records">
          {view.records.map((item) => (
            <article className="summary-card" key={item.qualificationReference}>
              <p className="bop-eyebrow">
                {item.subjectKind} · {item.subjectCode} · {item.severity}
              </p>
              <h2>{label(item.status)}</h2>
              <p>
                {item.qualificationTypeCode} · jurisdiction {item.jurisdictionCode}
              </p>
              <p>
                Effective {item.effectiveFrom} · expires {item.expiresAt}
              </p>
              <p>
                Issuer ref {item.issuerReference} · Evidence ref {item.evidenceReference}
              </p>
              <p>
                Verification {item.verificationResult} · reviewer{" "}
                {item.verifiedByReference ?? "None"}
              </p>
              <p>
                Requirement {item.requirementVersionReference} · source owner {item.owner}
                {item.ownerRecordReference ? ` / ${item.ownerRecordReference}` : ""}
              </p>
              <p>
                Eligibility outcome {item.eligibilityOutcomeReference ?? "None"} · renewal Task{" "}
                {item.renewalTaskReference ?? "None"}
              </p>
              <div className="card-actions">
                {view.permissions.mayReview &&
                ["Draft", "PendingVerification"].includes(item.status) ? (
                  <button>Review immutable record</button>
                ) : null}
                {view.permissions.maySuspendEligibility &&
                ["Active", "Expiring", "Expired"].includes(item.status) &&
                item.eligibilityOutcomeReference === null ? (
                  <button>Suspend eligibility through owner</button>
                ) : null}
                {view.permissions.mayRequestRenewal &&
                ["Active", "Expiring", "Expired", "Suspended"].includes(item.status) &&
                item.renewalTaskReference === null ? (
                  <button>Request renewal Task</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Supplier, Employee, Membership, and Device master facts remain owner-controlled. Certificate
        numbers, raw Evidence, credentials, and legal narrative are not exposed here.
      </p>
    </main>
  );
}
export function ComplianceQualificationPage({
  client = unavailableComplianceQualificationClient,
}: {
  readonly client?: ComplianceQualificationClient;
}) {
  const [state, setState] = useState<PageState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseComplianceQualificationView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof ComplianceQualificationPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <ComplianceQualification view={state.view} />
  ) : (
    <ComplianceQualificationState state={state.kind} />
  );
}
