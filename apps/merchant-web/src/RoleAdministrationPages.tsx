import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import {
  RoleAdministrationPageError,
  parseRoleAdministrationPageView,
  parseRoleAdministrationRouteReference,
  unavailableRoleAdministrationPageClient,
  type RoleAdministrationPageClient,
  type RoleAdministrationPageErrorCode,
  type RoleAdministrationPageView,
} from "./role-administration-pages.js";
type State =
  | { readonly kind: "Loading" | RoleAdministrationPageErrorCode }
  | { readonly kind: "Found"; readonly view: RoleAdministrationPageView };
function Status({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const copy = {
    Loading: "Loading authorized role metadata…",
    PermissionDenied: "Access Admin permission is required.",
    NotFound: "The requested role is unavailable in this scope.",
    FeatureDisabled: "Role administration is disabled.",
    Stale: "The projection is stale. Refresh before acting.",
    Conflict: "The policy version changed. Refresh and compare again.",
    CommandFailed: "No role or permission outcome was inferred.",
    Offline: "Offline read-only. Role actions are disabled.",
    Unavailable: "Role administration metadata is unavailable.",
  } as const;
  return (
    <StatePanel
      heading={state === "Loading" ? "Loading roles" : "Role administration unavailable"}
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[state]}</p>
    </StatePanel>
  );
}
function Screen({ view }: { readonly view: RoleAdministrationPageView }) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("All");
  const roles = useMemo(
    () =>
      view.roles.filter(
        (role) =>
          (status === "All" || role.status === status) &&
          `${role.name} ${role.code} ${role.description}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [query, status, view.roles],
  );
  return (
    <AppFrame
      title={view.screenId === "IAM-ROLE-LIST" ? "Roles" : "Role editor"}
      description={`${view.screenId} · ${view.freshness} · ${view.completeness}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId}</p>
          <h2>Role and permission governance</h2>
          <p>Source as of {view.sourceAsOf}</p>
        </div>
        <button
          disabled={
            !view.mayManage || view.freshness !== "Fresh" || view.completeness !== "Complete"
          }
        >
          Create custom role
        </button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Role or permission
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            <option>All</option>
            <option>Draft</option>
            <option>InReview</option>
            <option>Approved</option>
            <option>Active</option>
            <option>Deactivated</option>
          </select>
        </label>
      </div>
      {roles.length === 0 ? (
        <StatePanel heading="No matching roles" status>
          <p>Change the safe filters.</p>
        </StatePanel>
      ) : (
        roles.map((role) => (
          <section key={role.roleReference}>
            <StatePanel
              heading={role.name}
              tone={role.permissions.some((item) => item.highRisk) ? "offline" : "neutral"}
            >
              <p>
                <strong>{role.status}</strong> · {role.scope} · {role.type} · version {role.version}
              </p>
              <p>{role.description}</p>
              <p>
                {role.memberCount} active assignments · {role.permissions.length} permissions
              </p>
              {view.screenId === "IAM-ROLE-LIST" ? (
                <Link to={`/app/organization/roles/${role.roleReference}`}>View and compare</Link>
              ) : null}
            </StatePanel>
            {view.screenId === "IAM-ROLE-EDITOR" ? (
              <div className="detail-section-grid">
                <StatePanel heading="Permission groups">
                  <ul>
                    {role.permissions.map((permission) => (
                      <li key={permission.action}>
                        <strong>{permission.action}</strong> · {permission.group}
                        {permission.highRisk ? " · High risk" : ""}
                        {permission.dependencies.length
                          ? ` · requires ${permission.dependencies.join(", ")}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                </StatePanel>
                <StatePanel heading="Approval and history">
                  <p>Submitted by {role.submittedBy ?? "Not submitted"}</p>
                  <p>Approved by {role.approvedBy ?? "Independent approval pending"}</p>
                  <ul>
                    {role.history.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <button
                    disabled
                    title="Requires exact permission, reason, expected version, independent approval and dependency revalidation"
                  >
                    Save / compare / submit / approve / activate
                  </button>
                </StatePanel>
              </div>
            ) : null}
          </section>
        ))
      )}
    </AppFrame>
  );
}
function Page({
  screenId,
  client,
}: {
  readonly screenId: RoleAdministrationPageView["screenId"];
  readonly client: RoleAdministrationPageClient;
}) {
  const { id } = useParams();
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true,
      request: Promise<unknown>;
    try {
      request =
        screenId === "IAM-ROLE-EDITOR"
          ? client.loadRole(parseRoleAdministrationRouteReference(id))
          : client.loadRoles();
    } catch {
      setState({ kind: "NotFound" });
      return () => {
        active = false;
      };
    }
    void request
      .then((value) => {
        if (active)
          setState({ kind: "Found", view: parseRoleAdministrationPageView(value, screenId) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: error instanceof RoleAdministrationPageError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client, id, screenId]);
  return state.kind === "Found" ? <Screen view={state.view} /> : <Status state={state.kind} />;
}
export function RoleListPage({
  client = unavailableRoleAdministrationPageClient,
}: {
  readonly client?: RoleAdministrationPageClient;
}) {
  return <Page screenId="IAM-ROLE-LIST" client={client} />;
}
export function RoleEditorPage({
  client = unavailableRoleAdministrationPageClient,
}: {
  readonly client?: RoleAdministrationPageClient;
}) {
  return <Page screenId="IAM-ROLE-EDITOR" client={client} />;
}
