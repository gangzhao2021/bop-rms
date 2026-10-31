import { createHash } from "node:crypto";
import {
  createIdentityActor,
  parseCurrentWorkforceAccount,
  parseWorkforceAccountBinding,
  readClosedRecord,
  workforceAccountBindingCodec,
  type IdentityActor,
  type CurrentWorkforceAccount,
  type CurrentWorkforceInvitationEvidence,
  type WorkforceAccountBinding,
} from "@bop/identity";
import { createBrand, type Brand } from "@bop/tenant";
import {
  createApprovedPendingWorkforceMembership,
  createMembership,
  transitionMembership,
  type Membership,
} from "../../domain/membership.js";
import {
  approvedMembershipInvalid as invalid,
  approvedMembershipReference as reference,
  approvedMembershipInstant as instant,
  approvedMembershipDigest as digest,
  parseApprovedWorkforceMembership,
  parseCreateApprovedPendingMembership,
  parseActivateApprovedMembership,
  type ApprovedWorkforceMembership,
  type ApprovedWorkforceMembershipRequest,
} from "../../contracts/approved-workforce-membership.js";
import type { CurrentWorkforceRelationshipQualification } from "../workforce-relationship-qualification-files.js";

export interface ApprovedWorkforceMembershipTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
/** Produced by the actual Permission owner comparison against the original
 * approved role/assignment/grant content, not by copying the requested digest. */
