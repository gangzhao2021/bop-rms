import { appendAuditRecordInTransaction } from "@bop/audit";
import {
  listStoreStaffInvitations,
  maskStaffEmail,
  recordStoreStaffInvitation,
  recordStoreStaffInvitationDelivery,
  resendStoreStaffInvitation,
  revokeStoreStaffInvitation,
  StoreStaffAccountError,
  loadStoreStaffInvitation,
  type StoreStaffInvitation,
  type StoreStaffPool,
  type StoreStaffTransaction,
} from "@bop/identity";
import {
  addInvitedStoreMember,
  setStoreMemberDisplayName,
  withdrawInvitedStoreMember,
  type MemberDirectoryTransaction,
} from "@bop/membership";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: in-app staff invitations on Section 88 IAM-USER-LIST (Actions
 * "Invite" and "Resend Invite"). An Owner or manager (organization.staff.manage) invites a person
 * with their name (required, Owner 2026-10-18 "必填（推荐）"), work email and a role; Cognito creates
 * the account and sends the email with a temporary password. The role takes effect only after
 * another administrator approves it, and only once the person has signed in. The address itself
 * is never stored here (a keyed digest and a masked hint only), logged or audited.
 */
export interface StaffInvitationProvider {
  digestCorporateEmail(corporateEmail: unknown): string;
  create(input: {
    readonly actorReference: string;
    readonly creationIntentDigest: string;
    readonly corporateEmail: string;
  }): Promise<{ readonly status: string }>;
  resend(input: { readonly actorReference: string }): Promise<"Sent" | "NotFound" | "Unknown">;
  remove(input: {
    readonly actorReference: string;
    readonly creationIntentDigest: string;
  }): Promise<"Removed" | "NotFound" | "SignedIn" | "Unknown">;
}
export interface StaffInvitationOptions {
  readonly pool: StoreStaffPool;
  readonly provider: StaffInvitationProvider;
}
export interface StaffInvitationView {
  readonly status: "Pending" | "Expired" | "Accepted" | "Revoked";
  readonly delivery: "Sending" | "Sent" | "Unknown";
  readonly emailHint: string;
  readonly sentAt: string;
  readonly expiresAt: string;
  readonly sendCount: number;
  readonly version: number;
  readonly mayResend: boolean;
  readonly mayRevoke: boolean;
}
export type StaffInvitationCommand =
  | {
      readonly operation: "Invite";
      readonly displayName: string;
      readonly email: string;
      readonly roleReference: string;
      readonly operationReference: string;
    }
  | {
      readonly operation: "ResendInvitation";
      readonly actorReference: string;
      readonly expectedVersion: number;
      readonly operationReference: string;
      readonly email: string | null;
    }
  | {
      readonly operation: "RevokeInvitation";
      readonly actorReference: string;
      readonly expectedVersion: number;
      readonly operationReference: string;
    };

/** A work email as staff typed it, compared and sent in lower case; never echoed back. */
export function normalizeStaffEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    /[\p{Cc}\p{Cf}]/u.test(email)
  )
    return null;
  return email;
}

export function staffInvitationView(
  invitation: StoreStaffInvitation,
  now: string,
  mayManage: boolean,
): StaffInvitationView {
  const status =
    invitation.status === "Pending" && now >= invitation.expiresAt ? "Expired" : invitation.status;
  const open = invitation.status === "Pending";
  return Object.freeze({
    status,
    delivery: invitation.delivery,
    emailHint: invitation.emailHint,
    sentAt: invitation.lastSentAt,
    expiresAt: invitation.expiresAt,
    sendCount: invitation.sendCount,
    version: invitation.version,
    mayResend: mayManage && open,
    mayRevoke: mayManage && open,
  });
}

/** The latest invitation of each person at the Store, by person. */
export async function staffInvitationsByActor(
  tx: unknown,
  owner: { readonly brandReference: string; readonly storeReference: string },
): Promise<ReadonlyMap<string, StoreStaffInvitation>> {
  return new Map(
    (await listStoreStaffInvitations(tx as StoreStaffTransaction, owner)).map((item) => [
      item.actorReference,
      item,
    ]),
  );
}

