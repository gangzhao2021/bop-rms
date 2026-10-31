import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
} from "../../contracts/identity-actor.js";
import { parseRawBrowserCredential, parseSelectorHash } from "../../contracts/browser-session.js";
import { parseWorkforceAccountBindingConfiguration } from "../../contracts/workforce-account-binding.js";
import type { BrowserCredentialHasherPort } from "../../application/ports/session-credential-ports.js";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF: Identity owner of Store staff invitations and of the Cognito
 * account each invited person signed in with. An invitation keeps only a keyed digest of the work
 * email and a masked hint; Cognito holds the address and sends the email. The account binding
 * keeps only a keyed digest of the Cognito subject. Nothing here grants a permission: Membership
 * activates the person and Permission still needs an independent role approval.
 */
export interface StoreStaffTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export class StoreStaffAccountError extends Error {
  constructor(
    readonly code:
      | "STORE_STAFF_INVALID"
      | "STORE_STAFF_NOT_FOUND"
      | "STORE_STAFF_CONFLICT"
      | "STORE_STAFF_EXPIRED"
      | "STORE_STAFF_UNAVAILABLE",
  ) {
    super(code);
    this.name = "StoreStaffAccountError";
  }
}
const fail = (code: StoreStaffAccountError["code"]): never => {
  throw new StoreStaffAccountError(code);
};
export const storeStaffInvitationValidityMilliseconds = 7 * 24 * 60 * 60 * 1000;
export const storeStaffInvitationSendLimit = 20;
export type StoreStaffInvitationStatus = "Pending" | "Accepted" | "Revoked";
/** Staff: invited in the app. FirstOwner: an operator invites a new Store's first Owner.
 * ExistingMember: an operator gives a person who is already a member their own sign-in. */
export type StoreStaffInvitationKind = "Staff" | "FirstOwner" | "ExistingMember";
const invitationKinds: readonly StoreStaffInvitationKind[] = [
  "Staff",
  "FirstOwner",
  "ExistingMember",
];
export type StoreStaffInvitationDelivery = "Sending" | "Sent" | "Unknown";
export interface StoreStaffInvitation {
  readonly invitationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly membershipReference: string;
  readonly storeAssignmentReference: string;
  readonly invitedBy: string;
  readonly kind: StoreStaffInvitationKind;
  readonly environment: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly intentDigest: string;
  readonly emailDigest: string;
  readonly emailHint: string;
  readonly status: StoreStaffInvitationStatus;
  readonly delivery: StoreStaffInvitationDelivery;
  readonly sendCount: number;
  readonly createdAt: string;
  readonly lastSentAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly version: number;
}
export interface StoreStaffPool {
  readonly environment: string;
  readonly issuer: string;
  readonly clientId: string;
}
const ref = (value: unknown): string => String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
const instant = (value: unknown): string => parseCanonicalInstant(value);
function pool(value: StoreStaffPool): StoreStaffPool {
  const r = readClosedRecord(value, ["environment", "issuer", "clientId"]);
  const parsed = parseWorkforceAccountBindingConfiguration({
    environment: r.environment,
    issuer: r.issuer,
    clientIds: [r.clientId],
  });
  const clientId = parsed.clientIds[0];
  if (clientId === undefined) return fail("STORE_STAFF_INVALID");
  return Object.freeze({ environment: parsed.environment, issuer: parsed.issuer, clientId });
}
const time = (value: unknown): string => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return fail("STORE_STAFF_UNAVAILABLE");
  return value.toISOString();
};
const optionalTime = (value: unknown): string | null => (value === null ? null : time(value));
const scopeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
const columns = `invitation_id::text invitation,brand_id::text brand,store_id::text store,actor_id::text actor,
 membership_id::text membership,store_assignment_id::text assignment,invited_by_actor_id::text invited_by,
 invitation_kind,environment,issuer,client_id,intent_digest,email_digest,email_hint,status,delivery,send_count,
 created_at,last_sent_at,expires_at,accepted_at,revoked_at,version`;
