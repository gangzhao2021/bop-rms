import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { holdBrandSingleStore } from "@bop/tenant";
import {
  assignMemberToStore,
  confirmBrandMemberScope,
  confirmStoreMemberScope,
  endStoreMemberAssignment,
  listBrandMembersNotAtStore,
  listStoreMembers,
  loadStoreMember,
  memberDisplayNames,
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
import { revokeActorSessions, StoreStaffAccountError } from "@bop/identity";
import {
  dispatchStaffInvitation,
  loadStaffInvitation,
  normalizeStaffEmail,
  recordStaffInvitation,
  recordStaffInvitationDelivery,
  redispatchStaffInvitation,
  resendStaffInvitation,
  revokeStaffInvitation,
  staffInvitationsByActor,
  staffInvitationView,
  type StaffInvitationCommand,
  type StaffInvitationOptions,
} from "./merchant-staff-invitation.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { derivedReference } from "./merchant-products.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { staffRoleLabel } from "./merchant-staff-labels.js";
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
 * WP-2423 step 9: removing someone from the Store (organization.staff.manage) ends their Store roles
 * and Store assignment and signs them out at once; their Brand roles end with it, which
 * needs the same action at Brand scope. The last owner cannot be removed; nobody removes themselves.
 */
export class MerchantStaffAdministrationError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "LastOwner"
      | "BrandRolesRemain"
      | "PendingRequestsRemain"
      | "Invalid"
      // WP-2423 DEC-COGNITO-STORE-STAFF: an open invitation already goes to this email.
      | "AlreadyInvited"
      // The email typed to resend is not the invitation's email (invite again instead).
      | "EmailMismatch",
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
    }
  | {
      readonly operation: "RemoveFromStore";
      readonly actorReference: string;
      readonly operationReference: string;
    }
  | {
      /** DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 8: a Brand member gets a place here. */
      readonly operation: "AddToStore";
      readonly actorReference: string;
      readonly operationReference: string;
    }
  | StaffInvitationCommand;
const version = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail("Invalid");
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
    case "RemoveFromStore":
    case "AddToStore":
      if (keys !== "actorReference,operation,operationReference") return fail("Invalid");
      return {
        operation: r.operation,
        actorReference: ref(r.actorReference),
        operationReference: ref(r.operationReference),
      };
    // WP-2423 DEC-COGNITO-STORE-STAFF: name, work email and role are all required.
    case "Invite": {
      const email = normalizeStaffEmail(r.email);
      if (
        keys !== "displayName,email,operation,operationReference,roleReference" ||
        typeof r.displayName !== "string" ||
        email === null
      )
        return fail("Invalid");
      return {
        operation: "Invite",
        displayName: r.displayName,
        email,
        roleReference: ref(r.roleReference),
        operationReference: ref(r.operationReference),
      };
    }
    case "ResendInvitation": {
      const withEmail = Object.hasOwn(r, "email");
      const email = withEmail ? normalizeStaffEmail(r.email) : null;
      if (
        keys !==
          (withEmail
            ? "actorReference,email,expectedVersion,operation,operationReference"
            : "actorReference,expectedVersion,operation,operationReference") ||
        (withEmail && email === null)
      )
        return fail("Invalid");
      return {
        operation: "ResendInvitation",
        actorReference: ref(r.actorReference),
        expectedVersion: version(r.expectedVersion),
        operationReference: ref(r.operationReference),
        email,
      };
    }
    case "RevokeInvitation":
      if (keys !== "actorReference,expectedVersion,operation,operationReference")
        return fail("Invalid");
      return {
        operation: "RevokeInvitation",
        actorReference: ref(r.actorReference),
        expectedVersion: version(r.expectedVersion),
        operationReference: ref(r.operationReference),
      };
    default:
      return fail("Invalid");
  }
}

/**
 * WP-2423: a signed-in member records their own name the first time (Home: "Add your name so your
 * team sees who did what"). Only a member with no recorded name may do this, so the expected
 * profile version is always 0; afterwards a manager maintains the name on the staff page.
 */
export interface OwnNameCommand {
  readonly displayName: string;
  readonly expectedProfileVersion: 0;
  readonly operationReference: string;
}
export function parseOwnNameCommand(value: unknown): OwnNameCommand {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !== "displayName,expectedProfileVersion,operationReference" ||
    r.expectedProfileVersion !== 0 ||
    typeof r.displayName !== "string"
  )
    return fail("Invalid");
  return {
    displayName: r.displayName,
    expectedProfileVersion: 0,
    operationReference: ref(r.operationReference),
  };
}

