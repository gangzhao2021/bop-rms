import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  KdsProfileClientError,
  parseKdsProfileView,
  unavailableKdsProfileClient,
  type KdsProfileClient,
  type KdsProfileView,
} from "./kds-profile.js";
type State =
  | {
      readonly kind:
        | "Loading"
        | "PermissionDenied"
        | "NotFound"
        | "FeatureDisabled"
        | "Offline"
        | "Stale"
        | "Conflict"
        | "CommandFailed"
        | "Unavailable";
    }
  | { readonly kind: "Found"; readonly view: KdsProfileView };
const label = (value: string) => value.replaceAll("_", " ");
export function KdsProfileScreen({ view }: { readonly view: KdsProfileView }) {
  const publishable =
    view.freshness === "Current" &&
    view.completeness === "Complete" &&
    view.lifecycle === "Draft" &&
    view.assignmentReference !== null &&
    view.operatorSessionStatus !== "NamedActive" &&
    view.uat.status === "Passed";
  return (
    <AppFrame
      title="Managed KDS Profiles"
      description={`DEV-KDS-PROFILE · ${view.storeLabel} · ${view.stationLabel ?? "Unassigned"}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {label(view.profileLabelCode)} · Version {view.profileVersion}
          </p>
          <h2>
            {view.browserFamily} · minimum {view.minimumLogicalWidth}×{view.minimumLogicalHeight}
          </h2>
          <p>
            {view.lifecycle} · {view.freshness} · source {view.sourceAsOf}
          </p>
        </div>
        <strong>{view.uat.status}</strong>
      </header>
      <form className="list-filters" aria-label="KDS Profile filters">
        <label>
          Store / station
          <input
            value={`${view.filters.storeReference ?? "All"} · ${view.filters.stationReference ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Lifecycle / UAT due
          <input value={`${view.filters.lifecycle ?? "All"} · ${view.filters.uatDue}`} readOnly />
        </label>
      </form>
      <div className="detail-section-grid">
        <StatePanel heading="Managed browser and power" status>
          <p>
            {view.wakePolicyCode} · {view.powerPolicyCode}
          </p>
          <p>Auto-lock {view.autoLockSeconds} seconds · visibility loss locks</p>
          <p>Handover locks/signs out before a fresh named Session.</p>
          <p>Session {view.operatorSessionStatus}</p>
        </StatePanel>
        <StatePanel heading="Continuity procedures">
          <p>{view.networkProcedureCode}</p>
          <p>{view.replacementProcedureCode}</p>
          <p>{view.notificationMode}</p>
          <p>Browser commands are never queued offline.</p>
        </StatePanel>
        <StatePanel
          heading="Store UAT"
          tone={view.uat.status === "Passed" ? "neutral" : "offline"}
          status
        >
          <p>
            Checklist {view.uat.checklistVersionCode} · due {view.uat.dueAt}
          </p>
          <p>
            {view.uat.browserVersionCode ?? "Browser version not recorded"} ·{" "}
            {view.uat.logicalWidth ?? "—"}×{view.uat.logicalHeight ?? "—"}
          </p>
          <p>
            {view.uat.status === "Passed"
              ? "Accepted Evidence reference is present."
              : "Real Store device UAT remains unavailable unless accepted Evidence is supplied."}
          </p>
        </StatePanel>
      </div>
      <section className="card-list" aria-label="KDS UAT checklist">
        {view.uat.checks.map((item) => (
          <article className="summary-card" key={item.checkCode}>
            <h3>{label(item.checkCode)}</h3>
            <p>
              {item.outcome} · {item.safeResultCode ?? "Not run"}
            </p>
          </article>
        ))}
      </section>
      <div className="card-actions">
        {view.permissions.mayCreate ? <button>Create Profile revision</button> : null}
        {view.permissions.mayAssign && view.lifecycle === "Draft" ? (
          <button>Assign eligible KDS</button>
        ) : null}
        {view.permissions.mayRunUat && view.assignmentReference !== null ? (
          <button>Run UAT checklist</button>
        ) : null}
        {view.permissions.mayPublish ? (
          <button disabled={!publishable}>Publish Profile</button>
        ) : null}
        {view.permissions.mayRevoke && view.lifecycle === "Published" ? (
          <button>Revoke Profile</button>
        ) : null}
      </div>
      <StatePanel heading="Named operator privacy boundary">
        <p>
          No shared username, credential, operator name, token, raw Device log or unrestricted
          identifier is displayed. Store UAT Evidence stays with its owning service.
        </p>
      </StatePanel>
    </AppFrame>
  );
}
export function KdsProfileState({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const copy = {
    Loading: "Loading authorized KDS profiles…",
    PermissionDenied: "Your Device permission or Store scope does not allow this profile.",
    NotFound: "No authorized KDS Profile was found.",
    FeatureDisabled: "Managed browser KDS is not enabled for this Store.",
    Offline: "Offline read-only. Lock the board and use the approved recovery procedure.",
    Stale: "Device or UAT eligibility is stale. Refresh before acting.",
    Conflict: "Profile source changed. Refresh before assignment or publication.",
    CommandFailed: "No Profile, UAT, Session or Device state change is assumed.",
    Unavailable: "The KDS Profile adapter is not connected. No external evidence is claimed.",
  } as const;
  return (
    <StatePanel
      heading={state === "Loading" ? "Loading" : "KDS Profile unavailable"}
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[state]}</p>
    </StatePanel>
  );
}
export function KdsProfilePage({
  client = unavailableKdsProfileClient,
}: {
  readonly client?: KdsProfileClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .loadProfile()
      .then(parseKdsProfileView)
      .then((view) => {
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof KdsProfileClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <KdsProfileScreen view={state.view} />
  ) : (
    <KdsProfileState state={state.kind} />
  );
}
