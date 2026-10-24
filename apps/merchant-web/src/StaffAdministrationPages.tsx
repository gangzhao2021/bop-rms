import { listSeparator, systemText, t } from "./i18n/i18n.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime, StaffTime, StoreDate } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./operation-reference.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT, needsFullSignIn } from "./full-sign-in.js";
import {
  StaffPageError,
  parseStaffInviteResult,
  parseStaffResendResult,
  parseStaffRevokeResult,
  parseStaffPageView,
  parseStaffRouteReference,
  unavailableStaffPageClient,
  type StaffCommandRequest,
  type StaffInvitationView,
  type StaffMemberView,
  type StaffPageClient,
  type StaffPageErrorCode,
  type StaffPageView,
} from "./staff-administration-pages.js";
import { actionAccessDeniedText, noAccessHeading, pageAccessDeniedText } from "./access-denied.js";

const copy: Record<StaffPageErrorCode | "Loading", string> = {
  Loading: t("Loading Store staff…"),
  PermissionDenied: actionAccessDeniedText,
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  NotFound: t("This staff member is not assigned to the selected Store."),
  Conflict: t("The staff or role state changed. Refresh and try again."),
  LastOwner: t("The Store must keep at least one active Owner. Assign another Owner first."),
  PendingRequestsRemain: t(
    "Someone else has requested a role for this person. Ask an administrator who may approve roles to reject it, or to remove the person.",
  ),
  BrandRolesRemain: t(
    "This person also holds Brand roles (all Stores). Only someone who manages Brand staff can remove them; ask the Owner.",
  ),
  Invalid: t("The change was refused because the input is invalid."),
  AlreadyInvited: t("This email already has an open invitation."),
  EmailMismatch: t(
    "That's not the email this invitation was sent to. Cancel this invitation and invite again with the new address.",
  ),
  Offline: t("Offline. Your change was not confirmed; retry sends the same request again."),
  Unavailable: t("Staff administration is unavailable."),
};
type State =
  | { readonly kind: "Loading" | StaffPageErrorCode }
  | { readonly kind: "Found"; readonly view: StaffPageView };

/** Membership in plain words (never the stored status code). */
export function membershipText(status: string): string {
  if (status === "PendingActivation") return t("Invited (not signed in yet)");
  if (status === "Active") return t("Active");
  if (status === "Suspended") return t("Suspended");
  return status;
}

export const INVITE_NAME_HELP = t("Required — orders, refunds and records show who did what.");
export const INVITE_ROLE_NOTE = t("The role starts after another manager approves it.");
export function inviteSentText(delivery: StaffInvitationView["delivery"]): string {
  return delivery === "Unknown"
    ? t(
        "The invitation was saved but we couldn't confirm the email went out. Use Resend on their page.",
      )
    : t("Invitation sent. They'll get an email with a temporary password; it expires in 7 days.");
}
export function resendSentText(delivery: StaffInvitationView["delivery"]): string {
  return delivery === "Unknown"
    ? t(
        "The invitation was saved but we couldn't confirm the email went out. Try Resend again in a few minutes.",
      )
    : t("Invitation sent again. They'll get a new temporary password; it expires in 7 days.");
}
/** All three fields are needed (Owner decision 2026-10-18: a name is mandatory). */
export function inviteReady(name: string, email: string, role: string): boolean {
  return name.trim() !== "" && email.trim() !== "" && role !== "";
}

/** The list's one-line invitation state; nothing once accepted or cancelled. */
export function InvitationStatusLine({
  invitation,
}: {
  readonly invitation: StaffInvitationView | null;
}) {
  if (invitation === null) return null;
  if (invitation.status === "Expired")
    return <p className="staff-invitation__status">{t("Invitation expired")}</p>;
  if (invitation.status !== "Pending") return null;
  if (invitation.delivery === "Unknown")
    return <p className="staff-invitation__status">{t("Invited · email not confirmed")}</p>;
  return (
    <p className="staff-invitation__status">
      {t("Invited · email sent")} <StaffTime instant={invitation.sentAt} /> {t("· expires")}{" "}
      <StoreDate value={invitation.expiresAt} />
    </p>
  );
}

