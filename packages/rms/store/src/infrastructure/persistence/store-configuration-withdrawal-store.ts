import { parseStoreAdministrationReference } from "../../contracts/store-configuration-administration.js";

/**
 * WP-2423 (v15 live check, D2/D3): a Store configuration that is not published yet, withdrawn by
 * the person who made it ("Withdrawn") or declined by someone who may approve it ("Declined").
 * Append-only; the configuration itself is kept. The database checks that it is the Store's
 * latest recorded configuration, at its recorded state, and who withdrew it.
 */
export interface StoreConfigurationWithdrawalTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export class StoreConfigurationWithdrawalError extends Error {
  constructor(
    readonly code:
      "STORE_CONFIGURATION_WITHDRAWAL_CONFLICT" | "STORE_CONFIGURATION_WITHDRAWAL_INPUT_INVALID",
  ) {
    super(code);
    this.name = "StoreConfigurationWithdrawalError";
  }
}
export type StoreConfigurationWithdrawalKind = "Withdrawn" | "Declined";
export interface StoreConfigurationWithdrawal {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly configurationReference: string;
  readonly configurationVersion: number;
  readonly withdrawnLifecycle: "Draft" | "PendingApproval" | "Approved";
  readonly kind: StoreConfigurationWithdrawalKind;
  readonly actorReference: string;
  readonly reasonCode: string;
  readonly auditReference: string;
  readonly withdrawnAt: string;
}
const conflict = (): never => {
  throw new StoreConfigurationWithdrawalError("STORE_CONFIGURATION_WITHDRAWAL_CONFLICT");
};
const invalid = (): never => {
  throw new StoreConfigurationWithdrawalError("STORE_CONFIGURATION_WITHDRAWAL_INPUT_INVALID");
};
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const instant = (value: unknown, fail: () => never): string => {
  const text = value instanceof Date ? value.toISOString() : value;
  return typeof text === "string" && instantPattern.test(text) ? text : fail();
};
const ref = (value: unknown, fail: () => never): string => {
  try {
    return String(parseStoreAdministrationReference(value));
  } catch {
    return fail();
  }
};
const lifecycles = new Set(["Draft", "PendingApproval", "Approved"]);
const kinds = new Set(["Withdrawn", "Declined"]);
const reasonPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
function rows(value: unknown): readonly Record<string, unknown>[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  return d && "value" in d && Array.isArray(d.value) ? d.value : conflict();
}

/** The withdrawal of one configuration, or null (Store-scoped read). */
export async function readStoreConfigurationWithdrawal(
  tx: StoreConfigurationWithdrawalTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly configurationReference: string;
  },
): Promise<StoreConfigurationWithdrawal | null> {
  const brand = ref(input.brandReference, invalid),
    store = ref(input.storeReference, invalid),
    configuration = ref(input.configurationReference, invalid);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const found = rows(
    await tx.query(
      "SELECT configuration_version::text version,withdrawn_lifecycle lifecycle,withdrawal_kind kind,actor_id::text actor,reason_code reason,audit_id::text audit,withdrawn_at at FROM rms_store.store_configuration_withdrawal WHERE brand_id=$1 AND store_id=$2 AND configuration_id=$3 LIMIT 2",
      [brand, store, configuration],
    ),
  );
  if (found.length > 1) return conflict();
  const row = found[0];
  if (row === undefined) return null;
  const version = Number(row.version);
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !lifecycles.has(String(row.lifecycle)) ||
    !kinds.has(String(row.kind)) ||
    !reasonPattern.test(String(row.reason))
  )
    return conflict();
  return Object.freeze({
    brandReference: brand,
    storeReference: store,
    configurationReference: configuration,
    configurationVersion: version,
    withdrawnLifecycle: row.lifecycle as StoreConfigurationWithdrawal["withdrawnLifecycle"],
    kind: row.kind as StoreConfigurationWithdrawalKind,
    actorReference: ref(row.actor, conflict),
    reasonCode: String(row.reason),
    auditReference: ref(row.audit, conflict),
    withdrawnAt: instant(row.at, conflict),
  });
}

/** Records a withdrawal; an exact replay (same configuration, person and audit) returns the
 * existing record, anything else conflicts. */
export async function recordStoreConfigurationWithdrawal(
  tx: StoreConfigurationWithdrawalTransaction,
  input: StoreConfigurationWithdrawal,
): Promise<"Created" | "AlreadyRecorded"> {
  const value = {
    brand: ref(input.brandReference, invalid),
    store: ref(input.storeReference, invalid),
    configuration: ref(input.configurationReference, invalid),
    actor: ref(input.actorReference, invalid),
    audit: ref(input.auditReference, invalid),
    at: instant(input.withdrawnAt, invalid),
  };
  if (
    !Number.isSafeInteger(input.configurationVersion) ||
    input.configurationVersion < 1 ||
    !lifecycles.has(input.withdrawnLifecycle) ||
    !kinds.has(input.kind) ||
    !reasonPattern.test(input.reasonCode)
  )
    return invalid();
  const prior = await readStoreConfigurationWithdrawal(tx, {
    brandReference: value.brand,
    storeReference: value.store,
    configurationReference: value.configuration,
  });
  if (prior !== null) {
    if (
      prior.actorReference !== value.actor ||
      prior.kind !== input.kind ||
      prior.auditReference !== value.audit
    )
      return conflict();
    return "AlreadyRecorded";
  }
  await tx.query(
    "INSERT INTO rms_store.store_configuration_withdrawal (brand_id,store_id,configuration_id,configuration_version,withdrawn_lifecycle,withdrawal_kind,actor_id,reason_code,audit_id,withdrawn_at,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ConfigurationMetadata')",
    [
      value.brand,
      value.store,
      value.configuration,
      input.configurationVersion,
      input.withdrawnLifecycle,
      input.kind,
      value.actor,
      input.reasonCode,
      value.audit,
      value.at,
    ],
  );
  return "Created";
}
