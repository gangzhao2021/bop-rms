import { appendAuditRecordInTransaction, type AppendAuditRecordInput } from "@bop/audit";
import {
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
} from "../../contracts/dining-session.js";
import { createDiningTable, releaseClosedDiningSession } from "../../domain/dining-table.js";
import type { DiningTableStoreScope, DiningTableTransaction } from "./dining-table-store.js";

/**
 * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): staff merge the party at one table (the source) into
 * the party seated at another (the target), in one transaction (2000_128). The source session ends
 * (Closed) and its table is released (the caller marks it for cleaning); the target session's
 * version moves on so a concurrent change to either table (another merge, a move, checking out)
 * is refused. One append-only record with who and when, both sessions and tables with the versions
 * staff saw, and the party sizes; an audit record. The same operation again returns what it
 * recorded. The caller authorizes (dining.operate), checks the tables are mergeable (both pay at
 * the end, nothing paid or split) and records the bill's side in Ordering and Payment.
 */
export type DiningMergeErrorCode =
  | "DINING_MERGE_INPUT_INVALID"
  | "DINING_MERGE_CHANGED"
  | "DINING_MERGE_IDEMPOTENCY_CONFLICT"
  | "DINING_MERGE_UNAVAILABLE";
export class DiningMergeError extends Error {
  constructor(readonly code: DiningMergeErrorCode) {
    super("dining table merge " + code);
    this.name = "DiningMergeError";
  }
}
const fail = (code: DiningMergeErrorCode = "DINING_MERGE_UNAVAILABLE"): never => {
  throw new DiningMergeError(code);
};
const reference = (value: unknown) => {
  try {
    return parseDiningReference(value);
  } catch {
    return fail("DINING_MERGE_INPUT_INVALID");
  }
};
const count = (value: unknown, minimum: number, maximum: number) =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : fail("DINING_MERGE_INPUT_INVALID");
const rowsOf = (result: unknown): readonly Record<string, unknown>[] => {
  const value = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : fail();
};
const changed = (result: unknown) => {
  if ((result as { rowCount?: unknown } | null)?.rowCount !== 1) fail();
};
const tableLabel = (value: unknown): string | null =>
  typeof value === "string" && /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(value) && value.trim() === value
    ? value
    : null;

export interface DiningMergeCommand {
  readonly operationReference: string;
  readonly sourceTableReference: string;
  readonly targetTableReference: string;
  readonly sourceSessionReference: string;
  readonly targetSessionReference: string;
  readonly expectedSourceTableVersion: number;
  readonly expectedTargetTableVersion: number;
  readonly expectedSourceSessionVersion: number;
  readonly expectedTargetSessionVersion: number;
  readonly sourcePartySize: number;
  readonly targetPartySize: number;
  readonly actorReference: string;
  readonly observedAt: string;
  readonly intentDigest: string;
}
export interface DiningMergeRecord {
  readonly operationReference: string;
  readonly sourceSessionReference: string;
  readonly targetSessionReference: string;
  readonly sourceTableReference: string;
  readonly targetTableReference: string;
  readonly sourceTableLabel: string;
  readonly targetTableLabel: string;
  readonly expectedSourceTableVersion: number;
  readonly expectedTargetTableVersion: number;
  readonly mergedPartySize: number;
  readonly actorReference: string;
  readonly occurredAt: string;
}