function CommandError({
  error,
  csrf,
  busy,
  retry,
  reload,
  text = copy,
}: {
  readonly error: StaffPageErrorCode | null;
  readonly csrf: string;
  readonly busy: boolean;
  readonly retry: (() => void) | null;
  readonly reload: () => void;
  readonly text?: Record<StaffPageErrorCode | "Loading", string>;
}) {
  if (error === null) return null;
  if (needsFullSignIn(error))
    return (
      <StatePanel heading={t("Confirm it's you")} status>
        <FullSignInPrompt csrf={csrf} />
        {retry ? (
          <button disabled={busy} onClick={retry}>
            {t("Try again")}
          </button>
        ) : null}
      </StatePanel>
    );
  return (
    <StatePanel heading={t("Change not applied")} tone="error" status>
      <p>{text[error]}</p>
      {retry && error === "Offline" ? (
        <button disabled={busy} onClick={retry}>
          {t("Retry")}
        </button>
      ) : (
        <button onClick={reload}>{t("Refresh")}</button>
      )}
    </StatePanel>
  );
}

const inviteCopy: Record<StaffPageErrorCode | "Loading", string> = {
  ...copy,
  Invalid: t("Check the name and email."),
};

/** WP-2423 DEC-COGNITO-STORE-STAFF: invite a new staff member to sign in with their own account. */
function InvitePanel({
  view,
  client,
  csrf,
  reload,
}: {
  readonly view: StaffPageView;
  readonly client: StaffPageClient;
  readonly csrf: string;
  readonly reload: () => void;
}) {
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState(""),
    [pending, setPending] = useState<StaffCommandRequest | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<StaffPageErrorCode | null>(null),
    [notice, setNotice] = useState("");
  const run = async (request: StaffCommandRequest) => {
    if (!client.command || busy) return;
    setPending(request);
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = parseStaffInviteResult(await client.command(request));
      setPending(null);
      setName("");
      setEmail("");
      setRole("");
      setNotice(inviteSentText(result.delivery));
      reload();
    } catch (failure) {
      setError(failure instanceof StaffPageError ? failure.code : "Unavailable");
    } finally {
      setBusy(false);
    }
  };
  const ready = inviteReady(name, email, role);
  return (
    <StatePanel heading={t("Invite a staff member")}>
      <p>
        {t(
          "They get an email with a temporary password and sign in with their work email, a password they choose and an authenticator app.",
        )}
      </p>
      <form
        className="staff-invite"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          void run({
            operation: "Invite",
            displayName: name.trim(),
            email: email.trim(),
            roleReference: role,
            operationReference: newOperationReference(),
          });
        }}
      >
        <div className="staff-invite__field">
          <label>
            {t("Name")}
            <input
              value={name}
              maxLength={80}
              required
              autoComplete="off"
              aria-describedby="staff-invite-name-help"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <p id="staff-invite-name-help" className="staff-invite__help">
            {INVITE_NAME_HELP}
          </p>
        </div>
        <label>
          {t("Work email")}
          <input
            type="email"
            value={email}
            maxLength={254}
            required
            autoComplete="off"
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
        </label>
        <label>
          {t("Role")}
          <select
            value={role}
            required
            aria-describedby="staff-invite-role-note"
            onChange={(event) => setRole(event.currentTarget.value)}
          >
            <option value="">{t("Choose a role")}</option>
            {view.roles.map((item) => (
              <option key={item.roleReference} value={item.roleReference}>
                {item.name}
                {item.scope === "Brand" ? t(" — Brand, all Stores") : t(" — this Store")}
              </option>
            ))}
          </select>
        </label>
        <p id="staff-invite-role-note" className="staff-invite__help">
          {INVITE_ROLE_NOTE}
        </p>
        <button type="submit" disabled={busy || !ready}>
          {busy ? t("Sending…") : t("Send invitation")}
        </button>
      </form>
      {notice ? <p role="status">{notice}</p> : null}
      <CommandError
        error={error}
        csrf={csrf}
        busy={busy}
        retry={pending ? () => void run(pending) : null}
        reload={reload}
        text={inviteCopy}
      />
    </StatePanel>
  );
}

