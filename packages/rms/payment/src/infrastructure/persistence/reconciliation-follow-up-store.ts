import type { ConsumerTransaction } from "@bop/eventing";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  parseReconciliationFollowUp,
  parseReconciliationFollowUpCommand,
  transitionReconciliationFollowUp,
  ReconciliationFollowUpError,
} from "../../application/reconciliation-follow-up.js";
import type {
  ReconciliationFollowUpPorts,
  ReconciliationFollowUpTransition,
} from "../../application/reconciliation-follow-up-service.js";
type Command = ReturnType<typeof parseReconciliationFollowUpCommand>;
const fail = (): never => {
  throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_CONFLICT");
};
const json = (v: unknown) => JSON.stringify(v);
const select =
  "SELECT tenant_id::text,brand_id::text,store_id::text,reconciliation_exception_id::text,operation_id::text,actor_id::text,version::text,action,occurred_at,transition_json::text AS record FROM rms_payment.reconciliation_follow_up_history ";
type ReadScope = Pick<
  Command,
  "tenantReference" | "brandReference" | "storeReference" | "exceptionReference"
>;
const decode = (row: Record<string, unknown>, c: ReadScope): ReconciliationFollowUpTransition => {
  if (typeof row.record !== "string" || row.record.length > 65536) return fail();
  const raw = exactPaymentObject(JSON.parse(row.record), ["command", "before", "after"]);
  const command = parseReconciliationFollowUpCommand(raw.command),
    before = parseReconciliationFollowUp(raw.before),
    after = parseReconciliationFollowUp(raw.after);
  const expected = {
    tenant_id: c.tenantReference,
    brand_id: c.brandReference,
    store_id: c.storeReference,
    reconciliation_exception_id: c.exceptionReference,
    operation_id: command.operationReference,
    actor_id: command.actorReference,
    version: String(after.version),
    action: command.action,
  };
  if (
    Object.entries(expected).some(([key, value]) => row[key] !== value) ||
    command.tenantReference !== c.tenantReference ||
    command.brandReference !== c.brandReference ||
    command.storeReference !== c.storeReference ||
    command.exceptionReference !== c.exceptionReference ||
    json(after) !== json(transitionReconciliationFollowUp(before, command))
  )
    return fail();
  const occurred =
    row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at;
  if (parsePaymentInstant(occurred) !== command.occurredAt) return fail();
  return Object.freeze({ command, before, after });
};
const source = async (tx: ConsumerTransaction, c: ReadScope) => {
  const result = await tx.query(
    "SELECT candidate_id::text,status,opened_at FROM rms_payment.payment_reconciliation_exception WHERE brand_id=$1 AND store_id=$2 AND reconciliation_exception_id=$3",
    [c.brandReference, c.storeReference, c.exceptionReference],
  );
  if (result.rows.length !== 1) return fail();
  const row = result.rows[0];
  if (!row || row.status !== "Open") return fail();
  return {
    candidate: parsePaymentReference(row.candidate_id),
    openedAt: parsePaymentInstant(
      row.opened_at instanceof Date ? row.opened_at.toISOString() : row.opened_at,
    ),
  };
};
const readState = async (tx: ConsumerTransaction, c: ReadScope) => {
  const original = await source(tx, c);
  const result = await tx.query(
    select +
      "WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reconciliation_exception_id=$4 ORDER BY version DESC LIMIT 1",
    [c.tenantReference, c.brandReference, c.storeReference, c.exceptionReference],
  );
  if (result.rows.length > 1) return fail();
  if (result.rows[0]) {
    const latest = decode(result.rows[0], c).after;
    if (latest.openedAt !== original.openedAt) return fail();
    return latest;
  }
  return parseReconciliationFollowUp({
    tenantReference: c.tenantReference,
    brandReference: c.brandReference,
    storeReference: c.storeReference,
    exceptionReference: c.exceptionReference,
    version: 1,
    status: "Open",
    ownerReference: null,
    acknowledgedByReference: null,
    openedAt: original.openedAt,
    updatedAt: original.openedAt,
  });
};
export function createPostgresReconciliationFollowUpStore(options: {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly authorize: ReconciliationFollowUpPorts["authorize"];
}): ReconciliationFollowUpPorts["records"] {
  const scope = Object.freeze({
    tenantReference: parsePaymentReference(options.scope.tenantReference),
    brandReference: parsePaymentReference(options.scope.brandReference),
    storeReference: parsePaymentReference(options.scope.storeReference),
  });
  const params = (c: Command) => [
    scope.tenantReference,
    scope.brandReference,
    scope.storeReference,
    c.exceptionReference,
  ];
  const access = async (tx: ConsumerTransaction, value: Command) => {
    const c = parseReconciliationFollowUpCommand(value);
    if (
      c.tenantReference !== scope.tenantReference ||
      c.brandReference !== scope.brandReference ||
      c.storeReference !== scope.storeReference
    )
      return fail();
    if ((await options.authorize(tx, c, "OperatePaymentReconciliation")) !== true)
      throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED");
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    );
    return c;
  };
  const readCurrent = async (tx: ConsumerTransaction, value: Command) =>
    readState(tx, await access(tx, value));
  return Object.freeze({
    lock: async (tx, value) => {
      const c = await access(tx, value);
      for (const key of [
        "ReconciliationFollowUpOperation:" +
          scope.tenantReference +
          ":" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          c.operationReference,
        "ReconciliationFollowUpException:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          c.exceptionReference,
      ])
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
    },
    findOperation: async (tx, value) => {
      const c = await access(tx, value);
      const result = await tx.query(
        select + "WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
        [scope.tenantReference, scope.brandReference, scope.storeReference, c.operationReference],
      );
      if (result.rows.length > 1) return fail();
      const row = result.rows[0];
      if (!row) return null;
      const recorded = decode(row, c);
      if (recorded.command.operationReference !== c.operationReference) return fail();
      return recorded;
    },
    readCurrent,
    append: async (tx, value) => {
      const c = await access(tx, value.command),
        before = parseReconciliationFollowUp(value.before),
        after = parseReconciliationFollowUp(value.after);
      if (
        json(after) !== json(transitionReconciliationFollowUp(before, c)) ||
        json(await readCurrent(tx, c)) !== json(before)
      )
        return fail();
      const original = await source(tx, c),
        transition = { command: c, before, after };
      const result = await tx.query(
        "INSERT INTO rms_payment.reconciliation_follow_up_history (tenant_id,brand_id,store_id,reconciliation_exception_id,candidate_id,version,operation_id,actor_id,action,occurred_at,transition_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING version::text",
        [
          ...params(c),
          original.candidate,
          after.version,
          c.operationReference,
          c.actorReference,
          c.action,
          c.occurredAt,
          json(transition),
        ],
      );
      if (result.rows.length !== 1 || result.rows[0]?.version !== String(after.version))
        return fail();
      await access(tx, c);
    },
  });
}

/** Reads actual owner state without constructing a mutation intent. */
export function createPostgresReconciliationFollowUpQuery(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  authorize(
    tx: ConsumerTransaction,
    query: ReadScope,
    purpose: "ReadPaymentReconciliationFollowUp",
  ): Promise<boolean>;
}) {
  const scope = {
    tenantReference: parsePaymentReference(options.scope.tenantReference),
    brandReference: parsePaymentReference(options.scope.brandReference),
    storeReference: parsePaymentReference(options.scope.storeReference),
  };
  return async (tx: ConsumerTransaction, exceptionReference: unknown) => {
    const query = Object.freeze({
      ...scope,
      exceptionReference: parsePaymentReference(exceptionReference),
    });
    const authorize = async () => {
      if ((await options.authorize(tx, query, "ReadPaymentReconciliationFollowUp")) !== true)
        throw new ReconciliationFollowUpError("RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED");
    };
    await authorize();
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    );
    const state = await readState(tx, query);
    await authorize();
    return Object.freeze({
      version: state.version,
      followUpStatus: state.status,
      acknowledged: state.acknowledgedByReference !== null,
      assigned: state.ownerReference !== null,
      updatedAt: state.updatedAt,
    });
  };
}
