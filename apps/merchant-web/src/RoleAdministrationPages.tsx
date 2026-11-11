import { listSeparator, systemText, t } from "./i18n/i18n.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime, StaffTime } from "./StoreTime.js";
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
  roleChangeStatusLabels,
  roleDecisionLabels,
  roleKindLabels,
  rolePermissionLabel,
  roleScopeLabels,
  type RoleAdministrationItemView,
  type RoleAdministrationOperation,
  type RoleAdministrationPageClient,
  type RoleAdministrationPageErrorCode,
  type RoleAdministrationPageView,
  type RoleCatalogEntryView,
  type RoleCommandRequest,
} from "./role-administration-pages.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
import { StarterRoleSetOffer } from "./StarterRoleSets.js";
import { actionAccessDeniedText, noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { serverProblemText } from "./failure-words.js";
import { PageDidNotLoad, readingAgain } from "./PageDidNotLoad.js";
type State =
  | { readonly kind: "Loading" | RoleAdministrationPageErrorCode }
  | { readonly kind: "Found"; readonly view: RoleAdministrationPageView };
const copy: Record<Exclude<State["kind"], "Found">, string> = {
  Loading: t("Loading roles…"),
  PermissionDenied: actionAccessDeniedText,
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  NotFound: t("This role is not available at this store."),
  FeatureDisabled: t("Role administration is disabled."),
  Stale: t("This page may be out of date. Refresh before changing anything."),
  Conflict: t("Someone changed this role meanwhile. Refresh and check it again."),
  CommandFailed: t("The change was refused. Nothing was changed."),
  Offline: t("Offline. Your change was not confirmed; retry sends the same request again."),
  Unavailable: serverProblemText,
  InUse: t(
    "Staff hold this role, or a staff role request waiting for approval would give it. Give them another role first.",
  ),
  NameTaken: t("Another role here already has this name. Choose another name."),
  SoleOperatorNotInEffect: t(
    "You cannot approve this on your own now: someone else also approves roles, or Sole operator is off.",
  ),
  NeedsReverification: t("Confirm it's you again (valid 15 minutes), then approve."),
  WouldWidenOwnAccess: t(
    "This change gives the role something you don't hold yourself. Someone who holds it must approve.",
  ),
  ApproverLacksAccess: t(
    "This change adds permissions you don't hold yourself, so someone who holds them must approve it.",
  ),
  PresetChanged: t(
    "BOP updated this preset after the change was approved. Withdraw it and restore again, so you approve what it is now.",
  ),
};
const reasonCodes: Record<RoleAdministrationOperation, string> = {
  Create: "ROLE_CREATED",
  Duplicate: "ROLE_CREATED",
  SaveDraft: "ROLE_DRAFT_SAVED",
  Revise: "ROLE_CHANGE_STARTED",
  RestoreDefault: "ROLE_PRESET_RESTORE",
  Submit: "ROLE_SUBMITTED",
  Withdraw: "ROLE_CHANGE_WITHDRAWN",
  Approve: "ROLE_APPROVED",
  ApproveAlone: "ROLE_APPROVED",
  Reject: "ROLE_REJECTED",
  Activate: "ROLE_ACTIVATED",
  Deactivate: "ROLE_REMOVED",
};
function Status({
  state,
  onRetry,
}: {
  readonly state: Exclude<State["kind"], "Found">;
  readonly onRetry: () => void;
}) {
  if (state === "Unavailable" || state === "Offline")
    return <PageDidNotLoad code={state} title={t("Roles")} onRetry={onRetry} />;
  return (
    <StatePanel
      heading={
        state === "Loading"
          ? t("Loading roles")
          : state === "PermissionDenied"
            ? noAccessHeading
            : t("Roles are not available")
      }
      tone={state === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{state === "PermissionDenied" ? pageAccessDeniedText : copy[state]}</p>
    </StatePanel>
  );
}
const labelOf = (catalog: readonly RoleCatalogEntryView[], action: string) =>
  systemText(rolePermissionLabel(action, catalog));
const listOf = (catalog: readonly RoleCatalogEntryView[], actions: readonly string[]) =>
  actions.map((action) => labelOf(catalog, action)).join(listSeparator());
/** Flagged permissions first (the Owner's six in their order), then the rest as given. */
const flaggedFirst = (catalog: readonly RoleCatalogEntryView[], actions: readonly string[]) => {
  const rank = new Map(catalog.map((entry) => [entry.action, entry.riskRank]));
  const ranked = actions
    .filter((action) => (rank.get(action) ?? null) !== null)
    .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  return [...ranked, ...actions.filter((action) => (rank.get(action) ?? null) === null)];
};
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
    const words = query.trim().toLowerCase();
    // Staff search the words they read (in their language), never the codes.
    const matching = catalog.filter((entry) =>
      `${systemText(entry.description)} ${systemText(entry.group)}`.toLowerCase().includes(words),
    );
    return [...new Set(matching.map((entry) => entry.group))].map((group) => ({
      group,
      entries: matching.filter((entry) => entry.group === group),
    }));
  }, [catalog, query]);
  return (
    <fieldset className="role-permission-picker">
      <legend>{t("What this role can do ({size} ticked)", { size: selected.size })}</legend>
      <label>
        {t("Search")}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      {groups.map(({ group, entries }) => (
        <fieldset key={group}>
          <legend>{systemText(group)}</legend>
          {entries.map((entry) => (
            <div key={entry.action} className="role-permission">
              <label>
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
              </label>
              {selected.has(entry.action) && entry.warning !== null ? (
                <p role="note" className="role-permission-warning">
                  {systemText(entry.warning)}
                </p>
              ) : null}
            </div>
          ))}
        </fieldset>
      ))}
    </fieldset>
  );
}
/** "This role can: approve refunds, comp dishes…" with the flagged ones first. */
function RoleSummary({
  catalog,
  selected,
  memberCount,
}: {
  readonly catalog: readonly RoleCatalogEntryView[];
  readonly selected: readonly string[];
  readonly memberCount: number;
}) {
  const ranked = new Set(catalog.filter((e) => e.riskRank !== null).map((e) => e.action));
  const risky = flaggedFirst(catalog, selected).filter((action) => ranked.has(action));
  return (
    <div className="role-summary">
      <p>
        {risky.length === 0
          ? t("This role has no money or approval powers.")
          : t("This role can: {list}", { list: listOf(catalog, risky) })}
      </p>
      {memberCount > 0 ? (
        <p>
          {t(
            "Your changes apply to the {count} staff who hold it once approved and turned on. Until then they keep what they have now.",
            { count: memberCount },
          )}
        </p>
      ) : null}
    </div>
  );
}
function PermissionList({
  catalog,
  actions,
}: {
  readonly catalog: readonly RoleCatalogEntryView[];
  readonly actions: readonly string[];
}) {
  const byGroup = new Map<string, string[]>();
  for (const action of flaggedFirst(catalog, actions)) {
    const group = catalog.find((entry) => entry.action === action)?.group ?? "";
    byGroup.set(group, [...(byGroup.get(group) ?? []), action]);
  }
  return (
    <dl className="role-permission-list">
      {[...byGroup.entries()].map(([group, items]) => (
        <div key={group}>
          <dt>{systemText(group)}</dt>
          <dd>{items.map((action) => labelOf(catalog, action)).join(listSeparator())}</dd>
        </div>
      ))}
    </dl>
  );
}
function useRun(client: RoleAdministrationPageClient, reload: () => void) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<readonly RoleCommandRequest[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<RoleAdministrationPageErrorCode | null>(null),
    [partial, setPartial] = useState(false);
  /** Sends the commands in order; a later one failing leaves what the first did, said honestly. */
  const run = useCallback(
    async (requests: readonly RoleCommandRequest[], open?: boolean) => {
      if (!client.command) return;
      setPending(requests);
      setBusy(true);
      setError(null);
      setPartial(false);
      let done = 0;
      try {
        let roleReference: string | null = null;
        for (const request of requests) {
          roleReference = (await client.command(request)).roleReference;
          done += 1;
        }
        setPending(null);
        if (open && roleReference !== null) navigate(`/app/organization/roles/${roleReference}`);
        else reload();
      } catch (failure) {
        if (done > 0) {
          setPending(requests.slice(done));
          setPartial(true);
        }
        setError(failure instanceof RoleAdministrationPageError ? failure.code : "Unavailable");
      } finally {
        setBusy(false);
      }
    },
    [client, navigate, reload],
  );
  return { run, pending, busy, error, partial };
}
function Failure({
  csrf,
  state,
  reload,
}: {
  readonly csrf: string;
  readonly state: ReturnType<typeof useRun>;
  readonly reload: () => void;
}) {
  const { error, pending, busy, run, partial } = state;
  if (error === null) return null;
  if (needsFullSignIn(error))
    return (
      <StatePanel heading={t("Confirm it's you")} status>
        <FullSignInPrompt csrf={csrf} />
        {pending ? (
          <button disabled={busy} onClick={() => void run(pending)}>
            {t("Try again")}
          </button>
        ) : null}
      </StatePanel>
    );
  return (
    <StatePanel
      heading={partial ? t("Approved, not on yet") : t("Change not made")}
      tone="error"
      status
    >
      <p>{copy[error]}</p>
      {pending && (error === "Offline" || partial) ? (
        <button disabled={busy} onClick={() => void run(pending)}>
          {partial ? t("Turn on") : t("Retry")}
        </button>
      ) : (
        <button onClick={reload}>{t("Refresh")}</button>
      )}
    </StatePanel>
  );
}
function request(
  role: RoleAdministrationItemView,
  operation: RoleAdministrationOperation,
  draft: RoleCommandRequest["draft"] = null,
  version = role.version,
): RoleCommandRequest {
  return {
    operation,
    roleReference: role.roleReference,
    expectedVersion: version,
    operationReference: newOperationReference(),
    reasonCode: reasonCodes[operation],
    draft,
    ...(operation === "ApproveAlone" ? { confirmed: true as const } : {}),
  };
}
/**
 * WP-2423 role presets: BOP changed the preset after this Store made it its own. The Store's
 * version is never written over: here it adds or removes what changed (an ordinary change through
 * approval) or keeps its version as it is (recorded, not offered again for this preset update).
 */
