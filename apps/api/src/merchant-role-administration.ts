import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { listStoreMembers, type MemberDirectoryTransaction } from "@bop/membership";
import {
  createPostgresRoleAdministrationPorts,
  declineRolePresetOffer,
  planRoleAdministrationChange,
  executeRoleAdministration,
  findRoleAdministrationOperation,
  listRoleAdministration,
  loadRoleAdministration,
  buildRolePermissionSelections,
  equalsPreset,
  flaggedPermissionCodes,
  lockedRoleCodes,
  orderByRisk,
  permissionGroupLabel,
  permissionWarning,
  permissionRiskRank,
  rolePresetActions,
  rolePresetProfile,
  RoleAdministrationContractError,
  RoleAdministrationServiceError,
  RoleAdministrationStoreError,
  legacyPermissionReplacements,
  storePermissionCatalog,
  storePermissionCatalogVersion,
  storePermissionCodes,
  type RoleAdministrationRoleView,
  type RoleAdministrationTransaction,
  type RoleAdministrationVersionRecord,
  type RoleAssignmentTransaction,
  starterRole,
  starterRoleOfCode,
  starterRoleSet,
  starterStoreTypes,
  type StarterStoreType,
} from "@bop/permission";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { merchantFailureCode, onlyRefusal } from "./merchant-failure.js";
import { createStaffLabels } from "./merchant-staff-labels.js";
import {
  merchantStoreSoleOperatorGate,
  MerchantSoleOperatorGateError,
  requireMerchantStoreSoleOperator,
  staffRoleApprovalPermission,
  type ResolveContext,
} from "./merchant-sole-operator.js";

/**
 * WP-2423: Section 88 IAM-ROLE-LIST / IAM-ROLE-EDITOR for the selected Store. Reads need
 * identity.role.read; each command is authorized by the domain service for its exact action.
 *
 * WP-2423 role presets (Owner request 2026-11-06 "预设一些角色与权限，另外允许店家自定义；店家也可以
 * 对预设进行增删改"): a Store edits a BOP preset or its own role (Revise), restores a preset
 * (RestoreDefault), removes a role nobody holds (Deactivate) and brings it back (Activate),
 * creates a role from blank (Create) or a copy (Duplicate), and takes back a waiting change
 * (Withdraw). Every change goes through approval by someone else, or by a sole owner alone
 * (ApproveAlone). Staff hold the version that is on until a change is approved and turned on;
 * the change applies at their next server-checked action. Brand roles stay read-only here.
 */
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
type Operation = (typeof roleAdministrationOperations)[number];
const operationAction: Record<Operation, string> = {
  Create: "identity.role.create",
  Duplicate: "identity.role.create",
  SaveDraft: "identity.role.change",
  Revise: "identity.role.change",
  RestoreDefault: "identity.role.change",
  Submit: "identity.role.change",
  Withdraw: "identity.role.change",
  Approve: "identity.role.approve",
  ApproveAlone: "identity.role.approve",
  Reject: "identity.role.approve",
  Activate: "identity.role.activate",
  Deactivate: "identity.role.deactivate",
};
const withDraft: ReadonlySet<Operation> = new Set(["Create", "Duplicate", "SaveDraft", "Revise"]);
export class MerchantRoleAdministrationError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "InUse"
      | "Invalid"
      | "Unavailable"
      // WP-2423 role presets.
      | "NameTaken"
      | "SoleOperatorNotInEffect"
      | "NeedsReverification"
      | "WouldWidenOwnAccess"
      | "ApproverLacksAccess"
      | "PresetChanged",
  ) {
    super(code);
    this.name = "MerchantRoleAdministrationError";
  }
}
/** Another naming at this Store is being saved: the whole run is retried ("busy, try again"). */
class RoleNamingBusy extends Error {
  readonly code = "TENANT_DATABASE_TRANSACTION_CONFLICT";
  constructor() {
    super("role naming busy");
    this.name = "RoleNamingBusy";
  }
}
const fail = (code: MerchantRoleAdministrationError["code"]): never => {
  throw new MerchantRoleAdministrationError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safe = /^[^\p{Cc}\p{Cf}]{1,180}$/u;
const catalog = new Map(storePermissionCatalog().map((entry) => [entry.code, entry]));
/** The reason a restore draft opens with; its approval then turns the role back into the preset. */
export const rolePresetRestoreReason = "ROLE_PRESET_RESTORE";

export interface RoleCommandInput {
  readonly operation: Operation;
  /** Null only for Create. */
  readonly roleReference: string | null;
  readonly expectedVersion: number | null;
  readonly operationReference: string;
  readonly reasonCode: string;
  readonly draft: {
    readonly displayName: string;
    readonly description: string;
    readonly actions: readonly string[];
  } | null;
}
export function parseRoleCommandInput(value: unknown): RoleCommandInput {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const operation = roleAdministrationOperations.find((item) => item === r.operation);
  if (
    !operation ||
    Object.keys(r).sort().join(",") !==
      (operation === "ApproveAlone"
        ? "confirmed,draft,expectedVersion,operation,operationReference,reasonCode,roleReference"
        : "draft,expectedVersion,operation,operationReference,reasonCode,roleReference") ||
    (operation === "ApproveAlone" && r.confirmed !== true) ||
    (operation === "Create"
      ? r.roleReference !== null || r.expectedVersion !== null
      : typeof r.roleReference !== "string" ||
        !uuid.test(r.roleReference) ||
        !Number.isSafeInteger(r.expectedVersion) ||
        (r.expectedVersion as number) < 1) ||
    typeof r.operationReference !== "string" ||
    !uuid.test(r.operationReference) ||
    typeof r.reasonCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{2,63}$/u.test(r.reasonCode)
  )
    return fail("Invalid");
  const needsDraft = withDraft.has(operation);
  if ((r.draft === null) === needsDraft) return fail("Invalid");
  let draft: RoleCommandInput["draft"] = null;
  if (r.draft !== null) {
    const d = r.draft as Record<string, unknown>;
    if (
      typeof d !== "object" ||
      Array.isArray(d) ||
      Object.keys(d ?? {})
        .sort()
        .join(",") !== "actions,description,displayName" ||
      typeof d.displayName !== "string" ||
      !safe.test(d.displayName) ||
      d.displayName.trim() === "" ||
      typeof d.description !== "string" ||
      !safe.test(d.description) ||
      !Array.isArray(d.actions) ||
      d.actions.length > 512 ||
      d.actions.some((action) => typeof action !== "string" || !storePermissionCodes.has(action)) ||
      new Set(d.actions).size !== d.actions.length
    )
      return fail("Invalid");
    draft = {
      displayName: d.displayName.trim(),
      description: d.description,
      actions: d.actions as string[],
    };
  }
  return {
    operation,
    roleReference: (r.roleReference as string | null) ?? null,
    expectedVersion: (r.expectedVersion as number | null) ?? null,
    operationReference: r.operationReference,
    reasonCode: r.reasonCode,
    draft,
  };
}

/**
 * What a command asks for, independent of when it runs: a retry under the same operation
 * reference must ask for exactly this again (another name, other permissions or another role is a
 * conflict, never the first answer).
 */
export function roleCommandIntentDigest(command: RoleCommandInput): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(
        canonicalizeRfc8785({
          operation: command.operation,
          roleReference: command.roleReference,
          expectedVersion: command.expectedVersion,
          reasonCode: command.reasonCode,
          draft:
            command.draft === null
              ? null
              : {
                  displayName: command.draft.displayName,
                  description: command.draft.description,
                  actions: [...command.draft.actions].sort(),
                },
        }),
      )
      .digest("hex")
  );
}

