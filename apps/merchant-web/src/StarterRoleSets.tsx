import { listSeparator, systemText, t } from "./i18n/i18n.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { newOperationReference } from "./operation-reference.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { needsFullSignIn } from "./full-sign-in.js";
import { serverProblemText } from "./failure-words.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
import {
  RoleAdministrationPageError,
  createRoleAdministrationPageClient,
  parseRoleAdministrationPageView,
  starterStoreTypeLabel,
  starterStoreTypes,
  type RoleAdministrationItemView,
  type RoleAdministrationPageClient,
  type RoleAdministrationPageErrorCode,
  type RoleAdministrationPageView,
  type RoleCommandRequest,
  type StarterRoleSetView,
  type StarterRoleSetsView,
  type StarterStoreType,
} from "./role-administration-pages.js";

/**
 * WP-2423 store-type starter roles (DEC-STORE-TYPE-STARTER-ROLES): at Store setup and on Roles the
 * owner picks what kind of shop this is and starts from the roles that kind of shop has. The new
 * roles are the Store's own and go through approval like any new role (a sole owner approves them
 * here, alone); the owner changes, adds or removes any of them afterwards on Roles.
 */
type Read =
  | { readonly kind: "Loading" }
  | { readonly kind: "Failed"; readonly code: RoleAdministrationPageErrorCode }
  | {
      readonly kind: "Found";
      readonly sets: StarterRoleSetsView;
      readonly roles: RoleAdministrationPageView;
    };
const names = (items: readonly { readonly name: string }[]) =>
  items.map((item) => systemText(item.name)).join(listSeparator());
const failureText = (code: RoleAdministrationPageErrorCode) =>
  code === "Offline"
    ? t("Offline. Nothing was confirmed; Try again sends the same request again.")
    : code === "Conflict" || code === "NameTaken"
      ? t("Your roles changed meanwhile. Check the list again, then choose.")
      : code === "NeedsReverification"
        ? t("Confirm it's you again (valid 15 minutes), then approve.")
        : code === "SoleOperatorNotInEffect"
          ? t(
              "You cannot approve these on your own now: someone else also approves roles, or Sole operator is off.",
            )
          : code === "PermissionDenied"
            ? t("Your access doesn't allow changing roles. Ask the owner.")
            : serverProblemText;

/** A starter role this set adds, or sends for approval again. */
const sendsForApproval = (role: { readonly state: string }) =>
  role.state === "ToAdd" || role.state === "NotApproved";

/** Starter roles waiting on the signed-in person: their own to approve alone, or to turn on. */
export function waitingStarterRoles(
  sets: StarterRoleSetsView,
  roles: RoleAdministrationPageView,
): {
  readonly mine: readonly RoleAdministrationItemView[];
  readonly approveAlone: boolean;
  readonly turnOn: readonly RoleAdministrationItemView[];
} {
  const starter = new Set(
    sets.sets.flatMap((set) => set.roles.flatMap((role) => role.roleReference ?? [])),
  );
  const ours = roles.roles.filter((role) => starter.has(role.roleReference));
  const mine = ours.filter(
    (role) => role.change?.status === "InReview" && role.change.approval?.mine === true,
  );
  return {
    mine,
    approveAlone: mine.length > 0 && mine.every((role) => role.operations.includes("ApproveAlone")),
    turnOn: ours.filter(
      (role) => role.change?.status === "Approved" && role.operations.includes("Activate"),
    ),
  };
}
/**
 * Where the Store's starter roles stand for Store setup's "Who does what": the step is done only
 * when no starter role is still off (v15 2026-11-11: it said "set up" while every starter role
 * waited for approval or had been withdrawn). Removed ones were the owner's choice, unless every
 * one was removed: then no role for this kind of shop is in use, and the step is not done (v15
 * 2026-11-11 b10: it still said "set up").
 */
