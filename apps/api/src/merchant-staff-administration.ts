import { appendAuditRecordInTransaction } from "@bop/audit";
import {
  confirmBrandMemberScope,
  confirmStoreMemberScope,
  listStoreMembers,
  loadStoreMember,
  MemberDirectoryError,
  setStoreMemberDisplayName,
  type MemberDirectoryTransaction,
} from "@bop/membership";
import {
  decideRoleAssignment,
  listRoleAdministration,
  listStoreRoleAssignments,
  requestRoleAssignment,
  revokeRoleAssignment,
  RoleAssignmentError,
  type RoleAdministrationTransaction,
  type RoleAssignmentTransaction,
} from "@bop/permission";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * WP-2423: Section 88 IAM-USER-LIST / IAM-USER-DETAIL for the selected Store. Reads need
 * organization.staff.read. Maintaining names, requesting, withdrawing and revoking need
 * organization.staff.manage; approving or rejecting a role assignment needs identity.role.approve and
 * is never done by the requester or the subject.
 * DEC-PERM-BRAND-ROLES: Brand roles (Recipes, Catalog, pricing) are assigned on the same page; they
 * need the same actions held at Brand scope, and the subject needs only an Active Brand Membership.
 */
export class MerchantStaffAdministrationError extends Error {
  constructor(
    readonly code: "PermissionDenied" | "NotFound" | "Conflict" | "LastOwner" | "Invalid",
  ) {
    super(code);
    this.name = "MerchantStaffAdministrationError";
  }
}
const fail = (code: MerchantStaffAdministrationError["code"]): never => {
  throw new MerchantStaffAdministrationError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");

export type StaffCommand =
  | {
      readonly operation: "SetDisplayName";
      readonly actorReference: string;
      readonly expectedProfileVersion: number;
      readonly displayName: string;
      readonly operationReference: string;
    }
  | {
      readonly operation: "RequestRole";
      readonly actorReference: string;
      readonly roleReference: string;
      readonly operationReference: string;
    }
  | {
      readonly operation: "Approve" | "Reject" | "Withdraw";
      readonly changeReference: string;
    }
  | {
      readonly operation: "Revoke";
      readonly assignmentReference: string;
      readonly operationReference: string;
    };
export function parseStaffCommand(value: unknown): StaffCommand {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  switch (r.operation) {
    case "SetDisplayName":
      if (
        keys !== "actorReference,displayName,expectedProfileVersion,operation,operationReference" ||
        !Number.isSafeInteger(r.expectedProfileVersion) ||
        (r.expectedProfileVersion as number) < 0 ||
        typeof r.displayName !== "string"
      )
        return fail("Invalid");
      return {
        operation: "SetDisplayName",
        actorReference: ref(r.actorReference),
        expectedProfileVersion: r.expectedProfileVersion as number,
        displayName: r.displayName,
        operationReference: ref(r.operationReference),
      };
    case "RequestRole":
      if (keys !== "actorReference,operation,operationReference,roleReference")
        return fail("Invalid");
      return {
        operation: "RequestRole",
        actorReference: ref(r.actorReference),
        roleReference: ref(r.roleReference),
        operationReference: ref(r.operationReference),
      };
    case "Approve":
    case "Reject":
    case "Withdraw":
      if (keys !== "changeReference,operation") return fail("Invalid");
      return { operation: r.operation, changeReference: ref(r.changeReference) };
    case "Revoke":
      if (keys !== "assignmentReference,operation,operationReference") return fail("Invalid");
      return {
        operation: "Revoke",
        assignmentReference: ref(r.assignmentReference),
        operationReference: ref(r.operationReference),
      };
    default:
      return fail("Invalid");
  }
}

export function createMerchantStaffAdministration(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const resolveBrandScope = createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const directoryTx = (tx: Tx) => tx as unknown as MemberDirectoryTransaction;
  const permissionTx = (tx: Tx) =>
    tx as unknown as RoleAssignmentTransaction & RoleAdministrationTransaction;
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(
      tx,
      sessionCookie,
      "organization.staff.read",
      sessionReference,
    );
    if (!(await scope.allowed())) fail("PermissionDenied");
    return scope;
  }
  const may = async (scope: Awaited<ReturnType<typeof scopeFor>>, action: string) =>
    (await scope.authorizeAction(action))?.effect === "Allow";
  /** Brand-scoped decisions; a Store grant alone never satisfies them. */
  const brandMay = async (tx: Tx, sessionCookie: unknown, sessionReference: string) => {
    const brand = await resolveBrandScope(tx, sessionCookie, sessionReference).catch(() => null);
    return async (action: string) =>
      brand !== null && (await brand.authorizeAction(action))?.effect === "Allow";
  };
  /** Store and Brand assignments with the scope each one belongs to. */
  async function assignmentsOf(tx: Tx, owner: { brandReference: string; storeReference: string }) {
    const now = options.persistence.now();
    const store = await listStoreRoleAssignments(permissionTx(tx), owner, now);
    const brand = await listStoreRoleAssignments(
      permissionTx(tx),
      { brandReference: owner.brandReference, storeReference: null },
      now,
    );
    return {
      assignments: [
        ...store.assignments.map((item) => ({ ...item, scope: "Store" as const })),
        ...brand.assignments.map((item) => ({ ...item, scope: "Brand" as const })),
      ],
      pending: [
        ...store.pending.map((item) => ({ ...item, scope: "Store" as const })),
        ...brand.pending.map((item) => ({ ...item, scope: "Brand" as const })),
      ],
    };
  }

  async function view(
    tx: Tx,
    scope: Awaited<ReturnType<typeof scopeFor>>,
    actor: string | null,
    brandAllowed: (action: string) => Promise<boolean>,
  ) {
    const owner = {
      brandReference: scope.context.brand.brandReference,
      storeReference: scope.store.storeReference,
    };
    const viewer = String(scope.actorReference);
    const mayManage = await may(scope, "organization.staff.manage"),
      mayApprove = await may(scope, "identity.role.approve"),
      brandMayManage = await brandAllowed("organization.staff.manage"),
      brandMayApprove = await brandAllowed("identity.role.approve");
    const manages = (scope: "Store" | "Brand") => (scope === "Store" ? mayManage : brandMayManage),
      approves = (scope: "Store" | "Brand") => (scope === "Store" ? mayApprove : brandMayApprove);
    const now = options.persistence.now();
    const members =
      actor === null
        ? await listStoreMembers(directoryTx(tx), owner)
        : [await loadStoreMember(directoryTx(tx), owner, actor)];
    const { assignments, pending } = await assignmentsOf(tx, owner);
    const roles = (await listRoleAdministration(permissionTx(tx), owner, now))
      .filter((role) => role.record.lifecycle === "Active")
      .map((role) => ({
        roleReference: role.record.roleReference,
        code: role.record.code,
        name: role.record.displayName,
        scope: role.record.storeReference === null ? ("Brand" as const) : ("Store" as const),
      }))
      .filter((role) => manages(role.scope));
    const names = new Map(
      (actor === null ? members : await listStoreMembers(directoryTx(tx), owner)).map((member) => [
        member.actorReference,
        member.displayName,
      ]),
    );
    const label = (reference: string) =>
      reference === viewer ? "You" : (names.get(reference) ?? "Staff " + reference.slice(-4));
    return {
      screenId: actor === null ? "IAM-USER-LIST" : "IAM-USER-DETAIL",
      sourceAsOf: now,
      viewer: { mayManage, mayApprove, brandMayManage, brandMayApprove },
      roles: actor === null ? [] : roles,
      staff: members.map((member) => {
        const self = member.actorReference === viewer;
        return {
          actorReference: member.actorReference,
          displayName: member.displayName,
          label: label(member.actorReference),
          self,
          membershipStatus: member.membershipLifecycle,
          storeAssignmentStatus: member.assignmentLifecycle,
          profileVersion: member.profileVersion,
          assignments: assignments
            .filter((item) => item.actorReference === member.actorReference)
            .map((item) => ({
              assignmentReference: item.assignmentReference,
              roleReference: item.roleReference,
              roleName: item.roleName,
              scope: item.scope,
              since: item.effectiveFrom,
              mayRevoke: manages(item.scope) && !self,
            })),
          pending: pending
            .filter((item) => item.actorReference === member.actorReference)
            .map((item) => ({
              changeReference: item.changeReference,
              roleName: item.roleName,
              scope: item.scope,
              requestedBy: label(item.requestedBy),
              requestedAt: item.requestedAt,
              mayDecide: approves(item.scope) && !self && item.requestedBy !== viewer,
              mayWithdraw: manages(item.scope) && item.requestedBy === viewer,
            })),
          mayRequest: (mayManage || brandMayManage) && !self,
          mayRename: mayManage,
        };
      }),
    };
  }

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    actorReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const brandAllowed = await brandMay(tx, input.sessionCookie, current.sessionReference);
        try {
          return await view(tx, scope, input.actorReference, brandAllowed);
        } catch (error) {
          if (error instanceof MemberDirectoryError) return fail("NotFound");
          throw error;
        }
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const command = parseStaffCommand(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const owner = {
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.store.storeReference,
        };
        const viewer = String(scope.actorReference);
        const at = options.persistence.now();
        const brandAllowed = await brandMay(tx, input.sessionCookie, current.sessionReference);
        const require = async (action: string, at: "Store" | "Brand" = "Store") => {
          if (!(await (at === "Store" ? may(scope, action) : brandAllowed(action))))
            fail("PermissionDenied");
        };
        const scoped = (at: "Store" | "Brand") =>
          at === "Store" ? owner : { brandReference: owner.brandReference, storeReference: null };
        try {
          switch (command.operation) {
            case "SetDisplayName": {
              await require("organization.staff.manage");
              return await setStoreMemberDisplayName(
                directoryTx(tx),
                {
                  ...owner,
                  actorReference: command.actorReference,
                  expectedProfileVersion: command.expectedProfileVersion,
                  displayName: command.displayName,
                  operationReference: command.operationReference,
                  changedBy: viewer,
                  changedAt: at,
                  auditReference: options.references.next(),
                },
                (transaction, record) =>
                  appendAuditRecordInTransaction(
                    transaction,
                    record as unknown as Parameters<typeof appendAuditRecordInTransaction>[1],
                  ),
              );
            }
            case "RequestRole": {
              const role = (await listRoleAdministration(permissionTx(tx), owner, at)).find(
                (item) => item.record.roleReference === command.roleReference,
              );
              if (role === undefined) return fail("NotFound");
              const level = role.record.storeReference === null ? "Brand" : "Store";
              await require("organization.staff.manage", level);
              const member = await loadStoreMember(directoryTx(tx), owner, command.actorReference);
              const confirmed =
                level === "Store"
                  ? await confirmStoreMemberScope(directoryTx(tx), {
                      ...owner,
                      actorReference: member.actorReference,
                      membershipReference: member.membershipReference,
                      storeAssignmentReference: member.storeAssignmentReference,
                      at,
                    })
                  : await confirmBrandMemberScope(directoryTx(tx), {
                      brandReference: owner.brandReference,
                      actorReference: member.actorReference,
                      membershipReference: member.membershipReference,
                      at,
                    });
              if (!confirmed) fail("Conflict");
              return await requestRoleAssignment(permissionTx(tx), {
                ...scoped(level),
                changeReference: command.operationReference,
                assignmentReference: options.references.next(),
                roleReference: command.roleReference,
                actorReference: member.actorReference,
                membershipReference: member.membershipReference,
                storeAssignmentReference:
                  level === "Store" ? member.storeAssignmentReference : null,
                requestedBy: viewer,
                at,
                auditReference: options.references.next(),
              });
            }
            case "Approve":
            case "Reject":
            case "Withdraw": {
              const change = (await assignmentsOf(tx, owner)).pending.find(
                (item) => item.changeReference === command.changeReference,
              );
              if (change === undefined) return fail("NotFound");
              await require(command.operation === "Withdraw"
                ? "organization.staff.manage"
                : "identity.role.approve", change.scope);
              return await decideRoleAssignment(
                permissionTx(tx),
                {
                  ...scoped(change.scope),
                  changeReference: command.changeReference,
                  decision:
                    command.operation === "Approve"
                      ? "Approved"
                      : command.operation === "Reject"
                        ? "Rejected"
                        : "Withdrawn",
                  decidedBy: viewer,
                  at,
                  auditReference: options.references.next(),
                  snapshotReference: options.references.next(),
                },
                (member) =>
                  member.storeAssignmentReference === null
                    ? confirmBrandMemberScope(directoryTx(tx), {
                        brandReference: owner.brandReference,
                        actorReference: member.actorReference,
                        membershipReference: member.membershipReference,
                        at,
                      })
                    : confirmStoreMemberScope(directoryTx(tx), {
                        ...owner,
                        actorReference: member.actorReference,
                        membershipReference: member.membershipReference,
                        storeAssignmentReference: member.storeAssignmentReference,
                        at,
                      }),
              );
            }
            case "Revoke": {
              const assignment = (await assignmentsOf(tx, owner)).assignments.find(
                (item) => item.assignmentReference === command.assignmentReference,
              );
              if (assignment === undefined) return fail("NotFound");
              await require("organization.staff.manage", assignment.scope);
              return await revokeRoleAssignment(permissionTx(tx), {
                ...scoped(assignment.scope),
                changeReference: command.operationReference,
                assignmentReference: command.assignmentReference,
                revokedBy: viewer,
                at,
                auditReference: options.references.next(),
                snapshotReference: options.references.next(),
              });
            }
          }
        } catch (error) {
          if (error instanceof MemberDirectoryError)
            return fail(
              error.code === "MEMBER_DIRECTORY_NOT_FOUND"
                ? "NotFound"
                : error.code === "MEMBER_DIRECTORY_INPUT_INVALID"
                  ? "Invalid"
                  : "Conflict",
            );
          if (error instanceof RoleAssignmentError)
            return fail(
              error.code === "ROLE_ASSIGNMENT_NOT_FOUND"
                ? "NotFound"
                : error.code === "ROLE_ASSIGNMENT_LAST_OWNER"
                  ? "LastOwner"
                  : error.code === "ROLE_ASSIGNMENT_SELF"
                    ? "PermissionDenied"
                    : error.code === "ROLE_ASSIGNMENT_INVALID"
                      ? "Invalid"
                      : "Conflict",
            );
          throw error;
        }
      }),
    );
  };
  return { query, command };
}
