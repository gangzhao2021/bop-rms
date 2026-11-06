import { createHash } from "node:crypto";
import { listStoreMembers, type MemberDirectoryTransaction } from "@bop/membership";
import {
  createPostgresRoleAdministrationPorts,
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
  rolePresetActions,
  RoleAdministrationContractError,
  RoleAdministrationServiceError,
  RoleAdministrationStoreError,
  storePermissionCatalog,
  storePermissionCodes,
  type RoleAdministrationRoleView,
  type RoleAdministrationTransaction,
  type RoleAdministrationVersionRecord,
  type RoleAssignmentTransaction,
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
  };
}
const presetOf = (record: RoleAdministrationVersionRecord) =>
  rolePresetActions(record.code, record.storeReference === null ? "Brand" : "Store");
/** A preset's current content as catalog codes (its legacy codes are added back on selection). */
const presetCatalogCodes = (record: RoleAdministrationVersionRecord) =>
  (presetOf(record) ?? []).filter((action) => catalog.has(action));

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
                                    otherApprovers: gate.otherApprovers.map(
                                      (item) => item.displayName,
                                    ),
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

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const command = parseRoleCommandInput(input.body);
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
          async (scope, decisions, guard) => {
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
              if (prior.commandType !== command.operation || prior.actorReference !== viewer)
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
                role = await loadRoleAdministration(
                  asRoleTx(tx),
                  ownerScope,
                  command.roleReference,
                  now,
                );
              } catch (error) {
                if (error instanceof RoleAdministrationStoreError) return fail("NotFound");
                throw error;
              }
              if (role.record.storeReference === null) fail("PermissionDenied");
              if (role.record.version !== command.expectedVersion) fail("Conflict");
            }
            const current = role?.record ?? null;
            // A name is unique among this Store's roles in use or waiting (removed ones keep theirs).
            if (command.draft !== null) {
              const name = command.draft.displayName;
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
                            (scope as { selected: { tenantReference: string } }).selected
                              .tenantReference,
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
                          ? { code: generatedRoleCode(command.operationReference) }
                          : {}),
                        displayName: restore
                          ? (current as RoleAdministrationVersionRecord).displayName
                          : (command.draft?.displayName ?? ""),
                        description: restore
                          ? (current as RoleAdministrationVersionRecord).description
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
          },
        ),
      ),
    );
  };
  return { list, detail, command, waiting };
}
