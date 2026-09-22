import { parseDiningReference, parseDiningInstant } from "../../contracts/dining-session.js";
import { canonicalizeRfc8785, appendAuditRecordInTransaction } from "@bop/audit";
import {
  parseDiningTableReleaseRecord,
  type DiningTableReleaseRecord,
} from "../../application/dining-table-release-record.js";
import { createPostgresDiningClosingFence } from "./dining-closing-fence.js";
import { DiningClosingError } from "../../contracts/dining-closing.js";
import type { DiningTableTransaction, DiningTableStoreScope } from "./dining-table-store.js";
const fail = (): never => {
  throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
};
export function createPostgresDiningTableReleaseStore(options: {
  scope: DiningTableStoreScope;
  hashes: Parameters<typeof parseDiningTableReleaseRecord>[1];
  authorize(tx: DiningTableTransaction, record: DiningTableReleaseRecord): Promise<boolean>;
}) {
  return {
    /** Original immutable operation receipt; does not claim current table availability. */
    async readReceipt(
      tx: DiningTableTransaction,
      input: { operationReference: string; diningSessionReference: string; observedAt: string },
      authorizeLookup: () => Promise<boolean>,
    ) {
      try {
        const operation = parseDiningReference(input.operationReference),
          session = parseDiningReference(input.diningSessionReference),
          at = parseDiningInstant(input.observedAt),
          scope = options.scope;
        if ((await authorizeLookup()) !== true) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const result = await tx.query(
          "SELECT record_json AS record FROM rms_dining.dining_table_release_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
          [scope.tenantReference, scope.brandReference, scope.storeReference, operation],
        );
        if (!result || typeof result !== "object") return fail();
        const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
        if (!Array.isArray(rows) || rows.length > 1) return fail();
        const raw = rows[0] as { record?: unknown } | undefined;
        const record = raw ? parseDiningTableReleaseRecord(raw.record, options.hashes) : null;
        if (
          record &&
          (record.command.operationReference !== operation ||
            record.command.diningSessionReference !== session ||
            record.command.observedAt > at ||
            record.beforeTable.tenantReference !== scope.tenantReference ||
            record.beforeTable.brandReference !== scope.brandReference ||
            record.beforeTable.storeReference !== scope.storeReference ||
            (await options.authorize(tx, record)) !== true)
        )
          return fail();
        if ((await authorizeLookup()) !== true) return fail();
        return record;
      } catch {
        return fail();
      }
    },
    async commit(tx: DiningTableTransaction, value: unknown) {
      const record = parseDiningTableReleaseRecord(value, options.hashes),
        scope = options.scope,
        command = record.command;
      if (
        record.beforeTable.tenantReference !== scope.tenantReference ||
        record.beforeTable.brandReference !== scope.brandReference ||
        record.beforeTable.storeReference !== scope.storeReference
      )
        return fail();
      const authorize = async () => {
        if ((await options.authorize(tx, record)) !== true) return fail();
        return true;
      };
      await authorize();
      await tx.query("SAVEPOINT dining_table_release", []);
      const rows = (result: unknown) => {
        if (!result || typeof result !== "object") return fail();
        const list = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
        if (!Array.isArray(list) || list.length > 1) return fail();
        return list as Record<string, unknown>[];
      };
      const changed = (result: unknown) => {
        if (
          !result ||
          typeof result !== "object" ||
          Object.getOwnPropertyDescriptor(result, "rowCount")?.value !== 1
        )
          return fail();
      };
      try {
        const session = await createPostgresDiningClosingFence({ scope, authorize })(tx, {
          diningSessionReference: command.diningSessionReference,
          observedAt: command.observedAt,
        });
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `DiningTableRelease:${scope.tenantReference}:${scope.brandReference}:${scope.storeReference}:${command.operationReference}`,
        ]);
        const prior = rows(
          await tx.query(
            "SELECT record_json AS record FROM rms_dining.dining_table_release_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              command.operationReference,
            ],
          ),
        )[0];
        if (prior) {
          const original = parseDiningTableReleaseRecord(prior.record, options.hashes);
          if (canonicalizeRfc8785(original) !== canonicalizeRfc8785(record)) return fail();
          await authorize();
          await tx.query("RELEASE SAVEPOINT dining_table_release", []);
          return { status: "AlreadyApplied" as const, record: original };
        }
        if (canonicalizeRfc8785(session) !== canonicalizeRfc8785(record.session)) return fail();
        const table = rows(
          await tx.query(
            "SELECT table_snapshot AS snapshot FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              command.tableReference,
            ],
          ),
        )[0];
        if (
          !table ||
          canonicalizeRfc8785(table.snapshot) !== canonicalizeRfc8785(record.beforeTable)
        )
          return fail();
        changed(
          await tx.query(
            "UPDATE rms_dining.dining_table SET version=$5,table_snapshot=$6::jsonb,observed_at=$7 WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 AND version=$8",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              command.tableReference,
              record.afterTable.aggregateVersion,
              JSON.stringify(record.afterTable),
              command.observedAt,
              command.expectedTableVersion,
            ],
          ),
        );
        changed(
          await tx.query(
            "INSERT INTO rms_dining.dining_table_release_operation (tenant_id,brand_id,store_id,operation_id,session_id,table_id,expected_session_version,expected_table_version,intent_digest,occurred_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              command.operationReference,
              command.diningSessionReference,
              command.tableReference,
              command.expectedSessionVersion,
              command.expectedTableVersion,
              record.intentDigest,
              command.observedAt,
              JSON.stringify(record),
            ],
          ),
        );
        await appendAuditRecordInTransaction(tx, record.audit);
        await authorize();
        await tx.query("RELEASE SAVEPOINT dining_table_release", []);
        return { status: "Applied" as const, record };
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT dining_table_release", []);
        await tx.query("RELEASE SAVEPOINT dining_table_release", []);
        return fail();
      }
    },
  };
}
