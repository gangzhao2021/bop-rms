import { t } from "./i18n/i18n.js";
import { FULL_SIGN_IN_REQUIRED, isFullSignInRequired } from "./full-sign-in.js";
import { parseSoleOperatorGate, type SoleOperatorGateView } from "./SoleOperatorSelfApproval.js";

export type RoleAdministrationPageErrorCode =
  | "PermissionDenied"
  | typeof FULL_SIGN_IN_REQUIRED
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable"
  // WP-2423 role presets.
  | "InUse"
  | "NameTaken"
  | "SoleOperatorNotInEffect"
  | "NeedsReverification"
  | "WouldWidenOwnAccess"
  | "ApproverLacksAccess"
  | "PresetChanged";
export class RoleAdministrationPageError extends Error {
  constructor(readonly code: RoleAdministrationPageErrorCode) {
    super(t("Role administration is unavailable"));
    this.name = "RoleAdministrationPageError";
  }
}
export const roleAdministrationOperations = [
  "Create",
  "Duplicate",
  "SaveDraft",
  "Revise",
  "RestoreDefault",
  "Submit",
  "Withdraw",
  "Approve",
  "ApproveAlone",
  "Reject",
  "Activate",
  "Deactivate",
] as const;
export type RoleAdministrationOperation = (typeof roleAdministrationOperations)[number];
export interface RoleCatalogEntryView {
  readonly action: string;
  /** The permission's group in staff words. */
  readonly group: string;
  readonly description: string;
  readonly highRisk: boolean;
  /** Shown under the box when ticked; null when the permission needs no warning. */
  readonly warning: string | null;
  /** Order in a "this role can" summary (the Owner's six first); null when not listed there. */
  readonly riskRank: number | null;
}
export interface RoleChangeView {
  readonly status: "Draft" | "InReview" | "Approved";
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** A change that puts the BOP preset back. */
  readonly restore: boolean;
  /** Sent back by a BOP preset update while it was waiting. */
  readonly rebased: boolean;
  /** Permissions BOP no longer offers that were left out of the draft it sent back. */
  readonly droppedByBop: number;
  readonly by: string;
  readonly at: string;
  readonly approvedAlone: boolean;
  readonly approval: {
    readonly mine: boolean;
    readonly soleOperator: SoleOperatorGateView | null;
    /** Flagged permissions the change adds that the viewer does not hold. */
    readonly needsHolderOf: readonly string[];
  } | null;
}
export interface RolePresetUpdateView {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}
/** WP-2423 role presets: "Keep mine without it" for what a BOP preset update offered. */
export interface RolePresetOfferDeclineRequest {
  readonly roleReference: string;
  readonly expectedVersion: number;
  readonly operationReference: string;
  readonly kind: "Add" | "Remove";
  readonly actions: readonly string[];
}
export interface RoleAdministrationItemView {
  readonly roleReference: string;
  readonly name: string;
  readonly description: string;
  readonly scope: "Brand" | "Store";
  readonly version: number;
  readonly kind: "Preset" | "YourVersion" | "Custom";
  readonly locked: boolean;
  readonly state: "InUse" | "Removed" | "NotOn";
  readonly memberCount: number;
  readonly waitingAssignments: number;
  readonly permissions: readonly string[];
  /** Permissions BOP no longer offers that it took off this role's version (staff no longer hold). */
  readonly retiredByBop: number;
  /**
   * What BOP changed in the preset since this Store made it its own: offered to add or remove
   * (through approval), or to keep the Store's version as it is. Null when nothing is offered.
   */
  readonly presetUpdate: RolePresetUpdateView | null;
  readonly change: RoleChangeView | null;
  readonly lastOutcome: "Rejected" | "Withdrawn" | null;
  /** Operations the current viewer may perform now; the server re-authorizes every command. */
  readonly operations: readonly RoleAdministrationOperation[];
  readonly history: readonly {
    readonly decision: string;
    readonly by: string;
    readonly at: string;
  }[];
}
/** WP-2423 role presets: what a role is, in staff words. */
export const roleKindLabels: Readonly<Record<RoleAdministrationItemView["kind"], string>> =
  Object.freeze({
    Preset: t("BOP preset"),
    YourVersion: t("Your version of a BOP preset"),
    Custom: t("Your role"),
  });
export const roleScopeLabels: Readonly<Record<RoleAdministrationItemView["scope"], string>> =
  Object.freeze({ Brand: t("All stores in the brand"), Store: t("This store") });
