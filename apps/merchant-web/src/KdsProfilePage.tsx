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
        "Loading" | "PermissionDenied" | "Offline" | "Conflict" | "CommandFailed" | "Unavailable";
    }
  | { readonly kind: "Found"; readonly view: KdsProfileView };
export function KdsProfileScreen({ view }: { readonly view: KdsProfileView }) {
  const actionable =
    view.freshnessStatus === "Fresh" &&
    view.operatorSessionStatus !== "NamedActive" &&
    view.uatStatus === "Passed";
  return (
    <AppFrame
      title="Managed KDS Profile"
      description={`DEV-KDS-PROFILE · ${view.storeLabel} · ${view.stationLabel}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.profileLabel}</p>
          <h2>
            {view.browserFamily} · {view.resolution}
          </h2>
          <p>
            {view.freshnessStatus} · {view.projectedAt}
          </p>
        </div>
        <strong>{view.uatStatus}</strong>
      </header>
      <div className="detail-section-grid">
        <StatePanel heading="Lock and handover" status>
          <dl>
            <div>
              <dt>Auto-lock</dt>
              <dd>{view.autoLockSeconds} seconds</dd>
            </div>
            <div>
              <dt>Visibility loss</dt>
              <dd>Locks board</dd>
            </div>
            <div>
              <dt>Handover</dt>
              <dd>Lock, sign out, rotate named Session</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{view.operatorSessionStatus}</dd>
            </div>
          </dl>
        </StatePanel>
        <StatePanel heading="Continuity procedures">
          <p>{view.networkProcedureCode}</p>
          <p>{view.replacementProcedureCode}</p>
          <p>{view.notificationMode}</p>
        </StatePanel>
        <StatePanel
          heading="Device UAT evidence"
          tone={view.uatStatus === "Passed" ? "neutral" : "offline"}
          status
        >
          <p>
            {view.uatStatus === "Passed"
              ? "Accepted evidence reference is present."
              : "Real Store device UAT is unavailable and not claimed."}
          </p>
        </StatePanel>
      </div>
      <div className="card-actions">
        <button disabled={!actionable}>Assign / publish profile</button>
        <button disabled>Run UAT checklist — external device required</button>
        <button disabled>Revoke profile</button>
      </div>
      <StatePanel heading="Named operator privacy boundary">
        <p>
          No shared username, credential, token, operator name, medical narrative or unrestricted
          device identifier is displayed or stored by this browser view.
        </p>
      </StatePanel>
    </AppFrame>
  );
}
export function KdsProfileState({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const copy = {
    Loading: "Loading authorized KDS profile…",
    PermissionDenied: "Your integration permission or Store scope does not allow this profile.",
    Offline: "Offline read-only. Lock the board and use the approved recovery procedure.",
    Conflict: "Profile source changed. Refresh before any assignment.",
    CommandFailed: "No profile, Session or device state change is assumed.",
    Unavailable:
      "The Device/KDS profile adapter is not connected. No external evidence is claimed.",
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
