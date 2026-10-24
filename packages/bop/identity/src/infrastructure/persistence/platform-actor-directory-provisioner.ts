import { appendPlatformAuditRecordInTransaction, canonicalizeRfc8785 } from "@bop/audit";
import {
  buildPlatformActorDirectoryRevision,
  parsePlatformActorDirectoryCommand,
  parsePlatformActorDirectoryConfiguration,
  parsePlatformActorDirectoryInstant,
  parsePlatformActorDirectoryReference,
  parsePlatformActorDirectoryRevision,
  parsePlatformActorDirectorySubject,
  platformActorDirectoryClosed,
  platformActorDirectoryFail,
  platformActorDirectoryIntent,
  platformActorDirectoryOriginal,
  platformActorDirectoryPurpose,
  platformActorSubjectContext,
  PlatformActorDirectoryError,
  type PlatformActorDirectoryCommand,
  type PlatformActorDirectoryConfiguration,
  type PlatformActorDirectoryRevision,
} from "../../contracts/platform-actor-directory.js";
import {
  platformActorDirectoryCodec,
  platformActorDirectoryOne,
  platformActorDirectorySubjectHash,
  type PlatformActorDirectorySourceOptions,
  type PlatformActorDirectoryTransaction,
} from "./platform-actor-directory-store.js";
export interface PlatformActorDirectoryApprovalPort {
  hold(
    tx: PlatformActorDirectoryTransaction,
    input: {
      readonly configuration: PlatformActorDirectoryConfiguration;
      readonly command: PlatformActorDirectoryCommand;
      readonly subjectHash: string;
      readonly intentDigest: string;
      readonly observedAt: string;
      readonly validUntil: string;
    },
  ): Promise<{
    readonly operatorReference: string;
    readonly approvedByReference: string;
    readonly approvalReference: string;
    readonly validUntil: string;
  }>;
}
export interface PlatformActorDirectoryProvisionerOptions extends Omit<
  PlatformActorDirectorySourceOptions,
  "readCurrentProviderSubject"
> {
  readonly operatorReference: string;
  readonly provisioningRoleName: string;
  readonly authority: PlatformActorDirectoryApprovalPort;
  readonly nextReference: (kind: "Revision" | "Audit") => string;
  readonly appendAudit: typeof appendPlatformAuditRecordInTransaction;
  readonly readCurrentProviderSubject: PlatformActorDirectorySourceOptions["readCurrentProviderSubject"];
}
const principalSql = `SELECT session_user::text session_principal,current_user::text current_principal,current_setting('transaction_isolation') isolation,
 (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND has_table_privilege(session_user,'bop_identity.platform_actor_directory_revision','INSERT')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='bop_identity' AND (pg_has_role(r.oid,c.relowner,'USAGE') OR pg_has_role(r.oid,c.relowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='bop_identity' AND (pg_has_role(r.oid,n.nspowner,'USAGE') OR pg_has_role(r.oid,n.nspowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(r.oid,e.oid,'SET'))) IS TRUE controlled FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`;