/** A new role's internal code: from its operation reference, so a retry names the same role. */
export function generatedRoleCode(operationReference: string): string {
  return "custom_" + createHash("sha256").update(operationReference).digest("hex").slice(0, 12);
}
const actionsOf = (record: RoleAdministrationVersionRecord | null) =>
  record === null
    ? []
    : record.selections
        .map((item) => String(item.action))
        .filter((action) => catalog.has(action))
        .sort();
const pendingLifecycles = new Set(["Draft", "InReview", "Approved"]);
/** How many permissions in `codes` BOP no longer offers (legacy codes are not counted again). */
const noLongerOffered = (codes: readonly string[] | undefined) =>
  (codes ?? []).filter((code) => !catalog.has(code) && !(code in legacyPermissionReplacements))
    .length;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** What staff hold now and what a waiting change would add or take away. */
function changeOf(role: RoleAdministrationRoleView) {
  const pending = pendingLifecycles.has(role.record.lifecycle) ? role.record : null;
  if (pending === null) return null;
  const now = new Set(actionsOf(role.effective)),
    next = new Set(actionsOf(pending));
  return {
    record: pending,
    added: orderByRisk([...next].filter((action) => !now.has(action)).sort()),
    removed: orderByRisk([...now].filter((action) => !next.has(action)).sort()),
    restore:
      role.opening?.reasonCode === rolePresetRestoreReason &&
      equalsPreset(actionsOf(role.opening), actionsOf(pending)),
    rebased: role.opening?.reasonCode === "ROLE_DRAFT_REBASED",
    // Permissions BOP no longer offers, left out of the draft it sent back.
    droppedByBop: noLongerOffered(role.droppedFromRebase),
  };
}
const presetOf = (record: RoleAdministrationVersionRecord) =>
  rolePresetActions(record.code, record.storeReference === null ? "Brand" : "Store");
/** A preset's current content as catalog codes (its legacy codes are added back on selection). */
const presetCatalogCodes = (record: RoleAdministrationVersionRecord) =>
  (presetOf(record) ?? []).filter((action) => catalog.has(action));
/**
 * WP-2423 role presets: what BOP changed in a preset since the Store made it its own. `added`: the
 * preset now has it, the preset did not when the Store made its version, and the Store's version
 * lacks it. `removed`: the preset no longer has it and the Store's version still does. Minus what
 * the Store chose to keep without. Null when nothing is offered, while a change waits, or for any
 * role that is not the Store's own version of a preset it holds now.
 */
export function presetUpdateOf(
  role: RoleAdministrationRoleView,
): { readonly added: readonly string[]; readonly removed: readonly string[] } | null {
  const { record, effective } = role;
  const preset = role.presetVersion ?? null;
  if (
    preset === null ||
    effective === null ||
    effective !== record ||
    effective.roleType !== "Custom" ||
    effective.lifecycle !== "Active" ||
    record.storeReference === null ||
    lockedRoleCodes.has(record.code) ||
    presetOf(record) === null
  )
    return null;
  const template = presetCatalogCodes(record);
  const then = new Set(actionsOf(preset)),
    mine = new Set(actionsOf(effective));
  const declined = (kind: "Add" | "Remove") =>
    new Set(
      (role.declinedOffers ?? []).filter((item) => item.kind === kind).map((item) => item.action),
    );
  const keepAdd = declined("Add"),
    keepRemove = declined("Remove");
  const added = orderByRisk(
    template.filter((code) => !then.has(code) && !mine.has(code) && !keepAdd.has(code)).sort(),
  );
  const removed = orderByRisk(
    [...then]
      .filter((code) => !template.includes(code) && mine.has(code) && !keepRemove.has(code))
      .sort(),
  );
  return added.length === 0 && removed.length === 0 ? null : { added, removed };
}

