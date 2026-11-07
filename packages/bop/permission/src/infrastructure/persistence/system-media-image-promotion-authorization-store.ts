import { parseCanonicalInstant } from "@bop/tenant";
import {
  parseSystemMediaImagePromotionAuthorizationDecision,
  parseSystemMediaImagePromotionAuthorizationRequest,
  parseSystemMediaImagePromotionWorkloadIdentity,
  SystemMediaImagePromotionAuthorizationError,
  type SystemMediaImagePromotionAuthorization,
  type SystemMediaImagePromotionAuthorizationDecision,
  type SystemMediaImagePromotionAuthorizationReason,
  type SystemMediaImagePromotionAuthorizationRequest,
  type SystemMediaImagePromotionWorkloadIdentity,
} from "../../contracts/system-media-image-promotion-authorization.js";

export interface SystemMediaImagePromotionAuthorizationTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface SystemMediaImagePromotionAuthorizationSourceOptions extends SystemMediaImagePromotionWorkloadIdentity {
  readonly clock: { now(): string };
  readonly registerBeforeCommit: (
    tx: SystemMediaImagePromotionAuthorizationTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}

const fail = (): never => {
  throw new SystemMediaImagePromotionAuthorizationError(
    "SYSTEM_MEDIA_IMAGE_PROMOTION_SOURCE_UNAVAILABLE",
  );
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
function rows(value: unknown): readonly unknown[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (!d?.enumerable || !("value" in d) || !Array.isArray(d.value)) return fail();
  const list: unknown[] = d.value;
  if (
    Object.getPrototypeOf(list) !== Array.prototype ||
    list.length > 2 ||
    Reflect.ownKeys(list).length !== list.length + 1
  )
    return fail();
  return Object.freeze(
    Array.from({ length: list.length }, (_, i) => {
      const item = Object.getOwnPropertyDescriptor(list, String(i));
      if (!item?.enumerable || !("value" in item)) return fail();
      return item.value;
    }),
  );
}
function instant(value: unknown): string {
  return parseCanonicalInstant(
    value instanceof Date ? Date.prototype.toISOString.call(value) : value,
  );
}
function version(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return fail();
  const v = Number(value);
  return Number.isSafeInteger(v) ? v : fail();
}

/** Fixed Permission-owned authorization, separate from Workforce role evaluation.
 * Config identifies an authenticated server workload; it is not itself a grant.
 * This source never provisions policy. Current roots remain locked until the
 * caller's real transaction ends. A deny or swallowed error prevents that
 * transaction from committing, even if an earlier hold returned Allow.
 */
export function createPostgresSystemMediaImagePromotionAuthorizationSource(
  options: SystemMediaImagePromotionAuthorizationSourceOptions,
) {
  let identity: SystemMediaImagePromotionWorkloadIdentity,
    now: () => string,
    register: SystemMediaImagePromotionAuthorizationSourceOptions["registerBeforeCommit"];
  try {
    const r = closed(options, [
        "tenantReference",
        "brandReference",
        "storeReference",
        "workloadReference",
        "deploymentConfigurationDigest",
        "clock",
        "registerBeforeCommit",
      ]),
      clock = closed(r.clock, ["now"]);
    if (typeof clock.now !== "function" || typeof r.registerBeforeCommit !== "function")
      return fail();
    identity = parseSystemMediaImagePromotionWorkloadIdentity({
      tenantReference: r.tenantReference,
      brandReference: r.brandReference,
      storeReference: r.storeReference,
      workloadReference: r.workloadReference,
      deploymentConfigurationDigest: r.deploymentConfigurationDigest,
    });
    now = (clock.now as () => string).bind(r.clock);
    register = (r.registerBeforeCommit as typeof register).bind(options);
  } catch {
    return fail();
  }

  interface State {
    queryIdentity: SystemMediaImagePromotionAuthorizationTransaction["query"];
    query: SystemMediaImagePromotionAuthorizationTransaction["query"];
    observedAt: string;
    deadline: string;
    latest: string;
    busy: boolean;
    ready: boolean;
    failed: boolean;
    asyncCalls: number;
    asyncCompleted: boolean;
    finalCalls: number;
  }
  const states = new WeakMap<object, State>();
  return Object.freeze({
    async holdUntilTransactionCompletes(
      tx: SystemMediaImagePromotionAuthorizationTransaction,
      value: SystemMediaImagePromotionAuthorizationRequest,
    ): Promise<SystemMediaImagePromotionAuthorization> {
      let request: SystemMediaImagePromotionAuthorizationRequest | undefined,
        entryAt: string | undefined;
      try {
        request = parseSystemMediaImagePromotionAuthorizationRequest(value);
        entryAt = parseCanonicalInstant(now());
      } catch {
        /* Install the rejecting outer guard before surfacing bad input. */
      }
      if (!tx || typeof tx !== "object") return fail();
      let state = states.get(tx);
      const queryDescriptor = Object.getOwnPropertyDescriptor(tx, "query");
      if (
        !queryDescriptor ||
        !("value" in queryDescriptor) ||
        typeof queryDescriptor.value !== "function"
      ) {
        if (state) state.failed = true;
        return fail();
      }
      const first = state === undefined;
      if (!state) {
        const raw: SystemMediaImagePromotionAuthorizationTransaction["query"] =
          queryDescriptor.value;
        state = {
          queryIdentity: raw,
          query: raw.bind(tx),
          observedAt: request?.observedAt ?? "",
          deadline: request?.validUntil ?? "",
          latest: entryAt ?? "",
          busy: false,
          ready: false,
          failed: false,
          asyncCalls: 0,
          asyncCompleted: false,
          finalCalls: 0,
        };
        states.set(tx, state);
      }
      const current = state;
      const poison = (): never => {
        current.failed = true;
        return fail();
      };
      const check = (): string => {
        try {
          const d = Object.getOwnPropertyDescriptor(tx, "query"),
            at = parseCanonicalInstant(now());
          if (
            current.failed ||
            !d ||
            !("value" in d) ||
            d.value !== current.queryIdentity ||
            !current.deadline ||
            at < current.latest ||
            at >= current.deadline
          )
            return poison();
          current.latest = at;
          return at;
        } catch {
          return poison();
        }
      };
      try {
        if (current.busy || current.failed || current.asyncCalls !== 0 || current.finalCalls !== 0)
          return poison();
        current.busy = true;
        if (first) {
          if (
            (await register(
              tx,
              async () => {
                try {
                  if (++current.asyncCalls !== 1 || current.busy || !current.ready) return poison();
                  check();
                  current.asyncCompleted = true;
                } catch {
                  return poison();
                }
              },
              () => {
                if (
                  ++current.finalCalls !== 1 ||
                  current.asyncCalls !== 1 ||
                  !current.asyncCompleted ||
                  current.busy ||
                  !current.ready
                )
                  return poison();
                check();
              },
            )) !== undefined
          )
            return poison();
        }
        if (
          !request ||
          !entryAt ||
          request.observedAt > entryAt ||
          request.observedAt !== current.observedAt ||
          request.validUntil > current.deadline ||
          entryAt < current.latest
        )
          return poison();
        current.deadline = request.validUntil;
        check();
        const query = async (sql: string, values: readonly unknown[]) => {
          check();
          const result = await current.query(sql, values);
          check();
          return result;
        };
        // The first Media authority call precedes Media's own RLS setup. Only
        // the fixed, captured server identity supplies these transaction values.
        await query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true),set_config('lock_timeout','5000',true),set_config('statement_timeout','5000',true)",
          [identity.tenantReference, identity.brandReference, identity.storeReference ?? ""],
        );
        const isolation = rows(
          await query("SELECT current_setting('transaction_isolation') AS isolation", []),
        );
        if (
          isolation.length !== 1 ||
          closed(isolation[0], ["isolation"]).isolation !== "read committed"
        )
          return poison();
        const roots = rows(
          await query(
            "SELECT workload_id,tenant_id,brand_id,store_id,version::text AS version,decision_id,updated_at FROM bop_permission.system_media_image_promotion_authorization WHERE workload_id=$1 AND tenant_id=$2 AND brand_id=$3 AND store_id IS NOT DISTINCT FROM $4::uuid FOR SHARE",
            [
              identity.workloadReference,
              identity.tenantReference,
              identity.brandReference,
              identity.storeReference,
            ],
          ),
        );
        if (roots.length > 1) return poison();
        let decision: SystemMediaImagePromotionAuthorizationDecision | null = null,
          reason: SystemMediaImagePromotionAuthorizationReason = "MISSING_WORKLOAD_AUTHORIZATION";
        if (roots.length === 1) {
          const root = closed(roots[0], [
            "workload_id",
            "tenant_id",
            "brand_id",
            "store_id",
            "version",
            "decision_id",
            "updated_at",
          ]);
          if (
            root.workload_id !== identity.workloadReference ||
            root.tenant_id !== identity.tenantReference ||
            root.brand_id !== identity.brandReference ||
            root.store_id !== identity.storeReference
          )
            return poison();
          const rootVersion = version(root.version),
            updatedAt = instant(root.updated_at);
          if (updatedAt > check()) return poison();
          const records = rows(
            await query(
              `SELECT snapshot_json,digest,(
              decision_id::text=snapshot_json->>'decisionReference' AND workload_id::text=snapshot_json->>'workloadReference'
              AND tenant_id::text=snapshot_json->>'tenantReference' AND brand_id::text=snapshot_json->>'brandReference'
              AND store_id::text IS NOT DISTINCT FROM snapshot_json->>'storeReference'
              AND version::text=snapshot_json->>'version' AND profile=snapshot_json->>'profile'
              AND action_code=snapshot_json->>'action' AND purpose_code=snapshot_json->>'purposeCode'
              AND deployment_config_digest=snapshot_json->>'deploymentConfigurationDigest'
              AND enabled::text=snapshot_json->>'enabled' AND effective_from=(snapshot_json->>'effectiveFrom')::timestamptz
              AND effective_until IS NOT DISTINCT FROM (snapshot_json->>'effectiveUntil')::timestamptz
              AND recorded_at=(snapshot_json->>'recordedAt')::timestamptz AND audit_id::text=snapshot_json->>'auditReference'
              AND digest=snapshot_json->>'digest') AS coherent
             FROM bop_permission.system_media_image_promotion_authorization_decision
             WHERE decision_id=$1 AND workload_id=$2 AND tenant_id=$3 AND brand_id=$4 AND store_id IS NOT DISTINCT FROM $5::uuid`,
              [
                root.decision_id,
                identity.workloadReference,
                identity.tenantReference,
                identity.brandReference,
                identity.storeReference,
              ],
            ),
          );
          if (records.length !== 1) return poison();
          const row = closed(records[0], ["snapshot_json", "digest", "coherent"]);
          decision = parseSystemMediaImagePromotionAuthorizationDecision(row.snapshot_json);
          if (
            row.coherent !== true ||
            row.digest !== decision.digest ||
            decision.decisionReference !== root.decision_id ||
            decision.workloadReference !== identity.workloadReference ||
            decision.tenantReference !== identity.tenantReference ||
            decision.brandReference !== identity.brandReference ||
            decision.storeReference !== identity.storeReference ||
            decision.version !== rootVersion ||
            decision.recordedAt !== updatedAt
          )
            return poison();
          const at = check();
          reason = !decision.enabled
            ? "WORKLOAD_DISABLED"
            : decision.deploymentConfigurationDigest !== identity.deploymentConfigurationDigest
              ? "DEPLOYMENT_CONFIGURATION_MISMATCH"
              : decision.effectiveFrom > at ||
                  (decision.effectiveUntil !== null && decision.effectiveUntil <= at)
                ? "OUTSIDE_EFFECTIVE_PERIOD"
                : "CURRENT_WORKLOAD_AUTHORIZATION";
          if (
            reason === "CURRENT_WORKLOAD_AUTHORIZATION" &&
            decision.effectiveUntil !== null &&
            decision.effectiveUntil < current.deadline
          )
            current.deadline = decision.effectiveUntil;
        }
        const effect = reason === "CURRENT_WORKLOAD_AUTHORIZATION" ? "Allow" : "Deny";
        check();
        const result: SystemMediaImagePromotionAuthorization = Object.freeze({
          profile: "SystemMediaImagePromotionAuthorizationV1",
          ...identity,
          effect,
          reason,
          decisionReference: decision?.decisionReference ?? null,
          policyVersion: decision?.version ?? null,
          decisionDigest: decision?.digest ?? null,
          observedAt: current.observedAt,
          validUntil: current.deadline,
        });
        current.ready = effect === "Allow";
        if (effect === "Deny") current.failed = true;
        return result;
      } catch {
        return poison();
      } finally {
        current.busy = false;
      }
    },
  });
}
