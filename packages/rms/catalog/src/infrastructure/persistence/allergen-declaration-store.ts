import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { CatalogError, parseCatalogCode, parseCatalogReference } from "../../contracts/product.js";

/**
 * WP-2423 / DEC-ALLERGEN-DECLARATIONS: the Brand's allergen registry and ingredient allergen
 * declarations. A registry version lists the allergens the Brand discloses (the latest Approved
 * version is current). A declaration is approved source evidence for one Inventory Item version made
 * against one registry version: each listed allergen is contained or possibly cross-contacted; a
 * declaration listing none states the item contains none of that registry's allergens. Everything
 * is append-only; a new declaration replaces the previous one as current. Caller authorizes and owns
 * the transaction; all reads and writes run in the Brand scope.
 */
export type AllergenDeclarationErrorCode =
  | "ALLERGEN_REGISTRY_INVALID"
  | "ALLERGEN_REGISTRY_UNAVAILABLE"
  | "ALLERGEN_DECLARATION_INVALID"
  | "ALLERGEN_IDEMPOTENCY_CONFLICT";
export class AllergenDeclarationError extends Error {
  constructor(readonly code: AllergenDeclarationErrorCode) {
    super(code);
    this.name = "AllergenDeclarationError";
  }
}
const fail = (code: AllergenDeclarationErrorCode): never => {
  throw new AllergenDeclarationError(code);
};
interface Tx {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const brandScope = (tx: Tx, brand: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [brand]);
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

export interface AllergenRegistry {
  readonly registryVersionReference: string;
  readonly jurisdictionCode: string;
  readonly policyDocumentDigest: string;
  readonly reviewedAt: string;
  readonly reviewerReference: string;
  readonly entries: readonly {
    readonly allergenReference: string;
    readonly code: string;
    readonly localizedNames: Readonly<Record<string, string>>;
  }[];
}
/** The Brand's current registry: its latest Approved version. */
export async function currentAllergenRegistry(
  tx: Tx,
  scope: { readonly brandReference: string },
): Promise<AllergenRegistry | null> {
  const brand = parseCatalogReference(scope.brandReference);
  await brandScope(tx, brand);
  const row = (
    await tx.query(
      `SELECT r.registry_version_id::text registry,r.jurisdiction_code,r.policy_document_digest,
        ${iso("r.reviewed_at")} reviewed_at,r.reviewer_actor_id::text reviewer,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('allergenReference',e.allergen_id,'code',e.allergen_code,
          'localizedNames',e.localized_names_json) ORDER BY e.allergen_code)
          FROM rms_catalog.allergen_registry_entry e WHERE e.registry_version_id=r.registry_version_id
          AND e.brand_id=r.brand_id),'[]'::jsonb) entries
       FROM rms_catalog.allergen_registry_version r
       WHERE r.brand_id=$1 AND r.status='Approved'
       ORDER BY r.reviewed_at DESC,r.registry_version_id DESC LIMIT 1`,
      [brand],
    )
  ).rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    registryVersionReference: String(row.registry),
    jurisdictionCode: String(row.jurisdiction_code),
    policyDocumentDigest: String(row.policy_document_digest),
    reviewedAt: String(row.reviewed_at),
    reviewerReference: String(row.reviewer),
    entries: row.entries as AllergenRegistry["entries"],
  });
}

const audit = (input: {
  readonly brand: string;
  readonly actor: string;
  readonly actionCode: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly operation: string;
  readonly at: string;
  readonly auditReference: string;
  readonly afterSummary: Record<string, string | number | boolean | null>;
}): AppendAuditRecordInput =>
  ({
    auditId: input.auditReference,
    brandId: input.brand,
    actor: { type: "User", reference: input.actor },
    actionCode: input.actionCode,
    targetType: input.targetType,
    targetId: input.targetId,
    correlationId: input.operation,
    reasonCode: "AUTHORIZED_OPERATION",
    occurredAt: input.at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
    afterSummary: input.afterSummary,
  }) as AppendAuditRecordInput;

/**
 * Approves a new registry version for the Brand (it becomes current). The version identity is the
 * caller's stable reference for the operation, so a retry returns the same version.
 */
