import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ProviderIntegrationPageError,
  parseProviderIntegrationView,
  unavailableProviderIntegrationClient,
  type ProviderIntegrationClient,
  type ProviderIntegrationPageErrorCode,
  type ProviderIntegrationView,
} from "./provider-integration-pages.js";
type State =
  | { readonly kind: "Loading" | ProviderIntegrationPageErrorCode }
  | { readonly kind: "Found"; readonly view: ProviderIntegrationView };
const label = (value: string) => value.replaceAll("_", " ");
export function ProviderIntegrationState({
  state,
}: {
  readonly state: "Loading" | ProviderIntegrationPageErrorCode;
}) {
  const copy = {
    Loading: "Loading authorized Provider metadata…",
    PermissionDenied: "Integration Admin permission and scope are required.",
    NotFound: "No authorized Provider integration was found.",
    FeatureDisabled: "Provider administration is not enabled.",
    Stale: "Provider projection is stale. Refresh before acting.",
    Conflict: "Provider configuration changed. Refresh before acting.",
    CommandFailed: "No Provider, webhook, retry or Kill Switch outcome was inferred.",
    Offline: "Offline read-only. Provider actions and replay are disabled.",
    Unavailable: "Provider metadata is unavailable. No external state is inferred.",
  } as const;
  return (
    <StatePanel
      heading={state === "Loading" ? "Loading Providers" : "Provider integrations unavailable"}
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[state]}</p>
    </StatePanel>
  );
}
export function ProviderIntegrations({ view }: { readonly view: ProviderIntegrationView }) {
  const actionable = view.freshness === "Fresh" && view.completeness === "Complete";
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId} · Integration Administration</p>
          <h1>Provider Adapters</h1>
          <p>
            Source {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
      </header>
      <form className="list-filters" aria-label="Provider filters">
        <label>
          Provider / capability
          <input
            value={`${view.filters.providerCode ?? "All"} · ${view.filters.capabilityCode ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Status / environment
          <input
            value={`${view.filters.status ?? "All"} · ${view.filters.environment ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Health
          <input value={view.filters.degradedOnly ? "Degraded only" : "All"} readOnly />
        </label>
      </form>
      {view.integrations.length === 0 ? (
        <StatePanel heading="No Provider Integrations" tone="neutral" status>
          <p>No authorized Provider metadata matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Provider integrations">
          {view.integrations.map((item) => (
            <article className="summary-card" key={item.integrationReference}>
              <p className="bop-eyebrow">
                {label(item.providerCode)} · {item.environment} · {item.status}
              </p>
              <h2>{label(item.adapterCode)}</h2>
              <p>
                Owner {item.ownerModule} · contract {item.contractVersionCode} · region{" "}
                {item.regionCode}
              </p>
              <p>
                Endpoint {item.endpointHealth} · webhook {item.webhookHealth} · last success{" "}
                {item.lastSuccessAt ?? "None"}
              </p>
              <p>
                Retry {item.retryCount} · DLQ {item.deadLetterCount} · safe error{" "}
                {item.lastSafeErrorCode ?? "None"}
              </p>
              <p>
                Credential metadata {item.credentialAgeDays ?? "N/A"} days ·{" "}
                {item.credentialExpiryDisposition}
              </p>
              <p>
                Evidence {item.evidenceReferences.length} · enablement {item.effectiveEnablement} ·
                Kill Switch {item.killSwitchState}
              </p>
              <div className="card-actions">
                {view.permissions.mayEnable &&
                item.effectiveEnablement === "Blocked" &&
                item.status !== "KillSwitched" ? (
                  <button disabled={!actionable || !item.requiredEvidenceSatisfied}>
                    Enable through owner
                  </button>
                ) : null}
                {view.permissions.mayDisable && ["Enabled", "Degraded"].includes(item.status) ? (
                  <button disabled={!actionable}>Disable / Kill Switch</button>
                ) : null}
                {view.permissions.mayTestSandbox && item.environment === "Sandbox" ? (
                  <button disabled={!actionable}>Test approved sandbox</button>
                ) : null}
                {view.screenId === "INT-PROVIDER-DETAIL" &&
                view.permissions.mayRotateCredential &&
                item.credentialAgeDays !== null ? (
                  <button disabled={!actionable}>Start secret-manager rotation</button>
                ) : null}
                {view.screenId === "INT-PROVIDER-DETAIL" &&
                view.permissions.mayReplayInbox &&
                item.eligibleInboxReference !== null ? (
                  <button disabled={!actionable}>Replay eligible Inbox Event</button>
                ) : null}
                {view.permissions.mayOpenIncident ? <button>Open incident</button> : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        This view routes intents to owning modules. It never displays raw Provider payloads,
        endpoints, accounts, signatures, secrets, tokens or payment data.
      </p>
    </main>
  );
}
export function ProviderIntegrationPage({
  client = unavailableProviderIntegrationClient,
}: {
  readonly client?: ProviderIntegrationClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseProviderIntegrationView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof ProviderIntegrationPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <ProviderIntegrations view={state.view} />
  ) : (
    <ProviderIntegrationState state={state.kind} />
  );
}
export const ProviderIntegrationListPage = ProviderIntegrationPage;
export const ProviderIntegrationDetailPage = ProviderIntegrationPage;