export function starterRolesProgress(
  sets: StarterRoleSetsView,
  roles: RoleAdministrationPageView,
): {
  readonly done: boolean;
  /** Sent and waiting for approval, or approved and not turned on. */
  readonly waiting: readonly RoleAdministrationItemView[];
  /** Not approved, withdrawn, or never sent: nobody can be given them until they are sent again. */
  readonly notSent: readonly RoleAdministrationItemView[];
  /** Every starter role here was removed (none in use, none waiting): listed by name. */
  readonly allRemoved: readonly RoleAdministrationItemView[];
} {
  const starter = new Set(
    sets.sets.flatMap((set) => set.roles.flatMap((role) => role.roleReference ?? [])),
  );
  const ours = roles.roles.filter((role) => starter.has(role.roleReference));
  const off = ours.filter((role) => role.state === "NotOn");
  const waiting = off.filter(
    (role) => role.change?.status === "InReview" || role.change?.status === "Approved",
  );
  const notSent = off.filter((role) => !waiting.includes(role));
  const allRemoved = ours.length > 0 && ours.every((role) => role.state === "Removed") ? ours : [];
  return {
    done: off.length === 0 && allRemoved.length === 0,
    waiting,
    notSent,
    allRemoved,
  };
}
/**
 * After a failed approve or turn-on run: only a lost answer keeps the rest to send again as they
 * were (Try again). Any other failure means the versions this offer holds may be out of date, so
 * the roles are read again and the next press builds its steps from the fresh versions.
 */
export function afterApprovalFailure(
  code: RoleAdministrationPageErrorCode,
  rest: readonly RoleCommandRequest[],
  done: number,
): { readonly pending: readonly RoleCommandRequest[] | null; readonly reread: boolean } {
  return code === "Offline" ? { pending: rest, reread: done > 0 } : { pending: null, reread: true };
}
function command(
  role: RoleAdministrationItemView,
  operation: "ApproveAlone" | "Activate",
  version: number,
): RoleCommandRequest {
  return {
    operation,
    roleReference: role.roleReference,
    expectedVersion: version,
    operationReference: newOperationReference(),
    reasonCode: operation === "ApproveAlone" ? "ROLE_APPROVED" : "ROLE_ACTIVATED",
    draft: null,
    ...(operation === "ApproveAlone" ? { confirmed: true as const } : {}),
  };
}