export function createMerchantRoleAdministration(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  /**
   * WP-2423 role presets: the run's workforce context for evaluating who else at the Store
   * approves roles (each member as an approval would evaluate them). Absent: nobody approves
   * their own role change.
   */
  soleOperator?: { resolveContext(tx: unknown, scope: unknown): ResolveContext };
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const asRoleTx = (tx: Tx) => tx as unknown as RoleAdministrationTransaction;

  type Scope = Awaited<ReturnType<typeof resolveScope>>;
  type Decision = Awaited<ReturnType<Scope["authorizeAction"]>>;
  const denied = () => fail("PermissionDenied");
  const roleActions = [...new Set(Object.values(operationAction))];
  /**
   * WP-2423: one authorized run. The caller's `identity.role.read` and the further `actions` are
   * decided in full once at the start (one permission packet) and re-checked in full once more
   * before the reply or commit, inside the transaction, so nothing a refused command wrote commits.
   */
  function authorizedRun<T>(
    tx: Tx,
    sessionCookie: unknown,
    expectedSession: string,
    actions: readonly string[],
    recheckActions: readonly string[],
    work: (
      scope: Scope,
      decisions: ReadonlyMap<string, Decision>,
      guard: (transaction?: unknown) => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T> {
    return withMerchantTransactionAuthorization(
      {
        transaction: tx,
        resolve: async () => {
          const scope = await resolveScope(
            tx,
            sessionCookie,
            "identity.role.read",
            expectedSession,
          );
          const decisions = await scope.authorizeActions(["identity.role.read", ...actions]);
          if (decisions.get("identity.role.read")?.effect !== "Allow") return denied();
          return { scope, decisions };
        },
        recheck: async ({ scope }) => {
          if (recheckActions.length === 0) return (await scope.allowed()) === true;
          const decisions = await scope.authorizeActions(["identity.role.read", ...recheckActions]);
          return ["identity.role.read", ...recheckActions].every(
            (action) => decisions.get(action)?.effect === "Allow",
          );
        },
        denied,
      },
      (authority) => work(authority.scope.scope, authority.scope.decisions, authority.guard),
    );
  }
  const ownerScopeOf = (scope: Scope) => ({
    brandReference: String(scope.context.brand.brandReference),
    storeReference: String(scope.store.storeReference),
  });
  /** Codes among `codes` the signed-in person does not hold at the Store now. */
  async function notHeld(scope: Scope, codes: readonly string[]): Promise<readonly string[]> {
    if (codes.length === 0) return [];
    const decisions = await scope.authorizeActions(codes);
    return codes.filter((code) => decisions.get(code)?.effect !== "Allow");
  }
  /** The Store's role approval gate as the signed-in person sees it (null when not wired). */
  async function gateFor(tx: Tx, scope: Scope, at: string, mayApprove: boolean) {
    if (options.soleOperator === undefined || !mayApprove) return null;
    const owner = ownerScopeOf(scope);
    const gate = await merchantStoreSoleOperatorGate(tx as never, {
      tenantReference: String(
        (scope as { selected: { tenantReference: string } }).selected.tenantReference,
      ),
      brandReference: owner.brandReference,
      storeReference: owner.storeReference,
      actorReference: String(scope.actorReference),
      permissionCode: staffRoleApprovalPermission,
      observedAt: at,
      resolveContext: options.soleOperator.resolveContext(tx, scope),
      allowed: async () =>
        (await scope.authorizeActions([staffRoleApprovalPermission])).get(
          staffRoleApprovalPermission,
        )?.effect === "Allow",
      includeBrandHolders: true,
    });
    // The gate may leave the transaction at Brand scope; the selected Store's again.
    await (tx as unknown as RoleAdministrationTransaction).query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [owner.brandReference, owner.storeReference],
    );
    return gate;
  }
  async function labelsFor(tx: Tx, scope: Scope, at: string) {
    const owner = ownerScopeOf(scope);
    const members = await listStoreMembers(tx as unknown as MemberDirectoryTransaction, owner);
    const names = new Map<string, string | null>(
      members.map((member) => [member.actorReference, member.displayName]),
    );
    const label = await createStaffLabels(tx as unknown as RoleAssignmentTransaction, owner, {
      viewer: String(scope.actorReference),
      at,
      names,
    });
    // Someone who is not a member here and holds no role is the platform (a BOP preset update).
    return (actor: string | null) => {
      if (actor === null) return null;
      const name = label(actor);
      return name === "Staff member" && !names.has(actor) ? "BOP" : name;
    };
  }

  async function view(
    tx: Tx,
    scope: Scope,
    decisions: ReadonlyMap<string, Decision>,
    roles: readonly RoleAdministrationRoleView[],
    screenId: "IAM-ROLE-LIST" | "IAM-ROLE-EDITOR",
  ) {
    const now = options.persistence.now();
    const allowed = new Map<string, boolean>();
    for (const action of roleActions)
      allowed.set(action, decisions.get(action)?.effect === "Allow");
    const viewer = String(scope.actorReference);
    const label = await labelsFor(tx, scope, now);
    const mayApprove = allowed.get("identity.role.approve") === true;
    const ownWaiting = roles.some(
      (role) =>
        role.record.lifecycle === "InReview" && String(role.record.submittedByReference) === viewer,
    );
    const gate = ownWaiting ? await gateFor(tx, scope, now, mayApprove) : null;
    // One permission read for every flagged code another person's waiting changes would add.
    const flaggedAdded = [
      ...new Set(
        roles.flatMap((role) => {
          const change = changeOf(role);
          return change !== null &&
            change.record.lifecycle === "InReview" &&
            String(change.record.submittedByReference) !== viewer
            ? change.added.filter((action) => flaggedPermissionCodes.has(action))
            : [];
        }),
      ),
    ];
    const lacking = new Set(mayApprove ? await notHeld(scope, flaggedAdded) : []);
    return {
      screenId,
      sourceAsOf: now,
      freshness: "Fresh" as const,
      completeness: "Complete" as const,
      mayManage: allowed.get("identity.role.create") === true,
      roles: roles.map((role) => {
        const { record, effective, memberCount, openAssignmentChanges, decisions } = role;
        const change = changeOf(role);
        const closed = record.lifecycle === "Rejected" || record.lifecycle === "Withdrawn";
        const held = closed ? effective : effective === record ? record : null;
        const preset = presetOf(record) !== null;
        const locked = lockedRoleCodes.has(record.code);
        const kind =
          preset && (effective === null || effective.roleType === "System")
            ? ("Preset" as const)
            : preset
              ? ("YourVersion" as const)
              : ("Custom" as const);
        const state =
          effective === null
            ? ("NotOn" as const)
            : effective.lifecycle === "Active"
              ? ("InUse" as const)
              : ("Removed" as const);
        const submitter = String(record.submittedByReference);
        const operations: Operation[] = [];
        const add = (operation: Operation, when: boolean) => {
          if (when && allowed.get(operationAction[operation]) === true) operations.push(operation);
        };
        if (record.storeReference !== null) {
          const author = String(record.authoredByReference) === viewer;
          add("SaveDraft", record.lifecycle === "Draft" && !(change?.restore ?? false));
          add("Submit", record.lifecycle === "Draft");
          add(
            "Withdraw",
            (record.lifecycle === "Draft" && author) ||
              (record.lifecycle === "InReview" && submitter === viewer) ||
              (record.lifecycle === "Approved" &&
                (submitter === viewer || String(record.approvedByReference) === viewer)),
          );
          // Independent approval: the submitter never approves their own change.
          add("Approve", record.lifecycle === "InReview" && submitter !== viewer);
          add("Reject", record.lifecycle === "InReview" && submitter !== viewer);
          add(
            "ApproveAlone",
            record.lifecycle === "InReview" &&
              submitter === viewer &&
              options.soleOperator !== undefined,
          );
          add("Activate", record.lifecycle === "Approved");
          const on = held?.lifecycle === "Active";
          add("Revise", !locked && (on || (closed && effective === null)));
          add("RestoreDefault", !locked && on && kind === "YourVersion");
          add("Deactivate", !locked && on && memberCount === 0 && openAssignmentChanges === 0);
          add("Activate", held?.lifecycle === "Deactivated");
          add("Duplicate", held !== null);
        }
        const shown = effective ?? record;
        return {
          roleReference: record.roleReference,
          name: shown.displayName,
          description: shown.description,
          scope: record.storeReference === null ? ("Brand" as const) : ("Store" as const),
          version: record.version,
          kind,
          locked,
          state,
          memberCount,
          waitingAssignments: openAssignmentChanges,
          permissions: actionsOf(effective),
          // Permissions BOP no longer offers that it took off the version staff hold.
          retiredByBop: noLongerOffered(role.retiredByBop),
          // What BOP changed in the preset since the Store made it its own (add / keep mine).
          presetUpdate: allowed.get("identity.role.change") === true ? presetUpdateOf(role) : null,
          change:
            change === null
              ? null
              : {
                  status: change.record.lifecycle as "Draft" | "InReview" | "Approved",
                  name: change.record.displayName,
                  description: change.record.description,
                  permissions: actionsOf(change.record),
                  added: change.added,
                  removed: change.removed,
                  restore: change.restore,
                  rebased: change.rebased,
                  droppedByBop: change.droppedByBop,
                  by:
                    label(
                      change.record.lifecycle === "Draft"
                        ? change.record.authoredByReference
                        : change.record.submittedByReference,
                    ) ?? "",
                  at: change.record.changedAt,
                  approvedAlone: change.record.approvalMode === "SoleOperator",
                  approval:
                    change.record.lifecycle !== "InReview"
                      ? null
                      : submitter === viewer
                        ? {
                            mine: true,
                            soleOperator:
                              gate === null
                                ? null
                                : {
                                    status: gate.status,
                                    otherApprovers: gate.otherApprovers,
                                    verifiedUntil: gate.verifiedUntil,
                                  },
                            needsHolderOf: [] as string[],
                          }
                        : {
                            mine: false,
                            soleOperator: null,
                            needsHolderOf: change.added.filter((action) => lacking.has(action)),
                          },
                },
          lastOutcome: closed ? (record.lifecycle as "Rejected" | "Withdrawn") : null,
          operations,
          history: decisions.map((item) => ({
            decision: item.decision,
            by: label(item.actorReference) ?? "",
            at: item.occurredAt,
          })),
        };
      }),
      // Staff words for every permission (codes stay identifiers and are never shown).
      catalog: storePermissionCatalog().map((entry) => ({
        action: entry.code,
        group: permissionGroupLabel(entry.module),
        description: entry.description,
        highRisk: entry.risk === "High",
        warning: permissionWarning(entry.code),
        riskRank: permissionRiskRank(entry.code),
      })),
    };
  }

  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(onlyRefusal(() => fail("PermissionDenied")));
  const list = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current.sessionReference,
          roleActions,
          [],
          async (scope, decisions) => {
            const roles = await listRoleAdministration(
              asRoleTx(tx),
              ownerScopeOf(scope),
              options.persistence.now(),
            );
            return view(tx, scope, decisions, roles, "IAM-ROLE-LIST");
          },
        ),
      ),
    );
  };
  const detail = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    roleReference: string;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current.sessionReference,
          roleActions,
          [],
          async (scope, decisions) => {
            let role: RoleAdministrationRoleView;
            try {
              role = await loadRoleAdministration(
                asRoleTx(tx),
                ownerScopeOf(scope),
                input.roleReference,
                options.persistence.now(),
              );
            } catch (error) {
              if (error instanceof RoleAdministrationStoreError) return fail("NotFound");
              throw error;
            }
            return view(tx, scope, decisions, [role], "IAM-ROLE-EDITOR");
          },
        ),
      ),
    );
  };

  /**
   * WP-2423 role presets: role changes waiting for the signed-in person at the selected Store —
   * another person's change they may approve, their own they may approve alone now (sole
   * operator), or an approved change they may turn on. For Approvals and its badge.
   */
  const waiting = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current.sessionReference,
          ["identity.role.approve", "identity.role.activate"],
          [],
          async (scope, decisions) => {
            const now = options.persistence.now();
            const viewer = String(scope.actorReference);
            const mayApprove = decisions.get("identity.role.approve")?.effect === "Allow",
              mayActivate = decisions.get("identity.role.activate")?.effect === "Allow";
            if (!mayApprove && !mayActivate)
              return { screenId: "APPROVAL-INBOX" as const, sourceAsOf: now, changes: [] };
            const roles = (
              await listRoleAdministration(asRoleTx(tx), ownerScopeOf(scope), now)
            ).filter((role) => role.record.storeReference !== null);
            const own = roles.some(
              (role) =>
                role.record.lifecycle === "InReview" &&
                String(role.record.submittedByReference) === viewer,
            );
            const gate = own ? await gateFor(tx, scope, now, mayApprove) : null;
            const label = await labelsFor(tx, scope, now);
            const changes = roles.flatMap((role) => {
              const change = changeOf(role);
              if (change === null) return [];
              const submitter = String(change.record.submittedByReference);
              const action =
                change.record.lifecycle === "InReview" && mayApprove && submitter !== viewer
                  ? ("Approve" as const)
                  : change.record.lifecycle === "InReview" &&
                      mayApprove &&
                      submitter === viewer &&
                      gate?.status === "Effective"
                    ? ("ApproveAlone" as const)
                    : change.record.lifecycle === "Approved" && mayActivate
                      ? ("TurnOn" as const)
                      : null;
              if (action === null) return [];
              return [
                {
                  roleReference: role.record.roleReference,
                  name: (role.effective ?? role.record).displayName,
                  added: change.added.length,
                  removed: change.removed.length,
                  by: label(change.record.submittedByReference) ?? "",
                  at: change.record.changedAt,
                  action,
                },
              ];
            });
            return { screenId: "APPROVAL-INBOX" as const, sourceAsOf: now, changes };
          },
        ),
      ),
    );
  };

  /**
   * One role command inside an authorized run (`decisions` hold its action). A starter role is
   * created under its fixed `roleCode`; any other new role gets one from its operation reference.
   */
  async function executeCommand(
    tx: Tx,
    scope: Scope,
    decisions: ReadonlyMap<string, Decision>,
    guard: (transaction?: unknown) => Promise<boolean>,
    command: RoleCommandInput,
    intentDigest: string,
    roleCode?: string,
  ): Promise<{
    readonly roleReference: string;
    readonly version: number;
    readonly status: string;
  }> {
    const action = operationAction[command.operation];
    const ownerScope = ownerScopeOf(scope);
    const viewer = String(scope.actorReference);
    const now = options.persistence.now();
    // A retry answers from what the first attempt recorded (never a second role).
    const prior = await findRoleAdministrationOperation(
      asRoleTx(tx),
      ownerScope,
      command.operationReference,
    );
    if (prior !== null) {
      if (
        prior.commandType !== command.operation ||
        prior.actorReference !== viewer ||
        prior.intentDigest !== intentDigest
      )
        return fail("Conflict");
      return {
        roleReference: prior.roleReference,
        version: prior.version,
        status: prior.lifecycle,
      };
    }
    let role: RoleAdministrationRoleView | null = null;
    if (command.roleReference !== null) {
      try {
        role = await loadRoleAdministration(asRoleTx(tx), ownerScope, command.roleReference, now);
      } catch (error) {
        if (error instanceof RoleAdministrationStoreError) return fail("NotFound");
        throw error;
      }
      if (role.record.storeReference === null) fail("PermissionDenied");
      if (role.record.version !== command.expectedVersion) fail("Conflict");
    }
    const current = role?.record ?? null;
    // A name is unique among this Store's roles in use or waiting (removed ones keep theirs).
    // Bringing a removed role back and restoring a preset change the name without a draft:
    // they carry the removed role's name and the preset's own name.
    const restoring = command.operation === "RestoreDefault" && current !== null;
    const bringingBack =
      command.operation === "Activate" && current !== null && current.lifecycle !== "Approved";
    const name =
      command.draft !== null
        ? command.draft.displayName
        : restoring
          ? rolePresetProfile(current.code, current.storeReference === null ? "Brand" : "Store")
              ?.displayName
          : bringingBack
            ? (current.lifecycle === "Rejected" || current.lifecycle === "Withdrawn") &&
              role?.effective != null
              ? role.effective.displayName
              : current.displayName
            : undefined;
    if (name !== undefined) {
      // One naming at a time per Store, so two Creates or Revises never commit one name.
      // The run already holds the Brand's permission fence shared (authorization) and a
      // Create later takes it exclusive, so waiting here would deadlock: a second naming
      // backs off instead, and its rerun reads the first one's name.
      const free = (
        await asRoleTx(tx).query(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked",
          [
            "bop_permission.role_name:" +
              ownerScope.brandReference +
              ":" +
              ownerScope.storeReference,
          ],
        )
      ).rows[0]?.locked;
      if (free !== true) throw new RoleNamingBusy();
      const others = (await listRoleAdministration(asRoleTx(tx), ownerScope, now)).filter(
        (other) =>
          other.record.roleReference !==
            (command.operation === "Duplicate" ? null : current?.roleReference) &&
          other.effective?.lifecycle !== "Deactivated",
      );
      if (
        others.some(
          (other) =>
            sameName(other.record.displayName, name) ||
            (other.effective !== null && sameName(other.effective.displayName, name)),
        )
      )
        fail("NameTaken");
    }
    const change = role === null ? null : changeOf(role);
    if (command.operation === "Approve" && change !== null) {
      // The approver must hold every flagged permission the change adds: a widely held
      // role is never widened to money powers by someone who lacks them.
      const flagged = change.added.filter((code) => flaggedPermissionCodes.has(code));
      if ((await notHeld(scope, flagged)).length > 0) fail("ApproverLacksAccess");
    }
    if (command.operation === "ApproveAlone" && change !== null) {
      // Approving alone never widens a role past what the approver holds.
      if ((await notHeld(scope, change.added)).length > 0) fail("WouldWidenOwnAccess");
    }
    if (
      command.operation === "Activate" &&
      current !== null &&
      current.lifecycle === "Approved" &&
      change?.restore === true &&
      !equalsPreset(actionsOf(current), presetCatalogCodes(current))
    )
      // BOP updated the preset after this restore was approved: check it again.
      fail("PresetChanged");
    let gateFailure: unknown = null;
    const ports = createPostgresRoleAdministrationPorts({
      transaction: asRoleTx(tx),
      scope: ownerScope,
      operation: command.operation,
      operationReference: command.operationReference,
      actorReference: scope.actorReference,
      authorization: {
        // The decision taken at the start of this run (no query); the run re-checks it in
        // full before the commit.
        authorize: async (request) => {
          if (!(await guard(tx)) || String(request.action) !== action)
            return fail("PermissionDenied");
          return decisions.get(action) ?? fail("PermissionDenied");
        },
      },
      clock: { now: () => now },
      nextReference: () => options.references.next(),
      intentDigest,
    });
    const wired = options.soleOperator;
    const soleOperator =
      command.operation !== "ApproveAlone" || wired === undefined
        ? undefined
        : {
            confirm: async () => {
              try {
                return await requireMerchantStoreSoleOperator(tx as never, {
                  tenantReference: String(
                    (scope as { selected: { tenantReference: string } }).selected.tenantReference,
                  ),
                  brandReference: ownerScope.brandReference,
                  storeReference: ownerScope.storeReference,
                  actorReference: viewer,
                  permissionCode: staffRoleApprovalPermission,
                  observedAt: now,
                  resolveContext: wired.resolveContext(tx, scope),
                  allowed: async () => guard(tx),
                  includeBrandHolders: true,
                });
              } catch (error) {
                gateFailure = error;
                throw error;
              } finally {
                await asRoleTx(tx).query(
                  "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
                  [ownerScope.brandReference, ownerScope.storeReference],
                );
              }
            },
          };
    if (command.operation === "ApproveAlone" && soleOperator === undefined)
      fail("SoleOperatorNotInEffect");
    const policyVersion = await ports.policy.currentVersion(ownerScope.brandReference);
    const selections = (actions: readonly string[]) =>
      buildRolePermissionSelections(asRoleTx(tx), actions).catch((error: unknown) => {
        // A permission the catalog no longer offers: read the role again. A failed read
        // carries on as itself and is logged.
        if (merchantFailureCode(error) === "ROLE_ADMIN_NOT_FOUND") return fail("Conflict");
        throw error;
      });
    const restore = command.operation === "RestoreDefault";
    const presetProfile =
      current === null
        ? null
        : rolePresetProfile(current.code, current.storeReference === null ? "Brand" : "Store");
    if (restore && (current === null || presetOf(current) === null)) fail("Invalid");
    const draftActions = restore
      ? presetCatalogCodes(current as RoleAdministrationVersionRecord)
      : (command.draft?.actions ?? null);
    let next: RoleAdministrationVersionRecord;
    try {
      next = planRoleAdministrationChange({
        operation: command.operation,
        current,
        effective: role?.effective ?? null,
        scope: {
          brandReference: ownerScope.brandReference,
          storeReference: ownerScope.storeReference,
        },
        actorReference: scope.actorReference,
        policyVersion,
        changedAt: now,
        reasonCode: restore ? rolePresetRestoreReason : command.reasonCode,
        nextReference: () => options.references.next(),
        draft:
          draftActions === null
            ? null
            : {
                ...(command.operation === "Create" || command.operation === "Duplicate"
                  ? { code: roleCode ?? generatedRoleCode(command.operationReference) }
                  : {}),
                // A restore brings back the preset's own name and description too.
                displayName: restore
                  ? (presetProfile?.displayName ?? "")
                  : (command.draft?.displayName ?? ""),
                description: restore
                  ? (presetProfile?.description ?? "")
                  : (command.draft?.description ?? ""),
                selections: await selections(draftActions),
              },
      });
    } catch (error) {
      if (error instanceof MerchantRoleAdministrationError) throw error;
      return fail("Invalid");
    }
    try {
      const result = await executeRoleAdministration(
        {
          tenantContext: scope.context,
          operation: command.operation,
          expectedVersion: (current?.version ?? null) as never,
          idempotencyKey: command.operationReference,
          current,
          effective: role?.effective ?? null,
          next,
          auditId: options.references.next() as never,
          correlationId: command.operationReference as never,
          sourceChannel: "MERCHANT_WEB",
        },
        { ...ports, ...(soleOperator === undefined ? {} : { soleOperator }) },
      );
      return {
        roleReference: result.roleReference,
        version: result.version,
        status: result.lifecycle,
      };
    } catch (error) {
      if (gateFailure instanceof MerchantSoleOperatorGateError)
        return fail(
          gateFailure.code === "NeedsReverification"
            ? "NeedsReverification"
            : "SoleOperatorNotInEffect",
        );
      if (error instanceof RoleAdministrationServiceError)
        return fail(
          error.code === "ROLE_ADMIN_PERMISSION_DENIED"
            ? "PermissionDenied"
            : error.code === "ROLE_ADMIN_ROLE_IN_USE"
              ? "InUse"
              : error.code === "ROLE_ADMIN_MUTATION_INVALID"
                ? "Invalid"
                : "Conflict",
        );
      if (error instanceof RoleAdministrationContractError) return fail("Invalid");
      throw error;
    }
  }
  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const command = parseRoleCommandInput(input.body);
    const intentDigest = roleCommandIntentDigest(command);
    const action = operationAction[command.operation];
    const current0 = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current0.sessionReference,
          [action],
          [action],
          (scope, decisions, guard) =>
            executeCommand(tx, scope, decisions, guard, command, intentDigest),
        ),
      ),
    );
  };
  /**
   * WP-2423 role presets: "Keep mine without it" for what a BOP preset update offered. Recorded
   * append-only against the preset version the offer came from; adding or removing instead is an
   * ordinary Revise through approval.
   */
  const declineOffer = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const request = parsePresetOfferDecline(input.body);
    const current0 = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current0.sessionReference,
          ["identity.role.change"],
          ["identity.role.change"],
          async (scope, decisions, guard) => {
            if (decisions.get("identity.role.change")?.effect !== "Allow")
              return fail("PermissionDenied");
            const ownerScope = ownerScopeOf(scope);
            const now = options.persistence.now();
            let role: RoleAdministrationRoleView;
            try {
              role = await loadRoleAdministration(
                asRoleTx(tx),
                ownerScope,
                request.roleReference,
                now,
              );
            } catch (error) {
              if (error instanceof RoleAdministrationStoreError) return fail("NotFound");
              throw error;
            }
            if (role.record.storeReference === null) return fail("PermissionDenied");
            const offered = presetUpdateOf(role);
            const list = request.kind === "Add" ? offered?.added : offered?.removed;
            const stillOffered =
              role.record.version === request.expectedVersion &&
              request.actions.every((action) => list?.includes(action) === true);
            let status: "Recorded" | "AlreadyRecorded";
            try {
              status = await declineRolePresetOffer(asRoleTx(tx), ownerScope, {
                role,
                kind: request.kind,
                actions: request.actions,
                stillOffered,
                catalogVersion: storePermissionCatalogVersion,
                actorReference: String(scope.actorReference),
                operationReference: request.operationReference,
                at: now,
                auditId: options.references.next(),
                nextReference: () => options.references.next(),
              });
            } catch (error) {
              if (error instanceof RoleAdministrationStoreError) return fail("Conflict");
              throw error;
            }
            if (!(await guard(tx))) return fail("PermissionDenied");
            return { roleReference: role.record.roleReference, status };
          },
        ),
      ),
    );
  };
  /**
   * WP-2423 store-type starter roles (DEC-STORE-TYPE-STARTER-ROLES): what each kind of shop would
   * start from at the selected Store, read against the Store's roles now.
   */
  const starterSets = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current.sessionReference,
          starterActions,
          [],
          async (scope, decisions) => {
            const now = options.persistence.now();
            const roles = await listRoleAdministration(asRoleTx(tx), ownerScopeOf(scope), now);
            const allow = (code: string) => decisions.get(code)?.effect === "Allow";
            return {
              screenId: "IAM-ROLE-LIST" as const,
              sourceAsOf: now,
              mayApply: allow("identity.role.create") && allow("identity.role.change"),
              mayPutAway: allow("identity.role.deactivate"),
              started: roles.some(
                (role) =>
                  role.record.storeReference !== null &&
                  starterRoleOfCode(role.record.code) !== null,
              ),
              sets: starterStoreTypes.map((storeType) => starterSetView(roles, storeType)),
            };
          },
        ),
      ),
    );
  };
  /**
   * Starts the Store's roles from a kind of shop's set, in one transaction: each starter role the
   * Store does not have is created under its fixed code and sent for approval (approved by another
   * person, or by a sole owner alone, then turned on like any role), and, when asked, each preset
   * the shop does not use that nobody holds is removed (it can be brought back). A retry under the
   * same reference finds everything done and changes nothing; the same reference for another kind
   * of shop is a conflict.
   */
  const applyStarterSet = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    body: unknown;
  }) => {
    const request = parseStarterSetApply(input.body);
    const needed = [
      "identity.role.create",
      "identity.role.change",
      ...(request.putAway ? ["identity.role.deactivate"] : []),
    ];
    const current0 = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        authorizedRun(
          tx,
          input.sessionCookie,
          current0.sessionReference,
          needed,
          needed,
          async (scope, decisions, guard) => {
            if (needed.some((code) => decisions.get(code)?.effect !== "Allow"))
              return fail("PermissionDenied");
            const ownerScope = ownerScopeOf(scope);
            const step = (storeType: StarterStoreType, label: string) =>
              starterStepReference(request.operationReference, storeType + ":" + label);
            for (const other of starterStoreTypes) {
              if (other === request.storeType) continue;
              const set = starterRoleSet(other);
              for (const label of [
                ...set.add.map((key) => key + ":Create"),
                ...set.putAway.map((code) => code + ":Deactivate"),
              ])
                if (
                  (await findRoleAdministrationOperation(
                    asRoleTx(tx),
                    ownerScope,
                    step(other, label),
                  )) !== null
                )
                  return fail("Conflict");
            }
            const roles = await listRoleAdministration(
              asRoleTx(tx),
              ownerScope,
              options.persistence.now(),
            );
            const plan = starterSetView(roles, request.storeType);
            let added = 0,
              putAway = 0;
            for (const role of plan.roles) {
              if (role.state !== "ToAdd") continue;
              const definition = starterRole(role.key);
              const create: RoleCommandInput = {
                operation: "Create",
                roleReference: null,
                expectedVersion: null,
                operationReference: step(request.storeType, role.key + ":Create"),
                reasonCode: starterSetReason,
                draft: {
                  displayName: definition.displayName,
                  description: definition.description,
                  actions: [...definition.actions],
                },
              };
              const created = await executeCommand(
                tx,
                scope,
                decisions,
                guard,
                create,
                roleCommandIntentDigest(create),
                definition.roleCode,
              );
              const submit: RoleCommandInput = {
                operation: "Submit",
                roleReference: created.roleReference,
                expectedVersion: created.version,
                operationReference: step(request.storeType, role.key + ":Submit"),
                reasonCode: starterSetReason,
                draft: null,
              };
              await executeCommand(
                tx,
                scope,
                decisions,
                guard,
                submit,
                roleCommandIntentDigest(submit),
              );
              added += 1;
            }
            if (request.putAway)
              for (const preset of plan.putAway) {
                if (preset.held) continue;
                const role = roles.find(
                  (item) => item.record.roleReference === preset.roleReference,
                );
                if (role === undefined) continue;
                const remove: RoleCommandInput = {
                  operation: "Deactivate",
                  roleReference: preset.roleReference,
                  expectedVersion: role.record.version,
                  operationReference: step(request.storeType, role.record.code + ":Deactivate"),
                  reasonCode: starterSetReason,
                  draft: null,
                };
                await executeCommand(
                  tx,
                  scope,
                  decisions,
                  guard,
                  remove,
                  roleCommandIntentDigest(remove),
                );
                putAway += 1;
              }
            if (!(await guard(tx))) return fail("PermissionDenied");
            return { storeType: request.storeType, added, putAway };
          },
        ),
      ),
    );
  };
  return { list, detail, command, waiting, declineOffer, starterSets, applyStarterSet };
}

