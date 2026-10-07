import { canonicalizeRfc8785 } from "@bop/audit";
import { BrowserSessionError } from "@bop/identity";
import {
  assertPlatformPermissionIdentity,
  evaluatePlatformPermissionPolicy,
  parsePlatformPermissionAction,
  parsePlatformPermissionInstant,
  parsePlatformPermissionPolicy,
  parsePlatformPermissionScope,
  platformPermissionClosed,
  platformPermissionFail,
  PlatformPermissionError,
  type PlatformPermissionAction,
  type PlatformPermissionAuthorization,
  type PlatformPermissionIdentityObservation,
  type PlatformPermissionScope,
} from "../../contracts/platform-permission.js";
export interface PlatformPermissionTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface PlatformPermissionSourceOptions {
  readonly transaction: PlatformPermissionTransaction;
  readonly scope: PlatformPermissionScope;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly currentIdentity: (
    tx: PlatformPermissionTransaction,
  ) => Promise<PlatformPermissionIdentityObservation>;
  readonly registerBeforeCommit: (
    tx: PlatformPermissionTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export function platformPermissionOne(value: unknown): Record<string, unknown> | null {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length > 1 ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return platformPermissionFail("PLATFORM_PERMISSION_UNAVAILABLE");
  if (!d.value.length) return null;
  const row = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!row?.enumerable || !("value" in row) || !row.value || typeof row.value !== "object")
    return platformPermissionFail("PLATFORM_PERMISSION_UNAVAILABLE");
  return row.value as Record<string, unknown>;
}
const readSql = `SELECT r.snapshot_text,r.source_digest,
 (h.actor_id=r.actor_id AND h.purpose_code=r.purpose_code AND h.current_revision=r.revision AND h.policy_id=r.policy_id AND h.source_digest=r.source_digest AND h.recorded_at=r.recorded_at
 AND r.actor_id::text=(r.snapshot_text::jsonb->>'actorReference') AND r.purpose_code=r.snapshot_text::jsonb->>'purposeCode'
 AND r.policy_id::text=r.snapshot_text::jsonb->>'policyReference' AND r.revision::text=r.snapshot_text::jsonb->>'revision'
 AND r.source_digest=r.snapshot_text::jsonb->>'sourceDigest' AND r.recorded_by::text=r.snapshot_text::jsonb->>'recordedByReference'
 AND r.operation_id::text=r.snapshot_text::jsonb->>'operationReference' AND r.intent_digest=r.snapshot_text::jsonb->>'intentDigest'
 AND r.audit_id::text=r.snapshot_text::jsonb->>'auditReference' AND r.recorded_at=(r.snapshot_text::jsonb->>'recordedAt')::timestamptz) IS TRUE coherent
 FROM bop_permission.platform_permission_policy_head h JOIN bop_permission.platform_permission_policy_revision r ON r.actor_id=h.actor_id AND r.purpose_code=h.purpose_code AND r.revision=h.current_revision WHERE h.actor_id=$1 AND h.purpose_code=$2`;
/** Transaction-local authorization only. The caller owns actual Session/CSRF and COMMIT. */
export function createPostgresPlatformPermissionSource(options: PlatformPermissionSourceOptions) {
  const scope = parsePlatformPermissionScope(options.scope),
    tx = options.transaction,
    originalQuery = tx.query,
    clock = options.clock,
    now = clock.now,
    identity = options.currentIdentity,
    register = options.registerBeforeCommit;
  const observedAt = parsePlatformPermissionInstant(options.originalObservedAt),
    originalDeadline = parsePlatformPermissionInstant(options.originalValidUntil);
  if (
    observedAt >= originalDeadline ||
    Date.parse(originalDeadline) > Date.parse(observedAt) + 5000 ||
    [originalQuery, now, identity, register].some((p) => typeof p !== "function")
  )
    return platformPermissionFail();
  let latest = observedAt,
    deadline = originalDeadline,
    phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    asyncCalls = 0,
    finalCalls = 0,
    asyncComplete = false;
  const accepted = new Map<PlatformPermissionAction, string>();
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
      options.currentIdentity !== identity ||
      options.registerBeforeCommit !== register ||
      options.originalObservedAt !== observedAt ||
      options.originalValidUntil !== originalDeadline ||
      canonicalizeRfc8785(parsePlatformPermissionScope(options.scope)) !==
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
  const load = async (action: PlatformPermissionAction) => {
    const actual = await identity(tx);
    check();
    assertPlatformPermissionIdentity(actual, scope, latest);
    deadline = [deadline, actual.validUntil].sort()[0] ?? deadline;
    check();
    await query(
      "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_permission_subject_id',$1,true),set_config('bop.platform_purpose',$2,true)",
      [scope.actorReference, scope.purposeCode],
    );
    const isolation = platformPermissionOne(
      await query("SELECT current_setting('transaction_isolation') AS isolation", []),
    );
    if (
      !isolation ||
      platformPermissionClosed(isolation, ["isolation"]).isolation !== "read committed"
    )
      return poison();
    await query("SELECT bop_permission.platform_permission_policy_hold($1,$2)", [
      scope.actorReference,
      scope.purposeCode,
    ]);
    const row = platformPermissionOne(
      await query(readSql, [scope.actorReference, scope.purposeCode]),
    );
    if (!row) return platformPermissionFail("PLATFORM_PERMISSION_DENIED");
    const r = platformPermissionClosed(row, ["snapshot_text", "source_digest", "coherent"]);
    if (
      r.coherent !== true ||
      typeof r.snapshot_text !== "string" ||
      r.snapshot_text.length > 32768
    )
      return poison();
    const policy = parsePlatformPermissionPolicy(JSON.parse(r.snapshot_text));
    if (
      canonicalizeRfc8785(policy) !== r.snapshot_text ||
      policy.sourceDigest !== r.source_digest ||
      policy.actorReference !== scope.actorReference ||
      policy.purposeCode !== scope.purposeCode ||
      policy.recordedAt > check()
    )
      return poison();
    const permission = evaluatePlatformPermissionPolicy(policy, action, latest);
    if (!permission) return platformPermissionFail("PLATFORM_PERMISSION_DENIED");
    deadline = [deadline, permission.validUntil].sort()[0] ?? deadline;
    check();
    return { policy, permission, bytes: r.snapshot_text };
  };
  return Object.freeze({
    async authorize(input: {
      readonly action: PlatformPermissionAction;
    }): Promise<PlatformPermissionAuthorization> {
      try {
        if (busy || phase === "Final") return poison();
        busy = true;
        check();
        const action = parsePlatformPermissionAction(
            platformPermissionClosed(input, ["action"]).action,
          ),
          result = await load(action);
        if (accepted.has(action) && accepted.get(action) !== result.bytes) return poison();
        accepted.set(action, result.bytes);
        phase = "Ready";
        if (!registered) {
          registered = true;
          if (
            (await register(
              tx,
              async () => {
                if (busy || phase !== "Ready" || ++asyncCalls !== 1) return poison();
                busy = true;
                try {
                  for (const [selected, bytes] of accepted) {
                    if ((await load(selected)).bytes !== bytes) return poison();
                  }
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
        }
        return Object.freeze({
          profile: "PlatformPermissionAuthorizationV1",
          scope,
          action,
          policyReference: result.policy.policyReference,
          policyRevision: result.policy.revision,
          policySourceDigest: result.policy.sourceDigest,
          operateEvidenceReference: result.permission.operate.evidenceReference,
          actionEvidenceReference: result.permission.exact.evidenceReference,
          observedAt,
          validUntil: deadline,
        });
      } catch (error) {
        phase = "Poison";
        if (error instanceof PlatformPermissionError) throw error;
        if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED")
          return platformPermissionFail("PLATFORM_PERMISSION_DENIED");
        return platformPermissionFail("PLATFORM_PERMISSION_UNAVAILABLE");
      } finally {
        busy = false;
      }
    },
    assertFinalized(): void {
      if (phase !== "Final" || asyncCalls !== 1 || finalCalls !== 1 || !asyncComplete || busy)
        return platformPermissionFail("PLATFORM_PERMISSION_UNAVAILABLE");
    },
  });
}
