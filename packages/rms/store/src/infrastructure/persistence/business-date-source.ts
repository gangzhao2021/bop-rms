import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import {
  resolveStoreBusinessDate,
  parseStoreBusinessDateConfiguration,
  type StoreBusinessDateConfiguration,
} from "../../domain/resolve-business-date.js";
import { parseStoreAdministrationReference } from "../../contracts/store-configuration-administration.js";

interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface PublishedBusinessDateCandidate {
  readonly configurationReference: string;
  readonly configurationVersion: number;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly timeZone: string;
  readonly businessDayStartLocalTime: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly approvalEvidenceReference: string;
  readonly publicationReference: string;
  readonly liveGateEvidenceReference: string;
}
const denied = (): never => {
  throw new Error("STORE_BUSINESS_DATE_UNAVAILABLE");
};
function instant(value: unknown) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return denied();
  return value.toISOString();
}
/** Internal owner reader. Authorization and publication proof must fence their
 * current public-owner evidence in this transaction. No invented digest/default source.
 * A published successor follows the immutable authoring chain through unpublished
 * drafts. Strictly decreasing versions prevent cyclic traversal. It suppresses
 * its published predecessor from its effective start,
 * including after that successor expires; expiration never resurrects old policy.
 * Unrelated overlapping candidates still fail closed. Current publication proof
 * remains mandatory for the selected candidate.
 * SHARE table lock prevents a newly published overlapping configuration during read.
 */
export function createPostgresStoreBusinessDateConfigurationSource(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly timeZone: string;
  authorize(tx: Transaction, observedAt: string): Promise<boolean>;
  publicationProof(
    tx: Transaction,
    candidate: PublishedBusinessDateCandidate,
    observedAt: string,
  ): Promise<{
    readonly contentDigest: string;
    readonly businessDayStartSource: StoreBusinessDateConfiguration["businessDayStartSource"];
  } | null>;
}) {
  const brandReference = parseBrandReference(options.brandReference);
  const storeReference = parseStoreReference(options.storeReference);
  const timeZone = options.timeZone;
  return async (tx: Transaction, now: string) => {
    try {
      const at = parseCanonicalInstant(now);
      if ((await options.authorize(tx, at)) !== true) return denied();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brandReference, storeReference],
      );
      await tx.query(
        "LOCK TABLE rms_store.store_configuration_authoring_operation,rms_store.store_configuration_version IN SHARE MODE",
        [],
      );
      const result = await tx.query(
        "WITH RECURSIVE nodes AS (SELECT configuration_id,configuration_version,supersedes_configuration_reference FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 UNION SELECT configuration_id,configuration_version,(configuration_json->>'supersedesConfigurationReference')::uuid FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 AND occurred_at <= $3), lineage AS (SELECT configuration_id AS root_id,configuration_id,configuration_version,supersedes_configuration_reference::uuid AS supersedes_configuration_reference FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Published' AND effective_from <= $3 UNION SELECT l.root_id,n.configuration_id,n.configuration_version,n.supersedes_configuration_reference FROM lineage l JOIN nodes n ON n.configuration_id=l.supersedes_configuration_reference AND n.configuration_version < l.configuration_version) SELECT configuration_id,configuration_version,brand_id,store_id,time_zone,business_day_start_local_time,effective_from,effective_until,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at FROM rms_store.store_configuration_version v WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Published' AND effective_from <= $3 AND (effective_until IS NULL OR effective_until > $3) AND NOT EXISTS (SELECT 1 FROM lineage successor WHERE successor.configuration_id=v.configuration_id AND successor.root_id<>v.configuration_id) ORDER BY configuration_version DESC LIMIT 2",
        [brandReference, storeReference, at],
      );
      if (!result || typeof result !== "object") return denied();
      const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !Array.isArray(descriptor.value) ||
        descriptor.value.length !== 1
      )
        return denied();
      const row = descriptor.value[0] as Record<string, unknown>;
      const version =
        typeof row.configuration_version === "string" &&
        /^[1-9][0-9]*$/u.test(row.configuration_version)
          ? Number(row.configuration_version)
          : 0;
      if (
        !Number.isSafeInteger(version) ||
        version < 1 ||
        row.brand_id !== brandReference ||
        row.store_id !== storeReference ||
        row.time_zone !== timeZone ||
        instant(row.created_at) > at ||
        instant(row.updated_at) > at
      )
        return denied();
      const candidate: PublishedBusinessDateCandidate = Object.freeze({
        configurationReference: parseStoreAdministrationReference(row.configuration_id),
        configurationVersion: version,
        brandReference,
        storeReference,
        timeZone,
        businessDayStartLocalTime: String(row.business_day_start_local_time),
        effectiveFrom: instant(row.effective_from),
        effectiveUntil: row.effective_until === null ? null : instant(row.effective_until),
        approvalEvidenceReference: parseStoreAdministrationReference(
          row.approval_evidence_reference,
        ),
        publicationReference: parseStoreAdministrationReference(row.publication_reference),
        liveGateEvidenceReference: parseStoreAdministrationReference(
          row.live_gate_evidence_reference,
        ),
      });
      const proof = await options.publicationProof(tx, candidate, at);
      if (!proof) return denied();
      const configuration = parseStoreBusinessDateConfiguration({
        configurationReference: candidate.configurationReference,
        configurationVersion: version,
        brandReference,
        storeReference,
        timeZone,
        businessDayStartLocalTime: candidate.businessDayStartLocalTime,
        businessDayStartSource: proof.businessDayStartSource,
        contentDigest: proof.contentDigest,
        effectiveFrom: candidate.effectiveFrom,
        effectiveUntil: candidate.effectiveUntil,
      });
      resolveStoreBusinessDate({ occurredAt: at, configuration });
      if ((await options.authorize(tx, at)) !== true) return denied();
      return configuration;
    } catch {
      return denied();
    }
  };
}

/** Compatible point-in-time query over the same authorized configuration source. */
export function createPostgresStoreBusinessDateSource(
  options: Parameters<typeof createPostgresStoreBusinessDateConfigurationSource>[0],
) {
  const read = createPostgresStoreBusinessDateConfigurationSource(options);
  return async (tx: Transaction, at: string) =>
    resolveStoreBusinessDate({ occurredAt: at, configuration: await read(tx, at) });
}
