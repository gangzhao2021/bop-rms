import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogLocale,
} from "../../contracts/product.js";
import {
  parseAllergenRegistryEntry,
  parseAllergenSourceEvidence,
  type AllergenRegistryEntry,
  type AllergenSourceEvidence,
} from "../../contracts/allergen-provenance.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

const select = `SELECT jsonb_build_object(
  'registryVersionReference',r.registry_version_id,
  'registry',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'allergenReference',a.allergen_id,'code',a.allergen_code,'localizedNames',a.localized_names_json
  ) ORDER BY a.allergen_code,a.allergen_id) FROM rms_catalog.allergen_registry_entry a
    WHERE a.registry_version_id=r.registry_version_id AND a.brand_id=r.brand_id),'[]'::jsonb),
  'evidence',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'evidenceReference',e.evidence_id,'subjectReference',e.subject_id,'subjectKind',e.subject_kind,
    'sourceVersionReference',e.source_version_id,'supplierReference',e.supplier_id,
    'documentDigest',e.document_digest,
    'reviewedAt',to_char(e.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'validUntil',to_char(e.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'status',e.evidence_status,
    'assertions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'allergenReference',a.allergen_id,'classification',a.classification
    ) ORDER BY a.allergen_id) FROM rms_catalog.allergen_source_assertion a
      WHERE a.evidence_id=e.evidence_id AND a.brand_id=e.brand_id),'[]'::jsonb)
  ) ORDER BY e.evidence_id) FROM rms_catalog.allergen_source_evidence e
    WHERE e.brand_id=r.brand_id AND e.evidence_id=ANY($3::uuid[])),'[]'::jsonb)
) AS facts,
  (r.status='Approved' AND r.reviewed_at <= $4::timestamptz
   AND date_trunc('milliseconds',r.reviewed_at)=r.reviewed_at
   AND NOT EXISTS (SELECT 1 FROM rms_catalog.allergen_source_assertion a
     WHERE a.brand_id=r.brand_id AND a.evidence_id=ANY($3::uuid[]) AND a.registry_version_id<>r.registry_version_id)
   AND NOT EXISTS (SELECT 1 FROM rms_catalog.allergen_source_evidence e
     WHERE e.brand_id=r.brand_id AND e.evidence_id=ANY($3::uuid[]) AND
     (date_trunc('milliseconds',e.reviewed_at)<>e.reviewed_at OR date_trunc('milliseconds',e.valid_until)<>e.valid_until))
  ) AS coherent
FROM rms_catalog.allergen_registry_version r WHERE r.brand_id=$1 AND r.registry_version_id=$2`;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Pinned evidence reader only. Callers own the provenance path and must validate
 * its complete Product/Recipe/Option linkage. Keep tx open through review commit.
 */
export function createPostgresAllergenReviewFactsStore(options: {
  brandReference: string;
  authorize(tx: ProductLifecycleTransaction): Promise<boolean>;
}) {
  const brand = parseCatalogReference(options.brandReference);
  return async (
    tx: ProductLifecycleTransaction,
    input: {
      registryVersionReference: string;
      evidenceReferences: readonly string[];
      defaultLocale: string;
      observedAt: string;
    },
  ) => {
    try {
      const registry = parseCatalogReference(input.registryVersionReference);
      const locale = parseCatalogLocale(input.defaultLocale),
        at = parseCatalogInstant(input.observedAt);
      if (!Array.isArray(input.evidenceReferences) || !input.evidenceReferences.length)
        return fail();
      const references = input.evidenceReferences.map(parseCatalogReference);
      if (new Set(references).size !== references.length) return fail();
      const authorize = async () => {
        if ((await options.authorize(tx)) !== true)
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
        [brand],
      );
      // Entries and assertions are mutable configuration rows. Lock the complete
      // source tables so insertion of a new assertion cannot race the review.
      await tx.query(
        "LOCK TABLE rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry,rms_catalog.allergen_source_evidence,rms_catalog.allergen_source_assertion IN SHARE MODE",
        [],
      );
      const result = await tx.query<{
        coherent: boolean;
        facts: {
          registryVersionReference: string;
          registry: AllergenRegistryEntry[];
          evidence: AllergenSourceEvidence[];
        };
      }>(select, [brand, registry, references, at]);
      const row = result.rows[0];
      if (
        result.rows.length !== 1 ||
        !row ||
        row.coherent !== true ||
        row.facts.registryVersionReference !== registry
      )
        return fail();
      const entries = row.facts.registry.map((entry) => parseAllergenRegistryEntry(entry, locale));
      const evidence = row.facts.evidence.map((entry) => parseAllergenSourceEvidence(entry, at));
      if (
        !entries.length ||
        new Set(entries.map((entry) => entry.allergenReference)).size !== entries.length ||
        new Set(entries.map((entry) => entry.code)).size !== entries.length ||
        evidence.length !== references.length ||
        new Set(evidence.map((entry) => entry.evidenceReference)).size !== references.length ||
        evidence.some(
          (entry) =>
            !references.includes(entry.evidenceReference) ||
            entry.assertions.some(
              (assertion) =>
                !entries.some((entry) => entry.allergenReference === assertion.allergenReference),
            ),
        )
      )
        return fail();
      await authorize();
      return Object.freeze({
        registryVersionReference: registry,
        registry: Object.freeze(entries),
        evidence: Object.freeze(evidence),
      });
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
}