export const roleChangeStatusLabels: Readonly<Record<RoleChangeView["status"], string>> =
  Object.freeze({
    Draft: t("Change not sent yet"),
    InReview: t("Change waiting for approval"),
    Approved: t("Change approved, not on yet"),
  });
export const roleDecisionLabels: Readonly<Record<string, string>> = Object.freeze({
  Submitted: t("Sent for approval"),
  Approved: t("Approved"),
  Rejected: t("Not approved"),
  Activated: t("Turned on"),
  Deactivated: t("Removed"),
  Withdrawn: t("Withdrawn"),
});
/** A permission as staff read it: the catalog's description, never its code. */
export function rolePermissionLabel(
  action: string,
  catalog: readonly RoleCatalogEntryView[],
): string {
  return catalog.find((entry) => entry.action === action)?.description ?? t("Another permission");
}
export interface RoleAdministrationPageView {
  readonly screenId: "IAM-ROLE-LIST" | "IAM-ROLE-EDITOR";
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly roles: readonly RoleAdministrationItemView[];
  readonly mayManage: boolean;
  readonly catalog: readonly RoleCatalogEntryView[];
}
export interface RoleCommandRequest {
  readonly operation: RoleAdministrationOperation;
  readonly roleReference: string | null;
  readonly expectedVersion: number | null;
  readonly operationReference: string;
  readonly reasonCode: string;
  readonly draft: {
    readonly displayName: string;
    readonly description: string;
    readonly actions: readonly string[];
  } | null;
  readonly confirmed?: true;
}
/** WP-2423 role presets: a role change waiting for the signed-in person (Approvals). */
export interface RoleChangeWaitingView {
  readonly roleReference: string;
  readonly name: string;
  readonly added: number;
  readonly removed: number;
  readonly by: string;
  readonly at: string;
  readonly action: "Approve" | "ApproveAlone" | "TurnOn";
}
export interface RoleAdministrationPageClient {
  loadRoles(): Promise<unknown>;
  loadRole(roleReference: string): Promise<unknown>;
  command?(request: RoleCommandRequest): Promise<{ readonly roleReference: string }>;
  declineOffer?(request: RolePresetOfferDeclineRequest): Promise<void>;
  /** WP-2423 store-type starter roles. */
  starterSets?(): Promise<StarterRoleSetsView>;
  applyStarterSet?(request: StarterRoleSetApplyRequest): Promise<void>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  action =
    /^[a-z][a-z0-9]*(_[a-z0-9]+)*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*(-[a-z0-9]+)*){1,7}$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,300}$/u;
