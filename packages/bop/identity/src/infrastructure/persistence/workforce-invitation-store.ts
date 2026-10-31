import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createIdentityActor,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
  type IdentityActor,
} from "../../contracts/identity-actor.js";
import { parseSelectorHash } from "../../contracts/browser-session.js";
import {
  parseCorrelationReference,
  parseIdempotencyReference,
  parsePurposeCode,
} from "../../contracts/authentication-session.js";
import {
  createWorkforceInvitation,
  parseEvidenceReference,
  parseInvitationReference,
  parseMembershipEvidenceReference,
  parseSecurityVersion,
  parseStoreAssignmentEvidenceReference,
  WorkforceIdentitySecurityError,
  type WorkforceInvitation,
} from "../../contracts/workforce-identity-security.js";
import type { IssueWorkforceInvitationCommand } from "../../application/ports/workforce-identity-security-port.js";
import type { IdentitySecurityAuditDescriptor } from "../../application/ports/identity-security-audit-port.js";

export interface WorkforceInvitationTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface WorkforceInvitationBinding {
  readonly operatorReference: string;
  readonly actorReference: string;
  readonly membershipReference: string;
  readonly purposeCode: "WORKFORCE_ONBOARDING";
  readonly action: "IssueInvitation" | "AcceptInvitation";
  readonly operationReference: string;
  readonly correlationReference: string;
}
export interface WorkforceInvitationStoreOptions {
  readonly transaction: WorkforceInvitationTransaction;
  readonly binding: WorkforceInvitationBinding;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  /** The outer source owns genuine current onboarding/Member authority. This
   * leaf verifies its exact action/request/actual operator, never Member tables. */
  readonly authority: {
    hold(
      tx: WorkforceInvitationTransaction,
      input: {
        readonly binding: WorkforceInvitationBinding;
        readonly requestDigest: string;
        readonly observedAt: string;
        readonly validUntil: string;
      },
    ): Promise<{
      readonly binding: WorkforceInvitationBinding;
      readonly requestDigest: string;
      readonly operator: IdentityActor;
      readonly validUntil: string;
    }>;
  };
  readonly appendAudit: (
    tx: WorkforceInvitationTransaction,
    descriptor: IdentitySecurityAuditDescriptor,
  ) => Promise<void>;
  readonly registerBeforeCommit: (
    tx: WorkforceInvitationTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export interface WorkforceInvitationPendingRequest {
  readonly selectorHash: string;
  readonly emailDigest: string;
  readonly actorReference: string;
  readonly membershipReference: string;
}
export interface WorkforceInvitationConsumeRequest extends WorkforceInvitationPendingRequest {
  readonly invitationReference: string;
  readonly expectedVersion: number;
  readonly providerEvidenceReference: string;
  readonly observedAt: string;
}
export interface WorkforceInvitationStore {
  createInvitation(command: IssueWorkforceInvitationCommand): Promise<WorkforceInvitation>;
  readPending(request: WorkforceInvitationPendingRequest): Promise<WorkforceInvitation | null>;
  consumeInvitation(request: WorkforceInvitationConsumeRequest): Promise<WorkforceInvitation>;
  assertFinalized(): void;
}
const fail = (): never => {
  throw new WorkforceIdentitySecurityError("WORKFORCE_SECURITY_DENIED");
};
const ref = (v: unknown) => parseOpaqueUuidV7(v, "ACTOR_REFERENCE_INVALID");
const instant = (v: unknown) => {
  const at = parseCanonicalInstant(v);
  if (at.startsWith("0000-")) return fail();
  return at;
};
const bytes = (v: unknown) => canonicalizeRfc8785(v);
function bind(v: unknown): WorkforceInvitationBinding {
  const r = readClosedRecord(v, [
    "operatorReference",
    "actorReference",
    "membershipReference",
    "purposeCode",
    "action",
    "operationReference",
    "correlationReference",
  ]);
  if (
    r.purposeCode !== "WORKFORCE_ONBOARDING" ||
    (r.action !== "IssueInvitation" && r.action !== "AcceptInvitation")
  )
    return fail();
  const b = Object.freeze({
    operatorReference: ref(r.operatorReference),
    actorReference: ref(r.actorReference),
    membershipReference: parseMembershipEvidenceReference(r.membershipReference),
    purposeCode: r.purposeCode,
    action: r.action,
    operationReference: parseIdempotencyReference(r.operationReference),
    correlationReference: parseCorrelationReference(r.correlationReference),
  });
  if (b.action === "AcceptInvitation" && b.operatorReference !== b.actorReference) return fail();
  return b;
}
function dense(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    result.push(d.value);
  }
  return Object.freeze(result);
}
function row(result: unknown): Readonly<Record<string, unknown>> | null {
  const d =
    result !== null && typeof result === "object"
      ? Object.getOwnPropertyDescriptor(result, "rows")
      : undefined;
  if (!d || !("value" in d)) return fail();
  const rows = dense(d.value, 1);
  return rows.length
    ? readClosedRecord(rows[0], [
        "invitation_id",
        "actor_id",
        "inviter_actor_id",
        "membership_id",
        "store_assignment_ids",
        "email_digest",
        "selector_hash",
        "status",
        "created_at",
        "expires_at",
        "consumed_at",
        "provider_evidence_id",
        "version",
        "precise",
      ])
    : null;
}
const projection = `invitation_id::text,actor_id::text,inviter_actor_id::text,membership_id::text,store_assignment_ids,
 encode(email_digest,'hex') AS email_digest,encode(selector_hash,'hex') AS selector_hash,status,provider_evidence_id::text,version,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
 to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
 to_char(consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS consumed_at,
 (isfinite(created_at) AND isfinite(expires_at) AND created_at>=TIMESTAMPTZ '0001-01-01' AND expires_at<TIMESTAMPTZ '10000-01-01'
 AND created_at=date_trunc('milliseconds',created_at) AND expires_at=date_trunc('milliseconds',expires_at)
 AND (consumed_at IS NULL OR (isfinite(consumed_at) AND consumed_at>=TIMESTAMPTZ '0001-01-01' AND consumed_at<TIMESTAMPTZ '10000-01-01' AND consumed_at=date_trunc('milliseconds',consumed_at)))) AS precise`;
function decode(r: Readonly<Record<string, unknown>> | null): WorkforceInvitation | null {
  if (!r) return null;
  if (r.precise !== true) return fail();
  if (
    (r.status === "Pending" && r.provider_evidence_id !== null) ||
    (r.status === "Accepted" && r.provider_evidence_id === null)
  )
    return fail();
  return createWorkforceInvitation({
    invitationReference: r.invitation_id,
    actorReference: r.actor_id,
    inviterActorReference: r.inviter_actor_id,
    membershipReference: r.membership_id,
    storeAssignmentReferences: dense(r.store_assignment_ids, 100),
    emailDigest: r.email_digest,
    selectorHash: r.selector_hash,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    consumedAt: r.consumed_at,
    providerEvidenceReference: r.provider_evidence_id,
    version: r.version,
  });
}

/** Borrowed owner leaf only: callers arbitrate durable original operations and
 * Provider Unknown before calling it. It allocates/delivers nothing and starts
 * no transaction. The host must execute both registered guards before COMMIT. */
export function createPostgresWorkforceInvitationStore(
  options: WorkforceInvitationStoreOptions,
): WorkforceInvitationStore {
  readClosedRecord(options, [
    "transaction",
    "binding",
    "clock",
    "originalObservedAt",
    "originalValidUntil",
    "authority",
    "appendAudit",
    "registerBeforeCommit",
  ]);
  readClosedRecord(options.clock, ["now"]);
  readClosedRecord(options.authority, ["hold"]);
  const expected = bind(options.binding),
    expectedBytes = bytes(expected),
    tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.hold,
    audit = options.appendAudit,
    register = options.registerBeforeCommit;
  const origin = instant(options.originalObservedAt),
    originalEnd = instant(options.originalValidUntil);
  if (
    [queryPort, now, hold, audit, register].some((p) => typeof p !== "function") ||
    origin >= originalEnd ||
    Date.parse(originalEnd) > Date.parse(origin) + 5000
  )
    return fail();
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    admitted = false,
    written = false,
    checked = false,
    latest = origin,
    deadline = originalEnd,
    txid: string | undefined,
    operatorPin: string | undefined;
  let requestDigest: string | undefined,
    readBack: (() => Promise<WorkforceInvitation | null>) | undefined,
    expectedRecord: string | undefined,
    operatorForAudit: IdentityActor | undefined;
  const poison = (): never => {
    phase = "Poison";
    return fail();
  };
  const check = () => {
    try {
      const at = instant(now.call(clock));
      if (
        phase === "Poison" ||
        phase === "Final" ||
        options.transaction !== tx ||
        tx.query !== queryPort ||
        options.clock !== clock ||
        clock.now !== now ||
        options.authority !== authority ||
        authority.hold !== hold ||
        options.appendAudit !== audit ||
        options.registerBeforeCommit !== register ||
        options.originalObservedAt !== origin ||
        options.originalValidUntil !== originalEnd ||
        bytes(bind(options.binding)) !== expectedBytes ||
        at < latest ||
        at >= deadline
      )
        return poison();
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  };
  const currentAuthority = async () => {
    const at = check();
    if (!requestDigest) return poison();
    const result = await hold.call(authority, tx, {
      binding: expected,
      requestDigest,
      observedAt: at,
      validUntil: deadline,
    });
    check();
    const r = readClosedRecord(result, ["binding", "requestDigest", "operator", "validUntil"]),
      operator = createIdentityActor(r.operator),
      until = parseCanonicalInstant(r.validUntil);
    if (
      bytes(bind(r.binding)) !== expectedBytes ||
      r.requestDigest !== requestDigest ||
      operator.actorType !== "User" ||
      operator.status !== "Active" ||
      !["Platform", "Workforce"].includes(operator.accountKind) ||
      operator.actorReference !== expected.operatorReference ||
      operator.authenticationMethod !== "Oidc" ||
      operator.verificationLevel !== "RecentMfa" ||
      operator.recentMfaAt === null ||
      operator.authenticatedAt > origin ||
      operator.recentMfaAt > origin ||
      Date.parse(operator.recentMfaAt) + 900000 <= Date.parse(latest) ||
      until > deadline ||
      until <= latest
    )
      return poison();
    const pin = bytes(operator);
    if (operatorPin !== undefined && operatorPin !== pin) return poison();
    operatorPin = pin;
    operatorForAudit = operator;
    const mfaEnd = parseCanonicalInstant(
      new Date(Date.parse(operator.recentMfaAt) + 900000).toISOString(),
    );
    deadline = until < mfaEnd ? until : mfaEnd;
    check();
  };
  const sameTx = async () => {
    const result = await query(
      "SELECT current_setting('transaction_isolation') AS isolation,pg_current_xact_id()::text AS transaction_id",
      [],
    );
    const d =
      result !== null && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "rows")
        : undefined;
    if (!d || !("value" in d)) return poison();
    const rows = dense(d.value, 1);
    if (rows.length !== 1) return poison();
    const r = readClosedRecord(rows[0], ["isolation", "transaction_id"]);
    if (
      r.isolation !== "read committed" ||
      typeof r.transaction_id !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(r.transaction_id) ||
      (txid !== undefined && txid !== r.transaction_id)
    )
      return poison();
    txid = r.transaction_id;
  };
  const verify = async () => {
    await currentAuthority();
    await sameTx();
    if (!readBack || expectedRecord === undefined) return poison();
    const record = await readBack();
    if (bytes(record) !== expectedRecord) return poison();
    await currentAuthority();
    check();
  };
  const guard = async () => {
    if (busy || phase !== "Ready" || checked) return poison();
    busy = true;
    try {
      await verify();
      checked = true;
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  const final = () => {
    if (busy || phase !== "Ready" || !checked) return poison();
    check();
    phase = "Final";
  };
  const protect = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy || phase === "Final" || checked) return poison();
    busy = true;
    try {
      if (!registered) {
        registered = true;
        await register(tx, guard, final);
      }
      check();
      const result = await work();
      check();
      phase = "Ready";
      return result;
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  const admit = async (request: unknown) => {
    requestDigest = `sha256:${sha256Hex(bytes(request))}`;
    if (!admitted) {
      await query(
        "SELECT pg_advisory_xact_lock(hashtextextended('WORKFORCE_INVITATION:'||$1::text||':'||$2::text,0))",
        [expected.actorReference, expected.membershipReference],
      );
      admitted = true;
    }
    await currentAuthority();
    await sameTx();
    // A borrowed autocommit client must fail before any owner write commits.
    await sameTx();
  };
  const pending = (value: unknown, extra: readonly string[] = []) => {
    const r = readClosedRecord(value, [
      "selectorHash",
      "emailDigest",
      "actorReference",
      "membershipReference",
      ...extra,
    ]);
    const p = Object.freeze({
      selectorHash: parseSelectorHash(r.selectorHash),
      emailDigest: parseSelectorHash(r.emailDigest),
      actorReference: ref(r.actorReference),
      membershipReference: parseMembershipEvidenceReference(r.membershipReference),
    });
    if (
      p.actorReference !== expected.actorReference ||
      p.membershipReference !== expected.membershipReference
    )
      return poison();
    return { p, r };
  };
  const byId = async (id: string) => {
    const record = decode(
      row(
        await query(
          `SELECT ${projection} FROM bop_identity.workforce_invitation WHERE invitation_id=$1 AND actor_id=$2 AND membership_id=$3 FOR UPDATE`,
          [id, expected.actorReference, expected.membershipReference],
        ),
      ),
    );
    if (
      record &&
      (record.invitationReference !== id ||
        record.actorReference !== expected.actorReference ||
        record.membershipReference !== expected.membershipReference)
    )
      return poison();
    return record;
  };
  const remember = (
    record: WorkforceInvitation | null,
    reader: () => Promise<WorkforceInvitation | null>,
  ) => {
    readBack = reader;
    expectedRecord = bytes(record);
    if (record && record.status === "Pending")
      deadline = record.expiresAt < deadline ? record.expiresAt : deadline;
    check();
  };
  const append = async (
    operation: "InvitationIssued" | "InvitationAccepted",
    record: WorkforceInvitation,
  ) => {
    check();
    if (!operatorForAudit?.actorReference) return poison();
    const result = await audit(
      tx,
      Object.freeze({
        operation,
        actorReference: operatorForAudit.actorReference,
        targetActorReference: record.actorReference,
        purposeCode: parsePurposeCode(expected.purposeCode),
        correlationId: parseCorrelationReference(expected.correlationReference),
        idempotencyKey: parseIdempotencyReference(expected.operationReference),
        occurredAt: origin,
        resultCount: 1,
      }),
    );
    check();
    if (result !== undefined) return poison();
  };
  return Object.freeze({
    createInvitation(command: IssueWorkforceInvitationCommand) {
      return protect(async () => {
        if (written || expected.action !== "IssueInvitation") return poison();
        const r = readClosedRecord(command, [
          "invitationReference",
          "actorReference",
          "inviterActorReference",
          "membershipReference",
          "storeAssignmentReferences",
          "emailDigest",
          "selectorHash",
          "observedAt",
        ]);
        const c = Object.freeze({
          invitationReference: parseInvitationReference(r.invitationReference),
          actorReference: ref(r.actorReference),
          inviterActorReference: ref(r.inviterActorReference),
          membershipReference: parseMembershipEvidenceReference(r.membershipReference),
          storeAssignmentReferences: Object.freeze(
            dense(r.storeAssignmentReferences, 100).map(parseStoreAssignmentEvidenceReference),
          ),
          emailDigest: parseSelectorHash(r.emailDigest),
          selectorHash: parseSelectorHash(r.selectorHash),
          observedAt: parseCanonicalInstant(r.observedAt),
        });
        if (
          c.actorReference !== expected.actorReference ||
          c.inviterActorReference !== expected.operatorReference ||
          c.membershipReference !== expected.membershipReference ||
          c.observedAt !== origin ||
          new Set(c.storeAssignmentReferences).size !== c.storeAssignmentReferences.length
        )
          return poison();
        const wanted = createWorkforceInvitation({
          invitationReference: c.invitationReference,
          actorReference: c.actorReference,
          inviterActorReference: c.inviterActorReference,
          membershipReference: c.membershipReference,
          storeAssignmentReferences: c.storeAssignmentReferences,
          emailDigest: c.emailDigest,
          selectorHash: c.selectorHash,
          createdAt: c.observedAt,
          expiresAt: new Date(Date.parse(c.observedAt) + 86400000).toISOString(),
          status: "Pending",
          consumedAt: null,
          providerEvidenceReference: null,
          version: 1,
        });
        await admit(c);
        written = true;
        const saved = decode(
          row(
            await query(
              `INSERT INTO bop_identity.workforce_invitation(invitation_id,actor_id,inviter_actor_id,membership_id,store_assignment_ids,email_digest,selector_hash,status,created_at,expires_at,version) VALUES($1,$2,$3,$4,$5,decode($6,'hex'),decode($7,'hex'),'Pending',$8,$9,1) RETURNING ${projection}`,
              [
                c.invitationReference,
                c.actorReference,
                c.inviterActorReference,
                c.membershipReference,
                c.storeAssignmentReferences,
                c.emailDigest,
                c.selectorHash,
                c.observedAt,
                wanted.expiresAt,
              ],
            ),
          ),
        );
        if (!saved || bytes(saved) !== bytes(wanted)) return poison();
        remember(saved, () => byId(saved.invitationReference));
        await append("InvitationIssued", saved);
        await verify();
        return saved;
      });
    },
    readPending(request: WorkforceInvitationPendingRequest) {
      return protect(async () => {
        const { p } = pending(request);
        await admit(p);
        const reader = async () =>
          decode(
            row(
              await query(
                `SELECT ${projection} FROM bop_identity.workforce_invitation WHERE selector_hash=decode($1,'hex') AND email_digest=decode($2,'hex') AND actor_id=$3 AND membership_id=$4 AND status='Pending' FOR UPDATE`,
                [p.selectorHash, p.emailDigest, p.actorReference, p.membershipReference],
              ),
            ),
          );
        const record = await reader();
        if (
          record &&
          (record.status !== "Pending" ||
            record.actorReference !== p.actorReference ||
            record.membershipReference !== p.membershipReference ||
            record.selectorHash !== p.selectorHash ||
            record.emailDigest !== p.emailDigest ||
            record.createdAt > origin)
        )
          return poison();
        remember(record, reader);
        await verify();
        return record;
      });
    },
    consumeInvitation(request: WorkforceInvitationConsumeRequest) {
      return protect(async () => {
        if (written || expected.action !== "AcceptInvitation") return poison();
        const { p, r } = pending(request, [
          "invitationReference",
          "expectedVersion",
          "providerEvidenceReference",
          "observedAt",
        ]);
        const c = Object.freeze({
          ...p,
          invitationReference: parseInvitationReference(r.invitationReference),
          expectedVersion: parseSecurityVersion(r.expectedVersion),
          providerEvidenceReference: parseEvidenceReference(r.providerEvidenceReference),
          observedAt: parseCanonicalInstant(r.observedAt),
        });
        if (c.observedAt !== origin) return poison();
        await admit(c);
        const before = await byId(c.invitationReference);
        if (
          !before ||
          before.status !== "Pending" ||
          before.version !== c.expectedVersion ||
          before.emailDigest !== c.emailDigest ||
          before.selectorHash !== c.selectorHash ||
          before.createdAt > origin ||
          before.expiresAt <= latest ||
          before.consumedAt !== null ||
          before.providerEvidenceReference !== null
        )
          return poison();
        deadline = before.expiresAt < deadline ? before.expiresAt : deadline;
        check();
        written = true;
        const wanted = createWorkforceInvitation({
          ...before,
          status: "Accepted",
          consumedAt: origin,
          providerEvidenceReference: c.providerEvidenceReference,
          version: before.version + 1,
        });
        const saved = decode(
          row(
            await query(
              `UPDATE bop_identity.workforce_invitation SET status='Accepted',consumed_at=$5,provider_evidence_id=$6,version=version+1 WHERE invitation_id=$1 AND actor_id=$2 AND membership_id=$3 AND version=$4 AND status='Pending' AND selector_hash=decode($7,'hex') AND email_digest=decode($8,'hex') AND created_at<=$5 AND expires_at>$5 RETURNING ${projection}`,
              [
                c.invitationReference,
                c.actorReference,
                c.membershipReference,
                c.expectedVersion,
                origin,
                c.providerEvidenceReference,
                c.selectorHash,
                c.emailDigest,
              ],
            ),
          ),
        );
        if (!saved || bytes(saved) !== bytes(wanted)) return poison();
        remember(saved, () => byId(saved.invitationReference));
        await append("InvitationAccepted", saved);
        await verify();
        return saved;
      });
    },
    assertFinalized() {
      if (phase !== "Final" || busy || !checked) return poison();
    },
  });
}