const context = async (tx: DiningTableTransaction, scope: DiningTableStoreScope) => {
  const tenant = reference(scope.tenantReference),
    brand = reference(scope.brandReference),
    store = reference(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  return { tenant, brand, store };
};

const MERGE_COLUMNS =
  "m.operation_id::text op,m.source_session_id::text source_session,m.target_session_id::text target_session," +
  "m.source_table_id::text source_table,m.target_table_id::text target_table,m.expected_source_table_version source_version," +
  "m.expected_target_table_version target_version,m.merged_party_size party,m.actor_id::text actor,m.intent_digest digest," +
  "to_char(m.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') occurred_at," +
  "m.record_json->'sourceTable'->>'stableLabel' source_label,t.table_snapshot->>'stableLabel' target_label";
const parseMerge = (row: Record<string, unknown>): DiningMergeRecord & { digest: string } =>
  Object.freeze({
    operationReference: String(reference(row.op)),
    sourceSessionReference: String(reference(row.source_session)),
    targetSessionReference: String(reference(row.target_session)),
    sourceTableReference: String(reference(row.source_table)),
    targetTableReference: String(reference(row.target_table)),
    sourceTableLabel: tableLabel(row.source_label) ?? fail(),
    targetTableLabel: tableLabel(row.target_label) ?? fail(),
    expectedSourceTableVersion: Number(row.source_version),
    expectedTargetTableVersion: Number(row.target_version),
    mergedPartySize: Number(row.party),
    actorReference: String(reference(row.actor)),
    occurredAt: String(parseDiningInstant(row.occurred_at)),
    digest: String(row.digest),
  });

/** The merge recorded with this operation reference, or null. */
export async function resolveDiningMergeOperation(
  tx: DiningTableTransaction,
  scope: DiningTableStoreScope,
  operationReference: string,
): Promise<DiningMergeRecord | null> {
  const { brand, store } = await context(tx, scope);
  const found = rowsOf(
    await tx.query(
      `SELECT ${MERGE_COLUMNS} FROM rms_dining.dining_session_merge_operation m JOIN rms_dining.dining_table t ON t.tenant_id=m.tenant_id AND t.brand_id=m.brand_id AND t.store_id=m.store_id AND t.table_id=m.target_table_id WHERE m.brand_id=$1 AND m.store_id=$2 AND m.operation_id=$3`,
      [brand, store, reference(operationReference)],
    ),
  );
  if (found.length > 1) return fail();
  if (found[0] === undefined) return null;
  const { digest, ...record } = parseMerge(found[0]);
  void digest;
  return Object.freeze(record);
}

export async function mergeDiningSessions(
  tx: DiningTableTransaction,
  scope: DiningTableStoreScope,
  input: DiningMergeCommand,
  audit: Omit<
    AppendAuditRecordInput,
    "targetId" | "correlationId" | "occurredAt" | "actionCode" | "targetType"
  >,
): Promise<{ readonly status: "Applied" | "AlreadyApplied"; readonly record: DiningMergeRecord }> {
  const { tenant, brand, store } = await context(tx, scope);
  const command = Object.freeze({
    operation: reference(input.operationReference),
    sourceTable: reference(input.sourceTableReference),
    targetTable: reference(input.targetTableReference),
    sourceSession: reference(input.sourceSessionReference),
    targetSession: reference(input.targetSessionReference),
    sourceTableVersion: count(input.expectedSourceTableVersion, 1, 9007199254740990),
    targetTableVersion: count(input.expectedTargetTableVersion, 1, 9007199254740990),
    sourceSessionVersion: count(input.expectedSourceSessionVersion, 1, 2147483646),
    targetSessionVersion: count(input.expectedTargetSessionVersion, 1, 2147483646),
    sourceParty: count(input.sourcePartySize, 1, 99),
    targetParty: count(input.targetPartySize, 1, 99),
    actor: reference(input.actorReference),
    observedAt: parseDiningInstant(input.observedAt),
    digest: /^sha256:[0-9a-f]{64}$/u.test(input.intentDigest)
      ? input.intentDigest
      : fail("DINING_MERGE_INPUT_INVALID"),
  });
  if (
    command.sourceTable === command.targetTable ||
    command.sourceSession === command.targetSession ||
    command.sourceParty + command.targetParty > 99
  )
    return fail("DINING_MERGE_INPUT_INVALID");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `DiningSessionMerge:${tenant}:${brand}:${store}:${command.operation}`,
  ]);
  const prior = await resolveDiningMergeOperation(tx, scope, command.operation);
  if (prior !== null) {
    const [stored] = rowsOf(
      await tx.query(
        "SELECT intent_digest digest FROM rms_dining.dining_session_merge_operation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
        [brand, store, command.operation],
      ),
    );
    if (
      stored?.digest !== command.digest ||
      prior.sourceTableReference !== command.sourceTable ||
      prior.targetTableReference !== command.targetTable ||
      prior.actorReference !== command.actor
    )
      return fail("DINING_MERGE_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ status: "AlreadyApplied" as const, record: prior });
  }
  // The same lock order as a move (both tables by reference), then both sessions.
  for (const table of [command.sourceTable, command.targetTable].sort())
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `DiningTable:${tenant}:${brand}:${store}:${table}`,
    ]);
  const loadTable = async (table: string) => {
    const [row] = rowsOf(
      await tx.query(
        "SELECT table_snapshot AS table FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
        [tenant, brand, store, table],
      ),
    );
    return row === undefined ? fail("DINING_MERGE_CHANGED") : createDiningTable(row.table);
  };
  const loadSession = async (session: string) => {
    const [row] = rowsOf(
      await tx.query(
        "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
        [tenant, brand, store, session],
      ),
    );
    return row === undefined ? fail("DINING_MERGE_CHANGED") : parseDiningSession(row.session);
  };
  const sourceTable = await loadTable(command.sourceTable),
    targetTable = await loadTable(command.targetTable);
  const [first, second] = [command.sourceSession, command.targetSession].sort();
  const loaded = new Map([
    [first as string, await loadSession(first as string)],
    [second as string, await loadSession(second as string)],
  ]);
  const source = loaded.get(command.sourceSession),
    target = loaded.get(command.targetSession);
  if (source === undefined || target === undefined) return fail();
  if (
    sourceTable.aggregateVersion !== command.sourceTableVersion ||
    targetTable.aggregateVersion !== command.targetTableVersion ||
    source.version !== command.sourceSessionVersion ||
    target.version !== command.targetSessionVersion ||
    source.phase !== "Active" ||
    target.phase !== "Active" ||
    sourceTable.activeDiningSessionReference !== command.sourceSession ||
    targetTable.activeDiningSessionReference !== command.targetSession ||
    source.tableReference !== command.sourceTable ||
    target.tableReference !== command.targetTable ||
    sourceTable.observedAt > command.observedAt ||
    source.startedAt > command.observedAt
  )
    return fail("DINING_MERGE_CHANGED");
  const closedSource = parseDiningSession({
    ...source,
    phase: "Closed",
    version: source.version + 1,
  });
  const nextTarget = parseDiningSession({ ...target, version: target.version + 1 });
  const releasedTable = releaseClosedDiningSession(closedSource, sourceTable, command.observedAt);
  changed(
    await tx.query(
      "UPDATE rms_dining.dining_session SET phase='Closed',version=$5,session_snapshot=$6::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND version=$7 AND phase='Active'",
      [
        tenant,
        brand,
        store,
        command.sourceSession,
        closedSource.version,
        JSON.stringify(closedSource),
        command.sourceSessionVersion,
      ],
    ),
  );
  changed(
    await tx.query(
      "UPDATE rms_dining.dining_session SET version=$5,session_snapshot=$6::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND version=$7 AND phase='Active'",
      [
        tenant,
        brand,
        store,
        command.targetSession,
        nextTarget.version,
        JSON.stringify(nextTarget),
        command.targetSessionVersion,
      ],
    ),
  );
  changed(
    await tx.query(
      "UPDATE rms_dining.dining_table SET version=$5,table_snapshot=$6::jsonb,observed_at=$7 WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 AND version=$8",
      [
        tenant,
        brand,
        store,
        command.sourceTable,
        releasedTable.aggregateVersion,
        JSON.stringify(releasedTable),
        releasedTable.observedAt,
        command.sourceTableVersion,
      ],
    ),
  );
  const auditRecord: AppendAuditRecordInput = {
    ...audit,
    actionCode: "DINING_SESSION_MERGE_TABLE",
    targetType: "DiningSession",
    targetId: command.sourceSession,
    correlationId: command.operation,
    occurredAt: command.observedAt,
    actor: { type: "User", reference: command.actor },
  };
  changed(
    await tx.query(
      "INSERT INTO rms_dining.dining_session_merge_operation (operation_id,tenant_id,brand_id,store_id,source_session_id,target_session_id,source_table_id,target_table_id,expected_source_session_version,expected_target_session_version,expected_source_table_version,expected_target_table_version,source_party_size,target_party_size,merged_party_size,intent_digest,actor_id,occurred_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)",
      [
        command.operation,
        tenant,
        brand,
        store,
        command.sourceSession,
        command.targetSession,
        command.sourceTable,
        command.targetTable,
        command.sourceSessionVersion,
        command.targetSessionVersion,
        command.sourceTableVersion,
        command.targetTableVersion,
        command.sourceParty,
        command.targetParty,
        command.sourceParty + command.targetParty,
        command.digest,
        command.actor,
        command.observedAt,
        JSON.stringify({
          sourceSession: closedSource,
          targetSession: nextTarget,
          sourceTable: releasedTable,
          audit: auditRecord,
        }),
      ],
    ),
  );
  await appendAuditRecordInTransaction(tx as never, auditRecord);
  const record = await resolveDiningMergeOperation(tx, scope, command.operation);
  return Object.freeze({ status: "Applied" as const, record: record ?? fail() });
}