const auditAppend = (transaction: unknown, record: Record<string, unknown>) =>
  appendAuditRecordInTransaction(
    transaction as Parameters<typeof appendAuditRecordInTransaction>[0],
    record as unknown as Parameters<typeof appendAuditRecordInTransaction>[1],
  );

/** Writes a new invitation, its waiting Membership, the name and the role request (one transaction). */
export async function recordStaffInvitation(
  tx: unknown,
  input: {
    readonly owner: { readonly brandReference: string; readonly storeReference: string };
    readonly pool: StoreStaffPool;
    readonly provider: StaffInvitationProvider;
    readonly invitationReference: string;
    readonly actorReference: string;
    readonly membershipReference: string;
    readonly storeAssignmentReference: string;
    readonly nameOperationReference: string;
    readonly displayName: string;
    readonly email: string;
    readonly invitedBy: string;
    readonly kind: "Staff" | "FirstOwner";
    readonly at: string;
    readonly nextReference: () => string;
  },
): Promise<StoreStaffInvitation | "AlreadyInvited"> {
  const directory = tx as MemberDirectoryTransaction,
    identity = tx as StoreStaffTransaction;
  const emailDigest = input.provider.digestCorporateEmail(input.email);
  const open = await listStoreStaffInvitations(identity, input.owner);
  if (open.some((item) => item.status === "Pending" && item.emailDigest === emailDigest))
    return "AlreadyInvited";
  await addInvitedStoreMember(
    directory,
    {
      ...input.owner,
      actorReference: input.actorReference,
      membershipReference: input.membershipReference,
      storeAssignmentReference: input.storeAssignmentReference,
      invitedBy: input.invitedBy,
      invitationReference: input.invitationReference,
      at: input.at,
      auditReference: input.nextReference(),
    },
    auditAppend,
  );
  // Owner 2026-10-18: a name is required; an empty or unsafe name refuses the whole invitation.
  await setStoreMemberDisplayName(
    directory,
    {
      ...input.owner,
      actorReference: input.actorReference,
      expectedProfileVersion: 0,
      displayName: input.displayName,
      operationReference: input.nameOperationReference,
      changedBy: input.invitedBy,
      changedAt: input.at,
      auditReference: input.nextReference(),
    },
    auditAppend,
  );
  return recordStoreStaffInvitation(identity, {
    ...input.owner,
    invitationReference: input.invitationReference,
    actorReference: input.actorReference,
    membershipReference: input.membershipReference,
    storeAssignmentReference: input.storeAssignmentReference,
    invitedBy: input.invitedBy,
    kind: input.kind,
    pool: input.pool,
    emailDigest,
    emailHint: maskStaffEmail(input.email),
    at: input.at,
    auditReference: input.nextReference(),
  });
}

/** Asks Cognito to create the account and send the email; Created means accepted for delivery. */
export async function dispatchStaffInvitation(
  provider: StaffInvitationProvider,
  invitation: StoreStaffInvitation,
  email: string,
): Promise<"Sent" | "Unknown"> {
  try {
    const result = await provider.create({
      actorReference: invitation.actorReference,
      creationIntentDigest: invitation.intentDigest,
      corporateEmail: email,
    });
    return result.status === "Created" ? "Sent" : "Unknown";
  } catch {
    return "Unknown";
  }
}

/** Sends a Pending invitation again; an account Cognito never created needs the email again. */
export async function redispatchStaffInvitation(
  provider: StaffInvitationProvider,
  invitation: StoreStaffInvitation,
  email: string | null,
): Promise<{ readonly delivery: "Sent" | "Unknown"; readonly emailNeeded: boolean }> {
  let resent: "Sent" | "NotFound" | "Unknown";
  try {
    resent = await provider.resend({ actorReference: invitation.actorReference });
  } catch {
    resent = "Unknown";
  }
  if (resent === "Sent") return { delivery: "Sent", emailNeeded: false };
  if (resent === "Unknown") return { delivery: "Unknown", emailNeeded: false };
  if (email === null) return { delivery: "Unknown", emailNeeded: true };
  return {
    delivery: await dispatchStaffInvitation(provider, invitation, email),
    emailNeeded: false,
  };
}

