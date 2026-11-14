import { parseDeviceReference } from "../../contracts/device-management.js";
import { DigitalReceiptTemplateError } from "../../contracts/digital-receipt-template.js";

/**
 * WP-2423 DEC-SOLE-OPERATOR-APPROVAL (Owner decision 2026-10-16, Store configuration publication):
 * the mark of a receipt template version approved by the person who wrote it or sent it for
 * approval, alone, as sole operator. Append-only; written in the approving transaction before its
 * lifecycle record. The database checks the 15-minute second-factor window and, at COMMIT, that
 * the marked Approve committed with it by that person.
 */
export interface DigitalReceiptTemplateSoleOperatorTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface DigitalReceiptTemplateSoleOperatorApproval {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly templateReference: string;
  readonly versionReference: string;
  readonly reviewLifecycleReference: string;
  readonly operationReference: string;
  readonly approvalEvidenceReference: string;
  readonly approvalMode: "SoleOperator";
  readonly actorReference: string;
  readonly actorMfaAt: string;
  readonly approvedAt: string;
  readonly auditReference: string;
}
const conflict = (): never => {
  throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_CONFLICT");
};
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const instant = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : value;
  return typeof text === "string" && instantPattern.test(text) ? text : conflict();
};
const ref = (value: unknown): string => {
  try {
    return String(parseDeviceReference(value));
  } catch {
    return conflict();
  }
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  return d && "value" in d && Array.isArray(d.value) ? d.value : conflict();
}
const scope = (
  tx: DigitalReceiptTemplateSoleOperatorTransaction,
  tenant: string,
  brand: string,
  store: string,
) =>
  tx.query(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
    [tenant, brand, store],
  );
const select =
  "SELECT tenant_id::text tenant,brand_id::text brand,store_id::text store,template_id::text template,version_id::text version,review_lifecycle_id::text lifecycle,operation_id::text operation,approval_evidence_id::text evidence,approval_mode mode,actor_id::text actor,actor_mfa_at mfa,approved_at at,audit_id::text audit FROM rms_device.digital_receipt_template_sole_operator_approval";
function parse(row: Record<string, unknown>): DigitalReceiptTemplateSoleOperatorApproval {
  if (row.mode !== "SoleOperator") return conflict();
  return Object.freeze({
    tenantReference: ref(row.tenant),
    brandReference: ref(row.brand),
    storeReference: ref(row.store),
    templateReference: ref(row.template),
    versionReference: ref(row.version),
    reviewLifecycleReference: ref(row.lifecycle),
    operationReference: ref(row.operation),
    approvalEvidenceReference: ref(row.evidence),
    approvalMode: "SoleOperator" as const,
    actorReference: ref(row.actor),
    actorMfaAt: instant(row.mfa),
    approvedAt: instant(row.at),
    auditReference: ref(row.audit),
  });
}

/** The recorded sole-operator approval of one approval (by its evidence), or null. */
export async function readDigitalReceiptTemplateSoleOperatorApproval(
  tx: DigitalReceiptTemplateSoleOperatorTransaction,
  input: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly versionReference: string;
    readonly approvalEvidenceReference: string;
  },
): Promise<DigitalReceiptTemplateSoleOperatorApproval | null> {
  const tenant = ref(input.tenantReference),
    brand = ref(input.brandReference),
    store = ref(input.storeReference),
    version = ref(input.versionReference),
    evidence = ref(input.approvalEvidenceReference);
  await scope(tx, tenant, brand, store);
  const found = rows(
    await tx.query(
      select +
        " WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND version_id=$4 AND approval_evidence_id=$5 LIMIT 2",
      [tenant, brand, store, version, evidence],
    ),
  );
  if (found.length > 1) return conflict();
  const row = found[0];
  if (row === undefined) return null;
  const parsed = parse(row);
  if (
    parsed.tenantReference !== tenant ||
    parsed.brandReference !== brand ||
    parsed.storeReference !== store ||
    parsed.versionReference !== version ||
    parsed.approvalEvidenceReference !== evidence
  )
    return conflict();
  return parsed;
}

/**
 * Whether an approval given by the person who wrote or sent the version is backed by its exact
 * recorded sole-operator approval (same person, evidence and time; same Approve operation when
 * given). Any other approval is never accepted through this.
 */
export async function hasDigitalReceiptTemplateSoleOperatorApproval(
  tx: DigitalReceiptTemplateSoleOperatorTransaction,
  input: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly versionReference: string;
    readonly reviewLifecycleReference: string;
    readonly approvalEvidenceReference: string;
    readonly approverReference: string;
    readonly approvedAt: string;
    readonly operationReference?: string;
  },
): Promise<boolean> {
  const mark = await readDigitalReceiptTemplateSoleOperatorApproval(tx, input);
  return (
    mark !== null &&
    mark.actorReference === String(input.approverReference) &&
    mark.reviewLifecycleReference === String(input.reviewLifecycleReference) &&
    mark.approvedAt === String(input.approvedAt) &&
    (input.operationReference === undefined ||
      mark.operationReference === String(input.operationReference))
  );
}

/** Records the mark of the approval being given; an exact replay returns the existing mark. */
export async function recordDigitalReceiptTemplateSoleOperatorApproval(
  tx: DigitalReceiptTemplateSoleOperatorTransaction,
  input: Omit<DigitalReceiptTemplateSoleOperatorApproval, "approvalMode">,
): Promise<"Created" | "AlreadyRecorded"> {
  const value = {
    tenant: ref(input.tenantReference),
    brand: ref(input.brandReference),
    store: ref(input.storeReference),
    template: ref(input.templateReference),
    version: ref(input.versionReference),
    lifecycle: ref(input.reviewLifecycleReference),
    operation: ref(input.operationReference),
    evidence: ref(input.approvalEvidenceReference),
    actor: ref(input.actorReference),
    mfa: instant(input.actorMfaAt),
    at: instant(input.approvedAt),
    audit: ref(input.auditReference),
  };
  const prior = await readDigitalReceiptTemplateSoleOperatorApproval(tx, {
    tenantReference: value.tenant,
    brandReference: value.brand,
    storeReference: value.store,
    versionReference: value.version,
    approvalEvidenceReference: value.evidence,
  });
  if (prior !== null) {
    if (
      prior.operationReference !== value.operation ||
      prior.actorReference !== value.actor ||
      prior.auditReference !== value.audit ||
      prior.approvedAt !== value.at
    )
      return conflict();
    return "AlreadyRecorded";
  }
  await tx.query(
    "INSERT INTO rms_device.digital_receipt_template_sole_operator_approval (tenant_id,brand_id,store_id,template_id,version_id,review_lifecycle_id,operation_id,approval_evidence_id,approval_mode,actor_id,actor_mfa_at,approved_at,audit_id,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SoleOperator',$9,$10,$11,$12,'Confidential')",
    [
      value.tenant,
      value.brand,
      value.store,
      value.template,
      value.version,
      value.lifecycle,
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
