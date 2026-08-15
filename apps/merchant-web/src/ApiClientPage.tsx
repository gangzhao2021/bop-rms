import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ApiClientPageError,
  parseApiClientAdminView,
  unavailableApiClientPageClient,
  type ApiClientAdminView,
  type ApiClientPageClient,
  type ApiClientPageErrorCode,
} from "./api-client-page.js";
type State =
  | { readonly kind: "Loading" | ApiClientPageErrorCode }
  | { readonly kind: "Found"; readonly view: ApiClientAdminView };
const label = (value: string) => value.replaceAll("_", " ");
export function ApiClientState({ state }: { readonly state: "Loading" | ApiClientPageErrorCode }) {
  const copy = {
    Loading: "Loading authorized API Client metadata…",
    PermissionDenied: "Integration or Security Admin permission is required.",
    NotFound: "No authorized API Client was found.",
    FeatureDisabled: "API Client administration is not enabled.",
    Stale: "API Client projection is stale. Refresh before acting.",
    Conflict: "API Client version changed. Refresh before acting.",
    CommandFailed: "No credential or lifecycle outcome was inferred.",
    Offline: "Offline read-only. API Client actions are disabled.",
    Unavailable: "API Client metadata is unavailable.",
  } as const;
  return (
    <StatePanel
      heading={state === "Loading" ? "Loading API Clients" : "API Clients unavailable"}
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[state]}</p>
    </StatePanel>
  );
}
export function ApiClients({ view }: { readonly view: ApiClientAdminView }) {
  const actionable = view.freshness === "Fresh" && view.completeness === "Complete";
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId} · Integration Administration</p>
          <h1>API Clients</h1>
          <p>
            Source {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayRequest ? (
          <button disabled={!actionable}>Request API Client</button>
        ) : null}
      </header>
      <form className="list-filters" aria-label="API Client filters">
        <label>
          Name / scope
          <input
            value={`${view.filters.nameCode ?? "All"} · ${view.filters.scopeCode ?? "All"}`}
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
          Use
          <input value={view.filters.unusedOnly ? "Unused only" : "All"} readOnly />
        </label>
      </form>
      {view.clients.length === 0 ? (
        <StatePanel heading="No API Clients" tone="neutral" status>
          <p>No authorized API Client metadata matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="API Clients">
          {view.clients.map((item) => (
            <article className="summary-card" key={item.clientReference}>
              <p className="bop-eyebrow">
                {item.environment} · {item.status}
              </p>
              <h2>{label(item.nameCode)}</h2>
              <p>
                Owner {item.ownerReference} · Store {item.storeReference ?? "Brand-wide"}
              </p>
              <p>
                Scopes {item.scopeCodes.map(label).join(", ")} · Grants{" "}
                {item.grantCodes.map(label).join(", ")}
              </p>
              <p>
                Credential metadata v{item.credentialVersion ?? "Not issued"} · age{" "}
                {item.credentialAgeDays ?? "N/A"} days · expires {item.credentialExpiresAt ?? "N/A"}
              </p>
              <p>
                Last use {item.lastUsedAt ?? "None"} · revision {item.aggregateVersion}
              </p>
              <div className="card-actions">
                {view.permissions.maySubmitApproval && item.status === "Requested" ? (
                  <button disabled={!actionable}>Submit for independent approval</button>
                ) : null}
                {view.permissions.mayRotate && ["Active", "Suspended"].includes(item.status) ? (
                  <button disabled={!actionable}>Start secure rotation</button>
                ) : null}
                {view.permissions.mayRevoke && item.status !== "Revoked" ? (
                  <button disabled={!actionable}>Revoke API Client</button>
                ) : null}
                {view.permissions.mayViewAudit ? (
                  <button>View audit {item.auditSummaryReference}</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Credential values, tokens and private keys are never displayed or accepted by this screen.
      </p>
    </main>
  );
}
export function ApiClientPage({
  client = unavailableApiClientPageClient,
}: {
  readonly client?: ApiClientPageClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseApiClientAdminView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof ApiClientPageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <ApiClients view={state.view} />
  ) : (
    <ApiClientState state={state.kind} />
  );
}