/**
 * For each of these sessions merged into another table's party: that session (followed to the end
 * when it was merged on), the table it sits at now and the table the merged party left. Sessions
 * never merged are absent.
 */
export async function listDiningSessionMergedInto(
  tx: DiningTableTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  sessionReferences: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    {
      readonly diningSessionReference: string;
      readonly tableLabel: string;
      readonly fromTableLabel: string;
      readonly phase: string;
    }
  >
> {
  if (sessionReferences.length === 0) return new Map();
  if (sessionReferences.length > 200) return fail("DINING_MERGE_INPUT_INVALID");
  const brand = reference(scope.brandReference),
    store = reference(scope.storeReference),
    sessions = sessionReferences.map((value) => reference(value));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const found = rowsOf(
    await tx.query(
      "WITH RECURSIVE up(start_id,session_id,from_label,depth) AS (" +
        "SELECT m.source_session_id,m.target_session_id,m.record_json->'sourceTable'->>'stableLabel',1 FROM rms_dining.dining_session_merge_operation m WHERE m.brand_id=$1 AND m.store_id=$2 AND m.source_session_id=ANY($3::uuid[]) " +
        "UNION ALL SELECT up.start_id,m.target_session_id,up.from_label,up.depth+1 FROM rms_dining.dining_session_merge_operation m JOIN up ON m.brand_id=$1 AND m.store_id=$2 AND m.source_session_id=up.session_id WHERE up.depth<50) " +
        "SELECT DISTINCT ON (up.start_id) up.start_id::text start_id,up.session_id::text session_id,up.from_label,s.phase,t.table_snapshot->>'stableLabel' label FROM up " +
        "JOIN rms_dining.dining_session s ON s.brand_id=$1 AND s.store_id=$2 AND s.session_id=up.session_id " +
        "JOIN rms_dining.dining_table t ON t.tenant_id=s.tenant_id AND t.brand_id=s.brand_id AND t.store_id=s.store_id AND t.table_id=s.table_id " +
        "ORDER BY up.start_id,up.depth DESC",
      [brand, store, sessions],
    ),
  );
  const merged = new Map<
    string,
    { diningSessionReference: string; tableLabel: string; fromTableLabel: string; phase: string }
  >();
  for (const row of found) {
    const label = tableLabel(row.label),
      from = tableLabel(row.from_label);
    if (label === null || from === null) continue;
    merged.set(
      String(reference(row.start_id)),
      Object.freeze({
        diningSessionReference: String(reference(row.session_id)),
        tableLabel: label,
        fromTableLabel: from,
        phase: String(row.phase),
      }),
    );
  }
  return merged;
}

/**
 * The sessions merged into this one (and into those), oldest merge first: their phones and rounds
 * are on this table's bill.
 */
export async function listDiningSessionsMergedIn(
  tx: DiningTableTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  sessionReference: string,
): Promise<readonly string[]> {
  const brand = reference(scope.brandReference),
    store = reference(scope.storeReference),
    session = reference(sessionReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const found = rowsOf(
    await tx.query(
      "WITH RECURSIVE down(session_id,occurred_at,depth) AS (" +
        "SELECT m.source_session_id,m.occurred_at,1 FROM rms_dining.dining_session_merge_operation m WHERE m.brand_id=$1 AND m.store_id=$2 AND m.target_session_id=$3 " +
        "UNION ALL SELECT m.source_session_id,m.occurred_at,down.depth+1 FROM rms_dining.dining_session_merge_operation m JOIN down ON m.brand_id=$1 AND m.store_id=$2 AND m.target_session_id=down.session_id WHERE down.depth<50) " +
        "SELECT down.session_id::text session FROM down ORDER BY down.occurred_at,down.depth,down.session_id LIMIT 101",
      [brand, store, session],
    ),
  );
  if (found.length > 100) return fail();
  return Object.freeze(found.map((row) => String(reference(row.session))));
}

/**
 * For each of these sessions, the parties merged into it (and into those), oldest first: the
 * session and the table it left. Sessions nothing was merged into are absent.
 */
export async function listDiningSessionMergesInto(
  tx: DiningTableTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  sessionReferences: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    readonly { readonly diningSessionReference: string; readonly fromTableLabel: string }[]
  >
> {
  if (sessionReferences.length === 0) return new Map();
  if (sessionReferences.length > 200) return fail("DINING_MERGE_INPUT_INVALID");
  const brand = reference(scope.brandReference),
    store = reference(scope.storeReference),
    sessions = sessionReferences.map((value) => reference(value));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const found = rowsOf(
    await tx.query(
      "WITH RECURSIVE down(root_id,session_id,from_label,occurred_at,depth) AS (" +
        "SELECT m.target_session_id,m.source_session_id,m.record_json->'sourceTable'->>'stableLabel',m.occurred_at,1 FROM rms_dining.dining_session_merge_operation m WHERE m.brand_id=$1 AND m.store_id=$2 AND m.target_session_id=ANY($3::uuid[]) " +
        "UNION ALL SELECT down.root_id,m.source_session_id,m.record_json->'sourceTable'->>'stableLabel',m.occurred_at,down.depth+1 FROM rms_dining.dining_session_merge_operation m JOIN down ON m.brand_id=$1 AND m.store_id=$2 AND m.target_session_id=down.session_id WHERE down.depth<50) " +
        "SELECT down.root_id::text root,down.session_id::text session,down.from_label FROM down ORDER BY down.root_id,down.occurred_at,down.session_id LIMIT 1001",
      [brand, store, sessions],
    ),
  );
  if (found.length > 1000) return fail();
  const merged = new Map<string, { diningSessionReference: string; fromTableLabel: string }[]>();
  for (const row of found) {
    const label = tableLabel(row.from_label);
    if (label === null) continue;
    const root = String(reference(row.root));
    merged.set(root, [
      ...(merged.get(root) ?? []),
      Object.freeze({
        diningSessionReference: String(reference(row.session)),
        fromTableLabel: label,
      }),
    ]);
  }
  return merged;
}
