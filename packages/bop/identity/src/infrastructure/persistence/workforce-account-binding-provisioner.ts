import { Buffer } from "node:buffer";
import { appendPlatformAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createIdentityActor,
  parseCanonicalInstant,
  type IdentityActor,
} from "../../contracts/identity-actor.js";
import {
  parseRawBrowserCredential,
  parseSelectorHash,
  type SelectorHash,
} from "../../contracts/browser-session.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../../application/ports/session-credential-ports.js";
import { createCognitoSubjectStatus } from "../cognito-subject-status.js";
import {
  buildWorkforceAccountBinding,
  parseWorkforceAccountBinding,
  parseWorkforceAccountBindingCommand,
  parseWorkforceAccountBindingAcceptanceCommand,
  workforceAccountBindingAcceptanceOriginal,
  parseWorkforceAccountBindingConfiguration,
  parseWorkforceAccountBindingInstant,
  parseWorkforceAccountBindingReference,
  parseWorkforceAccountBindingSubject,
  workforceAccountBindingClosed,
  workforceAccountBindingFail,
  workforceAccountBindingIntent,
  workforceAccountBindingOriginal,
  workforceAccountBindingPurpose,
  workforceAccountSubjectContext,
  WorkforceAccountBindingError,
  type WorkforceAccountBinding,
  type WorkforceAccountBindingCommand,
  type WorkforceAccountBindingAcceptanceCommand,
  type WorkforceAccountBindingConfiguration,
} from "../../contracts/workforce-account-binding.js";
export interface WorkforceAccountBindingTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface WorkforceAccountBindingAuthorityPort {
  hold(
    tx: WorkforceAccountBindingTransaction,
    input: {
      readonly configuration: WorkforceAccountBindingConfiguration;
      readonly command: WorkforceAccountBindingCommand | WorkforceAccountBindingAcceptanceCommand;
      readonly subjectHash: string;
      readonly intentDigest: string;
      readonly observedAt: string;
      readonly validUntil: string;
    },
  ): Promise<{
    readonly operator: IdentityActor;
    readonly approvedByReference: string;
    readonly approvalEvidenceReference: string;
    readonly validUntil: string;
  }>;
}
export interface WorkforceAccountBindingProvisionerOptions {
  readonly transaction: WorkforceAccountBindingTransaction;
  readonly configuration: WorkforceAccountBindingConfiguration;
  readonly operatorReference: string;
  readonly provisioningRoleName: string;
  readonly clock: { now(): string };
  readonly hasher: BrowserCredentialHasherPort;
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly authority: WorkforceAccountBindingAuthorityPort;
  readonly nextReference: (kind: "Audit") => string;
  readonly appendAudit: typeof appendPlatformAuditRecordInTransaction;
  readonly registerBeforeCommit: (
    tx: WorkforceAccountBindingTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export interface WorkforceAccountBindingAcceptanceWriterOptions extends WorkforceAccountBindingProvisionerOptions {
  readonly authority: {
    hold(
      tx: WorkforceAccountBindingTransaction,
      input: Parameters<WorkforceAccountBindingAuthorityPort["hold"]>[1],
    ): Promise<
      Awaited<ReturnType<WorkforceAccountBindingAuthorityPort["hold"]>> & {
        readonly authorizationTransactionReference: string;
        readonly invitationReference: string;
        readonly originalOnboardingIntentDigest: string;
      }
    >;
  };
}
export const workforceAccountBindingCodec = Object.freeze({
  canonicalize: canonicalizeRfc8785,
  hash: sha256Hex,
});
export function workforceAccountBindingSubjectHash(
  hasher: BrowserCredentialHasherPort,
  configuration: WorkforceAccountBindingConfiguration,
  subject: string,
): SelectorHash {
  const c = parseWorkforceAccountBindingConfiguration(configuration);
  const preimage = canonicalizeRfc8785({
    domain: "WORKFORCE_ACCOUNT_BINDING_SUBJECT_V1",
    environment: c.environment,
    issuer: c.issuer,
    subject: parseWorkforceAccountBindingSubject(subject),
  });
  return parseSelectorHash(
    hasher.hash(
      parseRawBrowserCredential(Buffer.from(sha256Hex(preimage), "hex").toString("base64url")),
    ),
  );
}
function one(value: unknown): Readonly<Record<string, unknown>> | null {
  const d =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")
      : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length > 1 ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return workforceAccountBindingFail();
  if (d.value.length === 0) return null;
  const row = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!row?.enumerable || !("value" in row)) return workforceAccountBindingFail();
  if (row.value === null || typeof row.value !== "object") return workforceAccountBindingFail();
  return row.value;
}
const principalSql = `SELECT session_user::text session_principal,current_user::text current_principal,current_setting('transaction_isolation') isolation,txid_current()::text transaction_id,
 (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND has_table_privilege(session_user,'bop_identity.workforce_account_binding','INSERT')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='bop_identity' AND (pg_has_role(r.oid,c.relowner,'USAGE') OR pg_has_role(r.oid,c.relowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='bop_identity' AND (pg_has_role(r.oid,n.nspowner,'USAGE') OR pg_has_role(r.oid,n.nspowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(r.oid,e.oid,'SET'))) IS TRUE controlled FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`;
const originalSql =
  "SELECT snapshot_text,source_digest FROM bop_identity.workforce_account_binding WHERE recorded_by=$1 AND operation_id=$2";
const insertSql = `INSERT INTO bop_identity.workforce_account_binding(actor_id,environment,issuer,subject_hash,invitation_id,original_membership_id,provider_evidence_id,operation_id,recorded_by,approved_by,approval_id,reason_code,intent_digest,audit_id,recorded_at,source_digest,snapshot_text,writer_transaction_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,txid_current())`;
/** Create-only approved identity linkage. This verifies held evidence, not legal
 * employment, grants, a login, or a new invitation's acceptance. Caller owns rollback. */
export function createPostgresWorkforceAccountBindingProvisioner(
  options: WorkforceAccountBindingProvisionerOptions,
) {
  return createBindingWriter(options, false);
}
export function createPostgresWorkforceAccountBindingAcceptanceWriter(
  options: WorkforceAccountBindingAcceptanceWriterOptions,
) {
  const writer = createBindingWriter(options, true);
  return Object.freeze({ accept: writer.provision, assertFinalized: writer.assertFinalized });
}
function createBindingWriter(
  options: WorkforceAccountBindingProvisionerOptions,
  acceptance: boolean,
) {
  workforceAccountBindingClosed(options, [
    "transaction",
    "configuration",
    "operatorReference",
    "provisioningRoleName",
    "clock",
    "hasher",
    "envelopes",
    "originalObservedAt",
    "originalValidUntil",
    "authority",
    "nextReference",
    "appendAudit",
    "registerBeforeCommit",
  ]);
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    now = clock.now,
    configuration = parseWorkforceAccountBindingConfiguration(options.configuration),
    operator = parseWorkforceAccountBindingReference(options.operatorReference),
    role = options.provisioningRoleName,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    envelopes = options.envelopes,
    encrypt = envelopes.encrypt,
    decrypt = envelopes.decrypt,
    authority = options.authority,
    hold = authority.hold,
    next = options.nextReference,
    append = options.appendAudit,
    register = options.registerBeforeCommit;
  const observedAt = parseWorkforceAccountBindingInstant(options.originalObservedAt),
    originalDeadline = parseWorkforceAccountBindingInstant(options.originalValidUntil);
  if (
    !/^[a-z][a-z0-9_]{0,62}$/u.test(role) ||
    observedAt >= originalDeadline ||
    Date.parse(originalDeadline) > Date.parse(observedAt) + 5000 ||
    [queryPort, now, hash, equals, encrypt, decrypt, hold, next, append, register].some(
      (p) => typeof p !== "function",
    )
  )
    return workforceAccountBindingFail();
  const provider = createCognitoSubjectStatus({
    userPoolId: configuration.issuer.slice(configuration.issuer.lastIndexOf("/") + 1),
    clock,
  });
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    deadline = originalDeadline,
    latest = observedAt,
    asyncCalls = 0,
    finalCalls = 0,
    asyncComplete = false,
    transactionId: string | undefined,
    operatorPin: string | undefined,
    invitationPin: string | undefined,
    acceptanceAuthorityPin: string | undefined;
  let selected: WorkforceAccountBinding | undefined,
    command: WorkforceAccountBindingCommand | WorkforceAccountBindingAcceptanceCommand | undefined,
    subjectHash: SelectorHash | undefined,
    intentDigest: string | undefined,
    fresh = false;
  const poison = (): never => {
    phase = "Poison";
    return workforceAccountBindingFail("WORKFORCE_ACCOUNT_BINDING_UNAVAILABLE");
  };
  const check = () => {
    try {
      const at = parseWorkforceAccountBindingInstant(now.call(clock));
      if (
        phase === "Final" ||
        phase === "Poison" ||
        tx !== options.transaction ||
        tx.query !== queryPort ||
        options.clock !== clock ||
        clock.now !== now ||
        options.hasher !== hasher ||
        hasher.hash !== hash ||
        hasher.equals !== equals ||
        options.envelopes !== envelopes ||
        envelopes.encrypt !== encrypt ||
        envelopes.decrypt !== decrypt ||
        options.authority !== authority ||
        authority.hold !== hold ||
        options.nextReference !== next ||
        options.appendAudit !== append ||
        options.registerBeforeCommit !== register ||
        options.operatorReference !== operator ||
        options.provisioningRoleName !== role ||
        options.originalObservedAt !== observedAt ||
        options.originalValidUntil !== originalDeadline ||
        canonicalizeRfc8785(parseWorkforceAccountBindingConfiguration(options.configuration)) !==
          canonicalizeRfc8785(configuration) ||
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
    try {
      const r = await queryPort.call(tx, sql, values);
      check();
      return r;
    } catch {
      return poison();
    }
  };
  const principal = async () => {
    const row = one(await query(principalSql, []));
    if (!row) return poison();
    const r = workforceAccountBindingClosed(row, [
      "session_principal",
      "current_principal",
      "isolation",
      "transaction_id",
      "controlled",
    ]);
    if (
      r.session_principal !== role ||
      r.current_principal !== role ||
      r.isolation !== "read committed" ||
      r.controlled !== true ||
      typeof r.transaction_id !== "string" ||
      !/^[1-9][0-9]*$/u.test(r.transaction_id) ||
      (transactionId !== undefined && transactionId !== r.transaction_id)
    )
      return poison();
    transactionId = r.transaction_id;
  };
  const context = async () => {
    if (!command || !subjectHash) return poison();
    await query(
      "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true),set_config('bop.workforce_account_environment',$3,true),set_config('bop.workforce_account_issuer',$4,true),set_config('bop.workforce_account_actor_id',$5,true),set_config('bop.workforce_account_subject_hash',$6,true),set_config('bop.workforce_account_purpose',$2,true)",
      [
        operator,
        workforceAccountBindingPurpose,
        configuration.environment,
        configuration.issuer,
        command.actorReference,
        subjectHash,
      ],
    );
  };
  const parseRow = (
    row: Readonly<Record<string, unknown>> | null,
    coherent = false,
  ): WorkforceAccountBinding | null => {
    if (!row) return null;
    const r = workforceAccountBindingClosed(
      row,
      coherent
        ? ["snapshot_text", "source_digest", "coherent"]
        : ["snapshot_text", "source_digest"],
    );
    if (
      typeof r.snapshot_text !== "string" ||
      r.snapshot_text.length > 32768 ||
      (coherent && r.coherent !== true)
    )
      return poison();
    const b = parseWorkforceAccountBinding(
      JSON.parse(r.snapshot_text),
      workforceAccountBindingCodec,
    );
    if (
      canonicalizeRfc8785(b) !== r.snapshot_text ||
      b.sourceDigest !== r.source_digest ||
      canonicalizeRfc8785(b.configuration) !== canonicalizeRfc8785(configuration) ||
      b.recordedAt > check()
    )
      return poison();
    return b;
  };
  const original = async () => {
    if (!command) return poison();
    const b = parseRow(one(await query(originalSql, [operator, command.operationReference])));
    if (
      b &&
      (b.recordedByReference !== operator || b.operationReference !== command.operationReference)
    )
      return poison();
    return b;
  };
  const current = async () => {
    if (!command || !subjectHash) return poison();
    const actorBinding = parseRow(
      one(
        await query("SELECT * FROM bop_identity.workforce_account_binding_read($1,$2,$3,$4)", [
          command.actorReference,
          null,
          configuration.issuer,
          configuration.environment,
        ]),
      ),
      true,
    );
    const subjectBinding = parseRow(
      one(
        await query("SELECT * FROM bop_identity.workforce_account_binding_read($1,$2,$3,$4)", [
          null,
          subjectHash,
          configuration.issuer,
          configuration.environment,
        ]),
      ),
      true,
    );
    if (
      (actorBinding && actorBinding.actorReference !== command.actorReference) ||
      (subjectBinding && subjectBinding.subjectHash !== subjectHash)
    )
      return poison();
    return actorBinding ?? subjectBinding;
  };
  const authorize = async () => {
    if (!command || !subjectHash || !intentDigest) return poison();
    await principal();
    const r = workforceAccountBindingClosed(
      await hold.call(authority, tx, {
        configuration,
        command,
        subjectHash,
        intentDigest,
        observedAt: check(),
        validUntil: deadline,
      }),
      [
        "operator",
        "approvedByReference",
        "approvalEvidenceReference",
        "validUntil",
        ...(acceptance
          ? [
              "authorizationTransactionReference",
              "invitationReference",
              "originalOnboardingIntentDigest",
            ]
          : []),
      ],
    );
    check();
    const actor = createIdentityActor(r.operator),
      until = parseWorkforceAccountBindingInstant(r.validUntil);
    if (
      actor.actorReference !== operator ||
      actor.actorType !== "User" ||
      actor.accountKind !== (acceptance ? "Workforce" : "Platform") ||
      actor.status !== "Active" ||
      actor.authenticationMethod !== "Oidc" ||
      actor.verificationLevel !== "RecentMfa" ||
      actor.recentMfaAt === null ||
      actor.authenticatedAt === null ||
      String(actor.authenticatedAt) > latest ||
      String(actor.recentMfaAt) > latest ||
      Date.parse(latest) >= Date.parse(actor.recentMfaAt) + 900000 ||
      until <= latest ||
      Date.parse(until) > Date.parse(latest) + 5000 ||
      r.approvedByReference !== command.approvedByReference ||
      r.approvalEvidenceReference !== command.approvalEvidenceReference
    )
      return poison();
    if (acceptance) {
      const evidence = Object.freeze({
        authorizationTransactionReference: parseWorkforceAccountBindingReference(
          r.authorizationTransactionReference,
        ),
        invitationReference: parseWorkforceAccountBindingReference(r.invitationReference),
        originalOnboardingIntentDigest: r.originalOnboardingIntentDigest,
      });
      if (
        actor.actorReference !== command.actorReference ||
        evidence.invitationReference !== command.invitationReference ||
        typeof evidence.originalOnboardingIntentDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(evidence.originalOnboardingIntentDigest)
      )
        return poison();
      const evidenceBytes = canonicalizeRfc8785(evidence);
      if (acceptanceAuthorityPin !== undefined && evidenceBytes !== acceptanceAuthorityPin)
        return poison();
      acceptanceAuthorityPin = evidenceBytes;
    }
    const pin = canonicalizeRfc8785(actor);
    if (operatorPin !== undefined && operatorPin !== pin) return poison();
    operatorPin = pin;
    deadline =
      [deadline, until, new Date(Date.parse(actor.recentMfaAt) + 900000).toISOString()].sort()[0] ??
      deadline;
    check();
    await context();
  };
  const invitation = async () => {
    if (!command) return poison();
    const row = one(
      await query("SELECT * FROM bop_identity.workforce_account_invitation_read($1,$2)", [
        command.actorReference,
        command.invitationReference,
      ]),
    );
    if (!row) return poison();
    const r = workforceAccountBindingClosed(row, [
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
    ]);
    const created = parseWorkforceAccountBindingInstant(r.created_at),
      expires = parseWorkforceAccountBindingInstant(r.expires_at),
      consumed = parseWorkforceAccountBindingInstant(r.consumed_at);
    if (
      r.invitation_id !== command.invitationReference ||
      r.actor_id !== command.actorReference ||
      r.membership_id !== command.originalMembershipReference ||
      r.provider_evidence_id !== command.providerEvidenceReference ||
      r.status !== "Accepted" ||
      r.precise !== true ||
      !Number.isInteger(r.version) ||
      (r.version as number) < 1 ||
      (r.version as number) > 2147483647 ||
      created > observedAt ||
      consumed > observedAt ||
      (acceptance && (consumed !== observedAt || expires <= latest)) ||
      consumed < created ||
      consumed >= expires ||
      Date.parse(expires) !== Date.parse(created) + 86400000
    )
      return poison();
    const pin = canonicalizeRfc8785(r);
    if (invitationPin !== undefined && invitationPin !== pin) return poison();
    invitationPin = pin;
  };
  const verifyProvider = async () => {
    if (!command) return poison();
    const seen = check();
    const r = workforceAccountBindingClosed(
      await provider.readCurrentProviderSubject({
        issuer: configuration.issuer,
        subject: command.subject,
        observedAt: seen,
      }),
      ["issuer", "subject", "status", "observedAt", "validUntil"],
    );
    check();
    const until = parseWorkforceAccountBindingInstant(r.validUntil);
    if (
      r.issuer !== configuration.issuer ||
      r.subject !== command.subject ||
      r.status !== "Enabled" ||
      r.observedAt !== seen ||
      until <= latest ||
      Date.parse(until) > Date.parse(seen) + 5000
    )
      return poison();
    deadline = [deadline, until].sort()[0] ?? deadline;
    check();
  };
  const guard = async () => {
    if (busy || phase !== "Ready" || ++asyncCalls !== 1) return poison();
    busy = true;
    try {
      await authorize();
      if (fresh) {
        await invitation();
        await verifyProvider();
      }
      const b = await original();
      if (!b || !selected || canonicalizeRfc8785(b) !== canonicalizeRfc8785(selected))
        return poison();
      await principal();
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
    async provision(value: unknown): Promise<WorkforceAccountBinding> {
      if (busy || phase !== "Open") return poison();
      busy = true;
      try {
        await register(tx, guard, final);
        check();
        command = acceptance
          ? parseWorkforceAccountBindingAcceptanceCommand(value)
          : parseWorkforceAccountBindingCommand(value);
        if (command.recordedByReference !== operator)
          return workforceAccountBindingFail("WORKFORCE_ACCOUNT_BINDING_DENIED");
        subjectHash = workforceAccountBindingSubjectHash(hasher, configuration, command.subject);
        check();
        intentDigest = workforceAccountBindingIntent(
          configuration,
          command.profile === "WorkforceAccountBindingAcceptanceV1"
            ? workforceAccountBindingAcceptanceOriginal(command, subjectHash)
            : workforceAccountBindingOriginal(command, subjectHash),
          workforceAccountBindingCodec,
        );
        await principal();
        await context();
        await query(
          acceptance
            ? "SELECT bop_identity.workforce_account_binding_acceptance_admit($1,$2,$3,$4)"
            : "SELECT bop_identity.workforce_account_binding_import_admit($1,$2,$3,$4)",
          [operator, command.actorReference, command.operationReference, subjectHash],
        );
        const saved = await original();
        if (saved) {
          if (
            saved.intentDigest !== intentDigest ||
            canonicalizeRfc8785(saved.originalCommand) !==
              canonicalizeRfc8785(
                command.profile === "WorkforceAccountBindingAcceptanceV1"
                  ? workforceAccountBindingAcceptanceOriginal(command, subjectHash)
                  : workforceAccountBindingOriginal(command, subjectHash),
              )
          )
            return workforceAccountBindingFail("WORKFORCE_ACCOUNT_BINDING_INTENT_CONFLICT");
          await authorize();
          const plaintext = await decrypt.call(
            envelopes,
            saved.encryptedSubject,
            workforceAccountSubjectContext(configuration, saved.actorReference),
          );
          check();
          if (plaintext !== canonicalizeRfc8785({ subject: command.subject })) return poison();
          selected = saved;
        } else {
          if (await current())
            return workforceAccountBindingFail("WORKFORCE_ACCOUNT_BINDING_CONFLICT");
          await authorize();
          await invitation();
          await verifyProvider();
          const auditReference = parseWorkforceAccountBindingReference(next("Audit"));
          check();
          const encryptedSubject = await encrypt.call(
            envelopes,
            canonicalizeRfc8785({ subject: command.subject }),
            workforceAccountSubjectContext(configuration, command.actorReference),
          );
          check();
          const plaintext = await decrypt.call(
            envelopes,
            encryptedSubject,
            workforceAccountSubjectContext(configuration, command.actorReference),
          );
          check();
          if (plaintext !== canonicalizeRfc8785({ subject: command.subject })) return poison();
          selected = buildWorkforceAccountBinding(
            {
              profile: "WorkforceAccountBindingV1",
              actorReference: command.actorReference,
              configuration,
              subjectHash,
              encryptedSubject,
              invitationReference: command.invitationReference,
              originalMembershipReference: command.originalMembershipReference,
              providerEvidenceReference: command.providerEvidenceReference,
              operationReference: command.operationReference,
              intentDigest,
              originalCommand:
                command.profile === "WorkforceAccountBindingAcceptanceV1"
                  ? workforceAccountBindingAcceptanceOriginal(command, subjectHash)
                  : workforceAccountBindingOriginal(command, subjectHash),
              recordedByReference: operator,
              approvedByReference: command.approvedByReference,
              approvalEvidenceReference: command.approvalEvidenceReference,
              reasonCode: command.reasonCode,
              auditReference,
              recordedAt: observedAt,
              classification: "RestrictedSecurity",
            },
            workforceAccountBindingCodec,
          );
          await append(tx, {
            auditReference,
            actorReference: operator,
            purposeCode: workforceAccountBindingPurpose,
            actionCode: "WORKFORCE_ACCOUNT_BOUND",
            targetType: "WorkforceAccountBinding",
            targetReference: command.actorReference,
            operationReference: command.operationReference,
            intentDigest,
            occurredAt: parseCanonicalInstant(observedAt),
            reasonCode: command.reasonCode,
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          });
          check();
          await context();
          await query(insertSql, [
            selected.actorReference,
            configuration.environment,
            configuration.issuer,
            subjectHash,
            command.invitationReference,
            command.originalMembershipReference,
            command.providerEvidenceReference,
            command.operationReference,
            operator,
            command.approvedByReference,
            command.approvalEvidenceReference,
            command.reasonCode,
            intentDigest,
            auditReference,
            observedAt,
            selected.sourceDigest,
            canonicalizeRfc8785(selected),
          ]);
          const stored = await original();
          if (!stored || canonicalizeRfc8785(stored) !== canonicalizeRfc8785(selected))
            return poison();
          fresh = true;
        }
        check();
        phase = "Ready";
        return selected;
      } catch (error) {
        phase = "Poison";
        if (error instanceof WorkforceAccountBindingError) throw error;
        return workforceAccountBindingFail("WORKFORCE_ACCOUNT_BINDING_UNAVAILABLE");
      } finally {
        busy = false;
      }
    },
    assertFinalized() {
      if (phase !== "Final" || busy || asyncCalls !== 1 || finalCalls !== 1 || !asyncComplete)
        return poison();
    },
  });
}