function invitation(row: Record<string, unknown> | undefined): StoreStaffInvitation {
  if (row === undefined) return fail("STORE_STAFF_NOT_FOUND");
  const status = row.status,
    delivery = row.delivery,
    kind = row.invitation_kind;
  if (
    (status !== "Pending" && status !== "Accepted" && status !== "Revoked") ||
    (delivery !== "Sending" && delivery !== "Sent" && delivery !== "Unknown") ||
    !invitationKinds.includes(kind as StoreStaffInvitationKind)
  )
    return fail("STORE_STAFF_UNAVAILABLE");
  return Object.freeze({
    invitationReference: ref(row.invitation),
    brandReference: ref(row.brand),
    storeReference: ref(row.store),
    actorReference: ref(row.actor),
    membershipReference: ref(row.membership),
    storeAssignmentReference: ref(row.assignment),
    invitedBy: ref(row.invited_by),
    kind: kind as StoreStaffInvitationKind,
    environment: String(row.environment),
    issuer: String(row.issuer),
    clientId: String(row.client_id),
    intentDigest: String(row.intent_digest),
    emailDigest: String(row.email_digest),
    emailHint: String(row.email_hint),
    status,
    delivery,
    sendCount: Number(row.send_count),
    createdAt: time(row.created_at),
    lastSentAt: time(row.last_sent_at),
    expiresAt: time(row.expires_at),
    acceptedAt: optionalTime(row.accepted_at),
    revokedAt: optionalTime(row.revoked_at),
    version: Number(row.version),
  });
}

/** The provider username of an invited person (one Cognito user per person). */
export function storeStaffProviderUsername(actorReference: unknown): string {
  return "bop_" + ref(actorReference);
}
/** The person a signed Cognito username names, or null when it is not one of ours. */
export function storeStaffActorFromProviderUsername(username: unknown): string | null {
  if (typeof username !== "string" || !username.startsWith("bop_")) return null;
  try {
    return ref(username.slice(4));
  } catch {
    return null;
  }
}
/** Fixed digest of one invitation's intent; also stored on the Cognito user. */
export function storeStaffInvitationIntentDigest(input: {
  readonly invitationReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly pool: StoreStaffPool;
}): string {
  const selected = pool(input.pool);
  return (
    "sha256:" +
    sha256Hex(
      canonicalizeRfc8785({
        domain: "BOP_STORE_STAFF_INVITATION_V1",
        invitationReference: ref(input.invitationReference),
        actorReference: ref(input.actorReference),
        brandReference: ref(input.brandReference),
        storeReference: ref(input.storeReference),
        environment: selected.environment,
        issuer: selected.issuer,
        clientId: selected.clientId,
      }),
    )
  );
}
/** Keyed digest of a Cognito subject; the subject itself is never stored. */
export function storeStaffSubjectHash(
  hasher: BrowserCredentialHasherPort,
  input: { readonly environment: string; readonly issuer: string; readonly subject: unknown },
): string {
  if (
    typeof input.subject !== "string" ||
    input.subject.length < 1 ||
    input.subject.length > 128 ||
    !/^[\x21-\x7e]+$/u.test(input.subject)
  )
    return fail("STORE_STAFF_INVALID");
  const credential = parseRawBrowserCredential(
    createHash("sha256")
      .update(
        canonicalizeRfc8785({
          domain: "BOP_STORE_STAFF_SUBJECT_V1",
          environment: input.environment,
          issuer: input.issuer,
          subject: input.subject,
        }),
      )
      .digest("base64url"),
  );
  return String(parseSelectorHash(hasher.hash(credential)));
}
/** What staff screens show instead of the address: first character and the domain. */
export function maskStaffEmail(email: unknown): string {
  if (
    typeof email !== "string" ||
    email.length > 254 ||
    email !== email.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    /[\p{Cc}\p{Cf}]/u.test(email)
  )
    return fail("STORE_STAFF_INVALID");
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  const hint = Array.from(local)[0] + "•••@" + domain;
  if (Array.from(hint).length > 80) return Array.from(local)[0] + "•••@•••";
  return hint;
}

type AppendAudit = typeof appendAuditRecordInTransaction;
const audit = (
  tx: StoreStaffTransaction,
  append: AppendAudit,
  input: {
    readonly auditReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actor: { readonly type: "User"; readonly reference: string } | { type: "System" };
    readonly actionCode: string;
    readonly invitationReference: string;
    readonly reasonCode: string;
    readonly at: string;
    readonly summary: Record<string, string | number>;
  },
) =>
  append(tx, {
    auditId: input.auditReference,
    brandId: input.brandReference,
    storeId: input.storeReference,
    actor: input.actor,
    actionCode: input.actionCode,
    targetType: "StoreStaffInvitation",
    targetId: input.invitationReference,
    afterSummary: input.summary,
    reasonCode: input.reasonCode,
    correlationId: input.invitationReference,
    occurredAt: input.at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Restricted",
    retentionPolicyCode: "SECURITY_AUDIT",
    retentionPolicyVersion: 1,
  });