export async function recordStaffInvitationDelivery(
  tx: unknown,
  input: {
    readonly invitation: StoreStaffInvitation;
    readonly delivery: "Sent" | "Unknown";
    readonly recordedBy: string;
    readonly at: string;
    readonly auditReference: string;
  },
): Promise<StoreStaffInvitation> {
  return recordStoreStaffInvitationDelivery(tx as StoreStaffTransaction, {
    brandReference: input.invitation.brandReference,
    storeReference: input.invitation.storeReference,
    invitationReference: input.invitation.invitationReference,
    expectedVersion: input.invitation.version,
    delivery: input.delivery,
    recordedBy: input.recordedBy,
    at: input.at,
    auditReference: input.auditReference,
  });
}

export async function resendStaffInvitation(
  tx: unknown,
  input: {
    readonly owner: { readonly brandReference: string; readonly storeReference: string };
    readonly provider: StaffInvitationProvider;
    readonly actorReference: string;
    readonly expectedVersion: number;
    readonly email: string | null;
    readonly resentBy: string;
    readonly at: string;
    readonly auditReference: string;
  },
): Promise<StoreStaffInvitation | "EmailMismatch" | "NotFound"> {
  const current = (await staffInvitationsByActor(tx, input.owner)).get(input.actorReference);
  if (current === undefined) return "NotFound";
  if (
    input.email !== null &&
    input.provider.digestCorporateEmail(input.email) !== current.emailDigest
  )
    return "EmailMismatch";
  return resendStoreStaffInvitation(tx as StoreStaffTransaction, {
    ...input.owner,
    invitationReference: current.invitationReference,
    expectedVersion: input.expectedVersion,
    resentBy: input.resentBy,
    at: input.at,
    auditReference: input.auditReference,
  });
}

export async function revokeStaffInvitation(
  tx: unknown,
  input: {
    readonly owner: { readonly brandReference: string; readonly storeReference: string };
    readonly actorReference: string;
    readonly expectedVersion: number;
    readonly revokedBy: string;
    readonly at: string;
    readonly nextReference: () => string;
  },
): Promise<
  | { readonly status: "Applied" | "AlreadyApplied"; readonly invitation: StoreStaffInvitation }
  | "NotFound"
> {
  const current = (await staffInvitationsByActor(tx, input.owner)).get(input.actorReference);
  if (current === undefined) return "NotFound";
  const revoked = await revokeStoreStaffInvitation(tx as StoreStaffTransaction, {
    ...input.owner,
    invitationReference: current.invitationReference,
    expectedVersion: input.expectedVersion,
    revokedBy: input.revokedBy,
    at: input.at,
    auditReference: input.nextReference(),
  });
  if (revoked.status === "Applied")
    await withdrawInvitedStoreMember(
      tx as MemberDirectoryTransaction,
      {
        ...input.owner,
        actorReference: current.actorReference,
        membershipReference: current.membershipReference,
        invitationReference: current.invitationReference,
        withdrawnBy: input.revokedBy,
        at: input.at,
        auditReference: input.nextReference(),
      },
      auditAppend,
    );
  return revoked;
}

export async function loadStaffInvitation(
  tx: unknown,
  owner: { readonly brandReference: string; readonly storeReference: string },
  invitationReference: string,
): Promise<StoreStaffInvitation | null> {
  try {
    return await loadStoreStaffInvitation(tx as StoreStaffTransaction, owner, invitationReference);
  } catch (error) {
    if (error instanceof StoreStaffAccountError && error.code === "STORE_STAFF_NOT_FOUND")
      return null;
    throw error;
  }
}
