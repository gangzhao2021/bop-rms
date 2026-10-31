import { parseCatalogReference } from "../../domain/product.js";

/** WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): the mark of a menu version approved by the person who
 * submitted it, as sole operator. Append-only; written in the approving transaction. */
export interface MenuSoleOperatorTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export class MenuSoleOperatorError extends Error {
  constructor(readonly code: "MENU_SOLE_OPERATOR_CONFLICT") {
    super(code);
    this.name = "MenuSoleOperatorError";
  }
}
const conflict = (): never => {
  throw new MenuSoleOperatorError("MENU_SOLE_OPERATOR_CONFLICT");
};
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const instant = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : value;
  return typeof text === "string" && instantPattern.test(text) ? text : conflict();
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  return d && "value" in d && Array.isArray(d.value) ? d.value : conflict();
}

/** Records the mark of an approval already committed in this transaction; exact replay returns the
 * existing mark, anything else conflicts. The 15-minute window is checked by the database. */
export async function recordMenuSoleOperatorApproval(
  tx: MenuSoleOperatorTransaction,
  input: {
    readonly brandReference: string;
    readonly approvalEvidenceReference: string;
    readonly operationReference: string;
    readonly menuReference: string;
    readonly menuVersionReference: string;
    readonly lifecycleReference: string;
    readonly actorReference: string;
    readonly actorMfaAt: string;
    readonly approvedAt: string;
    readonly auditReference: string;
  },
): Promise<"Created" | "AlreadyCommitted"> {
  const ref = (value: string) => String(parseCatalogReference(value));
  const v = {
    brand: ref(input.brandReference),
    evidence: ref(input.approvalEvidenceReference),
    operation: ref(input.operationReference),
    menu: ref(input.menuReference),
    version: ref(input.menuVersionReference),
    lifecycle: ref(input.lifecycleReference),
    actor: ref(input.actorReference),
    audit: ref(input.auditReference),
    mfa: instant(input.actorMfaAt),
    at: instant(input.approvedAt),
  };
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
    v.brand,
  ]);
  const prior = rows(
    await tx.query(
      "SELECT approval_evidence_id::text evidence,menu_version_id::text version,actor_id::text actor,audit_id::text audit FROM rms_catalog.menu_sole_operator_approval WHERE brand_id=$1 AND operation_id=$2",
      [v.brand, v.operation],
    ),
  )[0];
  if (prior !== undefined) {
    if (
      prior.evidence !== v.evidence ||
      prior.version !== v.version ||
      prior.actor !== v.actor ||
      prior.audit !== v.audit
    )
      return conflict();
    return "AlreadyCommitted";
  }
  await tx.query(
    "INSERT INTO rms_catalog.menu_sole_operator_approval (brand_id,approval_evidence_id,operation_id,menu_id,menu_version_id,lifecycle_id,approval_mode,actor_id,actor_mfa_at,approved_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,'SoleOperator',$7,$8,$9,$10)",
    [
      v.brand,
      v.evidence,
      v.operation,
      v.menu,
      v.version,
      v.lifecycle,
      v.actor,
      v.mfa,
      v.at,
      v.audit,
    ],
  );
  return "Created";
}

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU: the mark of a menu version listed by one person at a
 * single store ("List it", no review). Append-only; written in the approving transaction. The
 * database refuses it unless the Brand has exactly one store (not archived) and it is this one.
 * Exact replay returns the existing mark; anything else conflicts.
 */
export async function recordMenuSingleStoreListing(
  tx: MenuSoleOperatorTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly approvalEvidenceReference: string;
    readonly operationReference: string;
    readonly menuReference: string;
    readonly menuVersionReference: string;
    readonly lifecycleReference: string;
    readonly actorReference: string;
    readonly listedAt: string;
    readonly auditReference: string;
    /** DEC-BRAND-MULTI-STORE segment 9: at a Brand with several Stores, by its Owner. */
    readonly approvalMode?: "SingleStoreListing" | "BrandOwnerListing";
  },
): Promise<"Created" | "AlreadyCommitted"> {
  const ref = (value: string) => String(parseCatalogReference(value));
  const mode = input.approvalMode ?? "SingleStoreListing";
  if (mode !== "SingleStoreListing" && mode !== "BrandOwnerListing") return conflict();
  const v = {
    brand: ref(input.brandReference),
    store: ref(input.storeReference),
    evidence: ref(input.approvalEvidenceReference),
    operation: ref(input.operationReference),
    menu: ref(input.menuReference),
    version: ref(input.menuVersionReference),
    lifecycle: ref(input.lifecycleReference),
    actor: ref(input.actorReference),
    audit: ref(input.auditReference),
    at: instant(input.listedAt),
  };
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
    v.brand,
  ]);
  const prior = rows(
    await tx.query(
      "SELECT approval_evidence_id::text evidence,menu_version_id::text version,actor_id::text actor,audit_id::text audit FROM rms_catalog.menu_single_store_listing WHERE brand_id=$1 AND operation_id=$2",
      [v.brand, v.operation],
    ),
  )[0];
  if (prior !== undefined) {
    if (
      prior.evidence !== v.evidence ||
      prior.version !== v.version ||
      prior.actor !== v.actor ||
      prior.audit !== v.audit
    )
      return conflict();
    return "AlreadyCommitted";
  }
  await tx.query(
    "INSERT INTO rms_catalog.menu_single_store_listing (brand_id,approval_evidence_id,operation_id,menu_id,menu_version_id,lifecycle_id,approval_mode,listing_store_id,actor_id,listed_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$11,$7,$8,$9,$10)",
    [
      v.brand,
      v.evidence,
      v.operation,
      v.menu,
      v.version,
      v.lifecycle,
      v.store,
      v.actor,
      v.at,
      v.audit,
      mode,
    ],
  );
  return "Created";
}
