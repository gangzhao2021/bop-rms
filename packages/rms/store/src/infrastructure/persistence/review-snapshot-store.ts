import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import { parsePublishingCode } from "@bop/publishing";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
  validateStoreConfigurationForPublication,
  type StoreConfigurationVersion,
} from "../../contracts/store-configuration-administration.js";
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
interface SnapshotInput {
  readonly reviewedPublication: StoreConfigurationVersion;
  readonly lifecycleReference: string;
  readonly actorReference: string;
  readonly auditReference: string;
}
const fail = (): never => {
  throw new Error("STORE_REVIEW_SNAPSHOT_UNAVAILABLE");
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return fail();
  const field = Object.getOwnPropertyDescriptor(value, "rows");
  if (!field || !("value" in field) || !Array.isArray(field.value)) return fail();
  return field.value;
}
/** Immutable planned content only. Caller retains transaction through Publishing/
 * Store commands. Audit must append in that transaction; no independent commit.
 */
export function createPostgresStoreReviewSnapshotStore(options: {
  brandReference: string;
  storeReference: string;
  publishingFamilyReference: string;
  configurationType: string;
  purposeCode: string;
  hashContent(configuration: StoreConfigurationVersion): string;
  authorize(tx: Transaction, at: string): Promise<boolean>;
  appendAudit(
    tx: Transaction,
    input: SnapshotInput & { recordedAt: string; contentDigest: string },
  ): Promise<void>;
}) {
  const brand = parseBrandReference(options.brandReference);
  const store = parseStoreReference(options.storeReference);
  const family = parseStoreAdministrationReference(options.publishingFamilyReference);
  const type = parsePublishingCode(options.configurationType);
  const purpose = parsePublishingCode(options.purposeCode);
  const fence = async (tx: Transaction, at: string, write: boolean) => {
    if ((await options.authorize(tx, at)) !== true) return fail();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    if (write)
      await tx.query(
        "LOCK TABLE rms_store.store_configuration_review_snapshot IN SHARE ROW EXCLUSIVE MODE",
        [],
      );
    else
      await tx.query("LOCK TABLE rms_store.store_configuration_review_snapshot IN SHARE MODE", []);
  };
  const parse = (row: Record<string, unknown>, at: string) => {
    const configuration = createStoreConfigurationVersion(row.configuration_json);
    validateStoreConfigurationForPublication(configuration);
    const digest = options.hashContent(configuration);
    if (
      configuration.brandReference !== brand ||
      configuration.storeReference !== store ||
      configuration.configurationReference !== row.configuration_id ||
      configuration.approvalEvidenceReference !== row.approval_evidence_reference ||
      row.publishing_family_reference !== family ||
      row.configuration_type !== type ||
      row.purpose_code !== purpose ||
      !/^sha256:[0-9a-f]{64}$/u.test(digest) ||
      digest !== row.content_digest ||
      configuration.updatedAt > at ||
      !(row.recorded_at instanceof Date) ||
      !Number.isFinite(row.recorded_at.getTime()) ||
      row.recorded_at.toISOString() > at
    )
      return fail();
    return Object.freeze({
      reviewedPublication: configuration,
      lifecycleReference: parseStoreAdministrationReference(row.lifecycle_id),
      actorReference: parseStoreAdministrationReference(row.actor_reference),
      auditReference: parseStoreAdministrationReference(row.audit_reference),
    });
  };
  const read = async (tx: Transaction, configuration: StoreConfigurationVersion, now: string) => {
    try {
      const at = parseCanonicalInstant(now);
      const candidate = createStoreConfigurationVersion(configuration);
      if (
        candidate.brandReference !== brand ||
        candidate.storeReference !== store ||
        candidate.approvalEvidenceReference === null
      )
        return fail();
      await fence(tx, at, false);
      const found = rows(
        await tx.query(
          "SELECT * FROM rms_store.store_configuration_review_snapshot WHERE brand_id=$1 AND store_id=$2 AND configuration_id=$3 AND approval_evidence_reference=$4",
          [brand, store, candidate.configurationReference, candidate.approvalEvidenceReference],
        ),
      );
      if (found.length > 1) return fail();
      const result = found[0] ? parse(found[0], at) : null;
      if ((await options.authorize(tx, at)) !== true) return fail();
      return result;
    } catch {
      return fail();
    }
  };
  const save = async (tx: Transaction, input: SnapshotInput, now: string) => {
    try {
      const at = parseCanonicalInstant(now);
      const configuration = createStoreConfigurationVersion(input.reviewedPublication);
      validateStoreConfigurationForPublication(configuration);
      const lifecycle = parseStoreAdministrationReference(input.lifecycleReference);
      const actor = parseStoreAdministrationReference(input.actorReference);
      const audit = parseStoreAdministrationReference(input.auditReference);
      const digest = options.hashContent(configuration);
      if (
        configuration.brandReference !== brand ||
        configuration.storeReference !== store ||
        configuration.updatedAt > at ||
        !/^sha256:[0-9a-f]{64}$/u.test(digest)
      )
        return fail();
      await fence(tx, at, true);
      const existing = rows(
        await tx.query(
          "SELECT * FROM rms_store.store_configuration_review_snapshot WHERE brand_id=$1 AND store_id=$2 AND lifecycle_id=$3",
          [brand, store, lifecycle],
        ),
      );
      if (existing.length > 1) return fail();
      const previous = existing[0];
      if (previous) {
        parse(previous, at);
        if (
          previous.content_digest !== digest ||
          previous.actor_reference !== actor ||
          previous.audit_reference !== audit
        )
          return fail();
        if ((await options.authorize(tx, at)) !== true) return fail();
        return "AlreadyApplied" as const;
      }
      await tx.query(
        "INSERT INTO rms_store.store_configuration_review_snapshot (brand_id,store_id,lifecycle_id,configuration_id,approval_evidence_reference,publishing_family_reference,configuration_type,purpose_code,content_digest,configuration_json,actor_reference,audit_reference,recorded_at,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,'ConfigurationMetadata')",
        [
          brand,
          store,
          lifecycle,
          configuration.configurationReference,
          configuration.approvalEvidenceReference,
          family,
          type,
          purpose,
          digest,
          JSON.stringify(configuration),
          actor,
          audit,
          at,
        ],
      );
      await options.appendAudit(tx, {
        reviewedPublication: configuration,
        lifecycleReference: lifecycle,
        actorReference: actor,
        auditReference: audit,
        recordedAt: at,
        contentDigest: digest,
      });
      if ((await options.authorize(tx, at)) !== true) return fail();
      return "Applied" as const;
    } catch {
      return fail();
    }
  };
  return Object.freeze({ read, save });
}