export async function createAllergenRegistryVersion(
  tx: Tx,
  scope: { readonly brandReference: string },
  input: {
    readonly registryVersionReference: string;
    readonly jurisdictionCode: string;
    readonly policyDocument: string;
    readonly entries: readonly {
      readonly allergenReference: string;
      readonly code: string;
      readonly localizedNames: Readonly<Record<string, string>>;
    }[];
    readonly actorReference: string;
    readonly at: string;
    readonly auditReference: string;
  },
): Promise<{ readonly status: "Applied" | "AlreadyApplied"; readonly registry: AllergenRegistry }> {
  const brand = parseCatalogReference(scope.brandReference);
  const version = parseCatalogReference(input.registryVersionReference);
  const jurisdiction = parseCatalogCode(input.jurisdictionCode);
  const entries = input.entries.map((entry) => ({
    allergenReference: parseCatalogReference(entry.allergenReference),
    code: parseCatalogCode(entry.code),
    localizedNames: entry.localizedNames,
  }));
  if (
    entries.length < 1 ||
    entries.length > 64 ||
    new Set(entries.map((entry) => entry.code)).size !== entries.length ||
    new Set(entries.map((entry) => entry.allergenReference)).size !== entries.length ||
    entries.some(
      (entry) =>
        Object.keys(entry.localizedNames).length < 1 ||
        Object.values(entry.localizedNames).some(
          (name) => typeof name !== "string" || name.trim().length < 1 || name.length > 120,
        ),
    ) ||
    input.policyDocument.trim().length < 1 ||
    input.policyDocument.length > 2000
  )
    return fail("ALLERGEN_REGISTRY_INVALID");
  const policyDigest = digest({ jurisdiction, policy: input.policyDocument.trim(), entries });
  await brandScope(tx, brand);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "AllergenRegistry:" + brand,
  ]);
  const existing = (
    await tx.query(
      "SELECT policy_document_digest FROM rms_catalog.allergen_registry_version WHERE brand_id=$1 AND registry_version_id=$2",
      [brand, version],
    )
  ).rows[0];
  if (existing !== undefined) {
    if (existing.policy_document_digest !== policyDigest)
      return fail("ALLERGEN_IDEMPOTENCY_CONFLICT");
    const current = await currentAllergenRegistry(tx, { brandReference: brand });
    if (current === null) return fail("ALLERGEN_REGISTRY_UNAVAILABLE");
    return { status: "AlreadyApplied", registry: current };
  }
  await tx.query(
    "INSERT INTO rms_catalog.allergen_registry_version(registry_version_id,brand_id,jurisdiction_code,policy_document_digest,reviewed_at,reviewer_actor_id,status) VALUES($1,$2,$3,$4,$5,$6,'Approved')",
    [version, brand, jurisdiction, policyDigest, input.at, input.actorReference],
  );
  for (const entry of entries)
    await tx.query(
      "INSERT INTO rms_catalog.allergen_registry_entry(registry_version_id,brand_id,allergen_id,allergen_code,localized_names_json) VALUES($1,$2,$3,$4,$5)",
      [version, brand, entry.allergenReference, entry.code, JSON.stringify(entry.localizedNames)],
    );
  await appendAuditRecordInTransaction(
    tx,
    audit({
      brand,
      actor: input.actorReference,
      actionCode: "CATALOG_ALLERGEN_REGISTRY_APPROVE",
      targetType: "CatalogAllergenRegistry",
      targetId: version,
      operation: version,
      at: input.at,
      auditReference: input.auditReference,
      afterSummary: { jurisdictionCode: jurisdiction, entries: entries.length },
    }),
  );
  const current = await currentAllergenRegistry(tx, { brandReference: brand });
  if (current?.registryVersionReference !== version) return fail("ALLERGEN_REGISTRY_UNAVAILABLE");
  return { status: "Applied", registry: current };
}