/** Records a new invitation (being sent now). The caller created its Membership in this transaction. */
export async function recordStoreStaffInvitation(
  tx: StoreStaffTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly invitationReference: string;
    readonly actorReference: string;
    readonly membershipReference: string;
    readonly storeAssignmentReference: string;
    readonly invitedBy: string;
    readonly kind: StoreStaffInvitationKind;
    readonly pool: StoreStaffPool;
    readonly emailDigest: string;
    readonly emailHint: string;
    readonly at: string;
    readonly auditReference: string;
  },
  append: AppendAudit = appendAuditRecordInTransaction,
): Promise<StoreStaffInvitation> {
  const selected = pool(input.pool);
  const at = instant(input.at);
  if (
    !invitationKinds.includes(input.kind) ||
    ref(input.invitedBy) === ref(input.actorReference) ||
    !/^[a-f0-9]{64}$/u.test(input.emailDigest) ||
    typeof input.emailHint !== "string"
  )
    return fail("STORE_STAFF_INVALID");
  const intentDigest = storeStaffInvitationIntentDigest({ ...input, pool: selected });
  await tx.query(scopeSql, [ref(input.brandReference), ref(input.storeReference)]);
  try {
    await tx.query("SAVEPOINT store_staff_invitation_insert", []);
    await tx.query(
      `INSERT INTO bop_identity.store_staff_invitation(brand_id,store_id,invitation_id,actor_id,membership_id,
        store_assignment_id,invited_by_actor_id,invitation_kind,environment,issuer,client_id,intent_digest,email_digest,
        email_hint,status,delivery,send_count,created_at,last_sent_at,expires_at,version,updated_at,data_classification)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Pending','Sending',1,$15,$15,$16,1,$15,'PersonalData')`,
      [
        input.brandReference,
        input.storeReference,
        ref(input.invitationReference),
        ref(input.actorReference),
        ref(input.membershipReference),
        ref(input.storeAssignmentReference),
        ref(input.invitedBy),
        input.kind,
        selected.environment,
        selected.issuer,
        selected.clientId,
        intentDigest,
        input.emailDigest,
        input.emailHint,
        at,
        new Date(Date.parse(at) + storeStaffInvitationValidityMilliseconds).toISOString(),
      ],
    );
    await tx.query("RELEASE SAVEPOINT store_staff_invitation_insert", []);
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT store_staff_invitation_insert", []);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "23505" || code === "23514") return fail("STORE_STAFF_CONFLICT");
    throw error;
  }
  await audit(tx, append, {
    auditReference: input.auditReference,
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    actor: { type: "User", reference: ref(input.invitedBy) },
    actionCode: "IDENTITY_STAFF_INVITATION_ISSUED",
    invitationReference: input.invitationReference,
    reasonCode:
      input.kind === "FirstOwner"
        ? "STORE_FIRST_OWNER"
        : input.kind === "ExistingMember"
          ? "STAFF_SIGN_IN_SWITCH"
          : "STAFF_ONBOARDING",
    at,
    summary: { subject: ref(input.actorReference), kind: input.kind },
  });
  return loadStoreStaffInvitation(tx, input, input.invitationReference);
}

export async function loadStoreStaffInvitation(
  tx: StoreStaffTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  invitationReference: string,
  lock = false,
): Promise<StoreStaffInvitation> {
  await tx.query(scopeSql, [ref(scope.brandReference), ref(scope.storeReference)]);
  return invitation(
    (
      await tx.query(
        `SELECT ${columns} FROM bop_identity.store_staff_invitation WHERE brand_id=$1 AND store_id=$2 AND invitation_id=$3` +
          (lock ? " FOR UPDATE" : ""),
        [scope.brandReference, scope.storeReference, ref(invitationReference)],
      )
    ).rows[0],
  );
}