const invalid = (): never => {
  throw new Error("ROLE_ADMIN_PAGE_INVALID");
};
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const text = (value: unknown) => {
  if (typeof value !== "string" || !safe.test(value)) return invalid();
  return value;
};
const when = (value: unknown) => {
  if (typeof value !== "string" || !instant.test(value)) return invalid();
  return value;
};
const actions = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return invalid();
  const list = value.map((item) =>
    typeof item === "string" && action.test(item) ? item : invalid(),
  );
  if (new Set(list).size !== list.length) invalid();
  return Object.freeze(list);
};
const count = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
};
export function parseRoleAdministrationRouteReference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) return invalid();
  return value;
}
function change(value: unknown): RoleChangeView | null {
  if (value === null) return null;
  const input = closed(value, [
    "status",
    "name",
    "description",
    "permissions",
    "added",
    "removed",
    "restore",
    "rebased",
    "droppedByBop",
    "by",
    "at",
    "approvedAlone",
    "approval",
  ]);
  if (
    !["Draft", "InReview", "Approved"].includes(String(input.status)) ||
    typeof input.restore !== "boolean" ||
    typeof input.rebased !== "boolean" ||
    typeof input.approvedAlone !== "boolean"
  )
    invalid();
  let approval: RoleChangeView["approval"] = null;
  if (input.approval !== null) {
    const a = closed(input.approval, ["mine", "soleOperator", "needsHolderOf"]);
    if (typeof a.mine !== "boolean") invalid();
    approval = Object.freeze({
      mine: a.mine as boolean,
      soleOperator: parseSoleOperatorGate(a.soleOperator),
      needsHolderOf: actions(a.needsHolderOf),
    });
  }
  return Object.freeze({
    status: input.status as RoleChangeView["status"],
    name: text(input.name),
    description: text(input.description),
    permissions: actions(input.permissions),
    added: actions(input.added),
    removed: actions(input.removed),
    restore: input.restore as boolean,
    rebased: input.rebased as boolean,
    droppedByBop: count(input.droppedByBop),
    by: typeof input.by === "string" && input.by.length <= 120 ? input.by : invalid(),
    at: when(input.at),
    approvedAlone: input.approvedAlone as boolean,
    approval,
  });
}
function presetUpdate(value: unknown): RolePresetUpdateView | null {
  if (value === null) return null;
  const input = closed(value, ["added", "removed"]);
  return Object.freeze({ added: actions(input.added), removed: actions(input.removed) });
}
function role(value: unknown): RoleAdministrationItemView {
  const input = closed(value, [
    "roleReference",
    "name",
    "description",
    "scope",
    "version",
    "kind",
    "locked",
    "state",
    "memberCount",
    "waitingAssignments",
    "permissions",
    "retiredByBop",
    "presetUpdate",
    "change",
    "lastOutcome",
    "operations",
    "history",
  ]);
  if (
    !["Brand", "Store"].includes(String(input.scope)) ||
    !["Preset", "YourVersion", "Custom"].includes(String(input.kind)) ||
    !["InUse", "Removed", "NotOn"].includes(String(input.state)) ||
    typeof input.locked !== "boolean" ||
    !Number.isSafeInteger(input.version) ||
    (input.version as number) < 1 ||
    (input.lastOutcome !== null &&
      !["Rejected", "Withdrawn"].includes(String(input.lastOutcome))) ||
    !Array.isArray(input.history) ||
    !Array.isArray(input.operations) ||
    input.operations.some(
      (item) => !roleAdministrationOperations.includes(item as RoleAdministrationOperation),
    )
  )
    invalid();
  return Object.freeze({
    roleReference: parseRoleAdministrationRouteReference(input.roleReference),
    name: text(input.name),
    description: text(input.description),
    scope: input.scope as RoleAdministrationItemView["scope"],
    version: input.version as number,
    kind: input.kind as RoleAdministrationItemView["kind"],
    locked: input.locked as boolean,
    state: input.state as RoleAdministrationItemView["state"],
    memberCount: count(input.memberCount),
    waitingAssignments: count(input.waitingAssignments),
    permissions: actions(input.permissions),
    retiredByBop: count(input.retiredByBop),
    presetUpdate: presetUpdate(input.presetUpdate),
    change: change(input.change),
    lastOutcome: input.lastOutcome as RoleAdministrationItemView["lastOutcome"],
    operations: Object.freeze([...(input.operations as RoleAdministrationOperation[])]),
    history: Object.freeze(
      (input.history as unknown[]).map((item) => {
        const entry = closed(item, ["decision", "by", "at"]);
        return Object.freeze({
          decision: text(entry.decision),
          by: typeof entry.by === "string" && entry.by.length <= 120 ? entry.by : invalid(),
          at: when(entry.at),
        });
      }),
    ),
  });
}
export function parseRoleAdministrationPageView(
  value: unknown,
  screenId: RoleAdministrationPageView["screenId"],
): RoleAdministrationPageView {
  const input = closed(value, [
    "screenId",
    "sourceAsOf",
    "freshness",
    "completeness",
    "roles",
    "mayManage",
    "catalog",
  ]);
  if (
    input.screenId !== screenId ||
    !["Fresh", "Stale"].includes(String(input.freshness)) ||
    !["Complete", "Partial"].includes(String(input.completeness)) ||
    !Array.isArray(input.roles) ||
    !Array.isArray(input.catalog) ||
    typeof input.mayManage !== "boolean"
  )
    invalid();
  when(input.sourceAsOf);
  const roles = Object.freeze((input.roles as unknown[]).map(role));
  if (
    new Set(roles.map((item) => item.roleReference)).size !== roles.length ||
    (screenId === "IAM-ROLE-EDITOR" && roles.length !== 1)
  )
    invalid();
  const catalog = Object.freeze(
    (input.catalog as unknown[]).map((value) => {
      const entry = closed(value, [
        "action",
        "group",
        "description",
        "highRisk",
        "warning",
        "riskRank",
      ]);
      if (
        typeof entry.action !== "string" ||
        !action.test(entry.action) ||
        typeof entry.highRisk !== "boolean"
      )
        invalid();
      return Object.freeze({
        action: entry.action as string,
        group: text(entry.group),
        description: text(entry.description),
        highRisk: entry.highRisk as boolean,
        warning: entry.warning === null ? null : text(entry.warning),
        riskRank:
          entry.riskRank === null
            ? null
            : Number.isSafeInteger(entry.riskRank) && (entry.riskRank as number) >= 0
              ? (entry.riskRank as number)
              : invalid(),
      });
    }),
  );
  return Object.freeze({ ...input, roles, catalog }) as RoleAdministrationPageView;
}
export function parseRoleChangesWaiting(value: unknown): readonly RoleChangeWaitingView[] {
  const input = closed(value, ["screenId", "sourceAsOf", "changes"]);
  if (input.screenId !== "APPROVAL-INBOX" || !Array.isArray(input.changes)) invalid();
  when(input.sourceAsOf);
  return Object.freeze(
    (input.changes as unknown[]).map((item) => {
      const entry = closed(item, [
        "roleReference",
        "name",
        "added",
        "removed",
        "by",
        "at",
        "action",
      ]);
      if (!["Approve", "ApproveAlone", "TurnOn"].includes(String(entry.action))) invalid();
      return Object.freeze({
        roleReference: parseRoleAdministrationRouteReference(entry.roleReference),
        name: text(entry.name),
        added: count(entry.added),
        removed: count(entry.removed),
        by: typeof entry.by === "string" && entry.by.length <= 120 ? entry.by : invalid(),
        at: when(entry.at),
        action: entry.action as RoleChangeWaitingView["action"],
      });
    }),
  );
}
/** WP-2423 store-type starter roles: the kinds of shop a Store can start its roles from. */
export const starterStoreTypes = [
  "TeaShop",
  "DessertShop",
  "Hotpot",
  "FullService",
  "CounterOnly",
] as const;
export type StarterStoreType = (typeof starterStoreTypes)[number];
/** The kind of shop in the owner's words, in the language shown now. */
export function starterStoreTypeLabel(type: StarterStoreType): string {
  return type === "TeaShop"
    ? t("Bubble tea or tea shop")
    : type === "DessertShop"
      ? t("Dessert shop")
      : type === "Hotpot"
        ? t("Hotpot restaurant")
        : type === "FullService"
          ? t("Full-service Chinese restaurant")
          : t("Counter service: guests order and pay first, no waiters");
}
export interface StarterRoleView {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly string[];
  /** ToAdd: added by this set. Added: already here. Removed: the owner removed it. NameTaken:
   * another role here already has its name, so it is not added. NotApproved: it was not approved,
   * or was withdrawn, before it was ever on; this set sends it for approval again. */
  readonly state: "ToAdd" | "Added" | "Removed" | "NameTaken" | "NotApproved";
  readonly roleReference: string | null;
}
export interface StarterRoleSetView {
  readonly storeType: StarterStoreType;
  readonly roles: readonly StarterRoleView[];
  readonly keep: readonly { readonly roleReference: string; readonly name: string }[];
  /** Presets this kind of shop does not use; `held` ones stay (staff hold them or a change waits). */
  readonly putAway: readonly {
    readonly roleReference: string;
    readonly name: string;
    readonly held: boolean;
    readonly memberCount: number;
  }[];
}
export interface StarterRoleSetsView {
  readonly sourceAsOf: string;
  readonly mayApply: boolean;
  readonly mayPutAway: boolean;
  /** The Store has at least one starter role (any kind of shop). */
  readonly started: boolean;
  readonly sets: readonly StarterRoleSetView[];
}
export interface StarterRoleSetApplyRequest {
  readonly storeType: StarterStoreType;
  readonly operationReference: string;
  readonly putAway: boolean;
}
export function parseStarterRoleSetsView(value: unknown): StarterRoleSetsView {
  const input = closed(value, [
    "screenId",
    "sourceAsOf",
    "mayApply",
    "mayPutAway",
    "started",
    "sets",
  ]);
  if (
    input.screenId !== "IAM-ROLE-LIST" ||
    typeof input.mayApply !== "boolean" ||
    typeof input.mayPutAway !== "boolean" ||
    typeof input.started !== "boolean" ||
    !Array.isArray(input.sets)
  )
    invalid();
  const sets = (input.sets as unknown[]).map((value) => {
    const set = closed(value, ["storeType", "roles", "keep", "putAway"]);
    if (
      !starterStoreTypes.includes(set.storeType as StarterStoreType) ||
      !Array.isArray(set.roles) ||
      !Array.isArray(set.keep) ||
      !Array.isArray(set.putAway)
    )
      invalid();
    return Object.freeze({
      storeType: set.storeType as StarterStoreType,
      roles: Object.freeze(
        (set.roles as unknown[]).map((item) => {
          const role = closed(item, [
            "key",
            "name",
            "description",
            "permissions",
            "state",
            "roleReference",
          ]);
          if (
            !["ToAdd", "Added", "Removed", "NameTaken", "NotApproved"].includes(String(role.state))
          )
            invalid();
          return Object.freeze({
            key: text(role.key),
            name: text(role.name),
            description: text(role.description),
            permissions: actions(role.permissions),
            state: role.state as StarterRoleView["state"],
            roleReference:
              role.roleReference === null
                ? null
                : parseRoleAdministrationRouteReference(role.roleReference),
          });
        }),
      ),
      keep: Object.freeze(
        (set.keep as unknown[]).map((item) => {
          const role = closed(item, ["roleReference", "name"]);
          return Object.freeze({
            roleReference: parseRoleAdministrationRouteReference(role.roleReference),
            name: text(role.name),
          });
        }),
      ),
      putAway: Object.freeze(
        (set.putAway as unknown[]).map((item) => {
          const role = closed(item, ["roleReference", "name", "held", "memberCount"]);
          if (typeof role.held !== "boolean") invalid();
          return Object.freeze({
            roleReference: parseRoleAdministrationRouteReference(role.roleReference),
            name: text(role.name),
            held: role.held as boolean,
            memberCount: count(role.memberCount),
          });
        }),
      ),
    });
  });
  if (new Set(sets.map((set) => set.storeType)).size !== sets.length) invalid();
  return Object.freeze({
    sourceAsOf: when(input.sourceAsOf),
    mayApply: input.mayApply as boolean,
    mayPutAway: input.mayPutAway as boolean,
    started: input.started as boolean,
    sets: Object.freeze(sets),
  });
}
export const unavailableRoleAdministrationPageClient: RoleAdministrationPageClient = {
  loadRoles: async () => {
    throw new RoleAdministrationPageError("Unavailable");
  },
  loadRole: async () => {
    throw new RoleAdministrationPageError("Unavailable");
  },
};