export const allergenDeclarationSources = [
  "SupplierSpecification",
  "ProductLabel",
  "ManufacturerStatement",
] as const;
export interface IngredientAllergenDeclaration {
  readonly evidenceReference: string;
  readonly itemReference: string;
  readonly itemVersionReference: string;
  readonly registryVersionReference: string;
  readonly allergens: readonly {
    readonly allergenReference: string;
    readonly classification: "Contains" | "CrossContactPossible";
  }[];
  readonly sourceKind: (typeof allergenDeclarationSources)[number];
  readonly documentReference: string;
  readonly note: string | null;
  readonly supplierReference: string | null;
  readonly declaredBy: string;
  readonly reviewedAt: string;
  readonly validUntil: string;
}
const declarationSql = `SELECT e.evidence_id::text evidence,e.subject_id::text item,e.source_version_id::text version,
  e.registry_version_id::text registry,e.supplier_id::text supplier,e.declaration_json,e.declared_by_actor_id::text actor,
  ${iso("e.reviewed_at")} reviewed_at,${iso("e.valid_until")} valid_until,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('allergenReference',a.allergen_id,'classification',a.classification)
    ORDER BY a.allergen_id) FROM rms_catalog.allergen_source_assertion a
    WHERE a.evidence_id=e.evidence_id AND a.brand_id=e.brand_id),'[]'::jsonb) assertions
 FROM rms_catalog.allergen_source_evidence e
 WHERE e.brand_id=$1 AND e.subject_kind='Ingredient' AND e.declaration_json IS NOT NULL
  AND e.evidence_status='Approved'`;
const declarationOf = (row: Record<string, unknown>): IngredientAllergenDeclaration => {
  const d = row.declaration_json as Record<string, unknown>;
  return Object.freeze({
    evidenceReference: String(row.evidence),
    itemReference: String(row.item),
    itemVersionReference: String(row.version),
    registryVersionReference: String(row.registry),
    allergens: row.assertions as IngredientAllergenDeclaration["allergens"],
    sourceKind: d.sourceKind as IngredientAllergenDeclaration["sourceKind"],
    documentReference: String(d.documentReference ?? ""),
    note: typeof d.note === "string" ? d.note : null,
    supplierReference: row.supplier === null ? null : String(row.supplier),
    declaredBy: String(row.actor),
    reviewedAt: String(row.reviewed_at),
    validUntil: String(row.valid_until),
  });
};

/** Each ingredient's latest declaration that is still valid at `at` (one per item). */
export async function listCurrentIngredientDeclarations(
  tx: Tx,
  scope: { readonly brandReference: string },
  at: string,
): Promise<readonly IngredientAllergenDeclaration[]> {
  const brand = parseCatalogReference(scope.brandReference);
  await brandScope(tx, brand);
  return (
    await tx.query(
      `SELECT DISTINCT ON (d.item) d.* FROM (${declarationSql} AND e.reviewed_at<=$2::timestamptz
        AND e.valid_until>$2::timestamptz) d ORDER BY d.item,d.reviewed_at DESC,d.evidence DESC`,
      [brand, at],
    )
  ).rows.map(declarationOf);
}

/** One ingredient's declarations, newest first (history). */
export async function listIngredientDeclarationHistory(
  tx: Tx,
  scope: { readonly brandReference: string },
  itemReference: string,
): Promise<readonly IngredientAllergenDeclaration[]> {
  const brand = parseCatalogReference(scope.brandReference);
  await brandScope(tx, brand);
  return (
    await tx.query(
      declarationSql +
        " AND e.subject_id=$2 ORDER BY e.reviewed_at DESC,e.evidence_id DESC LIMIT 50",
      [brand, parseCatalogReference(itemReference)],
    )
  ).rows.map(declarationOf);
}

/**
 * Records an ingredient's allergen declaration against the current registry. Every allergen of the
 * registry is decided by the declarer: listed allergens are contained or possibly cross-contacted,
 * the rest are absent. The evidence identity is the caller's stable reference for the operation.
 */
