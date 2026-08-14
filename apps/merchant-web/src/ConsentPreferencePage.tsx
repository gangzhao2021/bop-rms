import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import {
  ConsentPreferenceClientError,
  parseConsentPreferenceView,
  unavailableConsentPreferenceClient,
  type ConsentPreferenceClient,
  type ConsentPreferenceClientErrorCode,
  type ConsentPreferenceView,
} from "./consent-preference-pages.js";
type State =
  | { readonly kind: "Loading" | ConsentPreferenceClientErrorCode }
  | { readonly kind: "Ready"; readonly view: ConsentPreferenceView };
export function ConsentPreferenceState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Ready">;
}) {
  const messages: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> =
    {
      Loading: ["Loading", "Loading consent evidence…", "neutral"],
      PermissionDenied: ["Permission denied", "Consent evidence is unavailable.", "error"],
      NotFound: ["Customer not found", "No Brand-scoped record is available.", "neutral"],
      FeatureDisabled: ["Consent disabled", "This capability is unavailable.", "neutral"],
      Stale: ["Projection stale", "Refresh current choices before an action.", "offline"],
      Conflict: ["Record changed", "Refresh Expected Version before retrying.", "offline"],
      Validation: ["Choice blocked", "Verified proof and approved policy are required.", "error"],
      CommandFailed: ["Command failed", "No prior consent fact was overwritten.", "error"],
      Offline: ["Offline read-only", "Cached consent cannot authorize a send.", "offline"],
      Unavailable: ["Consent unavailable", "No Customer choice is inferred.", "error"],
    };
  const value = messages[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
export function ConsentPreferenceDetail({ view }: { readonly view: ConsentPreferenceView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CONSENT-PREFERENCE</p>
          <h1>Consent and contact preference</h1>
          <p>
            {view.brandLabel} · Customer {view.customerReference} · v{view.aggregateVersion}
          </p>
        </div>
      </header>
      {readOnly ? <ConsentPreferenceState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Purpose / channel / state
          <select disabled>
            <option>All immutable choices</option>
          </select>
        </label>
      </div>
      <section className="summary-card">
        <h2>Contact preference — not authorization</h2>
        {view.preference ? (
          <p>
            Language {view.preference.preferredLanguage} · channel{" "}
            {view.preference.preferredChannel ?? "None"} · frequency {view.preference.frequencyCode}{" "}
            · Store {view.preference.storeReference ?? "Brand"}
          </p>
        ) : (
          <p>No preference recorded.</p>
        )}
        {view.permissions.mayManage ? (
          <button disabled={readOnly}>Update preference with proof</button>
        ) : null}
      </section>
      <div className="card-list">
        {view.choices.map((choice) => (
          <article className="summary-card" key={choice.consentReference}>
            <p className="bop-eyebrow">
              {choice.purpose} · {choice.channel} · {choice.status}
            </p>
            <p>
              Contact method ref {choice.contactMethodReference} · policy {choice.policyVersion}
            </p>
            <p>
              Effective {choice.effectiveAt} · recorded {choice.recordedAt} · source{" "}
              {choice.sourceCode}
            </p>
            {view.permissions.mayViewEvidence ? <p>Evidence {choice.evidenceReference}</p> : null}
            <div className="card-actions">
              {view.permissions.mayManage && choice.status === "Granted" ? (
                <button disabled={readOnly}>Withdraw with verified proof</button>
              ) : null}
              {view.permissions.mayExportProof ? (
                <button disabled={readOnly}>Export proof</button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      {view.permissions.mayManage ? (
        <button disabled={readOnly}>Record verified choice</button>
      ) : null}
      <p role="note">
        Loyalty enrollment never grants Marketing consent. Operational notifications use a separate
        decision.
      </p>
    </main>
  );
}
export function ConsentPreferencePage({
  client = unavailableConsentPreferenceClient,
}: {
  readonly client?: ConsentPreferenceClient;
}) {
  const { customerId } = useParams(),
    [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    if (!customerId) {
      setState({ kind: "NotFound" });
      return () => {
        active = false;
      };
    }
    void client
      .load(customerId)
      .then((value) => {
        if (active) setState({ kind: "Ready", view: parseConsentPreferenceView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind:
              error instanceof ConsentPreferenceClientError
                ? error.code
                : navigator.onLine
                  ? "Unavailable"
                  : "Offline",
          });
      });
    return () => {
      active = false;
    };
  }, [client, customerId]);
  return state.kind === "Ready" ? (
    <ConsentPreferenceDetail view={state.view} />
  ) : (
    <ConsentPreferenceState state={state.kind} />
  );
}
