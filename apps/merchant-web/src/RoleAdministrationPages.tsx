import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  RoleAdministrationPageError,
  parseRoleAdministrationPageView,
  parseRoleAdministrationRouteReference,
  unavailableRoleAdministrationPageClient,
  type RoleAdministrationItemView,
  type RoleAdministrationOperation,
  type RoleAdministrationPageClient,
  type RoleAdministrationPageErrorCode,
  type RoleAdministrationPageView,
  type RoleCatalogEntryView,
  type RoleCommandRequest,
} from "./role-administration-pages.js";
type State =
  | { readonly kind: "Loading" | RoleAdministrationPageErrorCode }
  | { readonly kind: "Found"; readonly view: RoleAdministrationPageView };
const copy = {
  Loading: "Loading authorized role metadata…",
  PermissionDenied: "Role administration permission is required.",
  NotFound: "The requested role is unavailable in this scope.",
  FeatureDisabled: "Role administration is disabled.",
  Stale: "The projection is stale. Refresh before acting.",
  Conflict: "The role or policy changed, or the role is still assigned. Refresh and try again.",
  CommandFailed: "The change was refused. No role or permission outcome was inferred.",
  Offline: "Offline. Your change was not confirmed; retry sends the same request again.",
  Unavailable: "Role administration metadata is unavailable.",
} as const;
const operationLabels: Record<RoleAdministrationOperation, string> = {
  Duplicate: "Duplicate as custom role",
  SaveDraft: "Save draft",
  Submit: "Submit for approval",
  Approve: "Approve",
  Reject: "Reject",
  Activate: "Activate",
  Deactivate: "Deactivate",
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
/** UUIDv7 operation reference; one is kept per pending command so a retry stays idempotent. */
export function newOperationReference(
  now = Date.now(),
  random = crypto.getRandomValues(new Uint8Array(10)),
) {
  const time = now.toString(16).padStart(12, "0"),
    hex = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const variant = ((parseInt(hex.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex.slice(0, 3)}-${variant}${hex.slice(4, 7)}-${hex.slice(7, 19)}`;
}
function Status({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
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
      <legend>Permissions ({selected.size} selected)</legend>
      <label>
        Search permissions
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
              {entry.description} <code>{entry.action}</code>
              {entry.highRisk ? <strong> · High risk</strong> : null}
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
  reload,
}: {
  readonly view: RoleAdministrationPageView;
  readonly role: RoleAdministrationItemView;
  readonly client: RoleAdministrationPageClient;
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
              description: `Custom role based on ${role.name}`,
              actions: [...selected].sort(),
            }
          : null,
  });
  const editable = role.operations.includes("SaveDraft");
  const canDuplicate = role.operations.includes("Duplicate");
  return (
    <div className="detail-section-grid">
      {editable || duplicate ? (
        <StatePanel heading={duplicate ? "New custom role" : "Edit draft"}>
          {duplicate ? (
            <>
              <label>
                Role code (lowercase, e.g. shift_lead)
                <input
                  value={duplicate.code}
                  pattern="[a-z][a-z0-9_]{1,62}[a-z0-9]"
                  onChange={(event) =>
                    setDuplicate({ ...duplicate, code: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                Role name
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
                Role name
                <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
              </label>
              <label>
                Description
                <input
                  value={description}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </label>
            </>
          )}
          <PermissionPicker catalog={view.catalog} selected={selected} onChange={setSelected} />
          <p>
            Legacy combined permissions are added automatically when every permission they cover is
            selected.
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
                Create draft role
              </button>{" "}
              <button disabled={busy} onClick={() => setDuplicate(null)}>
                Cancel
              </button>
            </>
          ) : null}
        </StatePanel>
      ) : (
        <StatePanel heading="Permission groups">
          <ul>
            {role.permissions.map((permission) => (
              <li key={permission.action}>
                <strong>{permission.action}</strong> · {permission.group}
                {permission.highRisk ? " · High risk" : ""}
              </li>
            ))}
          </ul>
        </StatePanel>
      )}
      <StatePanel heading="Approval and history">
        <p>Submitted by {role.submittedBy ?? "Not submitted"}</p>
        <p>Approved by {role.approvedBy ?? "Independent approval pending"}</p>
        <ul>
          {role.history.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {role.type === "System" ? (
          <p>System template role: its permissions follow the released template.</p>
        ) : null}
        {role.memberCount > 0 && role.status === "Active" ? (
          <p>Reassign the {role.memberCount} staff holding this role before deactivating it.</p>
        ) : null}
        {role.status === "InReview" && !role.operations.includes("Approve") ? (
          <p>Another administrator must approve this change.</p>
        ) : null}
        <div role="group" aria-label="Role actions">
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
        {error ? (
          <StatePanel heading="Change not applied" tone="error" status>
            <p>{copy[error]}</p>
            {pending && error === "Offline" ? (
              <button disabled={busy} onClick={() => void run(pending)}>
                Retry
              </button>
            ) : (
              <button onClick={reload}>Refresh</button>
            )}
          </StatePanel>
        ) : null}
      </StatePanel>
    </div>
  );
}
function Screen({
  view,
  client,
  reload,
}: {
  readonly view: RoleAdministrationPageView;
  readonly client: RoleAdministrationPageClient;
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
      title={editor ? "Role editor" : "Roles"}
      description={`${view.screenId} · ${view.freshness} · ${view.completeness}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId}</p>
          <h2>Role and permission governance</h2>
          <p>
            Source as of <SourceTime instant={view.sourceAsOf} />
          </p>
          {!editor && view.mayManage ? (
            <p>
              To create a custom role, open a role and duplicate it, then adjust its permissions.
            </p>
          ) : null}
        </div>
      </header>
      {editor ? null : (
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
              <option>Rejected</option>
              <option>Deactivated</option>
            </select>
          </label>
        </div>
      )}
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
              {editor ? (
                <Link to="/app/organization/roles">Back to roles</Link>
              ) : (
                <Link to={`/app/organization/roles/${role.roleReference}`}>View and manage</Link>
              )}
            </StatePanel>
            {editor ? (
              <Editor
                key={`${role.roleReference}:${role.version}`}
                view={view}
                role={role}
                client={client}
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
}: {
  readonly screenId: RoleAdministrationPageView["screenId"];
  readonly client: RoleAdministrationPageClient;
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
    <Screen view={state.view} client={client} reload={reload} />
  ) : (
    <Status state={state.kind} />
  );
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
