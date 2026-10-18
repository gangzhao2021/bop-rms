import { appendAuditRecordInTransaction, canonicalizeRfc8785 } from "@bop/audit";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  parseSystemMediaImagePromotionAuthorizationDecision,
  parseSystemMediaImagePromotionWorkloadIdentity,
  type SystemMediaImagePromotionAuthorizationDecision,
  type SystemMediaImagePromotionWorkloadIdentity,
} from "../../contracts/system-media-image-promotion-authorization.js";

interface ProvisioningTransaction {
  readonly query: <Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}
export interface SystemMediaImagePromotionProvisionerOptions extends SystemMediaImagePromotionWorkloadIdentity {
  /** Trusted deployment configuration. Use a separate direct-login, non-owner
   * provisioning role; never derive this name from an HTTP or Worker request. */
  readonly provisioningRoleName: string;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: ProvisioningTransaction) => Promise<T>): Promise<T> };
  readonly registerBeforeCommit: (
    tx: ProvisioningTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
const fail = (code = "SYSTEM_MEDIA_IMAGE_PROMOTION_PROVISIONING_UNAVAILABLE"): never => {
  throw Object.assign(new Error("System image promotion provisioning is unavailable"), { code });
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[key] = d.value;
  }
  return r;
}
function reference(value: unknown): string {
  return typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
    ? value
    : fail();
}
function one(value: unknown): Record<string, unknown> | null {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1 ||
    d.value.length > 1
  )
    return fail();
  if (d.value.length === 0) return null;
  const row = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!row || !("value" in row) || !row.enumerable || !row.value || typeof row.value !== "object")
    return fail();
  return row.value as Record<string, unknown>;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const principalSql = `SELECT session_user::text session_principal,current_user::text current_principal,
 current_setting('transaction_isolation') isolation,
 (NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND r.rolcanlogin
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='bop_permission' AND c.relname IN ('system_media_image_promotion_authorization','system_media_image_promotion_authorization_decision')
 AND (pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE') OR pg_catalog.pg_has_role(r.oid,c.relowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='bop_permission'
 AND (pg_catalog.pg_has_role(r.oid,n.nspowner,'USAGE') OR pg_catalog.pg_has_role(r.oid,n.nspowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles elevated WHERE (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolcreaterole)
 AND pg_catalog.pg_has_role(r.oid,elevated.oid,'SET'))) IS TRUE controlled
 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`;

/** Technical Permission provisioning, deliberately separate from Worker startup
 * and Custom-role APIs. Real PostgreSQL login identity and table privileges are
 * the deployment capability. It never seeds a grant or accepts an event payload. */