function SetPreview({
  set,
  mayPutAway,
  putAway,
  onPutAway,
}: {
  readonly set: StarterRoleSetView;
  readonly mayPutAway: boolean;
  readonly putAway: boolean;
  onPutAway(value: boolean): void;
}) {
  const adding = set.roles.filter(sendsForApproval);
  const removable = set.putAway.filter((role) => !role.held);
  return (
    <div className="starter-roles__preview">
      {adding.length > 0 ? (
        <>
          <p>{t("Adds these roles:")}</p>
          <ul className="role-list">
            {adding.map((role) => (
              <li key={role.key} className="starter-roles__role">
                <strong>{systemText(role.name)}</strong>
                <span>{systemText(role.description)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>{t("Every role in this set is already here.")}</p>
      )}
      {set.roles
        .filter((role) => role.state !== "ToAdd")
        .map((role) => (
          <p key={role.key}>
            {role.state === "NotApproved"
              ? t(
                  "{name} wasn't approved, or was withdrawn, so nobody can be given it yet. These roles send it for approval again.",
                  { name: systemText(role.name) },
                )
              : role.state === "Added"
                ? t("{name} is already here.", { name: systemText(role.name) })
                : role.state === "Removed"
                  ? t("{name} was removed here, so it isn't added again. Bring it back on Roles.", {
                      name: systemText(role.name),
                    })
                  : t("You already have a role called {name}, so it isn't added.", {
                      name: systemText(role.name),
                    })}
          </p>
        ))}
      {set.keep.length > 0 ? <p>{t("Keeps: {list}.", { list: names(set.keep) })}</p> : null}
      {mayPutAway && removable.length > 0 ? (
        <label className="starter-roles__put-away">
          <input
            type="checkbox"
            checked={putAway}
            onChange={(event) => onPutAway(event.currentTarget.checked)}
          />{" "}
          {t(
            "Also remove the roles this kind of shop doesn't use: {list}. Nobody holds them, and you can bring any back.",
            { list: names(removable) },
          )}
        </label>
      ) : null}
      {set.putAway
        .filter((role) => role.held)
        .map((role) => (
          <p key={role.roleReference}>
            {role.memberCount > 0
              ? t("{name} stays: {count} staff hold it.", {
                  name: systemText(role.name),
                  count: role.memberCount,
                })
              : t("{name} stays: a change or staff request for it is waiting.", {
                  name: systemText(role.name),
                })}
          </p>
        ))}
    </div>
  );
}

export function StarterRoleSetOffer({
  client,
  csrf,
  place,
  onChanged,
  initial,
}: {
  readonly client: RoleAdministrationPageClient;
  readonly csrf: string;
  /** Roles keeps the offer under a fold once roles were started; Store setup then just links. */
  readonly place: "Roles" | "StoreSetup";
  /** The page's own role list to read again after a change. */
  readonly onChanged?: () => void;
  /** Test seam: what the reads returned, and the kind of shop already chosen. */
  readonly initial?: {
    readonly sets: StarterRoleSetsView;
    readonly roles: RoleAdministrationPageView;
    readonly storeType?: StarterStoreType;
  };
}) {
  const [read, setRead] = useState<Read>(
    initial === undefined
      ? { kind: "Loading" }
      : { kind: "Found", sets: initial.sets, roles: initial.roles },
  );
  const [generation, setGeneration] = useState(0);
  const [storeType, setStoreType] = useState<StarterStoreType | null>(initial?.storeType ?? null);
  // v15 2026-11-11 b10: removing the presets this kind of shop doesn't use is the owner's own
  // choice, never the default (an owner sending roles again lost three presets in use).
  const [putAway, setPutAway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RoleAdministrationPageErrorCode | null>(null);
  const [notice, setNotice] = useState("");
  // One reference per choice, kept until it is confirmed, so Try again never applies twice.
  const [reference, setReference] = useState<string | null>(null);
  const [pending, setPending] = useState<readonly RoleCommandRequest[] | null>(null);
  const reload = useCallback(() => {
    setGeneration((value) => value + 1);
    onChanged?.();
  }, [onChanged]);
  useEffect(() => {
    if (!client.starterSets) return;
    let active = true;
    const load = client.starterSets;
    void Promise.all([load(), client.loadRoles()])
      .then(([sets, roles]) => {
        if (active)
          setRead({
            kind: "Found",
            sets,
            roles: parseRoleAdministrationPageView(roles, "IAM-ROLE-LIST"),
          });
      })
      .catch((error: unknown) => {
        if (active)
          setRead({
            kind: "Failed",
            code: error instanceof RoleAdministrationPageError ? error.code : "Unavailable",
          });
      });
    return () => {
      active = false;
    };
  }, [client, generation]);
  const waiting = useMemo(
    () => (read.kind === "Found" ? waitingStarterRoles(read.sets, read.roles) : null),
    [read],
  );
  if (!client.starterSets && initial === undefined) return null;
  if (read.kind === "Loading")
    return place === "StoreSetup" ? <p role="status">{t("Loading roles…")}</p> : null;
  if (read.kind === "Failed") {
    // No access to roles: nothing to offer. Anything else is an outage, said as one.
    if (read.code === "PermissionDenied" || read.code === "FeatureDisabled") return null;
    return (
      <section className="starter-roles" aria-labelledby="starter-roles-heading">
        <h3 id="starter-roles-heading">{t("Roles for your kind of shop")}</h3>
        <p role="status">
          {read.code === "Offline"
            ? t("Offline. The roles for your kind of shop show again when you're back online.")
            : t("The roles for your kind of shop didn't load. Nothing was changed.")}
        </p>
        <button onClick={() => setGeneration((value) => value + 1)}>{t("Try again")}</button>
      </section>
    );
  }
  const { sets } = read;
  if (!sets.mayApply) return null;
  const chosen = sets.sets.find((set) => set.storeType === storeType) ?? null;
  const willAdd = chosen?.roles.filter(sendsForApproval).length ?? 0;
  const willRemove =
    chosen !== null && sets.mayPutAway && putAway
      ? chosen.putAway.filter((role) => !role.held).length
      : 0;
  const apply = async () => {
    if (chosen === null || !client.applyStarterSet) return;
    const operationReference = reference ?? newOperationReference();
    setReference(operationReference);
    setBusy(true);
    setFailure(null);
    try {
      await client.applyStarterSet({
        storeType: chosen.storeType,
        operationReference,
        putAway: sets.mayPutAway && putAway,
      });
      setReference(null);
      setStoreType(null);
      setNotice(
        willAdd === 0
          ? t("Done. The roles this kind of shop doesn't use were removed.")
          : willAdd === 1
            ? t("Added 1 role. It is on once it is approved.")
            : t("Added {count} roles. Each is on once it is approved.", { count: willAdd }),
      );
      reload();
    } catch (error) {
      const code = error instanceof RoleAdministrationPageError ? error.code : "Unavailable";
      // Only a lost answer is retried under the same reference; anything else starts afresh.
      if (code !== "Offline") setReference(null);
      setFailure(code);
      if (code === "Conflict" || code === "NameTaken") setGeneration((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };
  const runAll = async (requests: readonly RoleCommandRequest[]) => {
    if (!client.command) return;
    setBusy(true);
    setFailure(null);
    let done = 0;
    try {
      for (const request of requests) {
        await client.command(request);
        done += 1;
      }
      setPending(null);
      setNotice(
        requests.filter((request) => request.operation === "Activate").length > 1
          ? t("Your new roles are on. Give them to staff on Staff.")
          : t("Your new role is on. Give it to staff on Staff."),
      );
      reload();
    } catch (error) {
      const code = error instanceof RoleAdministrationPageError ? error.code : "Unavailable";
      const after = afterApprovalFailure(code, requests.slice(done), done);
      setPending(after.pending);
      setFailure(code);
      if (after.reread) reload();
    } finally {
      setBusy(false);
    }
  };
  const failureLine =
    failure === null ? null : needsFullSignIn(failure) ? (
      <div role="status">
        <FullSignInPrompt csrf={csrf} />
      </div>
    ) : (
      <p role="alert" className="starter-roles__failure">
        {failureText(failure)}{" "}
        {failure === "Offline" && pending === null && chosen !== null ? (
          <button disabled={busy} onClick={() => void apply()}>
            {t("Try again")}
          </button>
        ) : pending !== null && failure === "Offline" ? (
          <button disabled={busy} onClick={() => void runAll(pending)}>
            {t("Try again")}
          </button>
        ) : null}
      </p>
    );
  const several = (waiting?.mine.length ?? 0) > 1;
  const progress = read.kind === "Found" ? starterRolesProgress(read.sets, read.roles) : null;
  const offCount =
    progress === null
      ? 0
      : progress.waiting.length + progress.notSent.length + progress.allRemoved.length;
  // Roles the approval block above already names, so they are not listed twice.
  const shownAbove = new Set(
    [...(waiting?.mine ?? []), ...(waiting?.turnOn ?? [])].map((role) => role.roleReference),
  );
  const approval =
    waiting === null || (waiting.mine.length === 0 && waiting.turnOn.length === 0) ? null : (
      <div className="starter-roles__approval">
        {waiting.mine.length > 0 ? (
          <>
            <p>
              {t("Waiting for approval: {list}.", { list: names(waiting.mine) })}{" "}
              {several
                ? t("Staff can be given them once they are approved and turned on.")
                : t("Staff can be given it once it is approved and turned on.")}
            </p>
            {waiting.approveAlone ? (
              <SoleOperatorSelfApproval
                gate={waiting.mine[0]?.change?.approval?.soleOperator ?? null}
                csrf={csrf}
                summary={
                  <p>
                    {several
                      ? t("New roles: {list}.", { list: names(waiting.mine) })
                      : t("New role: {name}.", { name: names(waiting.mine) })}
                  </p>
                }
                what={several ? t("these new roles") : t("this new role")}
                permissionName={t("role approval")}
                actionLabel={
                  several
                    ? t("Approve them on my own and turn them on")
                    : t("Approve it on my own and turn it on")
                }
                busy={busy}
                yourPart={several ? t("You sent these roles") : t("You sent this role")}
                several={several}
                onApprove={() =>
                  void runAll(
                    waiting.mine.flatMap((role) => [
                      command(role, "ApproveAlone", role.version),
                      command(role, "Activate", role.version + 1),
                    ]),
                  )
                }
              />
            ) : (
              <p>
                {several
                  ? t("Someone else who approves roles must approve them.")
                  : t("Someone else who approves roles must approve it.")}
              </p>
            )}
          </>
        ) : null}
        {waiting.turnOn.length > 0 ? (
          <p>
            {t("Approved, not on yet: {list}.", { list: names(waiting.turnOn) })}{" "}
            <button
              disabled={busy}
              onClick={() =>
                void runAll(waiting.turnOn.map((role) => command(role, "Activate", role.version)))
              }
            >
              {waiting.turnOn.length > 1 ? t("Turn them on") : t("Turn it on")}
            </button>
          </p>
        ) : null}
      </div>
    );
  const offer = (
    <>
      <p>
        {t(
          "Choose what kind of shop this is. You start with the roles that kind of shop usually has, and you can change, add or remove any of them afterwards.",
        )}
      </p>
      <fieldset className="starter-roles__kinds">
        <legend>{t("What kind of shop is this?")}</legend>
        {starterStoreTypes.map((type) => (
          <label key={type}>
            <input
              type="radio"
              name="starter-store-type"
              value={type}
              checked={storeType === type}
              onChange={() => {
                setStoreType(type);
                setReference(null);
                setFailure(null);
                setNotice("");
              }}
            />{" "}
            {starterStoreTypeLabel(type)}
          </label>
        ))}
      </fieldset>
      {chosen !== null ? (
        <>
          <SetPreview
            set={chosen}
            mayPutAway={sets.mayPutAway}
            putAway={putAway}
            onPutAway={setPutAway}
          />
          <p>
            <button
              data-variant="primary"
              disabled={busy || willAdd + willRemove === 0}
              onClick={() => void apply()}
            >
              {t("Use these roles")}
            </button>
          </p>
        </>
      ) : null}
    </>
  );
  return (
    <section className="starter-roles" aria-labelledby="starter-roles-heading">
      {place === "StoreSetup" ? (
        <h3 id="starter-roles-heading">{t("Who does what")}</h3>
      ) : (
        <h3 id="starter-roles-heading" className="starter-roles__heading">
          {t("Roles for your kind of shop")}
        </h3>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {failureLine}
      {approval}
      {!sets.started ? (
        offer
      ) : place === "StoreSetup" ? (
        progress === null || progress.done ? (
          <p>
            {t("Your roles are set up for your kind of shop.")}{" "}
            <Link to="/app/organization/roles">{t("Change them on Roles")}</Link>
          </p>
        ) : (
          <>
            <p role="status">
              {offCount > 1
                ? t("Not done yet: nobody can be given these roles until they are on.")
                : t("Not done yet: nobody can be given this role until it is on.")}
            </p>
            {progress.waiting.some((role) => !shownAbove.has(role.roleReference)) ? (
              <p>
                {t("Waiting for another person who approves roles: {list}.", {
                  list: names(
                    progress.waiting.filter((role) => !shownAbove.has(role.roleReference)),
                  ),
                })}
              </p>
            ) : null}
            {progress.allRemoved.length > 0 ? (
              <>
                <p>
                  {progress.allRemoved.length > 1
                    ? t(
                        "{list} were removed, so no role for your kind of shop is in use. Bring them back on Roles, or start from the roles of another kind of shop.",
                        { list: names(progress.allRemoved) },
                      )
                    : t(
                        "{list} was removed, so no role for your kind of shop is in use. Bring it back on Roles, or start from the roles of another kind of shop.",
                        { list: names(progress.allRemoved) },
                      )}
                </p>
                {offer}
              </>
            ) : null}
            {progress.notSent.length > 0 ? (
              <>
                <p>
                  {progress.notSent.length > 1
                    ? t(
                        "{list} weren't approved, or were withdrawn. Choose your kind of shop again to send them for approval again.",
                        { list: names(progress.notSent) },
                      )
                    : t(
                        "{list} wasn't approved, or was withdrawn. Choose your kind of shop again to send it for approval again.",
                        { list: names(progress.notSent) },
                      )}
                </p>
                {offer}
              </>
            ) : null}
            <p>
              <Link to="/app/organization/roles">
                {offCount > 1 ? t("See them on Roles") : t("See it on Roles")}
              </Link>
            </p>
          </>
        )
      ) : (
        <details className="starter-roles__again">
          <summary>{t("Start from the roles of another kind of shop")}</summary>
          {offer}
        </details>
      )}
    </section>
  );
}

/** Store setup's "Who does what": the same offer, against the selected Store's roles. */
export function StoreStarterRolesPanel({ csrf }: { readonly csrf: string }) {
  const client = useMemo(() => createRoleAdministrationPageClient(csrf), [csrf]);
  return <StarterRoleSetOffer client={client} csrf={csrf} place="StoreSetup" />;
}
