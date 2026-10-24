import { systemText, t } from "./i18n/i18n.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { newOperationReference } from "./operation-reference.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT, needsFullSignIn } from "./full-sign-in.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  RoleAdministrationPageError,
  parseRoleAdministrationPageView,
  parseRoleAdministrationRouteReference,
  unavailableRoleAdministrationPageClient,
  rolePermissionLabel,
  roleScopeLabels,
  roleStatusLabels,
  roleTypeLabels,
  type RoleAdministrationItemView,
  type RoleAdministrationOperation,
  type RoleAdministrationPageClient,
  type RoleAdministrationPageErrorCode,
  type RoleAdministrationPageView,
  type RoleCatalogEntryView,
  type RoleCommandRequest,
} from "./role-administration-pages.js";
import { actionAccessDeniedText, noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
type State =
  | { readonly kind: "Loading" | RoleAdministrationPageErrorCode }
  | { readonly kind: "Found"; readonly view: RoleAdministrationPageView };
const copy = {
  Loading: t("Loading authorized role metadata…"),
  PermissionDenied: actionAccessDeniedText,
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  NotFound: t("The requested role is unavailable in this scope."),
  FeatureDisabled: t("Role administration is disabled."),
  Stale: t("The projection is stale. Refresh before acting."),
  Conflict: t("The role or policy changed, or the role is still assigned. Refresh and try again."),
  CommandFailed: t("The change was refused. No role or permission outcome was inferred."),
  Offline: t("Offline. Your change was not confirmed; retry sends the same request again."),
  Unavailable: t("Role administration metadata is unavailable."),
} as const;
const operationLabels: Record<RoleAdministrationOperation, string> = {
  Duplicate: t("Duplicate as custom role"),
  SaveDraft: t("Save draft"),
  Submit: t("Submit for approval"),
  Approve: t("Approve"),
  Reject: t("Reject"),
  Activate: t("Activate"),
  Deactivate: t("Deactivate"),
};
const reasonCodes: Record<RoleAdministrationOperation, string> = {
  Duplicate: "ROLE_CREATED",
  SaveDraft: "ROLE_DRAFT_SAVED",
  Submit: "ROLE_SUBMITTED",
  Approve: "ROLE_APPROVED",
  Reject: "ROLE_REJECTED",
  Activate: "ROLE_ACTIVATED",
  Deactivate: "ROLE_DEACTIVATED",
};
function Status({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  return (
    <StatePanel
      heading={
        state === "Loading"
          ? t("Loading roles")
          : state === "PermissionDenied"
            ? noAccessHeading
            : t("Role administration unavailable")
      }
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{state === "PermissionDenied" ? pageAccessDeniedText : copy[state]}</p>
    </StatePanel>
  );
}
function PermissionPicker({
  catalog,
  selected,
  onChange,
}: {
  readonly catalog: readonly RoleCatalogEntryView[];
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const matching = catalog.filter((entry) =>
      `${entry.action} ${entry.description}`.toLowerCase().includes(query.trim().toLowerCase()),
    );
    return [...new Set(matching.map((entry) => entry.group))].map((group) => ({
      group,
      entries: matching.filter((entry) => entry.group === group),
    }));
  }, [catalog, query]);
  return (
    <fieldset>
      <legend>{t("Permissions ({size} selected)", { size: selected.size })}</legend>
      <label>
        {t("Search permissions")}
        <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
      </label>
      {groups.map(({ group, entries }) => (
        <fieldset key={group}>
          <legend>{group}</legend>
          {entries.map((entry) => (
            <label key={entry.action} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={selected.has(entry.action)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.currentTarget.checked) next.add(entry.action);
                  else next.delete(entry.action);
                  onChange(next);
                }}
              />{" "}
              {systemText(entry.description)}
              {entry.highRisk ? <strong> {t("· High risk")}</strong> : null}
            </label>
          ))}
        </fieldset>
      ))}
    </fieldset>
  );
}
function Editor({
  view,
  role,
  client,
  csrf,
  reload,
}: {
  readonly view: RoleAdministrationPageView;
  readonly role: RoleAdministrationItemView;
  readonly client: RoleAdministrationPageClient;
  readonly csrf: string;
  readonly reload: () => void;
}) {
  const navigate = useNavigate();
  const catalogActions = useMemo(() => new Set(view.catalog.map((entry) => entry.action)), [view]);
  const current = useMemo(
    () => new Set(role.permissions.map((item) => item.action).filter((a) => catalogActions.has(a))),
    [role, catalogActions],
  );
  const [name, setName] = useState(role.name),
    [description, setDescription] = useState(role.description),
    [selected, setSelected] = useState<ReadonlySet<string>>(current),
    [duplicate, setDuplicate] = useState<{ code: string; name: string } | null>(null),
    [pending, setPending] = useState<RoleCommandRequest | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<RoleAdministrationPageErrorCode | null>(null);
  const run = useCallback(
    async (request: RoleCommandRequest) => {
      if (!client.command) return;
      setPending(request);
      setBusy(true);
      setError(null);
      try {
        const result = await client.command(request);
        setPending(null);
        if (request.operation === "Duplicate")
          navigate(`/app/organization/roles/${result.roleReference}`);
        else reload();
      } catch (failure) {
        setError(failure instanceof RoleAdministrationPageError ? failure.code : "Unavailable");
      } finally {
        setBusy(false);
      }
    },
    [client, navigate, reload],
  );
  const request = (operation: RoleAdministrationOperation): RoleCommandRequest => ({
    operation,
    roleReference: role.roleReference,
    expectedVersion: role.version,
    operationReference: newOperationReference(),
    reasonCode: reasonCodes[operation],
    draft:
      operation === "SaveDraft"
        ? { displayName: name, description, actions: [...selected].sort() }
        : operation === "Duplicate" && duplicate
          ? {
              code: duplicate.code,
              displayName: duplicate.name,
              description: t("Custom role based on {name}", { name: role.name }),
              actions: [...selected].sort(),
            }
          : null,
  });
  const editable = role.operations.includes("SaveDraft");
  const canDuplicate = role.operations.includes("Duplicate");
  return (
    <div className="detail-section-grid">
      {editable || duplicate ? (
        <StatePanel heading={duplicate ? t("New custom role") : t("Edit draft")}>
          {duplicate ? (
            <>
              <label>
                {t("Role code (lowercase, e.g. shift_lead)")}
                <input
                  value={duplicate.code}
                  pattern="[a-z][a-z0-9_]{1,62}[a-z0-9]"
                  onChange={(event) =>
                    setDuplicate({ ...duplicate, code: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                {t("Role name")}
                <input
                  value={duplicate.name}
                  onChange={(event) =>
                    setDuplicate({ ...duplicate, name: event.currentTarget.value })
                  }
                />
              </label>
            </>
          ) : (
            <>
              <label>
                {t("Role name")}
                <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
              </label>
              <label>
                {t("Description")}
                <input
                  value={description}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </label>
            </>
          )}
          <PermissionPicker catalog={view.catalog} selected={selected} onChange={setSelected} />
          <p>
            {t(
              "Legacy combined permissions are added automatically when every permission they cover is selected.",
            )}
          </p>
          {duplicate ? (
            <>
              <button
                disabled={
                  busy ||
                  !/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/u.test(duplicate.code) ||
                  !duplicate.name.trim()
                }
                onClick={() => void run(request("Duplicate"))}
              >
                {t("Create draft role")}
              </button>{" "}
              <button disabled={busy} onClick={() => setDuplicate(null)}>
                {t("Cancel")}
              </button>
            </>
          ) : null}
        </StatePanel>
      ) : (
        <StatePanel heading={t("Permission groups")}>
          <ul>
            {role.permissions.map((permission) => (
              <li key={permission.action}>
                <strong>
                  {rolePermissionLabel(permission.action, view.catalog, permission.group)}
                </strong>
                {rolePermissionLabel(permission.action, view.catalog, permission.group) ===
                permission.group
                  ? ""
                  : ` · ${permission.group}`}
                {permission.highRisk ? t(" · High risk") : ""}
              </li>
            ))}
          </ul>
        </StatePanel>
      )}
      <StatePanel heading={t("Approval and history")}>
        <p>{t("Submitted by {value}", { value: role.submittedBy ?? t("Not submitted") })}</p>
        <p>
          {t("Approved by {value}", {
            value: role.approvedBy ?? t("Independent approval pending"),
          })}
        </p>
        <ul>
          {role.history.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {role.type === "System" ? (
          <p>{t("System template role: its permissions follow the released template.")}</p>
        ) : null}
        {role.memberCount > 0 && role.status === "Active" ? (
          <p>
            {t("Reassign the {memberCount} staff holding this role before deactivating it.", {
              memberCount: role.memberCount,
            })}
          </p>
        ) : null}
        {role.status === "InReview" && !role.operations.includes("Approve") ? (
          <p>{t("Another administrator must approve this change.")}</p>
        ) : null}
        <div role="group" aria-label={t("Role actions")}>
          {role.operations
            .filter((operation) => operation !== "Duplicate")
            .map((operation) => (
              <button
                key={operation}
                disabled={busy || duplicate !== null}
                onClick={() => void run(request(operation))}
              >
                {operationLabels[operation]}
              </button>
            ))}{" "}
          {canDuplicate && !duplicate ? (
            <button
              disabled={busy}
              onClick={() => {
                setSelected(current);
                setDuplicate({ code: "", name: "" });
              }}
            >
              {operationLabels.Duplicate}
            </button>
          ) : null}
        </div>
        {error && needsFullSignIn(error) ? (
          <StatePanel heading={t("Confirm it's you")} status>
            <FullSignInPrompt csrf={csrf} />
            {pending ? (
              <button disabled={busy} onClick={() => void run(pending)}>
                {t("Try again")}
              </button>
            ) : null}
          </StatePanel>
        ) : error ? (
          <StatePanel heading={t("Change not applied")} tone="error" status>
            <p>{copy[error]}</p>
            {pending && error === "Offline" ? (
              <button disabled={busy} onClick={() => void run(pending)}>
                {t("Retry")}
              </button>
            ) : (
              <button onClick={reload}>{t("Refresh")}</button>
            )}
          </StatePanel>
        ) : null}
      </StatePanel>
    </div>
  );
}
export function RoleAdministrationScreen({
  view,
  client,
  csrf,
  reload,
}: {
  readonly view: RoleAdministrationPageView;
  readonly client: RoleAdministrationPageClient;
  readonly csrf: string;
  readonly reload: () => void;
}) {
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
  const editor = view.screenId === "IAM-ROLE-EDITOR";
  return (
    <AppFrame
      title={editor ? t("Role editor") : t("Roles")}
      description={[
        editor ? "Edit a role and its permissions" : "Roles and permissions",
        view.freshness === "Stale" ? "may be out of date" : null,
        view.completeness === "Partial" ? "some roles not shown" : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{editor ? t("Role editor") : t("Roles")}</p>
          <h2>{t("Role and permission governance")}</h2>
          <p>
            {t("Source as of")} <SourceTime instant={view.sourceAsOf} />
          </p>
          {!editor && view.mayManage ? (
            <p>
              {t(
                "To create a custom role, open a role and duplicate it, then adjust its permissions.",
              )}
            </p>
          ) : null}
        </div>
      </header>
      {editor ? null : (
        <div className="list-filters" role="search">
          <label>
            {t("Role or permission")}
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <label>
            {t("Status")}
            <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
              <option value="All">{t("All")}</option>
              {Object.entries(roleStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {roles.length === 0 ? (
        <StatePanel heading={t("No matching roles")} status>
          <p>{t("Change the safe filters.")}</p>
        </StatePanel>
      ) : (
        roles.map((role) => (
          <section key={role.roleReference}>
            <StatePanel
              heading={systemText(role.name)}
              tone={role.permissions.some((item) => item.highRisk) ? "offline" : "neutral"}
            >
              <p>
                <strong>{roleStatusLabels[role.status]}</strong>{" "}
                {t("· {value} · {value2} · version {version}", {
                  value: roleScopeLabels[role.scope],
                  value2: roleTypeLabels[role.type],
                  version: role.version,
                })}
              </p>
              <p>{systemText(role.description)}</p>
              <p>
                {t("{memberCount} active assignments · {length} permissions", {
                  memberCount: role.memberCount,
                  length: role.permissions.length,
                })}
              </p>
              {editor ? (
                <Link to="/app/organization/roles">{t("Back to roles")}</Link>
              ) : (
                <Link to={`/app/organization/roles/${role.roleReference}`}>
                  {t("View and manage")}
                </Link>
              )}
            </StatePanel>
            {editor ? (
              <Editor
                key={`${role.roleReference}:${role.version}`}
                view={view}
                role={role}
                client={client}
                csrf={csrf}
                reload={reload}
              />
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
  csrf,
}: {
  readonly screenId: RoleAdministrationPageView["screenId"];
  readonly client: RoleAdministrationPageClient;
  readonly csrf: string;
}) {
  const { id } = useParams();
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
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
  }, [client, id, screenId, generation]);
  return state.kind === "Found" ? (
    <RoleAdministrationScreen view={state.view} client={client} csrf={csrf} reload={reload} />
  ) : (
    <Status state={state.kind} />
  );
}
export function RoleListPage({
  client = unavailableRoleAdministrationPageClient,
  csrf = "",
}: {
  readonly client?: RoleAdministrationPageClient;
  /** Session token for the "Verify it's you" step on a PIN sign-in. */
  readonly csrf?: string;
}) {
  return <Page screenId="IAM-ROLE-LIST" client={client} csrf={csrf} />;
}
export function RoleEditorPage({
  client = unavailableRoleAdministrationPageClient,
  csrf = "",
}: {
  readonly client?: RoleAdministrationPageClient;
  /** Session token for the "Verify it's you" step on a PIN sign-in. */
  readonly csrf?: string;
}) {
  return <Page screenId="IAM-ROLE-EDITOR" client={client} csrf={csrf} />;
}
