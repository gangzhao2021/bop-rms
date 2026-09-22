import { createHash } from "node:crypto";
import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AuditTransaction,
} from "@bop/audit";
import { FeatureControlServiceError } from "../../application/feature-control-service.js";
import type { FeatureControlUnitOfWorkPort } from "../../application/ports/feature-control-ports.js";
import {
  createFeatureControlDefinition,
  parseFeatureControlReference,
  parseFeatureControlKey,
  parseFeatureControlInstant,
  type KillSwitchDefinition,
} from "../../contracts/feature-control.js";
export interface KillSwitchQueryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface KillSwitchQueryTransactionRunner {
  /** Dedicated read-only owner transaction; clear local scope before releasing its connection. */
  run<T>(action: (transaction: KillSwitchQueryTransaction) => Promise<T>): Promise<T>;
}
export class KillSwitchQueryError extends Error {
  readonly code = "FEATURE_CONTROL_DEPENDENCY_UNAVAILABLE";
  constructor() {
    super("current Kill Switch source unavailable");
    this.name = "KillSwitchQueryError";
  }
}
const select = `SELECT DISTINCT ON (store_id) definition_json AS definition,
to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at
FROM bop_feature_control.kill_switch_version
WHERE brand_id=$1 AND (store_id IS NULL OR store_id=$2) AND control_key=$3
ORDER BY store_id NULLS FIRST,control_version DESC`;
/** Latest definitions, never a default authorization. Evaluate using the existing public evaluator. */
export function createPostgresKillSwitchQueryStore(
  runner: KillSwitchQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string | null }>,
) {
  const brand: string = parseFeatureControlReference(scope.brandReference);
  const store: string | null =
    scope.storeReference === null ? null : parseFeatureControlReference(scope.storeReference);
  return Object.freeze({
    async loadCurrent(
      input: Readonly<{ key: string; observedAt: string }>,
    ): Promise<readonly KillSwitchDefinition[]> {
      try {
        const key = parseFeatureControlKey(input.key),
          at = parseFeatureControlInstant(input.observedAt);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store ?? ""],
          );
          const result = await tx.query(select, [brand, store, key]);
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length > 2) throw new Error();
          const definitions = rows.map((row) => {
            const value = Object.getOwnPropertyDescriptor(row, "definition")?.value as unknown;
            const recorded = Object.getOwnPropertyDescriptor(row, "recorded_at")?.value as unknown;
            const definition = createFeatureControlDefinition(value);
            if (
              definition.kind !== "KillSwitch" ||
              definition.key !== key ||
              definition.scope.brandReference !== brand ||
              (definition.scope.storeReference !== null &&
                definition.scope.storeReference !== store) ||
              parseFeatureControlInstant(recorded) > at
            )
              throw new Error();
            return definition;
          });
          if (new Set(definitions.map((d) => d.scope.storeReference)).size !== definitions.length)
            throw new Error();
          return Object.freeze(definitions);
        });
      } catch {
        throw new KillSwitchQueryError();
      }
    },
  });
}

export interface KillSwitchMutationTransactionRunner {
  run<T>(action: (transaction: AuditTransaction) => Promise<T>): Promise<T>;
}
const mutationFailed = (): never => {
  throw new FeatureControlServiceError("FEATURE_CONTROL_COMMIT_FAILED");
};
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]))
      .join(",") +
    "}"
  );
}
/** Authorized transition service must call this owner transaction port. No initial/default write. */
export function createPostgresKillSwitchMutationStore(
  runner: KillSwitchMutationTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string | null }>,
  clock: { now(): string },
): FeatureControlUnitOfWorkPort {
  const brand: string = parseFeatureControlReference(scope.brandReference);
  const store: string | null =
    scope.storeReference === null ? null : parseFeatureControlReference(scope.storeReference);
  return Object.freeze({
    async commit(input: Parameters<FeatureControlUnitOfWorkPort["commit"]>[0]) {
      try {
        const current = createFeatureControlDefinition(input.current),
          next = createFeatureControlDefinition(input.next);
        const now = parseFeatureControlInstant(clock.now());
        const audit = validateAuditRecord(input.audit, Date.parse(now));
        if (
          current.kind !== "KillSwitch" ||
          next.kind !== "KillSwitch" ||
          current.scope.brandReference !== brand ||
          current.scope.storeReference !== store ||
          canonical(next.scope) !== canonical(current.scope) ||
          current.controlId !== next.controlId ||
          current.key !== next.key ||
          current.version !== input.expectedVersion ||
          next.version !== current.version + 1 ||
          audit.brandId !== brand ||
          (audit.storeId ?? null) !== store ||
          audit.targetType !== "FeatureControl" ||
          audit.targetId !== current.controlId ||
          audit.actor.type !== "User" ||
          ![
            "FEATURE_CONTROL_CHANGED",
            "FEATURE_CONTROL_ACTIVATED",
            "FEATURE_CONTROL_RECOVERY_BEGUN",
            "FEATURE_CONTROL_RECOVERY_COMPLETED",
          ].includes(audit.actionCode) ||
          audit.reasonCode !== audit.actionCode ||
          audit.dataClassification !== "Internal"
        )
          return mutationFailed();
        const digest =
          "sha256:" +
          createHash("sha256").update(canonical({ current, next, audit })).digest("hex");
        await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store ?? ""],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            brand + ":" + current.controlId,
          ]);
          const result = await tx.query(
            "SELECT definition_json, audit_reference::text, operation_digest, control_version::text FROM bop_feature_control.kill_switch_version WHERE brand_id=$1 AND store_id IS NOT DISTINCT FROM $2::uuid AND control_id=$3 AND (control_version=$4 OR control_version=(SELECT max(control_version) FROM bop_feature_control.kill_switch_version WHERE brand_id=$1 AND store_id IS NOT DISTINCT FROM $2::uuid AND control_id=$3))",
            [brand, store, current.controlId, next.version],
          );
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2) return mutationFailed();
          const prior = rows.find((row) => row.control_version === String(next.version));
          if (prior) {
            if (
              prior.operation_digest !== digest ||
              prior.audit_reference !== audit.auditId ||
              canonical(createFeatureControlDefinition(prior.definition_json)) !== canonical(next)
            )
              return mutationFailed();
            return;
          }
          const latest = rows[0];
          if (
            !latest ||
            canonical(createFeatureControlDefinition(latest.definition_json)) !== canonical(current)
          )
            return mutationFailed();
          const inserted = await tx.query(
            "INSERT INTO bop_feature_control.kill_switch_version(brand_id,store_id,control_id,control_key,control_version,definition_json,recorded_at,audit_reference,operation_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)",
            [
              brand,
              store,
              next.controlId,
              next.key,
              next.version,
              JSON.stringify(next),
              now,
              audit.auditId,
              digest,
            ],
          );
          if (Object.getOwnPropertyDescriptor(inserted, "rowCount")?.value !== 1)
            return mutationFailed();
          await appendAuditRecordInTransaction(tx, audit);
        });
      } catch {
        return mutationFailed();
      }
    },
  });
}