const currentSql = `SELECT r.snapshot_text,r.source_digest FROM bop_identity.platform_actor_directory_head h JOIN bop_identity.platform_actor_directory_revision r ON r.actor_id=h.actor_id AND r.version=h.current_version WHERE h.actor_id=$1 AND h.issuer=$2 AND h.environment=$3 AND h.revision_id=r.revision_id AND h.source_digest=r.source_digest AND h.current_status=r.status AND h.subject_hash=r.subject_hash`;
const originalSql = `SELECT snapshot_text,source_digest FROM bop_identity.platform_actor_directory_revision WHERE recorded_by=$1 AND operation_id=$2`;
export function createPostgresPlatformActorDirectoryProvisioner(
  options: PlatformActorDirectoryProvisionerOptions,
) {
  const configuration = parsePlatformActorDirectoryConfiguration(options.configuration),
    operator = parsePlatformActorDirectoryReference(options.operatorReference),
    tx = options.transaction,
    originalQuery = tx.query,
    clock = options.clock,
    now = clock.now,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    envelopes = options.envelopes,
    encrypt = envelopes.encrypt,
    decrypt = envelopes.decrypt,
    provider = options.readCurrentProviderSubject,
    authority = options.authority,
    hold = authority.hold,
    next = options.nextReference,
    append = options.appendAudit,
    register = options.registerBeforeCommit,
    role = options.provisioningRoleName;
  const observedAt = parsePlatformActorDirectoryInstant(options.originalObservedAt),
    originalDeadline = parsePlatformActorDirectoryInstant(options.originalValidUntil);
  if (
    !/^[a-z][a-z0-9_]{0,62}$/u.test(role) ||
    observedAt >= originalDeadline ||
    Date.parse(originalDeadline) > Date.parse(observedAt) + 5000 ||
    [
      originalQuery,
      now,
      hash,
      equals,
      encrypt,
      decrypt,
      provider,
      hold,
      next,
      append,
      register,
    ].some((p) => typeof p !== "function")
  )
    return platformActorDirectoryFail();
  let latest = observedAt,
    deadline = originalDeadline,
    phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    asyncCalls = 0,
    finalCalls = 0,
    asyncComplete = false;
  const poison = (): never => {
    phase = "Poison";
    return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_UNAVAILABLE");
  };
  const check = () => {
    const at = parsePlatformActorDirectoryInstant(now.call(clock));
    if (
      phase === "Poison" ||
      phase === "Final" ||
      options.transaction !== tx ||
      tx.query !== originalQuery ||
      options.clock !== clock ||
      clock.now !== now ||
      options.hasher !== hasher ||
      hasher.hash !== hash ||
      hasher.equals !== equals ||
      options.envelopes !== envelopes ||
      envelopes.encrypt !== encrypt ||
      envelopes.decrypt !== decrypt ||
      options.readCurrentProviderSubject !== provider ||
      options.authority !== authority ||
      authority.hold !== hold ||
      options.nextReference !== next ||
      options.appendAudit !== append ||
      options.registerBeforeCommit !== register ||
      options.operatorReference !== operator ||
      options.provisioningRoleName !== role ||
      options.originalObservedAt !== observedAt ||
      options.originalValidUntil !== originalDeadline ||
      canonicalizeRfc8785(parsePlatformActorDirectoryConfiguration(options.configuration)) !==
        canonicalizeRfc8785(configuration) ||
      at < latest ||
      at >= deadline
    )
      return poison();
    latest = at;
    return at;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    try {
      const result = await originalQuery.call(tx, sql, values);
      check();
      return result;
    } catch {
      return poison();
    }
  };
  const context = async (actor: string) => {
    await query(
      "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true),set_config('bop.platform_directory_environment',$3,true),set_config('bop.platform_directory_issuer',$4,true),set_config('bop.platform_directory_actor_id',$5,true),set_config('bop.platform_directory_subject_hash','',true)",
      [
        operator,
        platformActorDirectoryPurpose,
        configuration.environment,
        configuration.issuer,
        actor,
      ],
    );
  };
  const parseRow = (row: Record<string, unknown> | null): PlatformActorDirectoryRevision | null => {
    if (!row) return null;
    const r = platformActorDirectoryClosed(row, ["snapshot_text", "source_digest"]);
    if (typeof r.snapshot_text !== "string" || r.snapshot_text.length > 32768) return poison();
    const parsed = parsePlatformActorDirectoryRevision(
      JSON.parse(r.snapshot_text),
      platformActorDirectoryCodec,
    );
    if (
      canonicalizeRfc8785(parsed) !== r.snapshot_text ||
      parsed.sourceDigest !== r.source_digest ||
      parsed.recordedAt > check()
    )
      return poison();
    return parsed;
  };
  const current = async (actor: string) => {
    const parsed = parseRow(
      platformActorDirectoryOne(
        await query(currentSql, [actor, configuration.issuer, configuration.environment]),
      ),
    );
    if (
      parsed &&
      (parsed.actorReference !== actor ||
        canonicalizeRfc8785(parsed.configuration) !== canonicalizeRfc8785(configuration))
    )
      return poison();
    return parsed;
  };
  const original = async (op: string) => {
    const parsed = parseRow(platformActorDirectoryOne(await query(originalSql, [operator, op])));
    if (
      parsed &&
      (parsed.recordedByReference !== operator ||
        parsed.operationReference !== op ||
        canonicalizeRfc8785(parsed.configuration) !== canonicalizeRfc8785(configuration))
    )
      return poison();
    return parsed;
  };
  const principal = async () => {
    const row = platformActorDirectoryOne(await query(principalSql, []));
    if (!row) return poison();
    const r = platformActorDirectoryClosed(row, [
      "session_principal",
      "current_principal",
      "isolation",
      "controlled",
    ]);
    if (
      r.session_principal !== role ||
      r.current_principal !== role ||
      r.isolation !== "read committed" ||
      r.controlled !== true
    )
      return poison();
  };
  const authorize = async (
    command: PlatformActorDirectoryCommand,
    subjectHash: string,
    intentDigest: string,
  ) => {
    await principal();
    const r = platformActorDirectoryClosed(
      await hold.call(authority, tx, {
        configuration,
        command,
        subjectHash,
        intentDigest,
        observedAt,
        validUntil: deadline,
      }),
      ["operatorReference", "approvedByReference", "approvalReference", "validUntil"],
    );
    check();
    if (
      r.operatorReference !== operator ||
      r.approvedByReference !== command.approvedByReference ||
      r.approvalReference !== command.approvalReference
    )
      return poison();
    deadline = [deadline, parsePlatformActorDirectoryInstant(r.validUntil)].sort()[0] ?? deadline;
    check();
    await context(command.actorReference);
  };
  const verifyProvider = async (subject: string) => {
    const r = platformActorDirectoryClosed(
      await provider({ issuer: configuration.issuer, subject, observedAt: check() }),
      ["issuer", "subject", "status", "observedAt", "validUntil"],
    );
    check();
    const seen = parsePlatformActorDirectoryInstant(r.observedAt),
      until = parsePlatformActorDirectoryInstant(r.validUntil);
    if (
      r.issuer !== configuration.issuer ||
      r.subject !== subject ||
      r.status !== "Enabled" ||
      seen < observedAt ||
      seen > latest ||
      until <= latest ||
      Date.parse(until) > Date.parse(seen) + 5000
    )
      return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_DENIED");
    deadline = [deadline, until].sort()[0] ?? deadline;
    check();
  };
  const subjectOf = async (revision: PlatformActorDirectoryRevision) => {
    const raw = await decrypt.call(
      envelopes,
      revision.encryptedSubject,
      platformActorSubjectContext(configuration, revision.actorReference),
    );
    check();
    if (typeof raw !== "string" || raw.length > 1024) return poison();
    const subject = parsePlatformActorDirectorySubject(
      platformActorDirectoryClosed(JSON.parse(raw), ["subject"]).subject,
    );
    if (
      !equals.call(
        hasher,
        platformActorDirectorySubjectHash(hasher, configuration, subject),
        revision.subjectHash,
      )
    )
      return poison();
    return subject;
  };
  return Object.freeze({
    async provision(value: unknown): Promise<PlatformActorDirectoryRevision> {
      try {
        if (busy || phase !== "Open") return poison();
        busy = true;
        check();
        const command = parsePlatformActorDirectoryCommand(value);
        if (command.recordedByReference !== operator)
          return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_DENIED");
        await principal();
        await context(command.actorReference);
        await query("SELECT bop_identity.platform_actor_directory_import_admit($1,$2,$3)", [
          operator,
          command.actorReference,
          command.operationReference,
        ]);
        const saved = await original(command.operationReference),
          before = await current(command.actorReference);
        const subjectHash =
          command.subject !== null
            ? platformActorDirectorySubjectHash(hasher, configuration, command.subject)
            : (saved?.subjectHash ?? before?.subjectHash);
        if (!subjectHash)
          return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_VERSION_CONFLICT");
        const originalCommand = platformActorDirectoryOriginal(command, subjectHash),
          intentDigest = platformActorDirectoryIntent(originalCommand, platformActorDirectoryCodec);
        await authorize(command, subjectHash, intentDigest);
        let result: PlatformActorDirectoryRevision,
          actualSubject: string | null = null;
        if (saved) {
          if (
            saved.intentDigest !== intentDigest ||
            canonicalizeRfc8785(saved.originalCommand) !== canonicalizeRfc8785(originalCommand)
          )
            return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_INTENT_CONFLICT");
          result = saved;
        } else {
          const beforeHead = before
            ? {
                revisionReference: before.revisionReference,
                version: before.version,
                sourceDigest: before.sourceDigest,
              }
            : null;
          if (canonicalizeRfc8785(beforeHead) !== canonicalizeRfc8785(command.expectedHead))
            return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_VERSION_CONFLICT");
          if (
            (command.operation === "Suspend" && before?.status !== "Active") ||
            (command.operation === "Restore" &&
              before?.status !== "Suspended" &&
              before?.status !== "Disabled") ||
            (command.operation === "Disable" && before?.status === "Disabled")
          )
            return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_VERSION_CONFLICT");
          actualSubject = command.subject ?? (before ? await subjectOf(before) : null);
          if (!actualSubject) return poison();
          if (command.operation === "ImportActive" || command.operation === "Restore")
            await verifyProvider(actualSubject);
          const version = (before?.version ?? 0) + 1;
          if (version > 2147483647) return poison();
          const revisionReference = parsePlatformActorDirectoryReference(next("Revision")),
            auditReference = parsePlatformActorDirectoryReference(next("Audit"));
          check();
          const encryptedSubject =
            before?.encryptedSubject ??
            (await encrypt.call(
              envelopes,
              JSON.stringify({ subject: actualSubject }),
              platformActorSubjectContext(configuration, command.actorReference),
            ));
          check();
          result = buildPlatformActorDirectoryRevision(
            {
              profile: "PlatformActorDirectoryRevisionV1",
              actorReference: command.actorReference,
              configuration,
              subjectHash,
              encryptedSubject,
              revisionReference,
              version,
              supersedesRevisionReference: before?.revisionReference ?? null,
              status:
                command.operation === "Suspend"
                  ? "Suspended"
                  : command.operation === "Disable"
                    ? "Disabled"
                    : "Active",
              operationReference: command.operationReference,
              intentDigest,
              originalCommand,
              recordedByReference: operator,
              approvedByReference: command.approvedByReference,
              approvalReference: command.approvalReference,
              reasonCode: command.reasonCode,
              auditReference,
              recordedAt: check(),
              classification: "RestrictedSecurity",
            },
            platformActorDirectoryCodec,
          );
          const inserted = platformActorDirectoryOne(
            await query(
              `INSERT INTO bop_identity.platform_actor_directory_revision(actor_id,version,revision_id,environment,issuer,subject_hash,status,recorded_by,approved_by,approval_id,operation_id,intent_digest,audit_id,recorded_at,source_digest,snapshot_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING revision_id::text AS revision_reference`,
              [
                result.actorReference,
                result.version,
                result.revisionReference,
                configuration.environment,
                configuration.issuer,
                result.subjectHash,
                result.status,
                operator,
                result.approvedByReference,
                result.approvalReference,
                result.operationReference,
                intentDigest,
                result.auditReference,
                result.recordedAt,
                result.sourceDigest,
                canonicalizeRfc8785(result),
              ],
            ),
          );
          if (
            !inserted ||
            platformActorDirectoryClosed(inserted, ["revision_reference"]).revision_reference !==
              revisionReference
          )
            return poison();
          const sql =
            before === null
              ? `INSERT INTO bop_identity.platform_actor_directory_head(actor_id,environment,issuer,subject_hash,current_version,revision_id,current_status,source_digest,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING revision_id::text AS revision_reference`
              : `UPDATE bop_identity.platform_actor_directory_head SET current_version=$5,revision_id=$6,current_status=$7,source_digest=$8,recorded_at=$9 WHERE actor_id=$1 AND environment=$2 AND issuer=$3 AND subject_hash=$4 AND current_version=$10 AND revision_id=$11 AND source_digest=$12 RETURNING revision_id::text AS revision_reference`;
          const values: readonly unknown[] =
            before === null
              ? [
                  result.actorReference,
                  configuration.environment,
                  configuration.issuer,
                  subjectHash,
                  result.version,
                  revisionReference,
                  result.status,
                  result.sourceDigest,
                  result.recordedAt,
                ]
              : [
                  result.actorReference,
                  configuration.environment,
                  configuration.issuer,
                  subjectHash,
                  result.version,
                  revisionReference,
                  result.status,
                  result.sourceDigest,
                  result.recordedAt,
                  before.version,
                  before.revisionReference,
                  before.sourceDigest,
                ];
          const advanced = platformActorDirectoryOne(await query(sql, values));
          if (
            !advanced ||
            platformActorDirectoryClosed(advanced, ["revision_reference"]).revision_reference !==
              revisionReference
          )
            return poison();
          if (result.status !== "Active")
            await query(
              `UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='Administrative',revoked_at=$3,version=version+1 WHERE actor_id=$1 AND status='Active' AND encryption_context=$2||':platform-session:'||session_id::text||':'||actor_id::text`,
              [result.actorReference, configuration.environment, result.recordedAt],
            );
          await append(tx, {
            auditReference,
            actorReference: operator,
            purposeCode: platformActorDirectoryPurpose,
            actionCode: "PLATFORM_ACTOR_DIRECTORY_CHANGED",
            targetType: "PlatformActorDirectoryRevision",
            targetReference: revisionReference,
            operationReference: result.operationReference,
            intentDigest,
            occurredAt: result.recordedAt,
            reasonCode: result.reasonCode,
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          });
          check();
        }
        const pinned = canonicalizeRfc8785(result),
          head = canonicalizeRfc8785(await current(command.actorReference));
        phase = "Ready";
        if (
          (await register(
            tx,
            async () => {
              if (busy || phase !== "Ready" || ++asyncCalls !== 1) return poison();
              busy = true;
              try {
                await authorize(command, subjectHash, intentDigest);
                if (
                  actualSubject !== null &&
                  (command.operation === "ImportActive" || command.operation === "Restore")
                )
                  await verifyProvider(actualSubject);
                if (
                  canonicalizeRfc8785(await original(command.operationReference)) !== pinned ||
                  canonicalizeRfc8785(await current(command.actorReference)) !== head
                )
                  return poison();
                await query("SET CONSTRAINTS ALL IMMEDIATE", []);
                check();
                asyncComplete = true;
              } catch {
                return poison();
              } finally {
                busy = false;
              }
            },
            () => {
              if (
                busy ||
                phase !== "Ready" ||
                !asyncComplete ||
                asyncCalls !== 1 ||
                ++finalCalls !== 1
              )
                return poison();
              check();
              phase = "Final";
            },
          )) !== undefined
        )
          return poison();
        check();
        return result;
      } catch (error) {
        phase = "Poison";
        if (error instanceof PlatformActorDirectoryError) throw error;
        return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_UNAVAILABLE");
      } finally {
        busy = false;
      }
    },
    assertFinalized(): void {
      if (phase !== "Final" || !asyncComplete || asyncCalls !== 1 || finalCalls !== 1 || busy)
        return platformActorDirectoryFail("PLATFORM_ACTOR_DIRECTORY_UNAVAILABLE");
    },
  });
}
