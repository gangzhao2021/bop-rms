import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  CompliancePolicyPageError,
  parseCompliancePolicyView,
  unavailableCompliancePolicyClient,
  type CompliancePolicyClient,
  type CompliancePolicyPageErrorCode,
  type CompliancePolicyView,
} from "./compliance-policy-page.js";

type PageState =
  | { readonly kind: "Loading" | CompliancePolicyPageErrorCode }
  | { readonly kind: "Found"; readonly view: CompliancePolicyView };
export function CompliancePolicyState({
  state,
}: {
  readonly state: "Loading" | CompliancePolicyPageErrorCode;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading Compliance Policies", "Loading authorized policy Versions…", "neutral"],
    PermissionDenied: ["Permission denied", "Compliance Policy access is required.", "error"],
    NotFound: ["Policy not found", "No authorized Policy Version exists.", "neutral"],
    FeatureDisabled: ["Policy management disabled", "This capability is not enabled.", "neutral"],
    Stale: ["Policy projection stale", "Refresh before review or publication.", "offline"],
    Conflict: ["Policy changed", "Refresh the immutable Version before acting.", "offline"],
    CommandFailed: ["Policy action failed", "No review or publication was inferred.", "error"],
    Offline: ["Offline read-only", "Cached policy facts cannot authorize actions.", "offline"],
    Unavailable: [
      "Policies unavailable",
      "No legal or owner-Control outcome is inferred.",
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
const label = (value: string) => value.replaceAll("_", " ").replace(/([a-z])([A-Z])/gu, "$1 $2");
export function CompliancePolicies({ view }: { readonly view: CompliancePolicyView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId} · Compliance Configuration</p>
          <h1>Policies and Regulatory Requirements</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayCreateRevision ? <button>Create policy revision</button> : null}
      </header>
      <form className="list-filters" aria-label="Compliance Policy filters">
        <label>
          Name / Requirement
          <input
            value={`${view.filters.nameCode ?? "All"} · ${view.filters.requirementTypeCode ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Jurisdiction / Layer
          <input
            value={`${view.filters.jurisdictionCode ?? "All"} · ${view.filters.layer ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Status / Effective
          <input
            value={`${view.filters.status ?? "All"} · ${view.filters.effectiveDisposition ?? "All"}`}
            readOnly
          />
        </label>
      </form>
      {view.policies.length === 0 ? (
        <StatePanel heading="No Compliance Policies" tone="neutral" status>
          <p>No authorized Policy or Requirement Version matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Compliance Policy Versions">
          {view.policies.map((item) => {
            const missingEvidence = item.evidenceRequirements.filter(
              (requirement) => requirement.mandatory && requirement.mappingReference === null,
            ).length;
            const proposedControls = item.controlMappings.filter(
              (mapping) => mapping.status === "Proposed",
            ).length;
            return (
              <article className="summary-card" key={item.versionReference}>
                <p className="bop-eyebrow">
                  {item.kind} · {item.layer} · {item.jurisdictionCode}
                </p>
                <h2>{label(item.nameCode)}</h2>
                <p>
                  {label(item.status)} · Version {item.policyVersion} · revision {item.revision} ·{" "}
                  {item.strength}
                </p>
                <p>
                  Requirement {item.requirementTypeCode} · authority{" "}
                  {item.authorityReference ?? "Internal policy"}
                </p>
                <p>
                  Effective {item.effectiveFrom} → {item.effectiveTo ?? "Open"} · {item.timeZone}
                </p>
                <p>
                  Monitoring every {item.monitoringFrequencyHours}h · retention {item.retentionDays}{" "}
                  days · notice {item.notificationRequirement}
                </p>
                <p>
                  Evidence requirements {item.evidenceRequirements.length} ({missingEvidence}{" "}
                  unmapped mandatory) · Controls {item.controlMappings.length} ({proposedControls}{" "}
                  proposed)
                </p>
                <p>
                  Legal review {item.legalReviewStatus} · reviewer{" "}
                  {item.reviewedByReference ?? "Pending"} · Counsel{" "}
                  {item.counselReviewerReference ?? "Not recorded"}
                </p>
                {item.parentVersionReference ? (
                  <p>
                    Inherited parent Version {item.parentVersionReference}; weakening is forbidden.
                  </p>
                ) : null}
                {item.threshold ? (
                  <p>
                    Threshold {label(item.threshold.operator)} {item.threshold.decimalValue}{" "}
                    {item.threshold.unitCode}
                  </p>
                ) : null}
                <div className="card-actions">
                  {view.permissions.mayMapControl && item.status === "Draft" ? (
                    <button>Map Evidence / Controls</button>
                  ) : null}
                  {view.permissions.mayRequestReview && item.status === "Draft" ? (
                    <button>Request review</button>
                  ) : null}
                  {view.permissions.mayApprove && item.status === "InReview" ? (
                    <button>Record independent approval</button>
                  ) : null}
                  {view.permissions.mayPublish && item.status === "Approved" ? (
                    <button>Publish Version</button>
                  ) : null}
                  {view.permissions.mayRetire && item.status === "Published" ? (
                    <button>Retire prospectively</button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      )}
      <p role="note">
        Published Versions are immutable. Compliance stores stable Evidence and owner-Control
        references only; it does not supply legal interpretation or execute operational controls.
      </p>
    </main>
  );
}
export function CompliancePolicyPage({
  client = unavailableCompliancePolicyClient,
}: {
  readonly client?: CompliancePolicyClient;
}) {
  const [state, setState] = useState<PageState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseCompliancePolicyView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof CompliancePolicyPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <CompliancePolicies view={state.view} />
  ) : (
    <CompliancePolicyState state={state.kind} />
  );
}
