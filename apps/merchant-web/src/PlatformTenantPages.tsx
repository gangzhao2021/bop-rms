import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import {
  parsePlatformTenantDetailView,
  parsePlatformTenantListView,
  PlatformTenantPageError,
  unavailablePlatformTenantPageClient,
  type PlatformTenantDetailView,
  type PlatformTenantListView,
  type PlatformTenantPageClient,
  type PlatformTenantPageErrorCode,
} from "./platform-tenant-pages.js";
type State<T> =
  | { readonly kind: "Loading" | PlatformTenantPageErrorCode }
  | { readonly kind: "Found"; readonly view: T };
function Status({ kind }: { readonly kind: Exclude<State<never>["kind"], "Found"> }) {
  const copy = {
    Loading: "Loading purpose-bound Tenant metadata…",
    PermissionDenied: "A named Platform role is required.",
    PurposeRequired: "A valid support purpose and case are required.",
    MfaRequired: "Recent MFA is required for this action.",
    NotFound: "The Tenant is unavailable in this authorized scope.",
    Stale: "The Platform projection is stale.",
    Conflict: "The Tenant version changed. Refresh before acting.",
    CommandFailed: "No Tenant lifecycle outcome was inferred.",
    Offline: "Offline read-only. Platform actions are disabled.",
    Unavailable: "Platform Tenant metadata is unavailable.",
  } as const;
  return (
    <StatePanel
      heading={kind === "Loading" ? "Loading Tenants" : "Tenant operations unavailable"}
      tone={kind === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[kind]}</p>
    </StatePanel>
  );
}
function Context({ view }: { readonly view: PlatformTenantListView | PlatformTenantDetailView }) {
  return (
    <StatePanel heading={`${view.access.environment} access`} tone="neutral">
      <p>
        {view.access.environment === "Production" ? "Production warning · " : ""}Named actor{" "}
        {view.access.actor} · purpose {view.access.purpose} · case{" "}
        {view.access.supportCaseReference} · recent MFA{" "}
        {view.access.recentMfa ? "verified" : "not verified"}
      </p>
      <p>Tenant impersonation and unrestricted database browsing are prohibited.</p>
    </StatePanel>
  );
}
export function PlatformTenantListPage({
  client = unavailablePlatformTenantPageClient,
}: {
  readonly client?: PlatformTenantPageClient;
}) {
  const [state, setState] = useState<State<PlatformTenantListView>>({ kind: "Loading" }),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState("All");
  useEffect(() => {
    let active = true;
    void client
      .loadTenants()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parsePlatformTenantListView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof PlatformTenantPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client]);
  const tenants = useMemo(
    () =>
      state.kind === "Found"
        ? state.view.tenants.filter(
            (item) =>
              (status === "All" || item.status === status) &&
              `${item.tenantReference} ${item.displayName} ${item.region}`
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
          )
        : [],
    [query, state, status],
  );
  if (state.kind !== "Found") return <Status kind={state.kind} />;
  return (
    <AppFrame
      title="Platform Tenants"
      description={`PLT-TENANT-LIST · ${state.view.freshness} · ${state.view.completeness}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">PLT-TENANT-LIST</p>
          <h2>Tenant and lifecycle operations</h2>
          <p>Source as of {state.view.sourceAsOf}</p>
        </div>
        <button disabled={!state.view.mayStartOnboarding}>Start approved onboarding</button>
      </header>
      <Context view={state.view} />
      <div className="list-filters" role="search">
        <label>
          Tenant ref or approved name
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            <option>All</option>
            <option>Draft</option>
            <option>PendingApproval</option>
            <option>Active</option>
            <option>Suspended</option>
          </select>
        </label>
      </div>
      {tenants.map((item) => (
        <StatePanel
          key={item.tenantReference}
          heading={item.displayName}
          tone={item.health === "Critical" ? "error" : "neutral"}
        >
          <p>
            {item.tenantReference} · {item.region} · {item.status} · {item.plan}
          </p>
          <p>
            {item.storeCount} Stores · {item.capabilityCount} capabilities · health {item.health} ·
            incident {item.openIncidentReference ?? "none"}
          </p>
          {item.mayView ? (
            <Link to={`/platform/tenants/${item.tenantReference}`}>View Tenant</Link>
          ) : null}{" "}
          <button disabled={!item.mayRequestSuspension}>Request suspension</button>
        </StatePanel>
      ))}
    </AppFrame>
  );
}
export function PlatformTenantDetailPage({
  client = unavailablePlatformTenantPageClient,
}: {
  readonly client?: PlatformTenantPageClient;
}) {
  const route = useParams().id,
    [state, setState] = useState<State<PlatformTenantDetailView>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    if (!route) {
      setState({ kind: "NotFound" });
      return () => {
        active = false;
      };
    }
    void client
      .loadTenant(route)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parsePlatformTenantDetailView(value, route) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof PlatformTenantPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, route]);
  if (state.kind !== "Found") return <Status kind={state.kind} />;
  const { view } = state;
  return (
    <AppFrame
      title={view.tenant.displayName}
      description={`PLT-TENANT-DETAIL · ${view.freshness} · ${view.completeness}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">PLT-TENANT-DETAIL</p>
          <h2>{view.tenant.tenantReference}</h2>
          <p>
            {view.tenant.region} · {view.tenant.status} · {view.tenant.plan}
          </p>
        </div>
      </header>
      <Context view={view} />
      <StatePanel heading="Non-sensitive configuration">
        <p>Environments: {view.environments.join(", ")}</p>
        <p>Capabilities: {view.capabilities.join(", ")}</p>
        <p>
          Data policy {view.dataPolicyReference} · retention policy {view.retentionPolicyReference}
        </p>
        <button disabled={!view.mayManageCapabilities}>Propose capability change</button>
      </StatePanel>
      <StatePanel heading="Owner health summaries">
        <p>Stores: {view.storeHealthSummary}</p>
        <p>Providers: {view.providerHealthSummary}</p>
        <p>Open incident {view.tenant.openIncidentReference ?? "none"}</p>
      </StatePanel>
      <StatePanel heading="Purpose-bound actions">
        <p>Support cases: {view.supportCaseReferences.join(", ") || "none"}</p>
        <button disabled={!view.mayOpenDiagnostic}>Open scoped diagnostic</button>{" "}
        <button disabled={!view.mayStartExport}>Start controlled export</button>{" "}
        <button disabled={!view.mayRequestRestore}>Request restore</button>
      </StatePanel>
      <StatePanel heading="Audit references">
        <p>{view.auditReferences.join(", ") || "No authorized audit references"}</p>
      </StatePanel>
    </AppFrame>
  );
}