function PresetUpdateOffer({
  role,
  catalog,
  client,
  csrf,
  reload,
  openAfterChange,
}: {
  readonly role: RoleAdministrationItemView;
  readonly catalog: readonly RoleCatalogEntryView[];
  readonly client: RoleAdministrationPageClient;
  readonly csrf: string;
  readonly reload: () => void;
  /** From the Roles list: open the role to check the draft and send it. */
  readonly openAfterChange: boolean;
}) {
  const state = useRun(client, reload);
  const [declining, setDeclining] = useState(false),
    [declineError, setDeclineError] = useState<RoleAdministrationPageErrorCode | null>(null);
  const offer = role.presetUpdate;
  if (offer === null || !role.operations.includes("Revise")) return null;
  const draftWith = (actions: readonly string[]) =>
    request(role, "Revise", {
      displayName: role.name,
      description: role.description,
      actions: [...actions].sort(),
    });
  const keep = async (kind: "Add" | "Remove", actions: readonly string[]) => {
    if (!client.declineOffer) return;
    setDeclining(true);
    setDeclineError(null);
    try {
      await client.declineOffer({
        roleReference: role.roleReference,
        expectedVersion: role.version,
        operationReference: newOperationReference(),
        kind,
        actions,
      });
      reload();
    } catch (failure) {
      setDeclineError(
        failure instanceof RoleAdministrationPageError ? failure.code : "Unavailable",
      );
    } finally {
      setDeclining(false);
    }
  };
  const busy = state.busy || declining;
  return (
    <div className="role-preset-update" role="note">
      <p>
        <strong>{t("BOP updated the preset this role is based on")}</strong>
      </p>
      {offer.added.length > 0 ? (
        <>
          <p>
            {t("The BOP preset now also includes: {list}. Add it to your version?", {
              list: listOf(catalog, offer.added),
            })}
          </p>
          <div role="group" aria-label={t("What the preset added")}>
            <button
              data-variant="primary"
              disabled={busy}
              onClick={() =>
                void state.run(
                  [draftWith([...new Set([...role.permissions, ...offer.added])])],
                  openAfterChange,
                )
              }
            >
              {t("Add to my version")}
            </button>{" "}
            <button disabled={busy} onClick={() => void keep("Add", offer.added)}>
              {t("Keep mine without it")}
            </button>
          </div>
        </>
      ) : null}
      {offer.removed.length > 0 ? (
        <>
          <p>
            {t("No longer in the BOP preset: {list}. Remove it from your version?", {
              list: listOf(catalog, offer.removed),
            })}
          </p>
          <div role="group" aria-label={t("What the preset no longer has")}>
            <button
              disabled={busy}
              onClick={() =>
                void state.run(
                  [draftWith(role.permissions.filter((action) => !offer.removed.includes(action)))],
                  openAfterChange,
                )
              }
            >
              {t("Remove from my version")}
            </button>{" "}
            <button disabled={busy} onClick={() => void keep("Remove", offer.removed)}>
              {t("Keep mine with it")}
            </button>
          </div>
        </>
      ) : null}
      <p>
        {t(
          "Adding or removing goes through approval like any change. Until it is on, staff keep what they have now.",
        )}
      </p>
      {declineError !== null ? (
        <p role="alert">
          {copy[declineError]} <button onClick={reload}>{t("Refresh")}</button>
        </p>
      ) : null}
      <Failure csrf={csrf} state={state} reload={reload} />
    </div>
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
  const state = useRun(client, reload);
  const { run, busy } = state;
  const { catalog } = view;
  const change = role.change;
  const draftSource = change ?? null;
  const [editing, setEditing] = useState<"Revise" | "SaveDraft" | null>(null);
  const [copying, setCopying] = useState(false);
  const [name, setName] = useState(draftSource?.name ?? role.name),
    [description, setDescription] = useState(draftSource?.description ?? role.description),
    [selected, setSelected] = useState<ReadonlySet<string>>(
      new Set(draftSource?.permissions ?? role.permissions),
    ),
    [copyName, setCopyName] = useState("");
  const may = (operation: RoleAdministrationOperation) => role.operations.includes(operation);
  const draft = () => ({
    displayName: name.trim(),
    description: description.trim() || name.trim(),
    actions: [...selected].sort(),
  });
  const removeBlocked = role.state === "InUse" && !role.locked && !may("Deactivate");
  return (
    <div className="detail-section-grid">
      {change ? (
        <StatePanel heading={roleChangeStatusLabels[change.status]}>
          {change.rebased ? (
            <p role="note">
              {t(
                "BOP updated this preset while your change was waiting. Check it and send it again.",
              )}
            </p>
          ) : null}
          {change.droppedByBop > 0 ? (
            <p role="note">
              {t(
                "Permissions BOP no longer offers were left out of this draft ({count}). Nothing else of your change was altered.",
                { count: change.droppedByBop },
              )}
            </p>
          ) : null}
          {change.restore ? (
            <p>
              {t(
                "{name} goes back to the BOP preset: removes {removed}, adds {added}. BOP updates will apply to it again.",
                {
                  name: systemText(role.name),
                  removed: change.removed.length,
                  added: change.added.length,
                },
              )}
            </p>
          ) : null}
          <p>
            {change.status === "Draft"
              ? change.by === "You"
                ? t("Written by you")
                : t("Written by {by}", { by: change.by })
              : change.by === "You"
                ? t("Sent by you")
                : t("Sent by {by}", { by: change.by })}{" "}
            · <StaffTime instant={change.at} />
          </p>
          {change.name !== role.name ? (
            <p>{t("New name: {name}", { name: systemText(change.name) })}</p>
          ) : null}
          {change.added.length > 0 ? (
            <p>{t("Adds: {list}", { list: listOf(catalog, change.added) })}</p>
          ) : null}
          {change.removed.length > 0 ? (
            <p>{t("Takes away: {list}", { list: listOf(catalog, change.removed) })}</p>
          ) : null}
          {change.added.length === 0 && change.removed.length === 0 && change.name === role.name ? (
            <p>{t("No permission changes.")}</p>
          ) : null}
          {role.memberCount > 0 ? (
            <p>
              {t(
                "Applies to the {count} staff who hold {name} once approved and turned on. Until then they keep what they have now.",
                { count: role.memberCount, name: systemText(role.name) },
              )}
            </p>
          ) : null}
          {change.status === "InReview" && change.approval?.mine === true ? (
            may("ApproveAlone") ? (
              <SoleOperatorSelfApproval
                gate={change.approval.soleOperator}
                csrf={csrf}
                summary={
                  <RoleSummary catalog={catalog} selected={change.permissions} memberCount={0} />
                }
                what={t("this role change")}
                permissionName={t("role approval")}
                actionLabel={t("Approve on my own and turn on")}
                busy={busy}
                // Two commands: a failed second step says "Approved, not on yet" with Turn on.
                onApprove={() =>
                  void run([
                    request(role, "ApproveAlone"),
                    request(role, "Activate", null, role.version + 1),
                  ])
                }
              />
            ) : (
              <p>{t("Someone else who approves roles must approve this change.")}</p>
            )
          ) : null}
          {change.status === "InReview" &&
          change.approval?.mine === false &&
          change.approval.needsHolderOf.length > 0 ? (
            <p role="note">
              {t(
                "This change adds {list}, which you don't hold yourself, so someone who holds them must approve it.",
                { list: listOf(catalog, change.approval.needsHolderOf) },
              )}
            </p>
          ) : null}
          {change.status === "InReview" && change.approval?.mine === false ? (
            <RoleSummary catalog={catalog} selected={change.permissions} memberCount={0} />
          ) : null}
          {change.approvedAlone ? <p>{t("Approved by the owner alone (sole operator).")}</p> : null}
          <div role="group" aria-label={t("Change actions")}>
            {may("SaveDraft") ? (
              <button disabled={busy} onClick={() => setEditing("SaveDraft")}>
                {t("Edit change")}
              </button>
            ) : null}
            {may("Submit") ? (
              <button
                data-variant="primary"
                disabled={busy}
                onClick={() => void run([request(role, "Submit")])}
              >
                {t("Send for approval")}
              </button>
            ) : null}
            {may("Approve") ? (
              <button
                data-variant="primary"
                disabled={busy || (change.approval?.needsHolderOf.length ?? 0) > 0}
                onClick={() => void run([request(role, "Approve")])}
              >
                {t("Approve")}
              </button>
            ) : null}
            {may("Reject") ? (
              <button disabled={busy} onClick={() => void run([request(role, "Reject")])}>
                {t("Reject")}
              </button>
            ) : null}
            {may("Activate") && change.status === "Approved" ? (
              <button
                data-variant="primary"
                disabled={busy}
                onClick={() => void run([request(role, "Activate")])}
              >
                {t("Turn on")}
              </button>
            ) : null}
            {may("Withdraw") ? (
              <button disabled={busy} onClick={() => void run([request(role, "Withdraw")])}>
                {t("Withdraw change")}
              </button>
            ) : null}
          </div>
        </StatePanel>
      ) : null}
      {!editing && change === null && role.presetUpdate !== null ? (
        <PresetUpdateOffer
          role={role}
          catalog={catalog}
          client={client}
          csrf={csrf}
          reload={reload}
          openAfterChange={false}
        />
      ) : null}
      {editing ? (
        <StatePanel heading={role.kind === "Custom" ? t("Edit role") : t("Edit this preset")}>
          <label>
            {t("Role name")}
            <input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            {t("Description")}
            <input
              value={description}
              maxLength={180}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <PermissionPicker catalog={catalog} selected={selected} onChange={setSelected} />
          <RoleSummary catalog={catalog} selected={[...selected]} memberCount={role.memberCount} />
          <button
            data-variant="primary"
            disabled={busy || !name.trim()}
            onClick={() => void run([request(role, editing, draft())])}
          >
            {t("Save change")}
          </button>{" "}
          <button disabled={busy} onClick={() => setEditing(null)}>
            {t("Cancel")}
          </button>
        </StatePanel>
      ) : (
        <StatePanel heading={t("What staff with this role can do now")}>
          {role.state === "NotOn" ? (
            <p>
              {t(
                "Not turned on yet: nobody can be given this role until it is approved and turned on.",
              )}
            </p>
          ) : role.permissions.length === 0 ? (
            <p>{t("Nothing yet.")}</p>
          ) : (
            <PermissionList catalog={catalog} actions={role.permissions} />
          )}
          {role.locked ? (
            <p>{t("The owner role always holds everything, so it cannot be edited or removed.")}</p>
          ) : null}
          {role.retiredByBop > 0 ? (
            <p role="note">
              {t(
                "Permissions BOP no longer offers were taken off your version ({count}). Staff with this role no longer hold them; everything else you chose stays.",
                { count: role.retiredByBop },
              )}
            </p>
          ) : null}
          <div role="group" aria-label={t("Role actions")}>
            {may("Revise") ? (
              <button disabled={busy} onClick={() => setEditing("Revise")}>
                {role.kind === "Custom" ? t("Edit") : t("Edit this preset")}
              </button>
            ) : null}
            {may("RestoreDefault") ? (
              <button disabled={busy} onClick={() => void run([request(role, "RestoreDefault")])}>
                {t("Restore default")}
              </button>
            ) : null}
            {may("Deactivate") ? (
              <button disabled={busy} onClick={() => void run([request(role, "Deactivate")])}>
                {t("Remove role")}
              </button>
            ) : null}
            {may("Activate") && role.state === "Removed" && change === null ? (
              <button disabled={busy} onClick={() => void run([request(role, "Activate")])}>
                {t("Bring back")}
              </button>
            ) : null}
            {may("Duplicate") && !copying ? (
              <button disabled={busy} onClick={() => setCopying(true)}>
                {t("Make a copy")}
              </button>
            ) : null}
          </div>
          {removeBlocked && role.memberCount > 0 ? (
            <p>
              {t("{count} staff hold this role. Give them another role first.", {
                count: role.memberCount,
              })}
            </p>
          ) : removeBlocked && role.waitingAssignments > 0 ? (
            <p>
              {t(
                "A staff role request waiting for approval would give this role. Decide it first.",
              )}
            </p>
          ) : null}
          {copying ? (
            <div className="role-copy">
              <label>
                {t("Name of the copy")}
                <input
                  value={copyName}
                  maxLength={80}
                  onChange={(event) => setCopyName(event.currentTarget.value)}
                />
              </label>{" "}
              <button
                data-variant="primary"
                disabled={busy || !copyName.trim()}
                onClick={() =>
                  void run(
                    [
                      request(role, "Duplicate", {
                        displayName: copyName.trim(),
                        description: t("Based on {name}", { name: systemText(role.name) }),
                        actions: [...role.permissions],
                      }),
                    ],
                    true,
                  )
                }
              >
                {t("Make the copy")}
              </button>{" "}
              <button disabled={busy} onClick={() => setCopying(false)}>
                {t("Cancel")}
              </button>
            </div>
          ) : null}
        </StatePanel>
      )}
      <StatePanel heading={t("History")}>
        {role.history.length === 0 ? (
          <p>{t("No decisions yet.")}</p>
        ) : (
          <ul className="role-history">
            {role.history.map((item, index) => (
              <li key={index}>
                {roleDecisionLabels[item.decision] ?? t("Changed")} ·{" "}
                {item.by === "BOP" ? t("BOP update") : item.by === "You" ? t("you") : item.by} ·{" "}
                <StaffTime instant={item.at} />
              </li>
            ))}
          </ul>
        )}
        {role.state === "Removed" ? <p>{t("Removed roles keep their history.")}</p> : null}
        <Failure csrf={csrf} state={state} reload={reload} />
      </StatePanel>
    </div>
  );
}
function NewRole({
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
  const state = useRun(client, reload);
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [from, setFrom] = useState("");
  const source = view.roles.find((role) => role.roleReference === from);
  if (!open)
    return (
      <button data-variant="primary" onClick={() => setOpen(true)}>
        {t("New role")}
      </button>
    );
  return (
    <div className="role-new">
      <label>
        {t("Role name")}
        <input
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label>
        {t("Start from")}
        <select value={from} onChange={(event) => setFrom(event.currentTarget.value)}>
          <option value="">{t("Start from blank")}</option>
          {view.roles
            .filter((role) => role.operations.includes("Duplicate"))
            .map((role) => (
              <option key={role.roleReference} value={role.roleReference}>
                {t("A copy of {name}", { name: systemText(role.name) })}
              </option>
            ))}
        </select>
      </label>
      <button
        data-variant="primary"
        disabled={state.busy || !name.trim()}
        onClick={() =>
          void state.run(
            [
              source === undefined
                ? {
                    operation: "Create",
                    roleReference: null,
                    expectedVersion: null,
                    operationReference: newOperationReference(),
                    reasonCode: reasonCodes.Create,
                    draft: {
                      displayName: name.trim(),
                      description: name.trim(),
                      actions: ["merchant.access"],
                    },
                  }
                : request(source, "Duplicate", {
                    displayName: name.trim(),
                    description: t("Based on {name}", { name: systemText(source.name) }),
                    actions: [...source.permissions],
                  }),
            ],
            true,
          )
        }
      >
        {t("Create and choose what it can do")}
      </button>{" "}
      <button disabled={state.busy} onClick={() => setOpen(false)}>
        {t("Cancel")}
      </button>
      <Failure csrf={csrf} state={state} reload={reload} />
    </div>
  );
}
function RoleRow({
  role,
  catalog,
  client,
  csrf,
  reload,
}: {
  readonly role: RoleAdministrationItemView;
  readonly catalog: readonly RoleCatalogEntryView[];
  readonly client: RoleAdministrationPageClient;
  readonly csrf: string;
  readonly reload: () => void;
}) {
  return (
    <li className="role-row">
      <div>
        <strong>{systemText(role.name)}</strong>{" "}
        <span className="role-kind">{roleKindLabels[role.kind]}</span>
        {role.scope === "Brand" ? <span> · {roleScopeLabels.Brand}</span> : null}
      </div>
      <div>
        {role.state === "NotOn"
          ? t("Not turned on yet")
          : t("{count} staff", { count: role.memberCount })}
        {role.change ? <span> · {roleChangeStatusLabels[role.change.status]}</span> : null}
      </div>
      <Link to={`/app/organization/roles/${role.roleReference}`}>{t("Open")}</Link>
      {role.change === null && role.presetUpdate !== null ? (
        <PresetUpdateOffer
          role={role}
          catalog={catalog}
          client={client}
          csrf={csrf}
          reload={reload}
          openAfterChange
        />
      ) : null}
    </li>
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
  const [query, setQuery] = useState("");
  const editor = view.screenId === "IAM-ROLE-EDITOR";
  const roles = useMemo(
    () =>
      view.roles.filter((role) =>
        `${systemText(role.name)} ${role.name}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [query, view.roles],
  );
  const role = editor ? view.roles[0] : undefined;
  return (
    <AppFrame
      title={editor ? systemText(role?.name ?? "") || t("Role") : t("Roles")}
      description={[
        editor ? t("What this role can do, and changes to it") : t("Who can do what at this store"),
        view.freshness === "Stale" ? t("may be out of date") : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Roles")}</p>
          <h2>{editor && role ? systemText(role.name) : t("Roles and what they can do")}</h2>
          {editor && role ? (
            <p>
              {roleKindLabels[role.kind]} ·{" "}
              {role.state === "Removed"
                ? t("Removed")
                : t("{count} staff hold this role", { count: role.memberCount })}
            </p>
          ) : (
            <p>
              {t("Checked")} <SourceTime instant={view.sourceAsOf} />
            </p>
          )}
        </div>
        {!editor && view.mayManage ? (
          <NewRole view={view} client={client} csrf={csrf} reload={reload} />
        ) : null}
      </header>
      {editor && role ? (
        <>
          <Link to="/app/organization/roles">{t("Back to roles")}</Link>
          <Editor
            key={`${role.roleReference}:${role.version}`}
            view={view}
            role={role}
            client={client}
            csrf={csrf}
            reload={reload}
          />
        </>
      ) : (
        <>
          {view.mayManage ? (
            <StarterRoleSetOffer client={client} csrf={csrf} place="Roles" onChanged={reload} />
          ) : null}
          <div className="list-filters" role="search">
            <label>
              {t("Find a role")}
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          </div>
          <section aria-labelledby="roles-in-use">
            <h3 id="roles-in-use">{t("Roles in use")}</h3>
            {roles.filter((item) => item.state !== "Removed").length === 0 ? (
              <p>{t("No matching roles.")}</p>
            ) : (
              <ul className="role-list">
                {roles
                  .filter((item) => item.state !== "Removed")
                  .map((item) => (
                    <RoleRow
                      key={item.roleReference}
                      role={item}
                      catalog={view.catalog}
                      client={client}
                      csrf={csrf}
                      reload={reload}
                    />
                  ))}
              </ul>
            )}
          </section>
          {roles.some((item) => item.state === "Removed") ? (
            <section aria-labelledby="roles-removed">
              <h3 id="roles-removed">{t("Removed roles")}</h3>
              <p>{t("Nobody holds these. Open one to bring it back.")}</p>
              <ul className="role-list">
                {roles
                  .filter((item) => item.state === "Removed")
                  .map((item) => (
                    <RoleRow
                      key={item.roleReference}
                      role={item}
                      catalog={view.catalog}
                      client={client}
                      csrf={csrf}
                      reload={reload}
                    />
                  ))}
              </ul>
            </section>
          ) : null}
        </>
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
    setState(readingAgain);
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
    <Status state={state.kind} onRetry={reload} />
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
