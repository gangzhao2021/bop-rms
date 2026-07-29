import type {
  SecurityOperationContext,
  SessionRevocationRequest,
  WorkforceIdentitySecurityService,
} from "@bop/identity";
import type { Membership, MembershipAccessInvalidation, StoreAssignment } from "@bop/membership";
import type { RoleAssignment } from "@bop/permission";
import { describe, expect, it } from "vitest";
import {
  WorkforceIdentitySecurityComposition,
  WorkforceIdentitySecurityCompositionError,
} from "./workforce-identity-security.js";

const uuid = (suffix: string) => `018f8f9a-ad3e-7a11-8d01-${suffix.padStart(12, "0")}`;
const ids = {
  actor: uuid("1"),
  admin: uuid("2"),
  brand: uuid("3"),
  store: uuid("4"),
  membership: uuid("5"),
  assignment: uuid("6"),
  roleAssignment: uuid("7"),
  correlation: uuid("8"),
  idempotency: uuid("9"),
  evidence: uuid("10"),
};
const FROM = "2026-07-29T11:00:00.000Z";
const AT = "2026-07-29T12:00:00.000Z";
const UNTIL = "2026-07-29T13:00:00.000Z";

const membership = (lifecycle: "Active" | "Suspended" = "Active") =>
  Object.freeze({
    membershipReference: ids.membership,
    actorReference: ids.actor,
    brandReference: ids.brand,
    workforceRelationshipReference: uuid("11"),
    lifecycle,
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  }) as unknown as Membership;
const assignment = (lifecycle: "Active" | "Suspended" = "Active") =>
  Object.freeze({
    storeAssignmentReference: ids.assignment,
    membershipReference: ids.membership,
    actorReference: ids.actor,
    brandReference: ids.brand,
    storeReference: ids.store,
    lifecycle,
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  }) as unknown as StoreAssignment;
const operation = Object.freeze({
  actingActorReference: ids.admin,
  purposeCode: "WORKFORCE_SECURITY",
  correlationId: ids.correlation,
  idempotencyKey: ids.idempotency,
}) as unknown as SecurityOperationContext;

function revocation(reason: string): SessionRevocationRequest {
  return Object.freeze({
    idempotencyKey: ids.idempotency,
    actorReference: ids.actor,
    reason,
    purposeCode: "WORKFORCE_SECURITY",
    correlationId: ids.correlation,
    sourceEvidenceReference: ids.evidence,
    cutoffAt: AT,
    completedAt: AT,
    revokedSessionReferences: [],
    version: 1,
  }) as unknown as SessionRevocationRequest;
}

function harness() {
  const calls: Readonly<Record<string, unknown>>[] = [];
  const service = {
    issueInvitation: async (input: Readonly<Record<string, unknown>>) => {
      calls.push(input);
      return Object.freeze({ invitation: Object.freeze({}), selector: "synthetic" });
    },
    revokeActorSessions: async (input: Readonly<Record<string, unknown>>) => {
      calls.push(input);
      return revocation(String(input.reason));
    },
  } as unknown as WorkforceIdentitySecurityService;
  return {
    calls,
    composition: new WorkforceIdentitySecurityComposition({ service }),
  };
}

describe("WP-0108 API cross-Domain composition", () => {
  it("issues only from one active exact Membership and Store Assignment", async () => {
    const { calls, composition } = harness();
    await composition.issueInvitation({
      actorReference: ids.actor as never,
      brandReference: ids.brand as never,
      storeReferences: [ids.store as never],
      memberships: [membership()],
      storeAssignments: [assignment()],
      corporateEmail: "worker@example.invalid",
      observedAt: AT,
      operation,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actorReference: ids.actor,
      membershipReference: ids.membership,
      storeAssignmentReferences: [ids.assignment],
    });
  });

  it("fails closed for suspended or ambiguous Membership evidence", async () => {
    const { composition } = harness();
    const input = {
      actorReference: ids.actor as never,
      brandReference: ids.brand as never,
      storeReferences: [ids.store as never],
      memberships: [membership("Suspended")],
      storeAssignments: [assignment()],
      corporateEmail: "worker@example.invalid",
      observedAt: AT,
      operation,
    };
    await expect(composition.issueInvitation(input)).rejects.toBeInstanceOf(
      WorkforceIdentitySecurityCompositionError,
    );
    await expect(
      composition.issueInvitation({ ...input, memberships: [membership(), membership()] }),
    ).rejects.toBeInstanceOf(WorkforceIdentitySecurityCompositionError);
  });

  it("maps bounded Membership invalidation to actor-wide revocation", async () => {
    const { calls, composition } = harness();
    const invalidation = Object.freeze({
      membershipReference: ids.membership,
      actorReference: ids.actor,
      storeAssignmentReferences: Object.freeze([ids.assignment]),
      occurredAt: AT,
    }) as unknown as MembershipAccessInvalidation;
    const result = await composition.revokeFromMembershipInvalidation({
      invalidation,
      operation,
    });
    expect(result.reason).toBe("MembershipDisabled");
    expect(calls[0]).toMatchObject({
      actorReference: ids.actor,
      reason: "MembershipDisabled",
    });
  });

  it("rejects duplicate invalidation evidence and self-revocation authority", async () => {
    const { composition } = harness();
    const duplicate = Object.freeze({
      membershipReference: ids.membership,
      actorReference: ids.actor,
      storeAssignmentReferences: Object.freeze([ids.assignment, ids.assignment]),
      occurredAt: AT,
    }) as unknown as MembershipAccessInvalidation;
    await expect(
      composition.revokeFromMembershipInvalidation({
        invalidation: duplicate,
        operation,
      }),
    ).rejects.toBeInstanceOf(WorkforceIdentitySecurityCompositionError);
    await expect(
      composition.revokeFromMembershipInvalidation({
        invalidation: Object.freeze({
          ...duplicate,
          actorReference: ids.admin,
          storeAssignmentReferences: Object.freeze([]),
        }) as unknown as MembershipAccessInvalidation,
        operation,
      }),
    ).rejects.toBeInstanceOf(WorkforceIdentitySecurityCompositionError);
  });

  it("accepts only a frozen non-active Role Assignment removal snapshot", async () => {
    const { calls, composition } = harness();
    const roleAssignment = Object.freeze({
      assignmentReference: ids.roleAssignment,
      roleReference: uuid("12"),
      membershipReference: ids.membership,
      storeAssignmentReference: ids.assignment,
      actorReference: ids.actor,
      brandReference: ids.brand,
      storeReference: ids.store,
      lifecycle: "Ended",
      effectiveFrom: FROM,
      effectiveUntil: UNTIL,
      version: 2,
      createdAt: FROM,
      updatedAt: AT,
    }) as unknown as RoleAssignment;
    const result = await composition.revokeFromRoleRemoval({ roleAssignment, operation });
    expect(result.reason).toBe("RoleRemoved");
    expect(calls[0]).toMatchObject({
      actorReference: ids.actor,
      reason: "RoleRemoved",
      sourceEvidenceReference: ids.roleAssignment,
    });
    await expect(
      composition.revokeFromRoleRemoval({
        roleAssignment: Object.freeze({
          ...roleAssignment,
          lifecycle: "Active",
        }) as RoleAssignment,
        operation,
      }),
    ).rejects.toBeInstanceOf(WorkforceIdentitySecurityCompositionError);
  });
});
