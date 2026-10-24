import { parseStoreAdministrationReference } from "../../contracts/store-configuration-administration.js";

/**
 * WP-2423 DEC-SOLE-OPERATOR-APPROVAL (Owner decision 2026-10-16): the mark of a Store configuration
 * from Store setup approved by the person who created it or sent it for approval, as sole operator.
 * Append-only; written while that approval is prepared, in its transaction. The database checks the
 * 15-minute second-factor window and, at COMMIT, that the marked Approve operation committed with it.
 */
export interface StoreConfigurationSoleOperatorTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export class StoreConfigurationSoleOperatorError extends Error {
  constructor(readonly code: "STORE_CONFIGURATION_SOLE_OPERATOR_CONFLICT") {
    super(code);
    this.name = "StoreConfigurationSoleOperatorError";
  }
}
export interface StoreConfigurationSoleOperatorApproval {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly configurationReference: string;
  readonly operationReference: string;
  readonly approvalEvidenceReference: string;
  readonly approvalMode: "SoleOperator";
  readonly actorReference: string;
  readonly actorMfaAt: string;
  readonly approvedAt: string;
  readonly auditReference: string;
}
const conflict = (): never => {
  throw new StoreConfigurationSoleOperatorError("STORE_CONFIGURATION_SOLE_OPERATOR_CONFLICT");
};
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const instant = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : value;
  return typeof text === "string" && instantPattern.test(text) ? text : conflict();
};
const ref = (value: unknown): string => {
  try {
    return String(parseStoreAdministrationReference(value));
  } catch {
    return conflict();
  }
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  return d && "value" in d && Array.isArray(d.value) ? d.value : conflict();
}
const scope = (tx: StoreConfigurationSoleOperatorTransaction, brand: string, store: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
const select =
  "SELECT brand_id::text brand,store_id::text store,configuration_id::text configuration,operation_id::text operation,approval_evidence_id::text evidence,approval_mode mode,actor_id::text actor,actor_mfa_at mfa,approved_at at,audit_id::text audit FROM rms_store.store_configuration_sole_operator_approval";
function parse(row: Record<string, unknown>): StoreConfigurationSoleOperatorApproval {
  if (row.mode !== "SoleOperator") return conflict();
  return Object.freeze({
    brandReference: ref(row.brand),
    storeReference: ref(row.store),
    configurationReference: ref(row.configuration),
    operationReference: ref(row.operation),
    approvalEvidenceReference: ref(row.evidence),
    approvalMode: "SoleOperator" as const,
    actorReference: ref(row.actor),
    actorMfaAt: instant(row.mfa),
    approvedAt: instant(row.at),
    auditReference: ref(row.audit),
  });
}

/** The recorded sole-operator approval of one configuration, or null (Store-scoped read). */
export async function readStoreConfigurationSoleOperatorApproval(
  tx: StoreConfigurationSoleOperatorTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly configurationReference: string;
  },
): Promise<StoreConfigurationSoleOperatorApproval | null> {
  const brand = ref(input.brandReference),
    store = ref(input.storeReference),
    configuration = ref(input.configurationReference);
  await scope(tx, brand, store);
  const found = rows(
    await tx.query(select + " WHERE brand_id=$1 AND store_id=$2 AND configuration_id=$3 LIMIT 2", [
      brand,
      store,
      configuration,
    ]),
  );
  if (found.length > 1) return conflict();
  const row = found[0];
  if (row === undefined) return null;
  const parsed = parse(row);
  if (
    parsed.brandReference !== brand ||
    parsed.storeReference !== store ||
    parsed.configurationReference !== configuration
  )
    return conflict();
  return parsed;
}

/** Records the mark of the approval being prepared; an exact replay returns the existing mark,
 * anything else conflicts. */
export async function recordStoreConfigurationSoleOperatorApproval(
  tx: StoreConfigurationSoleOperatorTransaction,
  input: Omit<StoreConfigurationSoleOperatorApproval, "approvalMode">,
): Promise<"Created" | "AlreadyRecorded"> {
  const value = {
    brand: ref(input.brandReference),
    store: ref(input.storeReference),
    configuration: ref(input.configurationReference),
    operation: ref(input.operationReference),
    evidence: ref(input.approvalEvidenceReference),
    actor: ref(input.actorReference),
    mfa: instant(input.actorMfaAt),
    at: instant(input.approvedAt),
    audit: ref(input.auditReference),
  };
  const prior = await readStoreConfigurationSoleOperatorApproval(tx, {
    brandReference: value.brand,
    storeReference: value.store,
    configurationReference: value.configuration,
  });
  if (prior !== null) {
    if (
      prior.operationReference !== value.operation ||
      prior.approvalEvidenceReference !== value.evidence ||
      prior.actorReference !== value.actor ||
      prior.auditReference !== value.audit
    )
      return conflict();
    return "AlreadyRecorded";
  }
  await tx.query(
    "INSERT INTO rms_store.store_configuration_sole_operator_approval (brand_id,store_id,configuration_id,operation_id,approval_evidence_id,approval_mode,actor_id,actor_mfa_at,approved_at,audit_id,data_classification) VALUES ($1,$2,$3,$4,$5,'SoleOperator',$6,$7,$8,$9,'ConfigurationMetadata')",
    [
      value.brand,
      value.store,
      value.configuration,
      value.operation,
      value.evidence,
      value.actor,
      value.mfa,
      value.at,
      value.audit,
    ],
  );
  return "Created";
}
