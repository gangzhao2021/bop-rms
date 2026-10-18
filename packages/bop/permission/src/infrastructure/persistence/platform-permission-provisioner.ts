import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  type AppendPlatformAuditRecordInput,
} from "@bop/audit";
import {
  buildPlatformPermissionPolicy,
  parsePlatformPermissionHead,
  parsePlatformPermissionInstant,
  parsePlatformPermissionPolicy,
  parsePlatformPermissionProvisionCommand,
  parsePlatformPermissionReference,
  parsePlatformPermissionScope,
  platformPermissionClosed,
  platformPermissionFail,
  PlatformPermissionError,
  platformPermissionIntentDigest,
  type PlatformPermissionPolicy,
  type PlatformPermissionProvisionCommand,
  type PlatformPermissionScope,
} from "../../contracts/platform-permission.js";
import {
  platformPermissionOne,
  type PlatformPermissionTransaction,
} from "./platform-permission-store.js";
export interface PlatformPermissionProvisioningAuthority {
  hold(
    tx: PlatformPermissionTransaction,
    input: {
      readonly scope: PlatformPermissionScope;
      readonly command: PlatformPermissionProvisionCommand;
      readonly intentDigest: string;
      readonly observedAt: string;
      readonly validUntil: string;
    },
  ): Promise<{
    readonly operatorReference: string;
    readonly approvedByReference: string;
    readonly approvalEvidenceReference: string;
    readonly validUntil: string;
  }>;
}
export interface PlatformPermissionProvisionerOptions {
  readonly transaction: PlatformPermissionTransaction;
  readonly operatorScope: PlatformPermissionScope;
  readonly provisioningRoleName: string;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly authority: PlatformPermissionProvisioningAuthority;
  readonly nextReference: (kind: "Policy" | "Audit") => string;
  readonly appendAudit: typeof appendPlatformAuditRecordInTransaction;
  readonly registerBeforeCommit: (
    tx: PlatformPermissionTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
const principalSql = `SELECT session_user::text session_principal,current_user::text current_principal,current_setting('transaction_isolation') isolation,
 (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND has_table_privilege(session_user,'bop_permission.platform_permission_policy_revision','INSERT')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='bop_permission' AND (pg_has_role(r.oid,c.relowner,'USAGE') OR pg_has_role(r.oid,c.relowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='bop_permission' AND (pg_has_role(r.oid,n.nspowner,'USAGE') OR pg_has_role(r.oid,n.nspowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(r.oid,e.oid,'SET'))) IS TRUE controlled
 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`;
const originalSql = `SELECT snapshot_text,source_digest FROM bop_permission.platform_permission_policy_revision WHERE recorded_by=$1 AND purpose_code=$2 AND operation_id=$3`;
const headSql = `SELECT policy_id::text AS "policyReference",current_revision AS revision,source_digest AS "sourceDigest" FROM bop_permission.platform_permission_policy_head WHERE actor_id=$1 AND purpose_code=$2`;
/** Deployment-only importer. No runtime/browser grant endpoint and no self-authorizing policy. */
export function createPostgresPlatformPermissionProvisioner(
  options: PlatformPermissionProvisionerOptions,
) {
  const scope = parsePlatformPermissionScope(options.operatorScope),
    tx = options.transaction,
    originalQuery = tx.query,
    clock = options.clock,
    now = clock.now,
    authority = options.authority,
    hold = authority.hold,
    next = options.nextReference,
    append = options.appendAudit,
    register = options.registerBeforeCommit,
    role = options.provisioningRoleName;
  const observedAt = parsePlatformPermissionInstant(options.originalObservedAt),
    originalDeadline = parsePlatformPermissionInstant(options.originalValidUntil);
  if (
    !/^[a-z][a-z0-9_]{0,62}$/u.test(role) ||
    observedAt >= originalDeadline ||
    Date.parse(originalDeadline) > Date.parse(observedAt) + 5000 ||
    [originalQuery, now, hold, next, append, register].some((p) => typeof p !== "function")
  )
    return platformPermissionFail();
  let deadline = originalDeadline,
    latest = observedAt,
    phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    asyncCalls = 0,
    finalCalls = 0,
    asyncComplete = false;
  const poison = (): never => {
    phase = "Poison";
    return platformPermissionFail("PLATFORM_PERMISSION_UNAVAILABLE");
  };
  const check = () => {
    const at = parsePlatformPermissionInstant(now.call(clock));
    if (
      phase === "Poison" ||
      phase === "Final" ||
      options.transaction !== tx ||
      tx.query !== originalQuery ||
      options.clock !== clock ||
      clock.now !== now ||
      options.authority !== authority ||
      authority.hold !== hold ||
      options.nextReference !== next ||
      options.appendAudit !== append ||
      options.registerBeforeCommit !== register ||
      options.provisioningRoleName !== role ||
      options.originalObservedAt !== observedAt ||
      options.originalValidUntil !== originalDeadline ||
      canonicalizeRfc8785(parsePlatformPermissionScope(options.operatorScope)) !==
        canonicalizeRfc8785(scope) ||
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
  const principal = async () => {
    const row = platformPermissionOne(await query(principalSql, []));
    if (!row) return poison();
    const r = platformPermissionClosed(row, [
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
  const original = async (
    command: PlatformPermissionProvisionCommand,
  ): Promise<PlatformPermissionPolicy | null> => {
    const row = platformPermissionOne(
      await query(originalSql, [
        scope.actorReference,
        scope.purposeCode,
        command.operationReference,
      ]),
    );
    if (!row) return null;
    const r = platformPermissionClosed(row, ["snapshot_text", "source_digest"]);
    if (typeof r.snapshot_text !== "string" || r.snapshot_text.length > 32768) return poison();
    const parsed = parsePlatformPermissionPolicy(JSON.parse(r.snapshot_text));
    if (
      parsed.sourceDigest !== r.source_digest ||
      canonicalizeRfc8785(parsed) !== r.snapshot_text ||
      parsed.recordedByReference !== scope.actorReference ||
      parsed.purposeCode !== scope.purposeCode ||
      parsed.operationReference !== command.operationReference ||
      parsed.recordedAt > check()
    )
      return poison();
    return parsed;
  };
  const head = async (actor: string) => {
    const row = platformPermissionOne(await query(headSql, [actor, scope.purposeCode]));
    return row === null ? null : parsePlatformPermissionHead(row);
  };
  const authorize = async (command: PlatformPermissionProvisionCommand, intentDigest: string) => {
    await principal();
    const result = platformPermissionClosed(
      await hold.call(authority, tx, {
        scope,
        command,
        intentDigest,
        observedAt,
        validUntil: deadline,
      }),
      ["operatorReference", "approvedByReference", "approvalEvidenceReference", "validUntil"],
    );
    check();
    if (
      result.operatorReference !== scope.actorReference ||
      result.approvedByReference !== command.approvedByReference ||
      result.approvalEvidenceReference !== command.approvalEvidenceReference
    )
      return poison();
    deadline = [deadline, parsePlatformPermissionInstant(result.validUntil)].sort()[0] ?? deadline;
    check();
    await query(
      "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_permission_subject_id',$2,true),set_config('bop.platform_purpose',$3,true)",
      [scope.actorReference, command.targetActorReference, scope.purposeCode],
    );
  };
  return Object.freeze({
    async provision(value: unknown): Promise<PlatformPermissionPolicy> {
      try {
        if (busy || phase !== "Open") return poison();
        busy = true;
        check();
        const command = parsePlatformPermissionProvisionCommand(value),
          intentDigest = platformPermissionIntentDigest(command);
        if (
          command.recordedByReference !== scope.actorReference ||
          command.purposeCode !== scope.purposeCode
        )
          return platformPermissionFail("PLATFORM_PERMISSION_DENIED");
        await authorize(command, intentDigest);
        await query("SELECT bop_permission.platform_permission_import_admit($1,$2,$3)", [
          scope.actorReference,
          command.targetActorReference,
          command.operationReference,
        ]);
        const existing = await original(command),
          before = await head(command.targetActorReference);
        let result: PlatformPermissionPolicy;
        if (existing) {
          if (
            existing.intentDigest !== intentDigest ||
            canonicalizeRfc8785(existing.originalCommand) !== canonicalizeRfc8785(command)
          )
            return platformPermissionFail("PLATFORM_PERMISSION_INTENT_CONFLICT");
          result = existing;
        } else {
          if (canonicalizeRfc8785(before) !== canonicalizeRfc8785(command.expectedHead))
            return platformPermissionFail("PLATFORM_PERMISSION_VERSION_CONFLICT");
          const revision = (before?.revision ?? 0) + 1;
          if (revision > 2147483647) return poison();
          const policyReference = parsePlatformPermissionReference(next("Policy")),
            auditReference = parsePlatformPermissionReference(next("Audit"));
          check();
          result = buildPlatformPermissionPolicy({
            profile: "PlatformPermissionPolicyV1",
            actorReference: command.targetActorReference,
            purposeCode: scope.purposeCode,
            policyReference,
            revision,
            supersedesPolicyReference: before?.policyReference ?? null,
            content: command.content,
            operationReference: command.operationReference,
            intentDigest,
            originalCommand: command,
            recordedByReference: scope.actorReference,
            approvedByReference: command.approvedByReference,
            approvalEvidenceReference: command.approvalEvidenceReference,
            reasonCode: command.reasonCode,
            auditReference,
            recordedAt: check(),
            classification: "RestrictedSecurity",
          });
          const inserted = platformPermissionOne(
            await query(
              `INSERT INTO bop_permission.platform_permission_policy_revision(actor_id,purpose_code,revision,policy_id,recorded_by,approved_by,approval_id,operation_id,intent_digest,audit_id,recorded_at,source_digest,snapshot_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING policy_id::text AS policy_reference`,
              [
                result.actorReference,
                result.purposeCode,
                result.revision,
                result.policyReference,
                result.recordedByReference,
                result.approvedByReference,
                result.approvalEvidenceReference,
                result.operationReference,
                result.intentDigest,
                result.auditReference,
                result.recordedAt,
                result.sourceDigest,
                canonicalizeRfc8785(result),
              ],
            ),
          );
          if (
            !inserted ||
            platformPermissionClosed(inserted, ["policy_reference"]).policy_reference !==
              result.policyReference
          )
            return poison();
          const advanceSql =
            before === null
              ? `INSERT INTO bop_permission.platform_permission_policy_head(actor_id,purpose_code,current_revision,policy_id,source_digest,recorded_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING policy_id::text AS policy_reference`
              : `UPDATE bop_permission.platform_permission_policy_head SET current_revision=$3,policy_id=$4,source_digest=$5,recorded_at=$6 WHERE actor_id=$1 AND purpose_code=$2 AND current_revision=$7 AND policy_id=$8 AND source_digest=$9 RETURNING policy_id::text AS policy_reference`;
          const advanceValues: readonly unknown[] =
            before === null
              ? [
                  result.actorReference,
                  result.purposeCode,
                  result.revision,
                  result.policyReference,
                  result.sourceDigest,
                  result.recordedAt,
                ]
              : [
                  result.actorReference,
                  result.purposeCode,
                  result.revision,
                  result.policyReference,
                  result.sourceDigest,
                  result.recordedAt,
                  before.revision,
                  before.policyReference,
                  before.sourceDigest,
                ];
          const advanced = platformPermissionOne(await query(advanceSql, advanceValues));
          if (
            !advanced ||
            platformPermissionClosed(advanced, ["policy_reference"]).policy_reference !==
              result.policyReference
          )
            return poison();
          const audit: AppendPlatformAuditRecordInput = {
            auditReference: result.auditReference,
            actorReference: scope.actorReference,
            purposeCode: scope.purposeCode,
            actionCode: "PLATFORM_PERMISSION_PROVISIONED",
            targetType: "PlatformPermissionPolicy",
            targetReference: result.policyReference,
            operationReference: result.operationReference,
            intentDigest,
            occurredAt: result.recordedAt,
            reasonCode: result.reasonCode,
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          };
          await append(tx, audit);
          check();
        }
        const heldHead = await head(command.targetActorReference),
          heldBytes = canonicalizeRfc8785(result);
        phase = "Ready";
        if (
          (await register(
            tx,
            async () => {
              if (busy || phase !== "Ready" || ++asyncCalls !== 1) return poison();
              busy = true;
              try {
                await authorize(command, intentDigest);
                if (
                  canonicalizeRfc8785(await original(command)) !== heldBytes ||
                  canonicalizeRfc8785(await head(command.targetActorReference)) !==
                    canonicalizeRfc8785(heldHead)
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
        if (error instanceof PlatformPermissionError) throw error;
        return platformPermissionFail("PLATFORM_PERMISSION_UNAVAILABLE");
      } finally {
        busy = false;
      }
    },
    assertFinalized(): void {
      if (phase !== "Final" || !asyncComplete || asyncCalls !== 1 || finalCalls !== 1 || busy)
        return platformPermissionFail("PLATFORM_PERMISSION_UNAVAILABLE");
    },
  });
}