/** The reason every starter-set step is recorded with. */
export const starterSetReason = "ROLE_STARTER_SET";
const starterActions = [
  "identity.role.create",
  "identity.role.change",
  "identity.role.deactivate",
] as const;
/**
 * A step of a starter-set apply: its own operation reference, derived from the apply's, so a retry
 * names the same steps. It keeps the apply reference's time and is a version 7 UUID.
 */
export function starterStepReference(operationReference: string, label: string): string {
  const hash = createHash("sha256")
    .update(operationReference + ":" + label)
    .digest("hex");
  const variant = ((parseInt(hash.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return (
    operationReference.slice(0, 13) +
    "-7" +
    hash.slice(0, 3) +
    "-" +
    variant +
    hash.slice(4, 7) +
    "-" +
    hash.slice(7, 19)
  );
}
const shownName = (role: RoleAdministrationRoleView) => (role.effective ?? role.record).displayName;
/** One kind of shop's set against the Store's roles now. */
export function starterSetView(
  roles: readonly RoleAdministrationRoleView[],
  storeType: StarterStoreType,
) {
  const store = roles.filter((role) => role.record.storeReference !== null);
  const byCode = new Map(store.map((role) => [String(role.record.code), role]));
  const named = store.filter((role) => role.effective?.lifecycle !== "Deactivated");
  const taken = (name: string) =>
    named.some(
      (role) =>
        sameName(role.record.displayName, name) ||
        (role.effective !== null && sameName(role.effective.displayName, name)),
    );
  const set = starterRoleSet(storeType);
  return {
    storeType,
    label: set.label,
    roles: set.add.map((key) => {
      const definition = starterRole(key);
      const have = byCode.get(definition.roleCode);
      return {
        key,
        name: definition.displayName,
        description: definition.description,
        permissions: [...definition.actions].sort(),
        state:
          have === undefined
            ? taken(definition.displayName)
              ? ("NameTaken" as const)
              : ("ToAdd" as const)
            : have.effective?.lifecycle === "Deactivated"
              ? ("Removed" as const)
              : ("Added" as const),
        roleReference: have?.record.roleReference ?? null,
      };
    }),
    keep: set.keep.flatMap((code) => {
      const role = byCode.get(code);
      return role === undefined || role.effective?.lifecycle !== "Active"
        ? []
        : [{ roleReference: role.record.roleReference, name: shownName(role) }];
    }),
    putAway: set.putAway.flatMap((code) => {
      const role = byCode.get(code);
      if (role === undefined || role.effective?.lifecycle !== "Active" || lockedRoleCodes.has(code))
        return [];
      // Staff hold it, a staff role request would give it, or a change to it waits: it stays.
      const held =
        role.memberCount > 0 || role.openAssignmentChanges > 0 || role.effective !== role.record;
      return [
        {
          roleReference: role.record.roleReference,
          name: shownName(role),
          held,
          memberCount: role.memberCount,
        },
      ];
    }),
  };
}
export interface StarterSetApplyInput {
  readonly storeType: StarterStoreType;
  readonly operationReference: string;
  readonly putAway: boolean;
}
export function parseStarterSetApply(value: unknown): StarterSetApplyInput {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !== "operationReference,putAway,storeType" ||
    !starterStoreTypes.includes(r.storeType as StarterStoreType) ||
    typeof r.operationReference !== "string" ||
    !uuid.test(r.operationReference) ||
    typeof r.putAway !== "boolean"
  )
    return fail("Invalid");
  return {
    storeType: r.storeType as StarterStoreType,
    operationReference: r.operationReference,
    putAway: r.putAway,
  };
}

export interface PresetOfferDeclineInput {
  readonly roleReference: string;
  readonly expectedVersion: number;
  readonly operationReference: string;
  readonly kind: "Add" | "Remove";
  readonly actions: readonly string[];
}
export function parsePresetOfferDecline(value: unknown): PresetOfferDeclineInput {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !==
      "actions,expectedVersion,kind,operationReference,roleReference" ||
    typeof r.roleReference !== "string" ||
    !uuid.test(r.roleReference) ||
    !Number.isSafeInteger(r.expectedVersion) ||
    (r.expectedVersion as number) < 1 ||
    typeof r.operationReference !== "string" ||
    !uuid.test(r.operationReference) ||
    (r.kind !== "Add" && r.kind !== "Remove") ||
    !Array.isArray(r.actions) ||
    r.actions.length === 0 ||
    r.actions.length > 512 ||
    r.actions.some((action) => typeof action !== "string" || !storePermissionCodes.has(action)) ||
    new Set(r.actions).size !== r.actions.length
  )
    return fail("Invalid");
  return {
    roleReference: r.roleReference,
    expectedVersion: r.expectedVersion as number,
    operationReference: r.operationReference,
    kind: r.kind,
    actions: r.actions as string[],
  };
}
