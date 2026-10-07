import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  StaffPageError,
  parseStaffPageView,
  parseStaffRouteReference,
  unavailableStaffPageClient,
  type StaffCommandRequest,
  type StaffMemberView,
  type StaffPageClient,
  type StaffPageErrorCode,
  type StaffPageView,
} from "./staff-administration-pages.js";

const copy: Record<StaffPageErrorCode | "Loading", string> = {
  Loading: "Loading Store staff…",
  PermissionDenied: "Staff administration permission is required for this action.",
  NotFound: "This staff member is not assigned to the selected Store.",
  Conflict: "The staff or role state changed. Refresh and try again.",
  LastOwner: "The Store must keep at least one active Owner. Assign another Owner first.",
  Invalid: "The change was refused because the input is invalid.",
  Offline: "Offline. Your change was not confirmed; retry sends the same request again.",
  Unavailable: "Staff administration is unavailable.",
};
type State =
  | { readonly kind: "Loading" | StaffPageErrorCode }
  | { readonly kind: "Found"; readonly view: StaffPageView };

function Member({
  member,
  view,
  client,
  reload,
}: {
  readonly member: StaffMemberView;
  readonly view: StaffPageView;
  readonly client: StaffPageClient;
  readonly reload: () => void;
}) {
  const [name, setName] = useState(member.displayName ?? ""),
    [role, setRole] = useState(""),
    [pending, setPending] = useState<StaffCommandRequest | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<StaffPageErrorCode | null>(null);
  const run = useCallback(
    async (request: StaffCommandRequest) => {
      if (!client.command) return;
      setPending(request);
      setBusy(true);
      setError(null);
      try {
        await client.command(request);
        setPending(null);
        reload();
      } catch (failure) {
        setError(failure instanceof StaffPageError ? failure.code : "Unavailable");
      } finally {
        setBusy(false);
      }
    },
    [client, reload],
  );
  const held = new Set(member.assignments.map((item) => item.roleReference));
  const requestable = view.roles.filter((item) => !held.has(item.roleReference));
  return (
    <div className="detail-section-grid">
      <StatePanel heading="Profile">
        <p>
          Membership {member.membershipStatus} · Store assignment {member.storeAssignmentStatus}
        </p>
        {member.mayRename ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run({
                operation: "SetDisplayName",
                actorReference: member.actorReference,
                expectedProfileVersion: member.profileVersion,
                displayName: name.trim(),
                operationReference: newOperationReference(),
              });
            }}
          >
            <label>
              Display name shown to staff
              <input
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <button disabled={busy || !name.trim() || name.trim() === member.displayName}>
              Save name
            </button>
          </form>
        ) : null}
      </StatePanel>
      <StatePanel heading="Roles in this Store">
        {member.assignments.length === 0 ? <p>No active role.</p> : null}
        <ul>
          {member.assignments.map((item) => (
            <li key={item.assignmentReference}>
              <strong>{item.roleName}</strong> · since {item.since}{" "}
              {item.mayRevoke ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run({
                      operation: "Revoke",
                      assignmentReference: item.assignmentReference,
                      operationReference: newOperationReference(),
                    })
                  }
                >
                  Remove role
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {member.self ? <p>You cannot change your own roles.</p> : null}
        {member.mayRequest ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (role)
                void run({
                  operation: "RequestRole",
                  actorReference: member.actorReference,
                  roleReference: role,
                  operationReference: newOperationReference(),
                });
            }}
          >
            <label>
              Assign role (takes effect after another administrator approves)
              <select value={role} onChange={(event) => setRole(event.currentTarget.value)}>
                <option value="">Choose a role</option>
                {requestable.map((item) => (
                  <option key={item.roleReference} value={item.roleReference}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy || !role}>Request assignment</button>
          </form>
        ) : null}
      </StatePanel>
      <StatePanel heading="Pending approval">
        {member.pending.length === 0 ? <p>No pending change.</p> : null}
        <ul>
          {member.pending.map((item) => (
            <li key={item.changeReference}>
              <strong>{item.roleName}</strong> · requested by {item.requestedBy} at{" "}
              {item.requestedAt}{" "}
              {item.mayDecide ? (
                <>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run({ operation: "Approve", changeReference: item.changeReference })
                    }
                  >
                    Approve
                  </button>{" "}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run({ operation: "Reject", changeReference: item.changeReference })
                    }
                  >
                    Reject
                  </button>
                </>
              ) : item.mayWithdraw ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run({ operation: "Withdraw", changeReference: item.changeReference })
                  }
                >
                  Withdraw request
                </button>
              ) : (
                <span>Waiting for another administrator.</span>
              )}
            </li>
          ))}
        </ul>
      </StatePanel>
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
    </div>
  );
}

function Page({
  screenId,
  client,
}: {
  readonly screenId: StaffPageView["screenId"];
  readonly client: StaffPageClient;
}) {
  const { id } = useParams();
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    let request: Promise<unknown>;
    try {
      request = client.load(screenId === "IAM-USER-DETAIL" ? parseStaffRouteReference(id) : null);
    } catch {
      setState({ kind: "NotFound" });
      return () => {
        active = false;
      };
    }
    void request
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseStaffPageView(value, screenId) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof StaffPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, id, screenId, generation]);
  if (state.kind !== "Found")
    return (
      <StatePanel
        heading={state.kind === "Loading" ? "Loading staff" : "Staff unavailable"}
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{copy[state.kind]}</p>
      </StatePanel>
    );
  const view = state.view;
  const detail = screenId === "IAM-USER-DETAIL";
  return (
    <AppFrame title={detail ? "Staff member" : "Staff"} description={`${view.screenId}`}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId}</p>
          <h2>Store staff and roles</h2>
          <p>Source as of {view.sourceAsOf}</p>
        </div>
      </header>
      {view.staff.length === 0 ? (
        <StatePanel heading="No staff" status>
          <p>No member is assigned to this Store.</p>
        </StatePanel>
      ) : (
        view.staff.map((member) => (
          <section key={member.actorReference}>
            <StatePanel heading={member.label}>
              <p>
                {member.assignments.map((item) => item.roleName).join(", ") || "No active role"}
                {member.pending.length ? ` · ${member.pending.length} pending approval` : ""}
              </p>
              {detail ? (
                <Link to="/app/organization/users">Back to staff</Link>
              ) : (
                <Link to={`/app/organization/users/${member.actorReference}`}>View and manage</Link>
              )}
            </StatePanel>
            {detail ? (
              <Member
                key={`${member.actorReference}:${member.profileVersion}:${member.assignments.length}:${member.pending.length}`}
                member={member}
                view={view}
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
export function StaffListPage({
  client = unavailableStaffPageClient,
}: {
  readonly client?: StaffPageClient;
}) {
  return <Page screenId="IAM-USER-LIST" client={client} />;
}
export function StaffDetailPage({
  client = unavailableStaffPageClient,
}: {
  readonly client?: StaffPageClient;
}) {
  return <Page screenId="IAM-USER-DETAIL" client={client} />;
}