/** The latest invitation of each person at the selected Store. */
export async function listStoreStaffInvitations(
  tx: StoreStaffTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<readonly StoreStaffInvitation[]> {
  await tx.query(scopeSql, [ref(scope.brandReference), ref(scope.storeReference)]);
  return Object.freeze(
    (
      await tx.query(
        `SELECT DISTINCT ON (actor_id) ${columns} FROM bop_identity.store_staff_invitation
         WHERE brand_id=$1 AND store_id=$2 ORDER BY actor_id,created_at DESC,invitation_id DESC`,
        [scope.brandReference, scope.storeReference],
      )
    ).rows.map((row) => invitation(row)),
  );
}

async function change(
  tx: StoreStaffTransaction,
  current: StoreStaffInvitation,
  sql: string,
  values: readonly unknown[],
): Promise<void> {
  try {
    await tx.query("SAVEPOINT store_staff_invitation_change", []);
    const updated = await tx.query(sql, values);
    await tx.query("RELEASE SAVEPOINT store_staff_invitation_change", []);
    if (updated.rows.length !== 1) fail("STORE_STAFF_CONFLICT");
  } catch (error) {
    if (error instanceof StoreStaffAccountError) throw error;
    await tx.query("ROLLBACK TO SAVEPOINT store_staff_invitation_change", []);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "23514" || code === "55000" || code === "23505") fail("STORE_STAFF_CONFLICT");
    throw error;
  }
  void current;
}

/** What Cognito answered for the current send: accepted for delivery, or not known. */
export async function recordStoreStaffInvitationDelivery(
  tx: StoreStaffTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly invitationReference: string;
    readonly expectedVersion: number;
    readonly delivery: "Sent" | "Unknown";
    readonly recordedBy: string;
    readonly at: string;
    readonly auditReference: string;
  },
  append: AppendAudit = appendAuditRecordInTransaction,
): Promise<StoreStaffInvitation> {
  if (input.delivery !== "Sent" && input.delivery !== "Unknown") return fail("STORE_STAFF_INVALID");
  const at = instant(input.at);
  const current = await loadStoreStaffInvitation(tx, input, input.invitationReference, true);
  if (current.version !== input.expectedVersion) return fail("STORE_STAFF_CONFLICT");
  // A send recorded meanwhile (a retried request) is answered from the record.
  if (current.status !== "Pending" || current.delivery !== "Sending") return current;
  await change(
    tx,
    current,
    `UPDATE bop_identity.store_staff_invitation SET delivery=$4,version=version+1,updated_at=GREATEST(updated_at,$5)
     WHERE brand_id=$1 AND store_id=$2 AND invitation_id=$3 AND version=$6 RETURNING version`,
    [
      current.brandReference,
      current.storeReference,
      current.invitationReference,
      input.delivery,
      at,
      current.version,
    ],
  );
  await audit(tx, append, {
    auditReference: input.auditReference,
    brandReference: current.brandReference,
    storeReference: current.storeReference,
    actor: { type: "User", reference: ref(input.recordedBy) },
    actionCode:
      input.delivery === "Sent"
        ? "IDENTITY_STAFF_INVITATION_SENT"
        : "IDENTITY_STAFF_INVITATION_DELIVERY_UNKNOWN",
    invitationReference: current.invitationReference,
    reasonCode: "STAFF_ONBOARDING",
    at,
    summary: { sendCount: current.sendCount },
  });
  return loadStoreStaffInvitation(tx, current, current.invitationReference);
}

/** A manager sends a Pending invitation again (also after it expired): a new 7-day window. */
export async function resendStoreStaffInvitation(
  tx: StoreStaffTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly invitationReference: string;
    readonly expectedVersion: number;
    readonly resentBy: string;
    readonly at: string;
    readonly auditReference: string;
  },
  append: AppendAudit = appendAuditRecordInTransaction,
): Promise<StoreStaffInvitation> {
  const at = instant(input.at);
  const current = await loadStoreStaffInvitation(tx, input, input.invitationReference, true);
  if (current.version !== input.expectedVersion || current.status !== "Pending")
    return fail("STORE_STAFF_CONFLICT");
  if (current.sendCount >= storeStaffInvitationSendLimit) return fail("STORE_STAFF_CONFLICT");
  if (at < current.lastSentAt) return fail("STORE_STAFF_CONFLICT");
  await change(
    tx,
    current,
    `UPDATE bop_identity.store_staff_invitation SET delivery='Sending',send_count=send_count+1,last_sent_at=$4,
       expires_at=$5,version=version+1,updated_at=$4
     WHERE brand_id=$1 AND store_id=$2 AND invitation_id=$3 AND version=$6 AND status='Pending' RETURNING version`,
    [
      current.brandReference,
      current.storeReference,
      current.invitationReference,
      at,
      new Date(Date.parse(at) + storeStaffInvitationValidityMilliseconds).toISOString(),
      current.version,
    ],
  );
  await audit(tx, append, {
    auditReference: input.auditReference,
    brandReference: current.brandReference,
    storeReference: current.storeReference,
    actor: { type: "User", reference: ref(input.resentBy) },
    actionCode: "IDENTITY_STAFF_INVITATION_RESENT",
    invitationReference: current.invitationReference,
    reasonCode: "STAFF_ONBOARDING",
    at,
    summary: { sendCount: current.sendCount + 1 },
  });
  return loadStoreStaffInvitation(tx, current, current.invitationReference);
}

