import { Buffer } from "node:buffer";
import { appendPlatformAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createIdentityActor, type IdentityActor } from "../../contracts/identity-actor.js";
import {
  parseRawBrowserCredential,
  parseSelectorHash,
  type RawBrowserCredential,
} from "../../contracts/browser-session.js";
import {
  createWorkforceInvitation,
  type WorkforceInvitation,
} from "../../contracts/workforce-identity-security.js";
import { parseWorkforceAccountBindingSubject } from "../../contracts/workforce-account-binding.js";
import {
  type BrowserCredentialHasherPort,
  type SessionEnvelopeCryptoPort,
} from "../../application/ports/session-credential-ports.js";
import type { IssueWorkforceInvitationCommand } from "../../application/ports/workforce-identity-security-port.js";
import {
  buildWorkforceOnboardingOperation,
  parseWorkforceOnboardingOperation,
  parseWorkforceOnboardingOriginal,
  parseWorkforceOnboardingConfiguration,
  assertWorkforceOnboardingTransition,
  workforceOnboardingClosed,
  workforceOnboardingDigest,
  workforceOnboardingFail,
  workforceOnboardingInstant,
  workforceOnboardingReference,
  workforceOnboardingVersion,
  workforceOnboardingIntent,
  workforceOnboardingSubjectContext,
  workforceOnboardingPurpose,
  type WorkforceOnboardingOriginal,
  type WorkforceOnboardingConfiguration,
  type WorkforceOnboardingOperation,
  type WorkforceOnboardingProvider,
} from "../../contracts/workforce-onboarding-operation.js";
export interface WorkforceOnboardingTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface WorkforceOnboardingBinding {
  readonly operatorReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly membershipReference: string;
  readonly purposeCode: "WORKFORCE_ONBOARDING";
}
export interface WorkforceOnboardingOperationStoreOptions {
  readonly transaction: WorkforceOnboardingTransaction;
  readonly configuration: WorkforceOnboardingConfiguration;
  readonly binding: WorkforceOnboardingBinding;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly authority: {
    hold(
      tx: WorkforceOnboardingTransaction,
      input: {
        readonly binding: WorkforceOnboardingBinding;
        readonly action: string;
        readonly requestDigest: string;
        readonly observedAt: string;
        readonly validUntil: string;
      },
    ): Promise<{
      readonly binding: WorkforceOnboardingBinding;
      readonly action: string;
      readonly requestDigest: string;
      readonly operator: IdentityActor;
      readonly validUntil: string;
    }>;
  };
  readonly hasher: BrowserCredentialHasherPort;
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly credentials: { generate(): RawBrowserCredential };
  readonly nextReference: (kind: "Invitation" | "PhaseOperation" | "Audit") => string;
  readonly createInvitation: (
    tx: WorkforceOnboardingTransaction,
    command: IssueWorkforceInvitationCommand,
  ) => Promise<WorkforceInvitation>;
  readonly registerBeforeCommit: (
    tx: WorkforceOnboardingTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export interface WorkforceOnboardingOriginalRequest {
  readonly operationReference: string;
  readonly intentDigest: string;
}
export interface WorkforceOnboardingPhaseRequest extends WorkforceOnboardingOriginalRequest {
  readonly expectedVersion: number;
}
export interface WorkforceOnboardingInspectionRequest extends WorkforceOnboardingPhaseRequest {
  readonly observation: unknown;
}
export interface WorkforceOnboardingOperationStore {
  prepare(original: WorkforceOnboardingOriginal): Promise<{
    readonly record: WorkforceOnboardingOperation;
    readonly outcome: "Prepared" | "Original";
    readonly deliverySecret: RawBrowserCredential | null;
  }>;
  resolveOriginal(
    request: WorkforceOnboardingOriginalRequest,
  ): Promise<WorkforceOnboardingOperation | null>;
  /** Only a newly returned Claimed result may dispatch externally. Original
   * never authorizes re-dispatch, including a saved DispatchClaimed state. */
  claimDispatch(request: WorkforceOnboardingPhaseRequest): Promise<{
    readonly record: WorkforceOnboardingOperation;
    readonly outcome: "Claimed" | "Original";
  }>;
  recordInspection(
    request: WorkforceOnboardingInspectionRequest,
  ): Promise<WorkforceOnboardingOperation>;
  recordExpired(request: WorkforceOnboardingPhaseRequest): Promise<WorkforceOnboardingOperation>;
  assertFinalized(): void;
}
export const workforceOnboardingCodec = Object.freeze({
  canonicalize: canonicalizeRfc8785,
  hash: sha256Hex,
});
const canon = canonicalizeRfc8785;
const requestHash = (v: unknown) => workforceOnboardingDigest(`sha256:${sha256Hex(canon(v))}`);
const originalKeys = ["operationReference", "intentDigest"] as const;
function binding(v: unknown): WorkforceOnboardingBinding {
  const r = workforceOnboardingClosed(v, [
    "operatorReference",
    "actorReference",
    "brandReference",
    "membershipReference",
    "purposeCode",
  ]);
  if (r.purposeCode !== workforceOnboardingPurpose) return workforceOnboardingFail();
  return Object.freeze({
    operatorReference: workforceOnboardingReference(r.operatorReference),
    actorReference: workforceOnboardingReference(r.actorReference),
    brandReference: workforceOnboardingReference(r.brandReference),
    membershipReference: workforceOnboardingReference(r.membershipReference),
    purposeCode: r.purposeCode,
  });
}
function one(v: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  const d =
    v !== null && typeof v === "object" ? Object.getOwnPropertyDescriptor(v, "rows") : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length > 1 ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return workforceOnboardingFail();
  if (!d.value.length) return null;
  const item = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!item?.enumerable || !("value" in item)) return workforceOnboardingFail();
  return workforceOnboardingClosed(item.value, keys);
}
const latestSql =
  "SELECT snapshot_text,source_digest FROM bop_identity.workforce_onboarding_operation WHERE operator_id=$1 AND operation_id=$2 ORDER BY version DESC LIMIT 1";
const invitationSql = `SELECT invitation_id::text,actor_id::text,inviter_actor_id::text,membership_id::text,store_assignment_ids,encode(email_digest,'hex') AS email_digest,encode(selector_hash,'hex') AS selector_hash,status,provider_evidence_id::text,version,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,to_char(consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS consumed_at,(isfinite(created_at) AND isfinite(expires_at) AND created_at>=TIMESTAMPTZ '0001-01-01' AND expires_at<TIMESTAMPTZ '10000-01-01' AND created_at=date_trunc('milliseconds',created_at) AND expires_at=date_trunc('milliseconds',expires_at) AND (consumed_at IS NULL OR (isfinite(consumed_at) AND consumed_at=date_trunc('milliseconds',consumed_at)))) AS precise FROM bop_identity.workforce_invitation WHERE invitation_id=$1 AND actor_id=$2 AND membership_id=$3 FOR SHARE`;
/** Durable original/dispatch facts only. No SDK call, guaranteed delivery,
 * acceptance, MFA or role activation. Secret exists only in first prepare result. */
export function createPostgresWorkforceOnboardingOperationStore(
  options: WorkforceOnboardingOperationStoreOptions,
): WorkforceOnboardingOperationStore {
  workforceOnboardingClosed(options, [
    "transaction",
    "configuration",
    "binding",
    "clock",
    "originalObservedAt",
    "originalValidUntil",
    "authority",
    "hasher",
    "envelopes",
    "credentials",
    "nextReference",
    "createInvitation",
    "registerBeforeCommit",
  ]);
  workforceOnboardingClosed(options.clock, ["now"]);
  workforceOnboardingClosed(options.authority, ["hold"]);
  workforceOnboardingClosed(options.credentials, ["generate"]);
  const tx = options.transaction,
    queryPort = tx.query,
    configuration = parseWorkforceOnboardingConfiguration(options.configuration),
    scope = binding(options.binding),
    configurationPort = options.configuration,
    scopePort = options.binding,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.hold,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    envelopes = options.envelopes,
    encrypt = envelopes.encrypt,
    decrypt = envelopes.decrypt,
    credentials = options.credentials,
    generate = credentials.generate,
    next = options.nextReference,
    create = options.createInvitation,
    register = options.registerBeforeCommit;
  const origin = workforceOnboardingInstant(options.originalObservedAt),
    originalEnd = workforceOnboardingInstant(options.originalValidUntil);
  if (
    [queryPort, now, hold, hash, equals, encrypt, decrypt, generate, next, create, register].some(
      (p) => typeof p !== "function",
    ) ||
    origin >= originalEnd ||
    Date.parse(originalEnd) > Date.parse(origin) + 5000
  )
    return workforceOnboardingFail();
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    checked = false,
    deadline = originalEnd,
    latest = origin,
    txid: string | undefined,
    pinnedOperator: string | undefined;
  let currentOperation: string | undefined,
    currentIntent: string | undefined,
    action = "ResolveOriginal",
    phaseDigest: string | undefined,
    pinned: string | undefined;
  const poison = (): never => {
    phase = "Poison";
    return workforceOnboardingFail("WORKFORCE_ONBOARDING_DENIED");
  };
  const check = () => {
    try {
      const at = workforceOnboardingInstant(now.call(clock));
      if (
        phase === "Poison" ||
        phase === "Final" ||
        options.transaction !== tx ||
        tx.query !== queryPort ||
        options.configuration !== configurationPort ||
        canon(parseWorkforceOnboardingConfiguration(configurationPort)) !== canon(configuration) ||
        options.binding !== scopePort ||
        canon(binding(scopePort)) !== canon(scope) ||
        options.clock !== clock ||
        clock.now !== now ||
        options.authority !== authority ||
        authority.hold !== hold ||
        options.hasher !== hasher ||
        hasher.hash !== hash ||
        hasher.equals !== equals ||
        options.envelopes !== envelopes ||
        envelopes.encrypt !== encrypt ||
        envelopes.decrypt !== decrypt ||
        options.credentials !== credentials ||
        credentials.generate !== generate ||
        options.nextReference !== next ||
        options.createInvitation !== create ||
        options.registerBeforeCommit !== register ||
        options.originalObservedAt !== origin ||
        options.originalValidUntil !== originalEnd ||
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
  const context = async () => {
    await query(
      "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true),set_config('bop.onboarding_environment',$3,true),set_config('bop.onboarding_issuer',$4,true),set_config('bop.onboarding_client_id',$5,true),set_config('bop.onboarding_actor_id',$6,true),set_config('bop.onboarding_brand_id',$7,true),set_config('bop.onboarding_member_id',$8,true)",
      [
        scope.operatorReference,
        scope.purposeCode,
        configuration.environment,
        configuration.issuer,
        configuration.clientId,
        scope.actorReference,
        scope.brandReference,
        scope.membershipReference,
      ],
    );
  };
  const sameTx = async () => {
    const r = one(
      await query(
        "SELECT current_setting('transaction_isolation') AS isolation,pg_current_xact_id()::text AS transaction_id",
        [],
      ),
      ["isolation", "transaction_id"],
    );
    if (
      !r ||
      r.isolation !== "read committed" ||
      typeof r.transaction_id !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(r.transaction_id) ||
      (txid !== undefined && txid !== r.transaction_id)
    )
      return poison();
    txid = r.transaction_id;
  };
  const currentAuthority = async () => {
    const at = check();
    if (!phaseDigest) return poison();
    const packet = await hold.call(authority, tx, {
      binding: scope,
      action,
      requestDigest: phaseDigest,
      observedAt: at,
      validUntil: deadline,
    });
    check();
    const r = workforceOnboardingClosed(packet, [
        "binding",
        "action",
        "requestDigest",
        "operator",
        "validUntil",
      ]),
      operator = createIdentityActor(r.operator),
      until = workforceOnboardingInstant(r.validUntil);
    if (
      canon(binding(r.binding)) !== canon(scope) ||
      r.action !== action ||
      r.requestDigest !== phaseDigest ||
      operator.actorType !== "User" ||
      operator.actorReference !== scope.operatorReference ||
      !["Platform", "Workforce"].includes(operator.accountKind) ||
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
    const identity = canon(operator);
    if (pinnedOperator !== undefined && identity !== pinnedOperator) return poison();
    pinnedOperator = identity;
    const mfaEnd = workforceOnboardingInstant(
      new Date(Date.parse(operator.recentMfaAt) + 900000).toISOString(),
    );
    deadline = until < mfaEnd ? until : mfaEnd;
    check();
    await context();
  };
  const parseRow = (
    r: Readonly<Record<string, unknown>> | null,
  ): WorkforceOnboardingOperation | null => {
    if (!r) return null;
    if (typeof r.snapshot_text !== "string" || r.snapshot_text.length > 32768) return poison();
    const record = parseWorkforceOnboardingOperation(
      JSON.parse(r.snapshot_text),
      workforceOnboardingCodec,
    );
    if (
      r.source_digest !== record.sourceDigest ||
      canon(record) !== r.snapshot_text ||
      record.original.operatorReference !== scope.operatorReference ||
      record.original.actorReference !== scope.actorReference ||
      record.original.brandReference !== scope.brandReference ||
      record.original.membershipReference !== scope.membershipReference ||
      canon(record.original.configuration) !== canon(configuration) ||
      record.original.operationReference !== currentOperation ||
      (currentIntent !== undefined && record.intentDigest !== currentIntent)
    )
      return poison();
    return record;
  };
  const read = async () => {
    if (!currentOperation) return poison();
    await context();
    return parseRow(
      one(await query(latestSql, [scope.operatorReference, currentOperation]), [
        "snapshot_text",
        "source_digest",
      ]),
    );
  };
  const verifyInvitation = async (record: WorkforceOnboardingOperation) => {
    const r = one(
      await query(invitationSql, [
        record.invitationReference,
        scope.actorReference,
        scope.membershipReference,
      ]),
      [
        "invitation_id",
        "actor_id",
        "inviter_actor_id",
        "membership_id",
        "store_assignment_ids",
        "email_digest",
        "selector_hash",
        "status",
        "provider_evidence_id",
        "version",
        "created_at",
        "expires_at",
        "consumed_at",
        "precise",
      ],
    );
    if (!r || r.precise !== true) return poison();
    const assignments = r.store_assignment_ids;
    if (
      !Array.isArray(assignments) ||
      Object.getPrototypeOf(assignments) !== Array.prototype ||
      Reflect.ownKeys(assignments).length !== assignments.length + 1 ||
      assignments.length > 100
    )
      return poison();
    const copied: unknown[] = [];
    for (let i = 0; i < assignments.length; i++) {
      const d = Object.getOwnPropertyDescriptor(assignments, String(i));
      if (!d?.enumerable || !("value" in d)) return poison();
      copied.push(d.value);
    }
    const invitation = createWorkforceInvitation({
      invitationReference: r.invitation_id,
      actorReference: r.actor_id,
      inviterActorReference: r.inviter_actor_id,
      membershipReference: r.membership_id,
      storeAssignmentReferences: copied,
      emailDigest: r.email_digest,
      selectorHash: r.selector_hash,
      status: r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      consumedAt: r.consumed_at,
      providerEvidenceReference: r.provider_evidence_id,
      version: r.version,
    });
    if (
      invitation.invitationReference !== record.invitationReference ||
      invitation.actorReference !== scope.actorReference ||
      invitation.inviterActorReference !== scope.operatorReference ||
      invitation.membershipReference !== scope.membershipReference ||
      invitation.emailDigest !== record.original.emailDigest ||
      invitation.selectorHash !== record.selectorHash ||
      invitation.createdAt !== record.createdAt ||
      invitation.expiresAt !== record.expiresAt ||
      canon(invitation.storeAssignmentReferences) !==
        canon(record.original.storeAssignmentReferences)
    )
      return poison();
    // Accepted is a different owner workflow; merely observing a Provider never
    // fabricates or rewrites that tuple. Current journal does not claim it.
    if (
      ["Prepared", "DispatchClaimed", "ProviderUnknown"].includes(record.state) &&
      (invitation.status !== "Pending" ||
        invitation.providerEvidenceReference !== null ||
        invitation.version !== 1)
    )
      return poison();
    return invitation;
  };
  const verify = async () => {
    await currentAuthority();
    await sameTx();
    const record = await read();
    if (canon(record) !== pinned) return poison();
    if (record) await verifyInvitation(record);
    await currentAuthority();
    check();
  };
  const guard = async () => {
    if (busy || phase !== "Ready" || checked) return poison();
    busy = true;
    try {
      await verify();
      check();
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
    if (busy || checked || phase === "Final") return poison();
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
  const admit = async (op: string, intent: string, name: string, normalized: unknown) => {
    if (currentOperation !== undefined && (currentOperation !== op || currentIntent !== intent))
      return poison();
    currentOperation = op;
    currentIntent = intent;
    action = name;
    phaseDigest = requestHash({ action: name, request: normalized });
    await context();
    await query("SELECT bop_identity.workforce_onboarding_operation_admit($1,$2,$3,$4)", [
      scope.operatorReference,
      op,
      scope.actorReference,
      scope.membershipReference,
    ]);
    await currentAuthority();
    await sameTx();
    await sameTx();
  };
  const request = (v: unknown, extra: readonly string[] = []) => {
    const r = workforceOnboardingClosed(v, [...originalKeys, ...extra]);
    return {
      r,
      operationReference: workforceOnboardingReference(r.operationReference),
      intentDigest: workforceOnboardingDigest(r.intentDigest),
    };
  };
  const append = async (
    body: Omit<
      WorkforceOnboardingOperation,
      "sourceDigest" | "phaseOperationReference" | "auditReference" | "phaseRequestDigest"
    >,
    previous: WorkforceOnboardingOperation | null,
  ) => {
    if (!phaseDigest) return poison();
    const record = buildWorkforceOnboardingOperation(
      {
        ...body,
        phaseOperationReference: workforceOnboardingReference(next("PhaseOperation")),
        phaseRequestDigest: phaseDigest,
        auditReference: workforceOnboardingReference(next("Audit")),
      },
      workforceOnboardingCodec,
    );
    check();
    if (previous) assertWorkforceOnboardingTransition(previous, record, workforceOnboardingCodec);
    await verifyInvitation(record);
    await currentAuthority();
    await sameTx();
    await context();
    await appendPlatformAuditRecordInTransaction(tx, {
      auditReference: record.auditReference,
      actorReference: scope.operatorReference,
      purposeCode: scope.purposeCode,
      actionCode: "WORKFORCE_ONBOARDING_RECORDED",
      targetType: "WorkforceOnboardingOperation",
      targetReference: record.original.operationReference,
      operationReference: record.phaseOperationReference,
      intentDigest: record.phaseRequestDigest,
      occurredAt: record.occurredAt,
      reasonCode: record.original.reasonCode,
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    });
    check();
    await context();
    await query(
      "INSERT INTO bop_identity.workforce_onboarding_operation(operator_id,operation_id,version,environment,issuer,client_id,actor_id,brand_id,membership_id,intent_digest,state,invitation_id,selector_hash,created_at,expires_at,dispatch_started_at,phase_operation_id,phase_request_digest,previous_source_digest,audit_id,occurred_at,source_digest,snapshot_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)",
      [
        scope.operatorReference,
        record.original.operationReference,
        record.version,
        configuration.environment,
        configuration.issuer,
        configuration.clientId,
        scope.actorReference,
        scope.brandReference,
        scope.membershipReference,
        record.intentDigest,
        record.state,
        record.invitationReference,
        record.selectorHash,
        record.createdAt,
        record.expiresAt,
        record.dispatchStartedAt,
        record.phaseOperationReference,
        record.phaseRequestDigest,
        record.previousSourceDigest,
        record.auditReference,
        record.occurredAt,
        record.sourceDigest,
        canon(record),
      ],
    );
    pinned = canon(record);
    const saved = await read();
    if (!saved || canon(saved) !== pinned) return poison();
    await verify();
    return saved;
  };
  const nextBody = (
    before: WorkforceOnboardingOperation,
    state: WorkforceOnboardingOperation["state"],
    provider = before.provider,
  ) => {
    const { sourceDigest, phaseOperationReference, phaseRequestDigest, auditReference, ...body } =
      before;
    void phaseOperationReference;
    void phaseRequestDigest;
    void auditReference;
    return {
      ...body,
      version: before.version + 1,
      state,
      provider,
      previousSourceDigest: sourceDigest,
      occurredAt: origin,
    };
  };
  const originalOnly = async (record: WorkforceOnboardingOperation | null) => {
    pinned = canon(record);
    await verify();
    return record;
  };
  return Object.freeze({
    prepare(value: unknown) {
      return protect(async () => {
        const original = parseWorkforceOnboardingOriginal(value),
          intent = workforceOnboardingIntent(original, workforceOnboardingCodec);
        if (
          original.operatorReference !== scope.operatorReference ||
          original.actorReference !== scope.actorReference ||
          original.brandReference !== scope.brandReference ||
          original.membershipReference !== scope.membershipReference ||
          canon(original.configuration) !== canon(configuration)
        )
          return poison();
        await admit(original.operationReference, intent, "Prepare", original);
        const previous = await read();
        if (previous) {
          if (canon(previous.original) !== canon(original)) return poison();
          await originalOnly(previous);
          return Object.freeze({
            record: previous,
            outcome: "Original" as const,
            deliverySecret: null,
          });
        }
        const invitationReference = workforceOnboardingReference(next("Invitation")),
          secret = parseRawBrowserCredential(generate.call(credentials));
        check();
        const selectorHash = parseSelectorHash(hash.call(hasher, secret));
        check();
        const wanted = createWorkforceInvitation({
          invitationReference,
          actorReference: scope.actorReference,
          inviterActorReference: scope.operatorReference,
          membershipReference: scope.membershipReference,
          storeAssignmentReferences: original.storeAssignmentReferences,
          emailDigest: original.emailDigest,
          selectorHash,
          status: "Pending",
          createdAt: origin,
          expiresAt: new Date(Date.parse(origin) + 86400000).toISOString(),
          consumedAt: null,
          providerEvidenceReference: null,
          version: 1,
        });
        const command: IssueWorkforceInvitationCommand = {
          invitationReference: wanted.invitationReference,
          actorReference: wanted.actorReference,
          inviterActorReference: wanted.inviterActorReference,
          membershipReference: wanted.membershipReference,
          storeAssignmentReferences: wanted.storeAssignmentReferences,
          emailDigest: wanted.emailDigest,
          selectorHash: wanted.selectorHash,
          observedAt: wanted.createdAt,
        };
        const actual = createWorkforceInvitation(await create(tx, command));
        check();
        if (canon(actual) !== canon(wanted)) return poison();
        const record = await append(
          {
            profile: "WorkforceOnboardingOperationV1",
            original,
            intentDigest: intent,
            version: 1,
            state: "Prepared",
            invitationReference,
            selectorHash,
            createdAt: origin,
            expiresAt: wanted.expiresAt,
            dispatchStartedAt: null,
            provider: null,
            previousSourceDigest: null,
            occurredAt: origin,
          },
          null,
        );
        return Object.freeze({ record, outcome: "Prepared" as const, deliverySecret: secret });
      });
    },
    resolveOriginal(value: unknown) {
      return protect(async () => {
        const r = request(value);
        await admit(r.operationReference, r.intentDigest, "ResolveOriginal", {
          operationReference: r.operationReference,
          intentDigest: r.intentDigest,
        });
        return originalOnly(await read());
      });
    },
    claimDispatch(value: unknown) {
      return protect(async () => {
        const { r, operationReference, intentDigest } = request(value, ["expectedVersion"]),
          expectedVersion = workforceOnboardingVersion(r.expectedVersion);
        await admit(operationReference, intentDigest, "ClaimDispatch", {
          operationReference,
          intentDigest,
          expectedVersion,
        });
        const before = await read();
        if (!before) return poison();
        if (before.state !== "Prepared") {
          await originalOnly(before);
          return Object.freeze({ record: before, outcome: "Original" as const });
        }
        if (before.version !== expectedVersion || before.expiresAt <= latest) return poison();
        const record = await append(
          { ...nextBody(before, "DispatchClaimed"), dispatchStartedAt: origin },
          before,
        );
        return Object.freeze({ record, outcome: "Claimed" as const });
      });
    },
    recordInspection(value: unknown) {
      return protect(async () => {
        const { r, operationReference, intentDigest } = request(value, [
            "expectedVersion",
            "observation",
          ]),
          expectedVersion = workforceOnboardingVersion(r.expectedVersion),
          o = workforceOnboardingClosed(r.observation, [
            "profile",
            "actorReference",
            "creationIntentDigest",
            "emailDigest",
            "observedAt",
            "validUntil",
            "status",
            "dispatchAccepted",
            "provider",
          ]);
        if (
          o.profile !== "CognitoWorkforceInvitationObservationV1" ||
          o.actorReference !== scope.actorReference ||
          o.creationIntentDigest !== intentDigest ||
          typeof o.status !== "string" ||
          !["Created", "Found", "NotFound", "Mismatch", "Unknown"].includes(o.status) ||
          (o.status === "Created" ? o.dispatchAccepted !== true : o.dispatchAccepted !== null)
        )
          return poison();
        const observedAt = workforceOnboardingInstant(o.observedAt),
          until = workforceOnboardingInstant(o.validUntil);
        if (
          observedAt > origin ||
          until <= observedAt ||
          Date.parse(until) > Date.parse(observedAt) + 5000
        )
          return poison();
        // An expired Unknown is still a dispatch-uncertainty fact, never current
        // Provider qualification. Positive/mismatch results require a live packet.
        if (o.status !== "Unknown" && o.status !== "NotFound") {
          if (until <= latest) return poison();
          deadline = until < deadline ? until : deadline;
        }
        check();
        let material: Readonly<{
          username: string;
          subject: string;
          status: "FORCE_CHANGE_PASSWORD" | "CONFIRMED";
          enabled: boolean;
          createdAt: string;
        }> | null = null;
        if (o.status === "Created" || o.status === "Found") {
          const raw = workforceOnboardingClosed(o.provider, [
            "username",
            "subject",
            "status",
            "enabled",
            "createdAt",
          ]);
          if (
            raw.username !== `bop_${scope.actorReference}` ||
            (raw.status !== "FORCE_CHANGE_PASSWORD" && raw.status !== "CONFIRMED") ||
            typeof raw.enabled !== "boolean"
          )
            return poison();
          material = Object.freeze({
            username: raw.username,
            subject: parseWorkforceAccountBindingSubject(raw.subject),
            status: raw.status,
            enabled: raw.enabled,
            createdAt: workforceOnboardingInstant(raw.createdAt),
          });
        } else if (o.provider !== null) return poison();
        const normalized = {
          operationReference,
          intentDigest,
          expectedVersion,
          observation: Object.freeze({
            ...o,
            emailDigest: parseSelectorHash(o.emailDigest),
            observedAt,
            validUntil: until,
            provider: material,
          }),
        };
        await admit(operationReference, intentDigest, "RecordInspection", normalized);
        const before = await read();
        if (
          !before ||
          before.version !== expectedVersion ||
          !["DispatchClaimed", "ProviderUnknown"].includes(before.state) ||
          before.expiresAt <= latest ||
          o.emailDigest !== before.original.emailDigest ||
          before.dispatchStartedAt === null ||
          observedAt < before.dispatchStartedAt
        )
          return poison();
        if (o.status === "Mismatch") {
          if (o.provider !== null) return poison();
          return append(nextBody(before, "Rejected"), before);
        }
        let provider: WorkforceOnboardingProvider | null = null;
        if (o.status === "Created" || o.status === "Found") {
          if (!material) return poison();
          const p = material,
            subject = p.subject,
            createdAt = p.createdAt;
          if (
            p.username !== `bop_${scope.actorReference}` ||
            (p.status !== "FORCE_CHANGE_PASSWORD" && p.status !== "CONFIRMED") ||
            typeof p.enabled !== "boolean" ||
            createdAt < before.dispatchStartedAt ||
            createdAt > latest
          )
            return poison();
          const subjectHash = parseSelectorHash(
            hash.call(
              hasher,
              parseRawBrowserCredential(
                Buffer.from(
                  sha256Hex(
                    canon({ domain: "WORKFORCE_ONBOARDING_SUBJECT_V1", configuration, subject }),
                  ),
                  "hex",
                ).toString("base64url"),
              ),
            ),
          );
          check();
          const encryptedSubject = await encrypt.call(
            envelopes,
            subject,
            workforceOnboardingSubjectContext(before.original),
          );
          check();
          provider = Object.freeze({
            subjectHash,
            encryptedSubject,
            username: p.username,
            createdAt,
            status: p.status,
            enabled: p.enabled,
          });
        } else if (o.provider !== null) return poison();
        return append(
          nextBody(before, provider ? "ProviderObserved" : "ProviderUnknown", provider),
          before,
        );
      });
    },
    recordExpired(value: unknown) {
      return protect(async () => {
        const { r, operationReference, intentDigest } = request(value, ["expectedVersion"]),
          expectedVersion = workforceOnboardingVersion(r.expectedVersion);
        await admit(operationReference, intentDigest, "RecordExpired", {
          operationReference,
          intentDigest,
          expectedVersion,
        });
        const before = await read();
        if (!before) return poison();
        if (before.state === "Expired" || before.state === "Rejected")
          return originalOnly(before).then((record) => {
            if (!record) return poison();
            return record;
          });
        if (before.version !== expectedVersion || before.expiresAt > origin) return poison();
        return append(nextBody(before, "Expired"), before);
      });
    },
    assertFinalized() {
      if (phase !== "Final" || busy || !checked) return poison();
    },
  });
}
