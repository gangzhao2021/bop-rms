import { AppFrame, StatePanel } from "@bop-rms/ui";
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
  if (state === "FeatureDisabled") return <PrivacyRequestFeatureDisabledReview />;
  const map: Record<
    Exclude<typeof state, "FeatureDisabled">,
    readonly [string, string, "neutral" | "error" | "offline"]
  > = {
    Loading: ["Loading", "Loading privacy cases…", "neutral"],
    PermissionDenied: ["Permission denied", "Privacy cases are unavailable.", "error"],
    NotFound: ["No request", "No matching Privacy Request is available.", "neutral"],
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

function PrivacyRequestFeatureDisabledReview() {
  return (
    <AppFrame className="privacy-request-review-shell" title="COMPLIANCE" description="">
      <section className="privacy-request-review">
        <header className="privacy-request-review__heading">
          <div>
            <p className="bop-eyebrow">PRIVACY-REQUEST · PHASE 3</p>
            <h2>Privacy rights requests</h2>
            <p>Requester verification, rights, scope and due-date evidence · source unavailable</p>
          </div>
          <span>Source values unavailable</span>
        </header>
        <aside className="privacy-request-review__notice" role="note">
          <h2>Privacy Request disabled</h2>
          <p>
            This Phase 3 capability is not enabled for the current workspace. No cases or owner
            results are shown.
          </p>
        </aside>
        <fieldset
          className="privacy-request-review__filters"
          disabled
          aria-labelledby="privacy-request-review-filters"
        >
          <legend id="privacy-request-review-filters">Filters</legend>
          <label>
            Case ref / verified contact
            <input placeholder="Unavailable" />
          </label>
          <label>
            Rights type
            <select defaultValue="Unavailable">
              <option>Unavailable</option>
            </select>
          </label>
          <label>
            Status
            <select defaultValue="Unavailable">
              <option>Unavailable</option>
            </select>
          </label>
          <label>
            Owner
            <select defaultValue="Unavailable">
              <option>Unavailable</option>
            </select>
          </label>
          <label>
            Due / overdue
            <input placeholder="Unavailable" />
          </label>
          <label>
            Brand
            <select defaultValue="Unavailable">
              <option>Unavailable</option>
            </select>
          </label>
          <p>Filters stay disabled while the Phase 3 capability is disabled.</p>
        </fieldset>
        <section aria-labelledby="privacy-request-review-records">
          <header className="privacy-request-review__records-heading">
            <h2 id="privacy-request-review-records">Requests</h2>
            <span>Phase 3 disabled</span>
          </header>
          <div className="privacy-request-review__empty" role="status">
            <div className="privacy-request-review__columns" aria-hidden="true">
              <span>Request / verification</span>
              <span>Right / scope</span>
              <span>Due / holds</span>
              <span>Owner work</span>
              <span>Fulfillment</span>
              <span>Audit</span>
            </div>
            <div>
              <h3>Requests are not available</h3>
              <p>
                The Phase 3 Privacy Request capability is not enabled. No sample case, contact,
                owner or rights data is shown.
              </p>
            </div>
          </div>
        </section>
        <aside
          className="privacy-request-review__actions"
          aria-labelledby="privacy-request-review-actions"
        >
          <h3 id="privacy-request-review-actions">Owner actions disabled</h3>
          <p>
            Intake, verification, owner collection, fulfillment/denial and close require enabled
            capability and authorized owner Commands.
          </p>
        </aside>
        <p className="privacy-request-review__privacy">
          Privacy rights workflows contain sensitive contact and verification data. This Review
          contains no request data.
        </p>
      </section>
    </AppFrame>
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
      <p id="privacy-actions-unavailable" role="note">
        Authenticated privacy commands are not connected. This page is read-only; no request or
        owner data will be changed here.
      </p>
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
        <button disabled aria-describedby="privacy-actions-unavailable">
          Intake tracked request
        </button>
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
                <button disabled aria-describedby="privacy-actions-unavailable">
                  Verify proportionally
                </button>
              ) : null}
              {view.permissions.mayFulfill ? (
                <>
                  <button disabled aria-describedby="privacy-actions-unavailable">
                    Collect scoped owner data
                  </button>
                  <button disabled aria-describedby="privacy-actions-unavailable">
                    Fulfill / deny with approved reason
                  </button>
                  <button disabled aria-describedby="privacy-actions-unavailable">
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