/** WP-2423 DEC-COGNITO-STORE-STAFF: an invitation not accepted yet — resend or cancel it. */
function InvitationPanel({
  member,
  invitation,
  client,
  csrf,
  reload,
}: {
  readonly member: StaffMemberView;
  readonly invitation: StaffInvitationView;
  readonly client: StaffPageClient;
  readonly csrf: string;
  readonly reload: () => void;
}) {
  const [pending, setPending] = useState<StaffCommandRequest | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<StaffPageErrorCode | null>(null),
    [notice, setNotice] = useState(""),
    [needEmail, setNeedEmail] = useState(false),
    [email, setEmail] = useState(""),
    [confirmCancel, setConfirmCancel] = useState(false);
  const navigate = useNavigate();
  const run = async (request: StaffCommandRequest) => {
    if (!client.command || busy) return;
    setPending(request);
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const answer = await client.command(request);
      setPending(null);
      if (request.operation === "RevokeInvitation") {
        parseStaffRevokeResult(answer);
        void navigate("/app/organization/users");
        return;
      }
      const result = parseStaffResendResult(answer);
      if (result.emailNeeded) {
        setNeedEmail(true);
        return;
      }
      setNeedEmail(false);
      setEmail("");
      setNotice(resendSentText(result.delivery));
      reload();
    } catch (failure) {
      setError(failure instanceof StaffPageError ? failure.code : "Unavailable");
    } finally {
      setBusy(false);
    }
  };
  const resend = (withEmail?: string) =>
    void run({
      operation: "ResendInvitation",
      actorReference: member.actorReference,
      expectedVersion: invitation.version,
      operationReference: newOperationReference(),
      ...(withEmail === undefined ? {} : { email: withEmail }),
    });
  return (
    <StatePanel heading={t("Invitation")}>
      <div className="staff-invitation">
        <p>
          {t("{value} · sent to {emailHint}", {
            value: invitation.status === "Expired" ? t("Invitation expired") : t("Invited"),
            emailHint: invitation.emailHint,
          })}
        </p>
        <p>
          {t("Sent")} <StaffTime instant={invitation.sentAt} />
          {invitation.sendCount > 1
            ? t(" · sent {sendCount} times", { sendCount: invitation.sendCount })
            : ""}{" "}
          · {invitation.status === "Expired" ? t("expired") : t("expires")}{" "}
          <StoreDate value={invitation.expiresAt} />
        </p>
        {invitation.status === "Pending" && invitation.delivery === "Unknown" ? (
          <p>{t("We couldn't confirm the email went out. Resend the invitation.")}</p>
        ) : null}
        {needEmail ? (
          <form
            className="staff-invite"
            onSubmit={(event) => {
              event.preventDefault();
              if (email.trim()) resend(email.trim());
            }}
          >
            <label>
              {t("Enter their work email again to send a new invitation")}
              <input
                type="email"
                value={email}
                maxLength={254}
                required
                autoComplete="off"
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
            </label>
            <button type="submit" disabled={busy || !email.trim()}>
              {t("Resend invitation")}
            </button>
          </form>
        ) : invitation.mayResend ? (
          <button disabled={busy} onClick={() => resend()}>
            {t("Resend invitation")}
          </button>
        ) : null}
        {invitation.mayRevoke ? (
          confirmCancel ? (
            <p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(
                    pending?.operation === "RevokeInvitation"
                      ? pending
                      : {
                          operation: "RevokeInvitation",
                          actorReference: member.actorReference,
                          expectedVersion: invitation.version,
                          operationReference: newOperationReference(),
                        },
                  )
                }
              >
                {t("Confirm: cancel the invitation for {label}", { label: member.label })}
              </button>{" "}
              <button disabled={busy} onClick={() => setConfirmCancel(false)}>
                {t("Keep the invitation")}
              </button>
            </p>
          ) : (
            <button disabled={busy} onClick={() => setConfirmCancel(true)}>
              {t("Cancel invitation")}
            </button>
          )
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
      </div>
      <CommandError
        error={error}
        csrf={csrf}
        busy={busy}
        retry={pending ? () => void run(pending) : null}
        reload={reload}
      />
    </StatePanel>
  );
}

