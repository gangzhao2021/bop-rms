import {
  membershipEvidenceReference,
  parseEvidenceReference,
  roleRemovalEvidenceReference,
  storeAssignmentEvidenceReference,
  type ActorReference,
  type SecurityOperationContext,
  type SessionRevocationRequest,
  type WorkforceIdentitySecurityService,
  type WorkforceInvitation,
} from "@bop/identity";
import {
  resolveActiveMembership,
  resolveActiveStoreAssignment,
  type Membership,
  type MembershipAccessInvalidation,
  type StoreAssignment,
} from "@bop/membership";
import type { RoleAssignment } from "@bop/permission";
import type { BrandReference, StoreReference } from "@bop/tenant";

export class WorkforceIdentitySecurityCompositionError extends Error {
  constructor() {
    super("workforce identity security request denied");
    this.name = "WorkforceIdentitySecurityCompositionError";
  }
}

export interface WorkforceIdentitySecurityCompositionOptions {
  readonly service: WorkforceIdentitySecurityService;
}

export class WorkforceIdentitySecurityComposition {
  readonly #service: WorkforceIdentitySecurityService;

  constructor(options: WorkforceIdentitySecurityCompositionOptions) {
    this.#service = options.service;
  }

  async issueInvitation(input: {
    readonly actorReference: ActorReference;
    readonly brandReference: BrandReference;
    readonly storeReferences: readonly StoreReference[];
    readonly memberships: readonly Membership[];
    readonly storeAssignments: readonly StoreAssignment[];
    readonly corporateEmail: unknown;
    readonly observedAt: unknown;
    readonly operation: SecurityOperationContext;
  }): Promise<Awaited<ReturnType<WorkforceIdentitySecurityService["issueInvitation"]>>> {
    try {
      const membership = resolveActiveMembership(
        input.memberships,
        input.actorReference,
        input.brandReference,
        input.observedAt,
      );
      const assignments = input.storeReferences.map((storeReference) =>
        resolveActiveStoreAssignment(
          membership,
          input.storeAssignments,
          storeReference,
          input.observedAt,
        ),
      );
      return await this.#service.issueInvitation({
        actorReference: input.actorReference,
        membershipReference: membershipEvidenceReference(membership.membershipReference),
        storeAssignmentReferences: assignments.map((assignment) =>
          storeAssignmentEvidenceReference(assignment.storeAssignmentReference),
        ),
        corporateEmail: input.corporateEmail,
        operation: input.operation,
      });
    } catch {
      throw new WorkforceIdentitySecurityCompositionError();
    }
  }

  async revokeFromMembershipInvalidation(input: {
    readonly invalidation: MembershipAccessInvalidation;
    readonly operation: SecurityOperationContext;
  }): Promise<SessionRevocationRequest> {
    try {
      if (
        !Object.isFrozen(input.invalidation) ||
        !Object.isFrozen(input.invalidation.storeAssignmentReferences) ||
        input.invalidation.actorReference === input.operation.actingActorReference ||
        new Set(input.invalidation.storeAssignmentReferences).size !==
          input.invalidation.storeAssignmentReferences.length
      )
        throw new Error("denied");
      return await this.#service.revokeActorSessions({
        actorReference: input.invalidation.actorReference,
        reason: "MembershipDisabled",
        sourceEvidenceReference: parseEvidenceReference(input.invalidation.membershipReference),
        operation: input.operation,
      });
    } catch {
      throw new WorkforceIdentitySecurityCompositionError();
    }
  }

  async revokeFromRoleRemoval(input: {
    readonly roleAssignment: RoleAssignment;
    readonly operation: SecurityOperationContext;
  }): Promise<SessionRevocationRequest> {
    try {
      if (
        !Object.isFrozen(input.roleAssignment) ||
        input.roleAssignment.lifecycle === "Active" ||
        input.roleAssignment.actorReference === input.operation.actingActorReference
      )
        throw new Error("denied");
      return await this.#service.revokeActorSessions({
        actorReference: input.roleAssignment.actorReference,
        reason: "RoleRemoved",
        sourceEvidenceReference: roleRemovalEvidenceReference(
          input.roleAssignment.assignmentReference,
        ),
        operation: input.operation,
      });
    } catch {
      throw new WorkforceIdentitySecurityCompositionError();
    }
  }
}

export type { WorkforceInvitation };
