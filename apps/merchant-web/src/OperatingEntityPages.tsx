import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  OperatingEntityPageError,
  parseOperatingEntityAdminView,
  unavailableOperatingEntityPageClient,
  type OperatingEntityAdminView,
  type OperatingEntityPageClient,
  type OperatingEntityPageErrorCode,
} from "./operating-entity-pages.js";
type State =
  | { readonly kind: "Loading" | OperatingEntityPageErrorCode }
  | { readonly kind: "Found"; readonly view: OperatingEntityAdminView };
const label = (v: string) => v.replaceAll(/([a-z])([A-Z])/gu, "$1 $2").replaceAll("_", " ");
export function OperatingEntityState({
  state,
}: {
  readonly state: "Loading" | OperatingEntityPageErrorCode;
}) {
  const copy = {
    Loading: "Loading authorized Operating Entity metadata…",
    PermissionDenied: "Owner, Finance or Compliance permission is required.",
    NotFound: "No authorized Operating Entity was found.",
    FeatureDisabled: "Operating Entity administration is not enabled.",
    Stale: "Operating Entity projection is stale. Refresh before acting.",
    Conflict: "Operating Entity version or assignment changed. Refresh before acting.",
    CommandFailed: "No legal, approval or assignment outcome was inferred.",
    Offline: "Offline read-only. Administration actions are disabled.",
    Unavailable: "Operating Entity metadata is unavailable.",
  } as const;
  return (
    <StatePanel
      heading={
        state === "Loading" ? "Loading Operating Entities" : "Operating Entities unavailable"
      }
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[state]}</p>
    </StatePanel>
  );
}
export function OperatingEntities({ view }: { readonly view: OperatingEntityAdminView }) {
  const actionable = view.freshness === "Fresh" && view.completeness === "Complete";
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId} · Organization</p>
          <h1>Operating Entities</h1>
          <p>
            Source {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayCreate ? (
          <button disabled={!actionable}>Create draft entity</button>
        ) : null}
      </header>
      <form className="list-filters" aria-label="Operating Entity filters">
        <label>
          Name
          <input value={view.filters.name ?? "All"} readOnly />
        </label>
        <label>
          Status / jurisdiction
          <input
            value={`${view.filters.status ?? "All"} · ${view.filters.jurisdictionCode ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Exact registration reference
          <input value={view.filters.registrationExact ?? "Restricted"} readOnly />
        </label>
      </form>
      {view.entities.length === 0 ? (
        <StatePanel heading="No Operating Entities" tone="neutral" status>
          <p>No authorized entity metadata matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Operating Entities">
          {view.entities.map((e) => (
            <article className="summary-card" key={e.operatingEntityReference}>
              <p className="bop-eyebrow">
                {e.jurisdictionCode} · {e.lifecycle} · v{e.aggregateVersion}
              </p>
              <h2>{e.legalName}</h2>
              <p>
                {e.tradeName ?? "No operating name"} · {e.brandCount} Brands · {e.storeCount} Stores
              </p>
              <p>
                Effective {e.effectiveFrom} → {e.effectiveUntil ?? "Open"} · profile v
                {e.profileVersion} · approval {e.approvalStatus}
              </p>
              {e.restrictedFieldsRevealed ? (
                <p>
                  Restricted references: registration {e.registrationReference ?? "None"} · tax{" "}
                  {e.taxRegistrationReference ?? "None"} · address{" "}
                  {e.registeredAddressReference ?? "None"}
                </p>
              ) : (
                <p>Restricted registration, tax and address references are masked.</p>
              )}
              <p>
                Authority{" "}
                {e.authoritySummaries
                  .map((a) => `${label(a.roleCode)} ${label(a.titleCode)} (${a.status})`)
                  .join(", ") || "None"}
              </p>
              <p>
                Business Functions{" "}
                {e.assignments
                  .map(
                    (a) =>
                      `${label(a.businessFunction)} · ${a.storeReference ?? "Brand-wide"} · ${a.status}`,
                  )
                  .join(", ") || "None"}
              </p>
              <p>
                Evidence {e.evidenceReferences.length} · Audit {e.auditSummaryReference}
              </p>
              <div className="card-actions">
                {view.permissions.mayEdit && e.lifecycle === "Draft" ? (
                  <button disabled={!actionable || !view.recentMfa}>Edit controlled profile</button>
                ) : null}
                {view.permissions.maySubmit && e.lifecycle === "Draft" ? (
                  <button disabled={!actionable}>Submit for approval</button>
                ) : null}
                {view.permissions.mayApprove && e.lifecycle === "PendingExternalEvidence" ? (
                  <button disabled={!actionable || !view.recentMfa}>Approve independently</button>
                ) : null}
                {view.permissions.mayActivate &&
                e.approvalStatus === "Approved" &&
                e.lifecycle !== "Active" ? (
                  <button disabled={!actionable || !view.recentMfa}>Activate entity</button>
                ) : null}
                {view.permissions.maySuspend && e.lifecycle === "Active" ? (
                  <button disabled={!actionable || !view.recentMfa}>Suspend entity</button>
                ) : null}
                {view.permissions.mayManageAssignment && e.lifecycle === "Active" ? (
                  <button disabled={!actionable || !view.recentMfa}>
                    Manage Business Functions
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        This screen stores and displays controlled references only. It does not create a
        corporation, filing, tax account, bank account or legal conclusion.
      </p>
    </main>
  );
}
export function OperatingEntityPage({
  client = unavailableOperatingEntityPageClient,
}: {
  readonly client?: OperatingEntityPageClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (v) => {
        if (active) setState({ kind: "Found", view: parseOperatingEntityAdminView(v) });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof OperatingEntityPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <OperatingEntities view={state.view} />
  ) : (
    <OperatingEntityState state={state.kind} />
  );
}
export const OperatingEntityListPage = OperatingEntityPage;
export const OperatingEntityDetailPage = OperatingEntityPage;