/** A manager withdraws a Pending invitation; the caller ends its Membership in this transaction. */
export async function revokeStoreStaffInvitation(
  tx: StoreStaffTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly invitationReference: string;
    readonly expectedVersion: number;
    readonly revokedBy: string;
    readonly at: string;
    readonly auditReference: string;
  },
  append: AppendAudit = appendAuditRecordInTransaction,
): Promise<{
  readonly status: "Applied" | "AlreadyApplied";
  readonly invitation: StoreStaffInvitation;
}> {
  const at = instant(input.at);
  const current = await loadStoreStaffInvitation(tx, input, input.invitationReference, true);
  if (current.status === "Revoked") return { status: "AlreadyApplied", invitation: current };
  if (current.version !== input.expectedVersion || current.status !== "Pending")
    return fail("STORE_STAFF_CONFLICT");
  await change(
    tx,
    current,
    `UPDATE bop_identity.store_staff_invitation SET status='Revoked',revoked_at=$4,revoked_by_actor_id=$5,
       version=version+1,updated_at=GREATEST(updated_at,$4)
     WHERE brand_id=$1 AND store_id=$2 AND invitation_id=$3 AND version=$6 AND status='Pending' RETURNING version`,
    [
      current.brandReference,
      current.storeReference,
      current.invitationReference,
      at,
      ref(input.revokedBy),
      current.version,
    ],
  );
  await audit(tx, append, {
    auditReference: input.auditReference,
    brandReference: current.brandReference,
    storeReference: current.storeReference,
    actor: { type: "User", reference: ref(input.revokedBy) },
    actionCode: "IDENTITY_STAFF_INVITATION_REVOKED",
    invitationReference: current.invitationReference,
    reasonCode: "STAFF_ONBOARDING",
    at,
    summary: { subject: current.actorReference },
  });
  return {
    status: "Applied",
    invitation: await loadStoreStaffInvitation(tx, current, current.invitationReference),
  };
}

async function signInScope(
  tx: StoreStaffTransaction,
  values: { readonly actorReference: string | null; readonly subjectHash: string | null },
) {
  await tx.query(
    "SELECT set_config('bop.store_staff_actor_id',$1,true),set_config('bop.store_staff_subject_hash',$2,true)",
    [values.actorReference ?? "", values.subjectHash ?? ""],
  );
}

/** The person bound to this Cognito account in this pool, or null (a first sign-in). */
export async function findStoreStaffAccount(
  tx: StoreStaffTransaction,
  input: { readonly pool: StoreStaffPool; readonly subjectHash: string },
): Promise<string | null> {
  const selected = pool(input.pool),
    subjectHash = String(parseSelectorHash(input.subjectHash));
  await signInScope(tx, { actorReference: null, subjectHash });
  try {
    const rows = (
      await tx.query(
        "SELECT actor_id::text actor FROM bop_identity.store_staff_account WHERE environment=$1 AND issuer=$2 AND subject_hash=$3",
        [selected.environment, selected.issuer, subjectHash],
      )
    ).rows;
    if (rows.length > 1) return fail("STORE_STAFF_UNAVAILABLE");
    return rows[0] === undefined ? null : ref(rows[0].actor);
  } finally {
    await signInScope(tx, { actorReference: null, subjectHash: null }).catch(() => undefined);
  }
}

/** Whether this person has a bound Cognito account in this pool (a current session re-check). */
export async function hasStoreStaffAccount(
  tx: StoreStaffTransaction,
  input: { readonly pool: StoreStaffPool; readonly actorReference: string },
): Promise<boolean> {
  const selected = pool(input.pool),
    actorReference = ref(input.actorReference);
  await signInScope(tx, { actorReference, subjectHash: null });
  try {
    const rows = (
      await tx.query(
        "SELECT 1 FROM bop_identity.store_staff_account WHERE environment=$1 AND issuer=$2 AND actor_id=$3",
        [selected.environment, selected.issuer, actorReference],
      )
    ).rows;
    return rows.length === 1;
  } finally {
    await signInScope(tx, { actorReference: null, subjectHash: null }).catch(() => undefined);
  }
}

