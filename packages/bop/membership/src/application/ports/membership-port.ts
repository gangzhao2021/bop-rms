import type { ActorReference } from "@bop/identity";
import type { BrandReference, StoreReference } from "@bop/tenant";
import type {
  Membership,
  MembershipInstant,
  MembershipReference,
  MembershipSuspension,
  MembershipVersion,
  StoreAssignment,
} from "../../domain/membership.js";

export interface MembershipPort {
  getMembership(reference: MembershipReference): Promise<Membership | null>;
  findMemberships(
    actorReference: ActorReference,
    brandReference: BrandReference,
  ): Promise<readonly Membership[]>;
  findStoreAssignments(
    membershipReference: MembershipReference,
    storeReference: StoreReference,
  ): Promise<readonly StoreAssignment[]>;
  saveMembership(membership: Membership, expectedVersion: MembershipVersion): Promise<Membership>;
  saveStoreAssignment(
    assignment: StoreAssignment,
    expectedVersion: MembershipVersion,
  ): Promise<StoreAssignment>;
  suspendMembershipAtomically(
    suspension: MembershipSuspension,
    occurredAt: MembershipInstant,
  ): Promise<MembershipSuspension>;
}