export function createMerchantStaffAdministration(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  /** WP-2423 DEC-COGNITO-STORE-STAFF: in-app invitations (staff sign in with Cognito). */
  invitations?: StaffInvitationOptions;
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
    // WP-2423 DEC-COGNITO-STORE-STAFF: who was invited, when it was sent and whether it expired.
    const invitations =
      options.invitations === undefined ? null : await staffInvitationsByActor(tx, owner);
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
    // A requester may be a Brand member not assigned to this Store (a Brand Owner): name them too.
    const unnamed = pending
      .map((item) => item.requestedBy)
      .filter((reference) => reference !== viewer && !names.get(reference));
    for (const [reference, name] of await memberDisplayNames(directoryTx(tx), owner, unnamed))
      names.set(reference, name);
    // Someone without a recorded name is named by their role, never "Unnamed staff member".
    const label = (reference: string) =>
      reference === viewer
        ? "You"
        : (names.get(reference) ??
          staffRoleLabel(assignments.filter((item) => item.actorReference === reference)));
    // Segment 8: the Brand's other members who could be added here (names only; never PII).
    const elsewhere =
      actor === null && mayManage
        ? (await listBrandMembersNotAtStore(directoryTx(tx), owner))
            .filter((member) => member.actorReference !== viewer)
            .map((member) => ({
              actorReference: member.actorReference,
              label:
                member.displayName ??
                staffRoleLabel(
                  assignments.filter((item) => item.actorReference === member.actorReference),
                ),
            }))
        : [];
    return {
      screenId: actor === null ? "IAM-USER-LIST" : "IAM-USER-DETAIL",
      otherStoresStaff: elsewhere,
      sourceAsOf: now,
      viewer: {
        mayManage,
        mayApprove,
        brandMayManage,
        brandMayApprove,
        ...(invitations === null ? {} : { mayInvite: mayManage }),
      },
      // The invite form on the list offers the same roles as the detail page.
      roles: actor === null && invitations === null ? [] : roles,
      staff: members.map((member) => {
        const self = member.actorReference === viewer;
        // A role for someone still invited can be approved only after they have signed in.
        const joined = member.membershipLifecycle !== "PendingActivation";
        const invitation = invitations?.get(member.actorReference);
        return {
          ...(invitations === null
            ? {}
            : {
                invitation:
                  invitation === undefined ? null : staffInvitationView(invitation, now, mayManage),
              }),
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
              mayDecide: approves(item.scope) && !self && item.requestedBy !== viewer && joined,
              mayWithdraw: manages(item.scope) && item.requestedBy === viewer,
            })),
          mayRequest: (mayManage || brandMayManage) && !self && joined,
          // Someone still invited is withdrawn with "Cancel invitation" instead.
          mayRemove: mayManage && !self && joined,
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

  /**
   * Role requests still open for a person who never joined, closed as their invitation is
   * withdrawn (withdrawn when the viewer asked for them, otherwise rejected): nobody could ever
   * approve them, so this needs no approval right.
   */
  async function closeOpenRequests(
    tx: Tx,
    owner: { brandReference: string; storeReference: string },
    actorReference: string,
    viewer: string,
    at: string,
  ) {
    const open = (await assignmentsOf(tx, owner)).pending.filter(
      (item) => item.actorReference === actorReference,
    );
    for (const item of open)
      await decideRoleAssignment(
        permissionTx(tx),
        {
          ...(item.scope === "Store"
            ? owner
            : { brandReference: owner.brandReference, storeReference: null }),
          changeReference: item.changeReference,
          decision: item.requestedBy === viewer ? "Withdrawn" : "Rejected",
          decidedBy: viewer,
          at,
          auditReference: options.references.next(),
          snapshotReference: options.references.next(),
        },
        async () => true,
      );
  }

  /**
   * WP-2423 DEC-COGNITO-STORE-STAFF: invite, resend and cancel. Each records its intent first,
   * asks Cognito outside the transaction, then records what Cognito answered; a retried request
   * with the same operation reference answers from the record (and finishes a send in progress).
   */
  const invitationCommand = async (
    input: { sessionCookie: unknown; csrf: unknown },
    command: StaffInvitationCommand,
    invitations: StaffInvitationOptions,
  ) => {
    const current = await session(input);
    const run = <T>(work: (tx: Tx, context: Awaited<ReturnType<typeof begin>>) => Promise<T>) =>
      retryTransactionConflict(() =>
        options.persistence.transactions.run(async (tx) => {
          try {
            return await work(tx, await begin(tx));
          } catch (error) {
            if (error instanceof StoreStaffAccountError)
              return fail(
                error.code === "STORE_STAFF_NOT_FOUND"
                  ? "NotFound"
                  : error.code === "STORE_STAFF_INVALID"
                    ? "Invalid"
                    : "Conflict",
              );
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
                  : error.code === "ROLE_ASSIGNMENT_INVALID"
                    ? "Invalid"
                    : "Conflict",
              );
            throw error;
          }
        }),
      );
    async function begin(tx: Tx) {
      const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
      if (!(await may(scope, "organization.staff.manage"))) fail("PermissionDenied");
      return {
        scope,
        owner: {
          brandReference: String(scope.context.brand.brandReference),
          storeReference: String(scope.store.storeReference),
        },
        viewer: String(scope.actorReference),
        at: options.persistence.now(),
        brandAllowed: await brandMay(tx, input.sessionCookie, current.sessionReference),
      };
    }
    const record = (
      invitation: Parameters<typeof recordStaffInvitationDelivery>[1]["invitation"],
      delivery: "Sent" | "Unknown",
    ) =>
      run((tx, context) =>
        recordStaffInvitationDelivery(tx, {
          invitation,
          delivery,
          recordedBy: context.viewer,
          at: context.at,
          auditReference: options.references.next(),
        }),
      );
    switch (command.operation) {
      case "Invite": {
        const op = command.operationReference;
        const written = await run(async (tx, context) => {
          const prior = await loadStaffInvitation(tx, context.owner, op);
          if (prior !== null) {
            if (prior.invitedBy !== context.viewer) fail("Conflict");
            return { invitation: prior, replay: true };
          }
          const role = (
            await listRoleAdministration(permissionTx(tx), context.owner, context.at)
          ).find(
            (item) =>
              item.record.roleReference === command.roleReference &&
              item.record.lifecycle === "Active",
          );
          if (role === undefined) return fail("NotFound");
          const level = role.record.storeReference === null ? "Brand" : "Store";
          if (level === "Brand" && !(await context.brandAllowed("organization.staff.manage")))
            fail("PermissionDenied");
          const actorReference = derivedReference(op, "staff-invitation:actor"),
            membershipReference = derivedReference(op, "staff-invitation:membership"),
            storeAssignmentReference = derivedReference(op, "staff-invitation:store-assignment");
          const invitation = await recordStaffInvitation(tx, {
            owner: context.owner,
            pool: invitations.pool,
            provider: invitations.provider,
            invitationReference: op,
            actorReference,
            membershipReference,
            storeAssignmentReference,
            nameOperationReference: derivedReference(op, "staff-invitation:name"),
            displayName: command.displayName,
            email: command.email,
            invitedBy: context.viewer,
            kind: "Staff",
            at: context.at,
            nextReference: () => options.references.next(),
          });
          if (invitation === "AlreadyInvited") return fail("AlreadyInvited");
          await requestRoleAssignment(permissionTx(tx), {
            ...(level === "Store"
              ? context.owner
              : { brandReference: context.owner.brandReference, storeReference: null }),
            changeReference: derivedReference(op, "staff-invitation:role"),
            assignmentReference: derivedReference(op, "staff-invitation:role-assignment"),
            roleReference: command.roleReference,
            actorReference,
            membershipReference,
            storeAssignmentReference: level === "Store" ? storeAssignmentReference : null,
            requestedBy: context.viewer,
            at: context.at,
            auditReference: options.references.next(),
          });
          return { invitation, replay: false };
        });
        let invitation = written.invitation;
        if (invitation.status === "Pending" && invitation.delivery === "Sending")
          invitation = await record(
            invitation,
            await dispatchStaffInvitation(invitations.provider, invitation, command.email),
          );
        return {
          status: written.replay ? ("AlreadyApplied" as const) : ("Invited" as const),
          actorReference: invitation.actorReference,
          delivery: invitation.delivery,
        };
      }
      case "ResendInvitation": {
        const resent = await run(async (tx, context) => {
          const result = await resendStaffInvitation(tx, {
            owner: context.owner,
            provider: invitations.provider,
            actorReference: command.actorReference,
            expectedVersion: command.expectedVersion,
            email: command.email,
            resentBy: context.viewer,
            at: context.at,
            auditReference: options.references.next(),
          });
          if (result === "NotFound") return fail("NotFound");
          if (result === "EmailMismatch") return fail("EmailMismatch");
          return result;
        });
        const sent = await redispatchStaffInvitation(invitations.provider, resent, command.email);
        const recorded = await record(resent, sent.delivery);
        return {
          status: "Resent" as const,
          delivery: recorded.delivery,
          emailNeeded: sent.emailNeeded,
        };
      }
      case "RevokeInvitation": {
        const revoked = await run(async (tx, context) => {
          const result = await revokeStaffInvitation(tx, {
            owner: context.owner,
            actorReference: command.actorReference,
            expectedVersion: command.expectedVersion,
            revokedBy: context.viewer,
            at: context.at,
            nextReference: () => options.references.next(),
          });
          if (result === "NotFound") return fail("NotFound");
          if (result.status === "Applied")
            await closeOpenRequests(
              tx,
              context.owner,
              command.actorReference,
              context.viewer,
              context.at,
            );
          return result;
        });
        // The unused Cognito account goes too, so the same email can be invited again.
        const account = await invitations.provider
          .remove({
            actorReference: revoked.invitation.actorReference,
            creationIntentDigest: revoked.invitation.intentDigest,
          })
          .catch(() => "Unknown" as const);
        return {
          status: revoked.status,
          accountRemoved: account === "Removed" || account === "NotFound",
        };
      }
    }
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const command = parseStaffCommand(input.body);
    if (
      command.operation === "Invite" ||
      command.operation === "ResendInvitation" ||
      command.operation === "RevokeInvitation"
    ) {
      if (options.invitations === undefined) return fail("Invalid");
      return invitationCommand(input, command, options.invitations);
    }
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
            case "RemoveFromStore": {
              await require("organization.staff.manage");
              if (command.actorReference === viewer) fail("PermissionDenied");
              const current = await assignmentsOf(tx, owner);
              const held = current.assignments.filter(
                (item) => item.actorReference === command.actorReference,
              );
              // Open role requests close too, so none can be approved after they leave: the
              // requester's own are withdrawn, others' are rejected (which needs approval rights).
              const open = current.pending.filter(
                (item) => item.actorReference === command.actorReference,
              );
              for (const item of open)
                if (
                  item.requestedBy !== viewer &&
                  !(await (item.scope === "Store"
                    ? may(scope, "identity.role.approve")
                    : brandAllowed("identity.role.approve")))
                )
                  fail("PendingRequestsRemain");
              // Brand roles end too when this is the Brand's only Store; a Store manager cannot end
              // them, so says so instead. DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: at a Brand with
              // several Stores a Brand role is the Brand's and stays (the person may work elsewhere).
              const singleStore = await holdBrandSingleStore(
                tx as unknown as Parameters<typeof holdBrandSingleStore>[0],
                owner.brandReference,
                owner.storeReference,
              );
              if (!singleStore)
                held.splice(0, held.length, ...held.filter((item) => item.scope === "Store"));
              if (
                held.some((item) => item.scope === "Brand") &&
                !(await brandAllowed("organization.staff.manage"))
              )
                fail("BrandRolesRemain");
              for (const item of open)
                await decideRoleAssignment(
                  permissionTx(tx),
                  {
                    ...scoped(item.scope),
                    changeReference: item.changeReference,
                    decision: item.requestedBy === viewer ? "Withdrawn" : "Rejected",
                    decidedBy: viewer,
                    at,
                    auditReference: options.references.next(),
                    snapshotReference: options.references.next(),
                  },
                  async () => true,
                );
              for (const item of held)
                await revokeRoleAssignment(permissionTx(tx), {
                  ...scoped(item.scope),
                  changeReference: derivedReference(
                    command.operationReference,
                    "role:" + item.assignmentReference,
                  ),
                  assignmentReference: item.assignmentReference,
                  revokedBy: viewer,
                  at,
                  auditReference: options.references.next(),
                  snapshotReference: options.references.next(),
                });
              const ended = await endStoreMemberAssignment(
                directoryTx(tx),
                {
                  ...owner,
                  actorReference: command.actorReference,
                  operationReference: command.operationReference,
                  endedBy: viewer,
                  endedAt: at,
                  auditReference: options.references.next(),
                },
                (transaction, record) =>
                  appendAuditRecordInTransaction(
                    transaction,
                    record as unknown as Parameters<typeof appendAuditRecordInTransaction>[1],
                  ),
              );
              const signedOut = await revokeActorSessions(tx as never, {
                actorReference: command.actorReference,
                reason: "StoreAssignmentRemoved",
                at,
              });
              return {
                status: ended.status,
                requestsClosed: open.length,
                rolesEnded: held.length,
                sessionsEnded: signedOut,
              };
            }
            case "AddToStore": {
              await require("organization.staff.manage");
              const candidate = (await listBrandMembersNotAtStore(directoryTx(tx), owner)).find(
                (member) => member.actorReference === command.actorReference,
              );
              const assignmentReference = derivedReference(
                command.operationReference,
                "store-assignment",
              );
              if (candidate === undefined) {
                // Already here: the same request answers from its own assignment.
                const here = await listStoreMembers(directoryTx(tx), owner);
                if (
                  here.some(
                    (member) =>
                      member.actorReference === command.actorReference &&
                      member.storeAssignmentReference === assignmentReference,
                  )
                )
                  return { status: "AlreadyApplied" as const };
                return fail("Conflict");
              }
              await assignMemberToStore(directoryTx(tx), {
                ...owner,
                actorReference: command.actorReference,
                membershipReference: candidate.membershipReference,
                storeAssignmentReference: assignmentReference,
                at,
              });
              await appendAuditRecordInTransaction(
                tx as unknown as Parameters<typeof appendAuditRecordInTransaction>[0],
                validateAuditRecord({
                  auditId: options.references.next(),
                  brandId: owner.brandReference,
                  storeId: owner.storeReference,
                  actor: { type: "User", reference: viewer },
                  actionCode: "MEMBER_ADDED_TO_STORE",
                  targetType: "StoreAssignment",
                  targetId: assignmentReference,
                  reasonCode: "STAFF_ADDED_FROM_BRAND",
                  correlationId: command.operationReference,
                  occurredAt: at,
                  sourceChannel: "MERCHANT_WEB",
                  dataClassification: "Internal",
                  retentionPolicyCode: "AUDIT_STANDARD",
                  retentionPolicyVersion: 1,
                }),
              );
              return { status: "Added" as const };
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
  /** The signed-in member's own name state at the selected Store (merchant.access). */
  const ownProfile = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await ownScope(tx, input.sessionCookie, current.sessionReference);
        const member = await ownMember(tx, scope);
        // A Brand member without a place at this Store is named on Brand screens, not here.
        if (member === null) return { name: "NotStoreMember" as const };
        return member.displayName === null
          ? { name: "Missing" as const, profileVersion: member.profileVersion }
          : { name: "Recorded" as const, displayName: member.displayName };
      }),
    );
  };
  /** The signed-in member records their first name (never someone else's, never a rename). */
  const nameSelf = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const command = parseOwnNameCommand(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await ownScope(tx, input.sessionCookie, current.sessionReference);
        const viewer = String(scope.actorReference);
        if ((await ownMember(tx, scope)) === null) return fail("NotFound");
        try {
          const result = await setStoreMemberDisplayName(
            directoryTx(tx),
            {
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.store.storeReference,
              actorReference: viewer,
              // Version 0 only: a retried request is AlreadyApplied, a recorded name is Conflict.
              expectedProfileVersion: command.expectedProfileVersion,
              displayName: command.displayName,
              operationReference: command.operationReference,
              changedBy: viewer,
              changedAt: options.persistence.now(),
              auditReference: options.references.next(),
            },
            (transaction, record) =>
              appendAuditRecordInTransaction(
                transaction,
                record as unknown as Parameters<typeof appendAuditRecordInTransaction>[1],
              ),
          );
          return { status: result.status, profileVersion: result.profileVersion };
        } catch (error) {
          if (error instanceof MemberDirectoryError)
            return fail(
              error.code === "MEMBER_DIRECTORY_NOT_FOUND"
                ? "NotFound"
                : error.code === "MEMBER_DIRECTORY_INPUT_INVALID"
                  ? "Invalid"
                  : "Conflict",
            );
          throw error;
        }
      }),
    );
  };
  async function ownScope(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, "merchant.access", sessionReference).catch(
      () => fail("PermissionDenied"),
    );
    if (!(await scope.allowed())) fail("PermissionDenied");
    return scope;
  }
  async function ownMember(tx: Tx, scope: Awaited<ReturnType<typeof ownScope>>) {
    try {
      return await loadStoreMember(
        directoryTx(tx),
        {
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.store.storeReference,
        },
        String(scope.actorReference),
      );
    } catch (error) {
      if (error instanceof MemberDirectoryError && error.code === "MEMBER_DIRECTORY_NOT_FOUND")
        return null;
      throw error;
    }
  }
  return { query, command, ownProfile, nameSelf };
}