export async function recordIngredientAllergenDeclaration(
  tx: Tx,
  scope: { readonly brandReference: string },
  input: {
    readonly evidenceReference: string;
    readonly itemReference: string;
    readonly itemVersionReference: string;
    readonly registryVersionReference: string;
    readonly allergens: readonly {
      readonly allergenReference: string;
      readonly classification: "Contains" | "CrossContactPossible";
    }[];
    readonly sourceKind: (typeof allergenDeclarationSources)[number];
    readonly documentReference: string;
    readonly note: string | null;
    readonly validUntil: string;
    readonly actorReference: string;
    readonly at: string;
    readonly auditReference: string;
  },
): Promise<{
  readonly status: "Applied" | "AlreadyApplied";
  readonly declaration: IngredientAllergenDeclaration;
}> {
  const brand = parseCatalogReference(scope.brandReference);
  const evidence = parseCatalogReference(input.evidenceReference);
  const allergens = [...input.allergens]
    .map((a) => ({
      allergenReference: parseCatalogReference(a.allergenReference),
      classification: a.classification,
    }))
    .sort((a, b) => a.allergenReference.localeCompare(b.allergenReference));
  const document = input.documentReference.trim();
  const note = input.note === null ? null : input.note.trim() || null;
  if (
    new Set(allergens.map((a) => a.allergenReference)).size !== allergens.length ||
    allergens.some(
      (a) => a.classification !== "Contains" && a.classification !== "CrossContactPossible",
    ) ||
    !(allergenDeclarationSources as readonly string[]).includes(input.sourceKind) ||
    document.length < 1 ||
    document.length > 200 ||
    (note !== null && note.length > 500) ||
    !(Date.parse(input.validUntil) > Date.parse(input.at))
  )
    return fail("ALLERGEN_DECLARATION_INVALID");
  const declaration = { sourceKind: input.sourceKind, documentReference: document, note };
  const content = {
    item: parseCatalogReference(input.itemReference),
    version: parseCatalogReference(input.itemVersionReference),
    registry: parseCatalogReference(input.registryVersionReference),
    allergens,
    declaration,
    validUntil: input.validUntil,
  };
  const documentDigest = digest(content);
  await brandScope(tx, brand);
  const prior = (await tx.query(declarationSql + " AND e.evidence_id=$2", [brand, evidence]))
    .rows[0];
  if (prior !== undefined) {
    const saved = (
      await tx.query(
        "SELECT document_digest FROM rms_catalog.allergen_source_evidence WHERE brand_id=$1 AND evidence_id=$2",
        [brand, evidence],
      )
    ).rows[0];
    if (saved?.document_digest !== documentDigest) return fail("ALLERGEN_IDEMPOTENCY_CONFLICT");
    return { status: "AlreadyApplied", declaration: declarationOf(prior) };
  }
  const registry = await currentAllergenRegistry(tx, { brandReference: brand });
  if (registry === null || registry.registryVersionReference !== content.registry)
    return fail("ALLERGEN_REGISTRY_UNAVAILABLE");
  const known = new Set(registry.entries.map((entry) => entry.allergenReference));
  if (allergens.some((a) => !known.has(a.allergenReference)))
    return fail("ALLERGEN_DECLARATION_INVALID");
  await tx.query(
    `INSERT INTO rms_catalog.allergen_source_evidence(evidence_id,brand_id,subject_id,subject_kind,source_version_id,
      supplier_id,document_digest,reviewed_at,valid_until,evidence_status,registry_version_id,declaration_json,declared_by_actor_id)
     VALUES($1,$2,$3,'Ingredient',$4,NULL,$5,$6,$7,'Approved',$8,$9,$10)`,
    [
      evidence,
      brand,
      content.item,
      content.version,
      documentDigest,
      input.at,
      input.validUntil,
      content.registry,
      JSON.stringify(declaration),
      input.actorReference,
    ],
  );
  for (const allergen of allergens)
    await tx.query(
      "INSERT INTO rms_catalog.allergen_source_assertion(evidence_id,brand_id,registry_version_id,allergen_id,classification) VALUES($1,$2,$3,$4,$5)",
      [evidence, brand, content.registry, allergen.allergenReference, allergen.classification],
    );
  await appendAuditRecordInTransaction(
    tx,
    audit({
      brand,
      actor: input.actorReference,
      actionCode: "CATALOG_ALLERGEN_DECLARE",
      targetType: "CatalogAllergenDeclaration",
      targetId: evidence,
      operation: evidence,
      at: input.at,
      auditReference: input.auditReference,
      afterSummary: {
        itemReference: content.item,
        itemVersionReference: content.version,
        contains: allergens.filter((a) => a.classification === "Contains").length,
        mayContain: allergens.filter((a) => a.classification === "CrossContactPossible").length,
        sourceKind: input.sourceKind,
      },
    }),
  );
  const saved = (await tx.query(declarationSql + " AND e.evidence_id=$2", [brand, evidence]))
    .rows[0];
  if (saved === undefined) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  return { status: "Applied", declaration: declarationOf(saved) };
}
