import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  PrivacyRequestClientError,
  parsePrivacyRequestView,
  unavailablePrivacyRequestClient,
  type PrivacyRequestClient,
  type PrivacyRequestClientErrorCode,
  type PrivacyRequestView,
} from "./privacy-request-pages.js";
type State =
  | { readonly kind: "Loading" | PrivacyRequestClientErrorCode }
  | { readonly kind: "Ready"; readonly view: PrivacyRequestView };
export function PrivacyRequestState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Ready">;
}) {
  const map: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading privacy cases…", "neutral"],
    PermissionDenied: ["Permission denied", "Privacy cases are unavailable.", "error"],
    NotFound: ["No request", "No matching Privacy Request is available.", "neutral"],
    FeatureDisabled: ["Privacy Request disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh before any case action.", "offline"],
    Conflict: ["Request changed", "Refresh Expected Version.", "offline"],
    Validation: [
      "Action blocked",
      "Verification, owner evidence or approved reason is missing.",
      "error",
    ],
    CommandFailed: ["Command failed", "No Data Owner fact was directly edited.", "error"],
    Offline: ["Offline read-only", "Cached cases cannot authorize fulfillment.", "offline"],
    Unavailable: ["Privacy unavailable", "No legal or fulfillment result is inferred.", "error"],
  };
  const v = map[state];
  return (
    <StatePanel heading={v[0]} tone={v[2]} status>
      <p>{v[1]}</p>
    </StatePanel>
  );
}
export function PrivacyRequestList({ view }: { readonly view: PrivacyRequestView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">PRIVACY-REQUEST</p>
          <h1>Privacy Rights Requests</h1>
          <p>{view.brandLabel} · proportional verification · 30-day target</p>
        </div>
      </header>
      {readOnly ? <PrivacyRequestState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Case ref / verified contact
          <input disabled placeholder="Exact authorized reference" />
        </label>
        <label>
          Right / status / owner / due
          <select disabled>
            <option>All requests</option>
          </select>
        </label>
      </div>
      {view.permissions.mayIntake ? (
        <button disabled={readOnly}>Intake tracked request</button>
      ) : null}
      <div className="card-list">
        {view.rows.map((row) => (
          <article className="summary-card" key={row.requestReference}>
            <p className="bop-eyebrow">
              {row.right} · {row.status}
            </p>
            <p>
              Case {row.requestReference} · subject {row.subjectReference}
            </p>
            <p>
              Due {row.dueAt} · owner {row.ownerReference ?? "Unassigned"}
            </p>
            <p>
              Owner work pending {row.pendingOwnerCount} · completed {row.completedOwnerCount} ·
              holds {row.holdCount}
            </p>
            {row.exportExpiresAt ? (
              <p>Encrypted single-use export expires {row.exportExpiresAt}</p>
            ) : null}
            <div className="card-actions">
              {view.permissions.mayVerify && row.status === "Intake" ? (
                <button disabled={readOnly}>Verify proportionally</button>
              ) : null}
              {view.permissions.mayFulfill ? (
                <>
                  <button disabled={readOnly || row.status !== "Assigned"}>
                    Collect scoped owner data
                  </button>
                  <button disabled={readOnly || row.status !== "InReview"}>
                    Fulfill / deny with approved reason
                  </button>
                  <button disabled={readOnly || !["Fulfilled", "Denied"].includes(row.status)}>
                    Close
                  </button>
                </>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <p role="note">
        Privacy coordinates owner Commands. Legal hold and statutory retention preserve required
        financial, Audit and Compliance history.
      </p>
    </main>
  );
}
export function PrivacyRequestPage({
  client = unavailablePrivacyRequestClient,
}: {
  readonly client?: PrivacyRequestClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((v) => {
        if (active) setState({ kind: "Ready", view: parsePrivacyRequestView(v) });
      })
      .catch((e: unknown) => {
        if (active)
          setState({
            kind:
              e instanceof PrivacyRequestClientError
                ? e.code
                : navigator.onLine
                  ? "Unavailable"
                  : "Offline",
          });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Ready" ? (
    <PrivacyRequestList view={state.view} />
  ) : (
    <PrivacyRequestState state={state.kind} />
  );
}