function Member({
  member,
  view,
  client,
  csrf,
  reload,
}: {
  readonly member: StaffMemberView;
  readonly view: StaffPageView;
  readonly client: StaffPageClient;
  readonly csrf: string;
  readonly reload: () => void;
}) {
  const [name, setName] = useState(member.displayName ?? ""),
    [role, setRole] = useState(""),
    [pending, setPending] = useState<StaffCommandRequest | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<StaffPageErrorCode | null>(null),
    [confirmRemoval, setConfirmRemoval] = useState(false);
  const navigate = useNavigate();
  const run = useCallback(
    async (request: StaffCommandRequest) => {
      if (!client.command) return;
      setPending(request);
      setBusy(true);
      setError(null);
      try {
        await client.command(request);
        setPending(null);
        // A removed person is no longer on this Store's list.
        if (request.operation === "RemoveFromStore") void navigate("/app/organization/users");
        else reload();
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
  const invitation = member.invitation;
  return (
    <div className="detail-section-grid">
      {invitation !== null &&
      (invitation.status === "Pending" || invitation.status === "Expired") ? (
        <InvitationPanel
          member={member}
          invitation={invitation}
          client={client}
          csrf={csrf}
          reload={reload}
        />
      ) : null}
      <StatePanel heading={t("Profile")}>
        <p>
          {t("Membership {membershipStatus} · Store assignment {storeAssignmentStatus}", {
            membershipStatus: membershipText(member.membershipStatus),
            storeAssignmentStatus: member.storeAssignmentStatus,
          })}
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
              {t("Display name shown to staff")}
              <input
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <button disabled={busy || !name.trim() || name.trim() === member.displayName}>
              {t("Save name")}
            </button>
          </form>
        ) : null}
      </StatePanel>
      <StatePanel heading={t("Roles")}>
        {member.assignments.length === 0 ? <p>{t("No active role.")}</p> : null}
        <ul>
          {member.assignments.map((item) => (
            <li key={item.assignmentReference}>
              <strong>{systemText(item.roleName)}</strong>
              {t("{value} · since", {
                value:
                  item.scope === "Brand" ? t(" (all Stores of the Brand)") : t(" (this Store)"),
              })}{" "}
              <StaffTime instant={item.since} />{" "}
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
                  {t("Remove role")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {member.self ? <p>{t("You cannot change your own roles.")}</p> : null}
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
              {t("Assign role (takes effect after another administrator approves)")}
              <select value={role} onChange={(event) => setRole(event.currentTarget.value)}>
                <option value="">{t("Choose a role")}</option>
                {requestable.map((item) => (
                  <option key={item.roleReference} value={item.roleReference}>
                    {item.name}
                    {item.scope === "Brand" ? t(" — Brand, all Stores") : t(" — this Store")}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy || !role}>{t("Request assignment")}</button>
          </form>
        ) : null}
      </StatePanel>
      <StatePanel heading={t("Pending approval")}>
        {member.pending.length === 0 ? <p>{t("No pending change.")}</p> : null}
        <ul>
          {member.pending.map((item) => (
            <li key={item.changeReference}>
              <strong>{systemText(item.roleName)}</strong>
              {t("{value} · requested by {requestedBy} at", {
                value: item.scope === "Brand" ? t(" (Brand)") : "",
                requestedBy: item.requestedBy,
              })}{" "}
              <StaffTime instant={item.requestedAt} />{" "}
              {item.mayDecide ? (
                <>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run({ operation: "Approve", changeReference: item.changeReference })
                    }
                  >
                    {t("Approve")}
                  </button>{" "}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run({ operation: "Reject", changeReference: item.changeReference })
                    }
                  >
                    {t("Reject")}
                  </button>
                </>
              ) : item.mayWithdraw ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run({ operation: "Withdraw", changeReference: item.changeReference })
                  }
                >
                  {t("Withdraw request")}
                </button>
              ) : (
                <span>
                  {member.membershipStatus === "PendingActivation"
                    ? t(
                        "Starts after {label} accepts the invitation and another manager approves it.",
                        { label: member.label },
                      )
                    : t("Waiting for another administrator.")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </StatePanel>
      {member.mayRemove ? (
        <StatePanel heading={t("Remove from this Store")}>
          <p>
            {t(
              "For someone who no longer works here: ends all their roles at this Store (and their Brand roles), ends their Store assignment and signs them out now. History stays on record.",
            )}
          </p>
          {confirmRemoval ? (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  void run(
                    pending?.operation === "RemoveFromStore"
                      ? pending
                      : {
                          operation: "RemoveFromStore",
                          actorReference: member.actorReference,
                          operationReference: newOperationReference(),
                        },
                  )
                }
              >
                {t("Confirm: remove {label}", { label: member.label })}
              </button>{" "}
              <button disabled={busy} onClick={() => setConfirmRemoval(false)}>
                {t("Cancel")}
              </button>
            </>
          ) : (
            <button disabled={busy} onClick={() => setConfirmRemoval(true)}>
              {t("Remove from this Store")}
            </button>
          )}
        </StatePanel>
      ) : null}
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
    </div>
  );
}

function Page({
  screenId,
  client,
  csrf,
}: {
  readonly screenId: StaffPageView["screenId"];
  readonly client: StaffPageClient;
  readonly csrf: string;
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
        heading={
          state.kind === "Loading"
            ? t("Loading staff")
            : state.kind === "PermissionDenied"
              ? noAccessHeading
              : t("Staff unavailable")
        }
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{state.kind === "PermissionDenied" ? pageAccessDeniedText : copy[state.kind]}</p>
      </StatePanel>
    );
  const view = state.view;
  const detail = screenId === "IAM-USER-DETAIL";
  return (
    <AppFrame title={detail ? t("Staff member") : t("Staff")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{detail ? t("Staff member") : t("Staff")}</p>
          <h2>{t("Store staff and roles")}</h2>
          <p>
            {t("Source as of")} <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
      </header>
      {!detail && view.viewer.mayInvite ? (
        <InvitePanel view={view} client={client} csrf={csrf} reload={reload} />
      ) : null}
      {view.staff.length === 0 ? (
        <StatePanel heading={t("No staff")} status>
          <p>{t("No member is assigned to this Store.")}</p>
        </StatePanel>
      ) : (
        view.staff.map((member) => (
          <section key={member.actorReference}>
            <StatePanel heading={member.label}>
              <p>
                {member.assignments
                  .map((item) => systemText(item.roleName))
                  .join(listSeparator()) || t("No active role")}
                {member.pending.length
                  ? t(" · {length} pending approval", { length: member.pending.length })
                  : ""}
              </p>
              <InvitationStatusLine invitation={member.invitation} />
              {detail ? (
                <Link to="/app/organization/users">{t("Back to staff")}</Link>
              ) : (
                <Link to={`/app/organization/users/${member.actorReference}`}>
                  {t("View and manage")}
                </Link>
              )}
            </StatePanel>
            {detail ? (
              <Member
                key={`${member.actorReference}:${member.profileVersion}:${member.assignments.length}:${member.pending.length}`}
                member={member}
                view={view}
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
export function StaffListPage({
  client = unavailableStaffPageClient,
  csrf = "",
}: {
  readonly client?: StaffPageClient;
  /** Session token for the "Verify it's you" step on a PIN sign-in. */
  readonly csrf?: string;
}) {
  return <Page screenId="IAM-USER-LIST" client={client} csrf={csrf} />;
}
export function StaffDetailPage({
  client = unavailableStaffPageClient,
  csrf = "",
}: {
  readonly client?: StaffPageClient;
  /** Session token for the "Verify it's you" step on a PIN sign-in. */
  readonly csrf?: string;
}) {
  return <Page screenId="IAM-USER-DETAIL" client={client} csrf={csrf} />;
}
