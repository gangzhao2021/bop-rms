import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
  type CanonicalInstant,
} from "../../contracts/identity-actor.js";
import {
  parseEvidenceReference,
  parseInvitationReference,
  parseMembershipEvidenceReference,
  parseSecurityVersion,
  WorkforceIdentitySecurityError,
  type EvidenceReference,
  type InvitationReference,
  type MembershipEvidenceReference,
  type SecurityVersion,
} from "../../contracts/workforce-identity-security.js";

export interface CurrentWorkforceInvitationTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface CurrentWorkforceInvitationBinding {
  readonly actorReference: string;
  readonly invitationReference: string;
  readonly purposeCode: "BRAND_INITIAL_PROVISIONING";
}
export interface CurrentWorkforceInvitationAuthority extends CurrentWorkforceInvitationBinding {
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface CurrentWorkforceInvitationSourceOptions {
  readonly transaction: CurrentWorkforceInvitationTransaction;
  readonly binding: CurrentWorkforceInvitationBinding;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  /** Must hold the actual caller's current authority to read this exact Actor's
   * invitation for this purpose. Historical acceptance does not grant access. */
  readonly authority: {
    hold(
      tx: CurrentWorkforceInvitationTransaction,
      input: {
        readonly binding: CurrentWorkforceInvitationBinding;
        readonly observedAt: string;
        readonly validUntil: string;
      },
    ): Promise<CurrentWorkforceInvitationAuthority>;
  };
  readonly registerBeforeCommit: (
    tx: CurrentWorkforceInvitationTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export interface CurrentWorkforceInvitationEvidence {
  readonly profile: "CurrentWorkforceInvitationEvidenceV1";
  readonly invitationReference: InvitationReference;
  readonly actorReference: string;
  readonly originalMembershipReference: MembershipEvidenceReference;
  readonly providerEvidenceReference: EvidenceReference;
  readonly status: "Accepted";
  readonly version: SecurityVersion;
  readonly createdAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly consumedAt: CanonicalInstant;
  readonly observedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}
export interface CurrentWorkforceInvitationSource {
  hold(): Promise<CurrentWorkforceInvitationEvidence>;
  /** Pure post-COMMIT assertion; the host must run both registered guards first. */
  assertFinalized(): void;
}

const denied = (): never => {
  throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
};
function binding(value: unknown): CurrentWorkforceInvitationBinding {
  const r = readClosedRecord(value, ["actorReference", "invitationReference", "purposeCode"]);
  if (r.purposeCode !== "BRAND_INITIAL_PROVISIONING") return denied();
  return Object.freeze({
    actorReference: parseOpaqueUuidV7(r.actorReference, "ACTOR_REFERENCE_INVALID"),
    invitationReference: parseInvitationReference(r.invitationReference),
    purposeCode: r.purposeCode,
  });
}
function one(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const d =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")
      : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length !== 1 ||
    Reflect.ownKeys(d.value).length !== 2
  )
    return denied();
  const row = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!row?.enumerable || !("value" in row)) return denied();
  return readClosedRecord(row.value, keys);
}

/** Identity-owned historical qualification only. The invitation remains bound
 * to its original Membership; it neither authorizes nor activates a new one.
 * Keep the actual borrowed READ COMMITTED transaction through host COMMIT. */
export function createPostgresCurrentWorkforceInvitationSource(
  options: CurrentWorkforceInvitationSourceOptions,
): CurrentWorkforceInvitationSource {
  const expected = binding(options.binding),
    expectedBytes = JSON.stringify(expected),
    tx = options.transaction,
    originalQuery = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    holdAuthority = authority.hold,
    register = options.registerBeforeCommit,
    observedAt = parseCanonicalInstant(options.originalObservedAt),
    originalDeadline = parseCanonicalInstant(options.originalValidUntil);
  if (
    observedAt >= originalDeadline ||
    Date.parse(originalDeadline) > Date.parse(observedAt) + 5000 ||
    [originalQuery, now, holdAuthority, register].some((port) => typeof port !== "function")
  )
    return denied();
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    asyncCalls = 0,
    finalCalls = 0,
    asyncComplete = false,
    latest = observedAt,
    deadline = originalDeadline,
    transactionId: string | undefined,
    pinned: string | undefined;
  const poison = (): never => {
    phase = "Poison";
    return denied();
  };
  const check = () => {
    const at = parseCanonicalInstant(now.call(clock));
    if (
      phase === "Poison" ||
      phase === "Final" ||
      options.transaction !== tx ||
      tx.query !== originalQuery ||
      options.clock !== clock ||
      clock.now !== now ||
      options.authority !== authority ||
      authority.hold !== holdAuthority ||
      options.registerBeforeCommit !== register ||
      options.originalObservedAt !== observedAt ||
      options.originalValidUntil !== originalDeadline ||
      JSON.stringify(binding(options.binding)) !== expectedBytes ||
      at < latest ||
      at >= deadline
    )
      return poison();
    latest = at;
    return at;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await originalQuery.call(tx, sql, values);
    check();
    return result;
  };
  const currentAuthority = async () => {
    const at = check(),
      r = readClosedRecord(
        await holdAuthority.call(authority, tx, {
          binding: expected,
          observedAt: at,
          validUntil: deadline,
        }),
        ["actorReference", "invitationReference", "purposeCode", "observedAt", "validUntil"],
      );
    check();
    const until = parseCanonicalInstant(r.validUntil);
    if (
      r.actorReference !== expected.actorReference ||
      r.invitationReference !== expected.invitationReference ||
      r.purposeCode !== expected.purposeCode ||
      r.observedAt !== at ||
      until > deadline ||
      until <= latest
    )
      return poison();
    deadline = until;
  };
  const sameTransaction = async () => {
    const r = one(
      await query(
        "SELECT current_setting('transaction_isolation') AS isolation,pg_current_xact_id()::text AS transaction_id",
        [],
      ),
      ["isolation", "transaction_id"],
    );
    if (
      r.isolation !== "read committed" ||
      typeof r.transaction_id !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(r.transaction_id) ||
      (transactionId !== undefined && r.transaction_id !== transactionId)
    )
      return poison();
    transactionId = r.transaction_id;
  };
  const inspect = async (): Promise<CurrentWorkforceInvitationEvidence> => {
    await currentAuthority();
    await sameTransaction();
    const r = one(
      await query(
        `SELECT invitation_id::text,actor_id::text,membership_id::text,status,
          provider_evidence_id::text,version,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
          to_char(consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS consumed_at,
          (isfinite(created_at) AND isfinite(expires_at) AND isfinite(consumed_at)
            AND created_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00'
            AND expires_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00'
            AND consumed_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00'
            AND created_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'
            AND expires_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'
            AND consumed_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'
            AND created_at=date_trunc('milliseconds',created_at)
            AND expires_at=date_trunc('milliseconds',expires_at)
            AND consumed_at=date_trunc('milliseconds',consumed_at)) AS precise
        FROM bop_identity.workforce_invitation
        WHERE invitation_id=$1 AND actor_id=$2 FOR SHARE`,
        [expected.invitationReference, expected.actorReference],
      ),
      [
        "invitation_id",
        "actor_id",
        "membership_id",
        "status",
        "provider_evidence_id",
        "version",
        "created_at",
        "expires_at",
        "consumed_at",
        "precise",
      ],
    );
    const fact = Object.freeze({
      invitationReference: parseInvitationReference(r.invitation_id),
      actorReference: parseOpaqueUuidV7(r.actor_id, "ACTOR_REFERENCE_INVALID"),
      originalMembershipReference: parseMembershipEvidenceReference(r.membership_id),
      providerEvidenceReference: parseEvidenceReference(r.provider_evidence_id),
      status: "Accepted" as const,
      version: parseSecurityVersion(r.version),
      createdAt: parseCanonicalInstant(r.created_at),
      expiresAt: parseCanonicalInstant(r.expires_at),
      consumedAt: parseCanonicalInstant(r.consumed_at),
    });
    if (
      r.status !== "Accepted" ||
      r.precise !== true ||
      fact.invitationReference !== expected.invitationReference ||
      fact.actorReference !== expected.actorReference ||
      fact.createdAt > observedAt ||
      fact.consumedAt > observedAt ||
      Date.parse(fact.expiresAt) !== Date.parse(fact.createdAt) + 86_400_000 ||
      fact.consumedAt < fact.createdAt ||
      fact.consumedAt >= fact.expiresAt
    )
      return poison();
    const bytes = JSON.stringify(fact);
    if (pinned !== undefined && pinned !== bytes) return poison();
    pinned = bytes;
    await currentAuthority();
    await sameTransaction();
    check();
    return Object.freeze({
      profile: "CurrentWorkforceInvitationEvidenceV1",
      ...fact,
      observedAt,
      validUntil: deadline,
    });
  };
  const guard = async () => {
    if (busy || phase !== "Ready" || ++asyncCalls !== 1) return poison();
    busy = true;
    try {
      await inspect();
      check();
      asyncComplete = true;
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  const final = () => {
    try {
      if (busy || phase !== "Ready" || !asyncComplete || ++finalCalls !== 1) return poison();
      check();
      phase = "Final";
    } catch {
      return poison();
    }
  };
  return Object.freeze({
    async hold() {
      if (busy || phase === "Final") return poison();
      busy = true;
      try {
        // Register before any fallible read: a caught failure must not let the
        // outer initial-creation transaction commit earlier owner writes.
        if (!registered) {
          registered = true;
          await register(tx, guard, final);
        }
        check();
        const result = await inspect();
        phase = "Ready";
        return result;
      } catch {
        return poison();
      } finally {
        busy = false;
      }
    },
    assertFinalized() {
      if (phase !== "Final" || busy || asyncCalls !== 1 || finalCalls !== 1 || !asyncComplete)
        return denied();
    },
  });
}