export function createPostgresSystemMediaImagePromotionProvisioner(
  options: SystemMediaImagePromotionProvisionerOptions,
) {
  const r = closed(options, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "workloadReference",
      "deploymentConfigurationDigest",
      "provisioningRoleName",
      "clock",
      "transactions",
      "registerBeforeCommit",
    ]),
    identity = parseSystemMediaImagePromotionWorkloadIdentity({
      tenantReference: r.tenantReference,
      brandReference: r.brandReference,
      storeReference: r.storeReference,
      workloadReference: r.workloadReference,
      deploymentConfigurationDigest: r.deploymentConfigurationDigest,
    }),
    clock = closed(r.clock, ["now"]),
    transactions = closed(r.transactions, ["run"]);
  if (
    typeof r.provisioningRoleName !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(r.provisioningRoleName) ||
    typeof clock.now !== "function" ||
    typeof transactions.run !== "function" ||
    typeof r.registerBeforeCommit !== "function"
  )
    return fail();
  const role = r.provisioningRoleName,
    now = (clock.now as () => string).bind(r.clock),
    run = (
      transactions.run as SystemMediaImagePromotionProvisionerOptions["transactions"]["run"]
    ).bind(r.transactions),
    register = (
      r.registerBeforeCommit as SystemMediaImagePromotionProvisionerOptions["registerBeforeCommit"]
    ).bind(options),
    failed = new WeakSet<object>(),
    active = new WeakSet<object>(),
    scopes = [
      identity.tenantReference,
      identity.brandReference,
      identity.storeReference,
      identity.workloadReference,
    ];
  return Object.freeze({
    async provision(value: {
      readonly decision: SystemMediaImagePromotionAuthorizationDecision;
      readonly correlationReference: string;
    }) {
      let decision: SystemMediaImagePromotionAuthorizationDecision | undefined,
        correlationReference: string | undefined,
        observedAt: string | undefined;
      try {
        const request = closed(value, ["decision", "correlationReference"]);
        decision = parseSystemMediaImagePromotionAuthorizationDecision(request.decision);
        correlationReference = reference(request.correlationReference);
        observedAt = parseCanonicalInstant(now());
        if (
          decision.tenantReference !== identity.tenantReference ||
          decision.brandReference !== identity.brandReference ||
          decision.storeReference !== identity.storeReference ||
          decision.workloadReference !== identity.workloadReference ||
          decision.deploymentConfigurationDigest !== identity.deploymentConfigurationDigest
        )
          return fail();
      } catch {
        decision = undefined;
      }
      let actual: ProvisioningTransaction | undefined,
        callbacks = 0,
        complete = false,
        asyncComplete = false,
        finalComplete = false;
      let receipt: SystemMediaImagePromotionAuthorizationDecision | undefined;
      try {
        const result = await run(async (tx) => {
          actual = tx;
          if (
            !tx ||
            typeof tx !== "object" ||
            typeof tx.query !== "function" ||
            ++callbacks !== 1 ||
            failed.has(tx) ||
            active.has(tx)
          )
            return fail();
          active.add(tx);
          const originalQuery = tx.query,
            raw = originalQuery.bind(tx);
          let latest = "",
            deadline = "",
            ready = false,
            asyncCalls = 0,
            finalCalls = 0;
          const poison = (): never => {
            failed.add(tx);
            return fail();
          };
          const check = () => {
            const at = parseCanonicalInstant(now());
            if (
              failed.has(tx) ||
              tx.query !== originalQuery ||
              !deadline ||
              at < latest ||
              at >= deadline
            )
              return poison();
            latest = at;
            return at;
          };
          const query: ProvisioningTransaction["query"] = async <Row>(
            sql: string,
            values: readonly unknown[],
          ) => {
            check();
            try {
              const result = await raw<Row>(sql, values);
              check();
              return result;
            } catch {
              return poison();
            }
          };
          const authorize = async () => {
            const row = one(await query(principalSql, []));
            if (!row) return poison();
            const principal = closed(row, [
              "session_principal",
              "current_principal",
              "isolation",
              "controlled",
            ]);
            if (
              principal.session_principal !== role ||
              principal.current_principal !== role ||
              principal.isolation !== "read committed" ||
              principal.controlled !== true
            )
              return poison();
          };
          const inserted = (result: { readonly rowCount?: number | null }) => {
            if (result.rowCount !== 1) return poison();
          };
          try {
            if (
              (await register(
                tx,
                async () => {
                  try {
                    if (++asyncCalls !== 1 || !ready) return poison();
                    await authorize();
                    check();
                    asyncComplete = true;
                  } catch {
                    return poison();
                  }
                },
                () => {
                  if (++finalCalls !== 1 || !ready || !asyncComplete || asyncCalls !== 1)
                    return poison();
                  check();
                  finalComplete = true;
                },
              )) !== undefined
            )
              return poison();
            if (!decision || !correlationReference || !observedAt) return poison();
            const d = decision;
            latest = observedAt;
            deadline = new Date(Date.parse(observedAt) + 5000).toISOString();
            await authorize();
            await query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true),set_config('lock_timeout','5000',true),set_config('statement_timeout','5000',true)",
              [identity.tenantReference, identity.brandReference, identity.storeReference ?? ""],
            );
            await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              "PermissionMediaWorkload:" + identity.workloadReference,
            ]);
            const original = one(
              await query(
                `SELECT snapshot_json snapshot,correlation_id::text correlation_reference,
              (tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND workload_id=$4 AND decision_id=$5
               AND version=(snapshot_json->>'version')::bigint AND digest=snapshot_json->>'digest'
               AND audit_id::text=snapshot_json->>'auditReference' AND recorded_at=(snapshot_json->>'recordedAt')::timestamptz) IS TRUE coherent
              FROM bop_permission.system_media_image_promotion_authorization_decision WHERE decision_id=$5 LIMIT 2`,
                [...scopes, d.decisionReference],
              ),
            );
            if (original) {
              const saved = closed(original, ["snapshot", "correlation_reference", "coherent"]),
                parsed = parseSystemMediaImagePromotionAuthorizationDecision(saved.snapshot);
              if (
                saved.coherent !== true ||
                saved.correlation_reference !== correlationReference ||
                !equal(parsed, d) ||
                parsed.recordedAt > check()
              )
                return poison();
              receipt = parsed;
              ready = complete = true;
              return receipt;
            }
            if (
              d.recordedAt > observedAt ||
              Date.parse(observedAt) - Date.parse(d.recordedAt) > 5000
            )
              return poison();
            const root = one(
              await query(
                `SELECT version::text version,decision_id::text decision_reference,
              to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at,
              (tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND workload_id=$4) IS TRUE coherent
              FROM bop_permission.system_media_image_promotion_authorization WHERE workload_id=$4 FOR UPDATE`,
                scopes,
              ),
            );
            if (root) {
              const current = closed(root, [
                "version",
                "decision_reference",
                "updated_at",
                "coherent",
              ]);
              if (
                current.coherent !== true ||
                current.version !== String(d.version - 1) ||
                parseCanonicalInstant(current.updated_at) > d.recordedAt
              )
                return poison();
              reference(current.decision_reference);
            } else if (d.version !== 1) return poison();
            await query("SAVEPOINT permission_media_workload", []);
            try {
              inserted(
                await query(
                  `INSERT INTO bop_permission.system_media_image_promotion_authorization_decision
                (decision_id,workload_id,tenant_id,brand_id,store_id,version,profile,action_code,purpose_code,deployment_config_digest,
                 enabled,effective_from,effective_until,recorded_at,audit_id,correlation_id,snapshot_json,digest)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)`,
                  [
                    d.decisionReference,
                    d.workloadReference,
                    d.tenantReference,
                    d.brandReference,
                    d.storeReference,
                    d.version,
                    d.profile,
                    d.action,
                    d.purposeCode,
                    d.deploymentConfigurationDigest,
                    d.enabled,
                    d.effectiveFrom,
                    d.effectiveUntil,
                    d.recordedAt,
                    d.auditReference,
                    correlationReference,
                    canonicalizeRfc8785(d),
                    d.digest,
                  ],
                ),
              );
              if (root)
                inserted(
                  await query(
                    `UPDATE bop_permission.system_media_image_promotion_authorization SET version=$5,decision_id=$6,updated_at=$7
                WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND workload_id=$4 AND version=$8`,
                    [...scopes, d.version, d.decisionReference, d.recordedAt, d.version - 1],
                  ),
                );
              else
                inserted(
                  await query(
                    `INSERT INTO bop_permission.system_media_image_promotion_authorization(workload_id,tenant_id,brand_id,store_id,version,decision_id,updated_at)
                VALUES($1,$2,$3,$4,$5,$6,$7)`,
                    [
                      d.workloadReference,
                      d.tenantReference,
                      d.brandReference,
                      d.storeReference,
                      d.version,
                      d.decisionReference,
                      d.recordedAt,
                    ],
                  ),
                );
              await appendAuditRecordInTransaction(
                { query },
                {
                  auditId: d.auditReference,
                  brandId: d.brandReference,
                  ...(d.storeReference === null ? {} : { storeId: d.storeReference }),
                  actor: { type: "System" },
                  actionCode: d.enabled
                    ? "SYSTEM_MEDIA_PROMOTION_AUTHORIZED"
                    : "SYSTEM_MEDIA_PROMOTION_REVOKED",
                  targetType: "SystemMediaImagePromotionWorkload",
                  targetId: d.workloadReference,
                  reasonCode: "CONTROLLED_DEPLOYMENT_CONFIGURATION",
                  correlationId: correlationReference,
                  occurredAt: d.recordedAt,
                  sourceChannel: "DEPLOYMENT",
                  dataClassification: "Confidential",
                  retentionPolicyCode: "PERMISSION_POLICY_AUDIT",
                  retentionPolicyVersion: 1,
                  afterSummary: {
                    version: d.version,
                    enabled: d.enabled,
                    decisionReference: d.decisionReference,
                    configurationDigest: d.deploymentConfigurationDigest,
                  },
                },
              );
              await authorize();
              check();
            } catch {
              failed.add(tx);
              await raw("ROLLBACK TO SAVEPOINT permission_media_workload", []);
              await raw("RELEASE SAVEPOINT permission_media_workload", []);
              return fail();
            }
            await query("RELEASE SAVEPOINT permission_media_workload", []);
            receipt = d;
            ready = complete = true;
            return receipt;
          } catch {
            return poison();
          }
        });
        if (
          !actual ||
          callbacks !== 1 ||
          !complete ||
          !asyncComplete ||
          !finalComplete ||
          failed.has(actual) ||
          result !== receipt
        )
          return fail();
        return result;
      } catch (error) {
        if (actual) failed.add(actual);
        const descriptor =
          error && typeof error === "object"
            ? Object.getOwnPropertyDescriptor(error, "code")
            : undefined;
        if (descriptor && "value" in descriptor && descriptor.value === "COMMIT_OUTCOME_UNKNOWN")
          return fail("SYSTEM_MEDIA_IMAGE_PROMOTION_PROVISIONING_OUTCOME_UNKNOWN");
        return fail();
      } finally {
        if (actual) active.delete(actual);
      }
    },
  });
}