export interface ApprovedWorkforceMembershipPolicy {
  readonly approvedPolicyDigest: string;
  readonly contentDigest: string;
  readonly policySnapshotReference: string;
  readonly policyVersion: number;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface ApprovedWorkforceMembershipActivation {
  readonly pendingMembership: Membership;
  readonly invitation: CurrentWorkforceInvitationEvidence;
  readonly account: CurrentWorkforceAccount;
  readonly binding: WorkforceAccountBinding;
  readonly policy: ApprovedWorkforceMembershipPolicy;
}
export interface ApprovedWorkforceMembershipAuthority {
  readonly requestDigest: string;
  readonly approval: ApprovedWorkforceMembership;
  readonly brand: Brand;
  /** Creation: current original inviter. Activation: the actual intended
   * Workforce Actor with Provider-verified recent MFA. The original approver
   * remains a signed approval fact, not a manufactured current login. */
  readonly operator: IdentityActor;
  readonly relationship: CurrentWorkforceRelationshipQualification;
  readonly activation: ApprovedWorkforceMembershipActivation | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface ApprovedWorkforceMembershipAuditInput {
  readonly auditReference: string;
  readonly operationReference: string;
  readonly originalOperationReference: string;
  readonly brandReference: string;
  readonly membershipReference: string;
  readonly actorReference: string;
  readonly targetActorReference: string;
  readonly planDigest: string;
  readonly requestDigest: string;
  readonly approvalEvidenceReference: string;
  readonly purposeCode: "WORKFORCE_ONBOARDING";
  readonly actionCode: "APPROVED_MEMBERSHIP_PENDING_CREATED" | "APPROVED_MEMBERSHIP_ACTIVATED";
  readonly beforeVersion: 0 | 1;
  readonly afterVersion: 1 | 2;
  readonly occurredAt: string;
}
export interface ApprovedWorkforceMembershipStoreOptions {
  readonly transaction: ApprovedWorkforceMembershipTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly auditReference: string;
  readonly authority: {
    /** Hold the actual original approval and current Brand/relationship until
     * COMMIT. On activation, also hold the exact original Pending receipt,
     * actual intended-Actor signed TOTP, Accepted invitation, first acceptance
     * binding and current approved policy. No default source is supplied here.
     * The root must arbitrate durable originals BEFORE invoking this write leaf. */
    hold(
      tx: ApprovedWorkforceMembershipTransaction,
      input: {
        readonly request: ApprovedWorkforceMembershipRequest;
        readonly requestDigest: string;
        readonly observedAt: string;
        readonly validUntil: string;
      },
    ): Promise<ApprovedWorkforceMembershipAuthority>;
  };
  readonly appendAudit: (
    tx: ApprovedWorkforceMembershipTransaction,
    input: ApprovedWorkforceMembershipAuditInput,
  ) => Promise<void>;
  readonly registerBeforeCommit: (
    tx: ApprovedWorkforceMembershipTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void>;
}
export interface ApprovedWorkforceMembershipResult {
  readonly profile: "ApprovedWorkforceMembershipResultV1";
  readonly membership: Membership;
  readonly operationReference: string;
  readonly originalOperationReference: string;
  readonly requestDigest: string;
  readonly auditReference: string;
  readonly occurredAt: string;
}
export interface ApprovedWorkforceMembershipStore {
  createPending(value: unknown): Promise<ApprovedWorkforceMembershipResult>;
  activateApproved(value: unknown): Promise<ApprovedWorkforceMembershipResult>;
  assertFinalized(): void;
}

function rows(value: unknown): readonly unknown[] {
  const d =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")
      : undefined;
  if (
    !d?.enumerable ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length > 2 ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return invalid();
  return Object.freeze(
    Array.from({ length: d.value.length }, (_, i) => {
      const item = Object.getOwnPropertyDescriptor(d.value, String(i));
      if (!item?.enumerable || !("value" in item)) return invalid();
      return item.value;
    }),
  );
}
export function hashApprovedWorkforceMembershipRequest(value: unknown): string {
  try {
    const profile = Object.getOwnPropertyDescriptor(value, "profile");
    const parsed =
      profile && "value" in profile && profile.value === "CreateApprovedPendingMembershipV1"
        ? parseCreateApprovedPendingMembership(value)
        : parseActivateApprovedMembership(value);
    return `sha256:${createHash("sha256").update(JSON.stringify(parsed), "utf8").digest("hex")}`;
  } catch {
    return invalid();
  }
}
const memberSql = `SELECT membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,version,
  to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') effective_from,
  to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') effective_until,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') created_at,
  to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at,
  effective_from=date_trunc('milliseconds',effective_from) AND effective_until=date_trunc('milliseconds',effective_until)
    AND created_at=date_trunc('milliseconds',created_at) AND updated_at=date_trunc('milliseconds',updated_at) precise
  FROM bop_membership.membership WHERE brand_id=$1 AND (membership_id=$2 OR actor_id=$3)
  ORDER BY membership_id LIMIT 2 FOR UPDATE`;
function pending(approval: ApprovedWorkforceMembership, createdAt: string): Membership {
  return createApprovedPendingWorkforceMembership(
    {
      membershipReference: approval.membershipReference,
      actorReference: approval.actorReference,
      brandReference: approval.brandReference,
      workforceRelationshipReference: approval.workforceRelationshipReference,
      lifecycle: "PendingActivation",
      effectiveFrom: approval.effectiveFrom,
      effectiveUntil: approval.effectiveUntil,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    },
    approval.actorReference,
  );
}
function stored(value: unknown, actor: IdentityActor, expected: Membership): Membership {
  const r = readClosedRecord(value, [
    "membership_id",
    "actor_id",
    "brand_id",
    "workforce_relationship_reference",
    "lifecycle",
    "version",
    "effective_from",
    "effective_until",
    "created_at",
    "updated_at",
    "precise",
  ]);
  if (r.precise !== true) return invalid();
  const input = {
    membershipReference: r.membership_id,
    actorReference: r.actor_id,
    brandReference: r.brand_id,
    workforceRelationshipReference: r.workforce_relationship_reference,
    lifecycle: r.lifecycle,
    version: r.version,
    effectiveFrom: r.effective_from,
    effectiveUntil: r.effective_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  const parsed =
    expected.lifecycle === "PendingActivation"
      ? createApprovedPendingWorkforceMembership(input, expected.actorReference)
      : createMembership(input, actor);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) return invalid();
  return parsed;
}

/** Borrowed transaction, one mutation only. This leaf deliberately provides no
 * absent-as-success, original arbitration, invitation delivery or role writer. */
export function createPostgresApprovedWorkforceMembershipStore(
  options: ApprovedWorkforceMembershipStoreOptions,
): ApprovedWorkforceMembershipStore {
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.hold,
    append = options.appendAudit,
    register = options.registerBeforeCommit,
    origin = instant(options.originalObservedAt),
    originalUntil = instant(options.originalValidUntil),
    auditReference = reference(options.auditReference);
  if (
    originalUntil <= origin ||
    Date.parse(originalUntil) > Date.parse(origin) + 5000 ||
    [queryPort, now, hold, append, register].some((p) => typeof p !== "function")
  )
    return invalid();
  let phase: "Ready" | "Work" | "Guarded" | "Final" | "Poison" = "Ready",
    busy = false,
    latest = origin,
    deadline = originalUntil,
    transactionId: string | undefined,
    pin: string | undefined;
  const poison = (): never => {
    phase = "Poison";
    return invalid();
  };
  const check = () => {
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
      options.appendAudit !== append ||
      options.registerBeforeCommit !== register ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil ||
      options.auditReference !== auditReference ||
      at < latest ||
      at >= deadline
    )
      return poison();
    latest = at;
    return at;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  };
  const sameTransaction = async () => {
    const result = rows(
      await query(
        "SELECT current_setting('transaction_isolation') AS isolation,txid_current()::text AS transaction_id",
        [],
      ),
    );
    if (result.length !== 1) return poison();
    const r = readClosedRecord(result[0], ["isolation", "transaction_id"]);
    if (
      r.isolation !== "read committed" ||
      typeof r.transaction_id !== "string" ||
      !/^[1-9][0-9]*$/u.test(r.transaction_id) ||
      (transactionId !== undefined && r.transaction_id !== transactionId)
    )
      return poison();
    transactionId = r.transaction_id;
  };
  const window = (observedInput: unknown, untilInput: unknown, at: string) => {
    const observed = instant(observedInput),
      until = instant(untilInput);
    if (
      observed < origin ||
      observed > at ||
      until <= at ||
      Date.parse(until) > Date.parse(observed) + 5000
    )
      return poison();
    if (until < deadline) deadline = until;
    return { observedAt: observed, validUntil: until };
  };
  const scope = (approval: ApprovedWorkforceMembership) =>
    query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
      [approval.brandReference],
    );
  const qualify = async (request: ApprovedWorkforceMembershipRequest, requestDigest: string) => {
    const at = check();
    const answer = await hold.call(
      authority,
      tx,
      Object.freeze({ request, requestDigest, observedAt: at, validUntil: deadline }),
    );
    const after = check(),
      r = readClosedRecord(answer, [
        "requestDigest",
        "approval",
        "brand",
        "operator",
        "relationship",
        "activation",
        "observedAt",
        "validUntil",
      ]),
      approval = parseApprovedWorkforceMembership(r.approval),
      brand = createBrand(r.brand),
      operator = createIdentityActor(r.operator);
    window(r.observedAt, r.validUntil, after);
    const activating = request.profile === "ActivateApprovedMembershipV1";
    if (
      digest(r.requestDigest) !== requestDigest ||
      JSON.stringify(approval) !== JSON.stringify(request.approval) ||
      brand.brandReference !== approval.brandReference ||
      (brand.lifecycle !== "Draft" && brand.lifecycle !== "Active") ||
      String(brand.updatedAt) > at ||
      operator.actorType !== "User" ||
      operator.status !== "Active" ||
      operator.actorReference !==
        (activating ? approval.actorReference : approval.operatorReference) ||
      operator.authenticationMethod !== "Oidc" ||
      operator.verificationLevel !== "RecentMfa" ||
      (activating
        ? operator.accountKind !== "Workforce"
        : !["Workforce", "Platform"].includes(operator.accountKind)) ||
      operator.authenticatedAt === null ||
      operator.recentMfaAt === null ||
      String(operator.authenticatedAt) > at ||
      String(operator.recentMfaAt) > at ||
      approval.effectiveFrom > origin ||
      approval.effectiveUntil <= after
    )
      return poison();
    const mfaUntil = new Date(Date.parse(operator.recentMfaAt) + 15 * 60_000).toISOString();
    if (mfaUntil < deadline) deadline = mfaUntil;
    if (approval.effectiveUntil < deadline) deadline = approval.effectiveUntil;
    const rel = readClosedRecord(r.relationship, [
      "profile",
      "environmentReference",
      "actorReference",
      "brandReference",
      "workforceRelationshipReference",
      "relationshipEvidenceReference",
      "issuerReference",
      "revision",
      "relationshipEffectiveFrom",
      "relationshipEffectiveUntil",
      "verifiedAt",
      "observedAt",
      "validUntil",
    ]);
    const relFrom = instant(rel.relationshipEffectiveFrom),
      relUntil =
        rel.relationshipEffectiveUntil === null ? null : instant(rel.relationshipEffectiveUntil);
    window(rel.observedAt, rel.validUntil, after);
    if (
      rel.profile !== "CurrentWorkforceRelationshipQualificationV1" ||
      [
        "environmentReference",
        "actorReference",
        "brandReference",
        "workforceRelationshipReference",
        "relationshipEvidenceReference",
      ].some((key) => rel[key] !== approval[key as keyof ApprovedWorkforceMembership]) ||
      rel.revision !== approval.relationshipRevision ||
      instant(rel.verifiedAt) > at ||
      relFrom > approval.effectiveFrom ||
      (relUntil !== null && relUntil < approval.effectiveUntil)
    )
      return poison();
    reference(rel.issuerReference);
    let activationPin: unknown = null;
    if (activating) {
      const activation = readClosedRecord(r.activation, [
          "pendingMembership",
          "invitation",
          "account",
          "binding",
          "policy",
        ]),
        invitation = readClosedRecord(activation.invitation, [
          "profile",
          "invitationReference",
          "actorReference",
          "originalMembershipReference",
          "providerEvidenceReference",
          "status",
          "version",
          "createdAt",
          "expiresAt",
          "consumedAt",
          "observedAt",
          "validUntil",
        ]),
        account = parseCurrentWorkforceAccount(activation.account),
        binding = parseWorkforceAccountBinding(activation.binding, workforceAccountBindingCodec),
        policy = readClosedRecord(activation.policy, [
          "approvedPolicyDigest",
          "contentDigest",
          "policySnapshotReference",
          "policyVersion",
          "observedAt",
          "validUntil",
        ]);
      const originalPending = createApprovedPendingWorkforceMembership(
        activation.pendingMembership,
        approval.actorReference,
      );
      if (
        JSON.stringify(originalPending) !==
        JSON.stringify(pending(approval, request.pendingCreatedAt))
      )
        return poison();
      window(invitation.observedAt, invitation.validUntil, after);
      window(account.observedAt, account.validUntil, after);
      window(policy.observedAt, policy.validUntil, after);
      const created = instant(invitation.createdAt),
        expires = instant(invitation.expiresAt),
        consumed = instant(invitation.consumedAt);
      if (
        request.pendingCreatedAt > origin ||
        invitation.profile !== "CurrentWorkforceInvitationEvidenceV1" ||
        invitation.status !== "Accepted" ||
        invitation.version !== 2 ||
        invitation.invitationReference !== request.invitationReference ||
        invitation.actorReference !== approval.actorReference ||
        invitation.originalMembershipReference !== approval.membershipReference ||
        created < request.pendingCreatedAt ||
        Date.parse(expires) - Date.parse(created) !== 86_400_000 ||
        consumed < created ||
        consumed >= expires ||
        consumed > at ||
        String(operator.recentMfaAt) < created ||
        account.actorReference !== approval.actorReference ||
        binding.originalCommand.profile !== "WorkforceAccountBindingAcceptanceV1" ||
        binding.actorReference !== approval.actorReference ||
        binding.recordedByReference !== approval.actorReference ||
        binding.invitationReference !== request.invitationReference ||
        binding.originalMembershipReference !== approval.membershipReference ||
        binding.providerEvidenceReference !== reference(invitation.providerEvidenceReference) ||
        binding.approvedByReference !== approval.approvedByReference ||
        binding.approvalEvidenceReference !== approval.approvalEvidenceReference ||
        binding.recordedAt < consumed ||
        binding.recordedAt > at ||
        digest(policy.approvedPolicyDigest) !== approval.approvedPolicyDigest ||
        digest(policy.contentDigest) !== approval.approvedPolicyDigest ||
        typeof policy.policyVersion !== "number" ||
        !Number.isSafeInteger(policy.policyVersion) ||
        policy.policyVersion < 1
      )
        return poison();
      reference(policy.policySnapshotReference);
      activationPin = {
        originalPending,
        invitation: { ...invitation, observedAt: undefined, validUntil: undefined },
        account: { ...account, observedAt: undefined, validUntil: undefined },
        bindingDigest: binding.sourceDigest,
        policy: { ...policy, observedAt: undefined, validUntil: undefined },
      };
    } else if (r.activation !== null) return poison();
    const identity = JSON.stringify({
      approval,
      brand,
      operator,
      relationship: { ...rel, observedAt: undefined, validUntil: undefined },
      activation: activationPin,
    });
    if (pin !== undefined && pin !== identity) return poison();
    pin = identity;
    check();
    return operator;
  };
  const execute = async (value: unknown, activating: boolean) => {
    try {
      if (busy || phase !== "Ready") return poison();
      busy = true;
      phase = "Work";
      let complete = false;
      let requestDigest = "",
        expected: Membership | undefined;
      await register(
        tx,
        async () => {
          try {
            if (!complete || !request || !expected || busy || phase !== "Work") return poison();
            busy = true;
            await sameTransaction();
            const actor = await qualify(request, requestDigest);
            await scope(request.approval);
            const result = rows(
              await query(memberSql, [
                request.approval.brandReference,
                request.approval.membershipReference,
                request.approval.actorReference,
              ]),
            );
            if (result.length !== 1) return poison();
            stored(result[0], actor, expected);
            await sameTransaction();
            check();
            phase = "Guarded";
          } catch {
            return poison();
          } finally {
            busy = false;
          }
        },
        () => {
          try {
            if (!complete || busy || phase !== "Guarded") return poison();
            check();
            phase = "Final";
          } catch {
            return poison();
          }
        },
      );
      const request: ApprovedWorkforceMembershipRequest = activating
        ? parseActivateApprovedMembership(value)
        : parseCreateApprovedPendingMembership(value);
      requestDigest = hashApprovedWorkforceMembershipRequest(request);
      check();
      // Two independent statements establish a real borrowed transaction before
      // any mutation; a single xid observation would also pass on autocommit.
      await sameTransaction();
      await sameTransaction();
      const a = request.approval;
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `Brand:${a.brandReference}`,
      ]);
      const actor = await qualify(request, requestDigest);
      await scope(a);
      if (!activating)
        await query("LOCK TABLE bop_membership.membership IN SHARE ROW EXCLUSIVE MODE", []);
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `ApprovedWorkforceMembership:${a.brandReference}:${a.actorReference}`,
      ]);
      const before = rows(
        await query(memberSql, [a.brandReference, a.membershipReference, a.actorReference]),
      );
      let written: readonly unknown[];
      if (request.profile === "CreateApprovedPendingMembershipV1") {
        if (before.length !== 0) return poison();
        expected = pending(a, origin);
        await sameTransaction();
        written = rows(
          await query(
            "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'PendingActivation',$5,$6,1,$7,$7) RETURNING membership_id",
            [
              a.membershipReference,
              a.actorReference,
              a.brandReference,
              a.workforceRelationshipReference,
              a.effectiveFrom,
              a.effectiveUntil,
              origin,
            ],
          ),
        );
      } else {
        if (before.length !== 1) return poison();
        const original = pending(a, request.pendingCreatedAt);
        stored(before[0], actor, original);
        expected = transitionMembership(original, original.version, "Active", origin);
        await sameTransaction();
        written = rows(
          await query(
            "UPDATE bop_membership.membership SET lifecycle='Active',version=version+1,updated_at=$4 WHERE membership_id=$1 AND brand_id=$2 AND actor_id=$3 AND lifecycle='PendingActivation' AND version=1 RETURNING membership_id",
            [a.membershipReference, a.brandReference, a.actorReference, origin],
          ),
        );
      }
      if (
        written.length !== 1 ||
        readClosedRecord(written[0], ["membership_id"]).membership_id !== a.membershipReference
      )
        return poison();
      await sameTransaction();
      const operationReference =
        request.profile === "ActivateApprovedMembershipV1"
          ? request.operationReference
          : a.operationReference;
      if (
        (await append(
          tx,
          Object.freeze({
            auditReference,
            operationReference,
            originalOperationReference: a.operationReference,
            brandReference: a.brandReference,
            membershipReference: a.membershipReference,
            actorReference: actor.actorReference ?? poison(),
            targetActorReference: a.actorReference,
            planDigest: a.planDigest,
            requestDigest,
            approvalEvidenceReference: a.approvalEvidenceReference,
            purposeCode: "WORKFORCE_ONBOARDING",
            actionCode: activating
              ? "APPROVED_MEMBERSHIP_ACTIVATED"
              : "APPROVED_MEMBERSHIP_PENDING_CREATED",
            beforeVersion: activating ? 1 : 0,
            afterVersion: activating ? 2 : 1,
            occurredAt: origin,
          }),
        )) !== undefined
      )
        return poison();
      check();
      await sameTransaction();
      complete = true;
      return Object.freeze({
        profile: "ApprovedWorkforceMembershipResultV1" as const,
        membership: expected ?? poison(),
        operationReference,
        originalOperationReference: a.operationReference,
        requestDigest,
        auditReference,
        occurredAt: origin,
      });
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  return Object.freeze({
    createPending: (value: unknown) => execute(value, false),
    activateApproved: (value: unknown) => execute(value, true),
    assertFinalized() {
      if (busy || phase !== "Final") return poison();
    },
  });
}