const errorCodes: Record<string, RoleAdministrationPageErrorCode> = {
  PermissionDenied: "PermissionDenied",
  NotFound: "NotFound",
  Conflict: "Conflict",
  InUse: "InUse",
  Invalid: "CommandFailed",
  Unavailable: "Unavailable",
  NameTaken: "NameTaken",
  SoleOperatorNotInEffect: "SoleOperatorNotInEffect",
  NeedsReverification: "NeedsReverification",
  WouldWidenOwnAccess: "WouldWidenOwnAccess",
  ApproverLacksAccess: "ApproverLacksAccess",
  PresetChanged: "PresetChanged",
};
/** Same-origin Merchant BFF client; every request carries the session CSRF token. */
export function createRoleAdministrationPageClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): RoleAdministrationPageClient & {
  command(request: RoleCommandRequest): Promise<{ readonly roleReference: string }>;
  declineOffer(request: RolePresetOfferDeclineRequest): Promise<void>;
  waiting(): Promise<readonly RoleChangeWaitingView[]>;
  starterSets(): Promise<StarterRoleSetsView>;
  applyStarterSet(request: StarterRoleSetApplyRequest): Promise<void>;
} {
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new RoleAdministrationPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (isFullSignInRequired(response.status, payload))
        throw new RoleAdministrationPageError(FULL_SIGN_IN_REQUIRED);
      throw new RoleAdministrationPageError(
        errorCodes[String(payload?.error)] ??
          (response.status === 403 ? "PermissionDenied" : "Unavailable"),
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    loadRoles: () => post("/merchant/organization/roles/query", { roleReference: null }),
    loadRole: (roleReference) => post("/merchant/organization/roles/query", { roleReference }),
    async command(request) {
      const result = (await post("/merchant/organization/roles/command", request)) as {
        roleReference?: unknown;
      };
      return { roleReference: parseRoleAdministrationRouteReference(result.roleReference) };
    },
    async declineOffer(request) {
      await post("/merchant/organization/roles/offer-decline", request);
    },
    waiting: async () =>
      parseRoleChangesWaiting(await post("/merchant/organization/roles/waiting", {})),
    starterSets: async () =>
      parseStarterRoleSetsView(await post("/merchant/organization/roles/starter-sets", {})),
    async applyStarterSet(request) {
      await post("/merchant/organization/roles/starter-sets/apply", request);
    },
  };
}