/**
 * A person's first sign-in: binds the Cognito account to their own Pending, unexpired invitation
 * in this pool and records that their authenticator was set up (Cognito requires it). The caller
 * has checked the Cognito user (username, invitation intent, email) and activates the Membership
 * in this transaction. Expired or revoked invitations are refused.
 */
export async function acceptStoreStaffInvitation(
  tx: StoreStaffTransaction,
  input: {
    readonly pool: StoreStaffPool;
    readonly actorReference: string;
    readonly subjectHash: string;
    readonly authenticatedAt: string;
    readonly at: string;
    readonly auditReference: string;
    readonly mfaEvidenceReference: string;
    /** Checks the Cognito user against the invitation before anything is written. */
    readonly confirm: (invitation: StoreStaffInvitation) => Promise<boolean>;
  },
  append: AppendAudit = appendAuditRecordInTransaction,
): Promise<StoreStaffInvitation> {
  const selected = pool(input.pool),
    actorReference = ref(input.actorReference),
    subjectHash = String(parseSelectorHash(input.subjectHash)),
    at = instant(input.at),
    authenticatedAt = instant(input.authenticatedAt);
  if (authenticatedAt > at) return fail("STORE_STAFF_INVALID");
  await signInScope(tx, { actorReference, subjectHash });
  try {
    const found = (
      await tx.query(
        `SELECT ${columns} FROM bop_identity.store_staff_invitation
         WHERE actor_id=$1 AND environment=$2 AND issuer=$3 AND client_id=$4 AND status='Pending' FOR UPDATE`,
        [actorReference, selected.environment, selected.issuer, selected.clientId],
      )
    ).rows;
    if (found.length !== 1) return fail("STORE_STAFF_NOT_FOUND");
    const current = invitation(found[0]);
    if (at >= current.expiresAt) return fail("STORE_STAFF_EXPIRED");
    if ((await input.confirm(current)) !== true) return fail("STORE_STAFF_CONFLICT");
    await tx.query(scopeSql, [current.brandReference, current.storeReference]);
    try {
      await tx.query("SAVEPOINT store_staff_account_bind", []);
      await tx.query(
        `INSERT INTO bop_identity.store_staff_account(environment,issuer,subject_hash,actor_id,brand_id,store_id,
          invitation_id,bound_at,audit_id,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RestrictedSecurity')`,
        [
          selected.environment,
          selected.issuer,
          subjectHash,
          actorReference,
          current.brandReference,
          current.storeReference,
          current.invitationReference,
          at,
          ref(input.auditReference),
        ],
      );
      const updated = await tx.query(
        `UPDATE bop_identity.store_staff_invitation SET status='Accepted',accepted_at=$4,version=version+1,
           updated_at=GREATEST(updated_at,$4)
         WHERE brand_id=$1 AND store_id=$2 AND invitation_id=$3 AND status='Pending' AND version=$5 RETURNING version`,
        [
          current.brandReference,
          current.storeReference,
          current.invitationReference,
          at,
          current.version,
        ],
      );
      if (updated.rows.length !== 1) fail("STORE_STAFF_CONFLICT");
      await tx.query("RELEASE SAVEPOINT store_staff_account_bind", []);
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT store_staff_account_bind", []);
      if (error instanceof StoreStaffAccountError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      // Another account already bound to this person or this account to another person.
      if (code === "23505" || code === "23514" || code === "55000") fail("STORE_STAFF_CONFLICT");
      throw error;
    }
    // Cognito requires an authenticator before the first sign-in completes.
    await tx.query(
      `INSERT INTO bop_identity.workforce_mfa_status(actor_id,status,provider_evidence_id,verified_at,reset_at,version)
       VALUES($1,'TotpVerified',$2,$3,NULL,1) ON CONFLICT (actor_id) DO NOTHING`,
      [actorReference, ref(input.mfaEvidenceReference), authenticatedAt],
    );
    await audit(tx, append, {
      auditReference: input.auditReference,
      brandReference: current.brandReference,
      storeReference: current.storeReference,
      actor: { type: "User", reference: actorReference },
      actionCode: "IDENTITY_STAFF_INVITATION_ACCEPTED",
      invitationReference: current.invitationReference,
      reasonCode: "STAFF_ONBOARDING",
      at,
      summary: { kind: current.kind },
    });
    return await loadStoreStaffInvitation(tx, current, current.invitationReference);
  } finally {
    await signInScope(tx, { actorReference: null, subjectHash: null }).catch(() => undefined);
  }
}
