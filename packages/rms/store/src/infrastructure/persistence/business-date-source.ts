import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import {
  BusinessDateError,
  resolveStoreBusinessDate,
  resolveStoreBusinessDay,
  resolveStoreBusinessDateBounds,
  resolveClosedStoreBusinessDateWindowAcross,
  parseStoreBusinessDateConfiguration,
  type ClosedStoreBusinessDateWindow,
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
 * A version governs an instant only once it is both effective (effective_from <= at)
 * and published by then (Store publication recorded, created and updated <= at):
 * between an edit's draft save (its effectiveFrom) and its publication the previous
 * version stays in force, so historical reads at such instants are stable.
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
        "LOCK TABLE rms_store.store_configuration_authoring_operation,rms_store.store_configuration_version,rms_store.store_configuration_publication_content IN SHARE MODE",
        [],
      );
      const result = await tx.query(
        "WITH RECURSIVE published AS (SELECT v.configuration_id FROM rms_store.store_configuration_version v JOIN rms_store.store_configuration_publication_content c ON c.brand_id=v.brand_id AND c.store_id=v.store_id AND c.configuration_id=v.configuration_id WHERE v.brand_id=$1 AND v.store_id=$2 AND v.lifecycle='Published' AND c.recorded_at <= $3 AND v.created_at <= $3 AND v.updated_at <= $3), nodes AS (SELECT configuration_id,configuration_version,supersedes_configuration_reference FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 UNION SELECT configuration_id,configuration_version,(configuration_json->>'supersedesConfigurationReference')::uuid FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 AND occurred_at <= $3), lineage AS (SELECT configuration_id AS root_id,configuration_id,configuration_version,supersedes_configuration_reference::uuid AS supersedes_configuration_reference FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Published' AND effective_from <= $3 AND configuration_id IN (SELECT configuration_id FROM published) UNION SELECT l.root_id,n.configuration_id,n.configuration_version,n.supersedes_configuration_reference FROM lineage l JOIN nodes n ON n.configuration_id=l.supersedes_configuration_reference AND n.configuration_version < l.configuration_version) SELECT configuration_id,configuration_version,brand_id,store_id,time_zone,business_day_start_local_time,effective_from,effective_until,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at FROM rms_store.store_configuration_version v WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Published' AND configuration_id IN (SELECT configuration_id FROM published) AND effective_from <= $3 AND (effective_until IS NULL OR effective_until > $3) AND NOT EXISTS (SELECT 1 FROM lineage successor WHERE successor.configuration_id=v.configuration_id AND successor.root_id<>v.configuration_id) ORDER BY configuration_version DESC LIMIT 2",
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

/** WP-2423 Q21: the current Store business day (date, start and end) over the same source. */
export function createPostgresStoreBusinessDaySource(
  options: Parameters<typeof createPostgresStoreBusinessDateConfigurationSource>[0],
) {
  const read = createPostgresStoreBusinessDateConfigurationSource(options);
  return async (tx: Transaction, at: string) =>
    resolveStoreBusinessDay({ occurredAt: at, configuration: await read(tx, at) });
}

/** Closed Store business day read for settlement: every configuration in force at any
 * instant of the day, each verified by the caller's publicationProof (use the
 * as-published proof for past days). anchorAt selects the configuration whose time
 * zone and day start define the requested day's boundaries; the day is then read at
 * its start and at every Store fact instant inside it where the governing version can
 * change (effective from/until, publication recorded/created/updated, authoring).
 * Several versions may govern the day only with identical boundaries (see
 * resolveClosedStoreBusinessDateWindowAcross); a mismatch is refused with
 * STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE, anything else with
 * STORE_BUSINESS_DATE_UNAVAILABLE.
 */
export function createPostgresStoreClosedBusinessDateWindowSource(
  options: Parameters<typeof createPostgresStoreBusinessDateConfigurationSource>[0],
) {
  const read = createPostgresStoreBusinessDateConfigurationSource(options);
  const brandReference = parseBrandReference(options.brandReference);
  const storeReference = parseStoreReference(options.storeReference);
  return async (
    tx: Transaction,
    input: {
      readonly businessDate: string;
      readonly anchorAt: string;
      readonly observedAt: string;
    },
  ): Promise<ClosedStoreBusinessDateWindow> => {
    try {
      const anchorAt = parseCanonicalInstant(input.anchorAt);
      const observedAt = parseCanonicalInstant(input.observedAt);
      const anchor = await read(tx, anchorAt);
      const { startsAt, endsAt } = resolveStoreBusinessDateBounds({
        businessDate: input.businessDate,
        configuration: anchor,
      });
      if (endsAt > observedAt) return denied();
      if ((await options.authorize(tx, observedAt)) !== true) return denied();
      // The source read already holds SHARE locks on these Store tables in this tx.
      const result = await tx.query(
        "SELECT DISTINCT t FROM (SELECT v.effective_from AS t FROM rms_store.store_configuration_version v WHERE v.brand_id=$1 AND v.store_id=$2 AND v.lifecycle='Published' UNION ALL SELECT v.effective_until FROM rms_store.store_configuration_version v WHERE v.brand_id=$1 AND v.store_id=$2 AND v.lifecycle='Published' UNION ALL SELECT v.created_at FROM rms_store.store_configuration_version v WHERE v.brand_id=$1 AND v.store_id=$2 AND v.lifecycle='Published' UNION ALL SELECT v.updated_at FROM rms_store.store_configuration_version v WHERE v.brand_id=$1 AND v.store_id=$2 AND v.lifecycle='Published' UNION ALL SELECT c.recorded_at FROM rms_store.store_configuration_publication_content c WHERE c.brand_id=$1 AND c.store_id=$2 UNION ALL SELECT o.occurred_at FROM rms_store.store_configuration_authoring_operation o WHERE o.brand_id=$1 AND o.store_id=$2) points WHERE t > $3 AND t < $4 ORDER BY t LIMIT 64",
        [brandReference, storeReference, startsAt, endsAt],
      );
      if (!result || typeof result !== "object") return denied();
      const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !Array.isArray(descriptor.value) ||
        descriptor.value.length > 63
      )
        return denied();
      const instants = [
        startsAt,
        ...(descriptor.value as Record<string, unknown>[]).map((row) => instant(row.t)),
      ];
      const configurations: StoreBusinessDateConfiguration[] = [];
      for (const at of instants) {
        const configuration = await read(tx, at);
        const previous = configurations[configurations.length - 1];
        if (!previous || JSON.stringify(previous) !== JSON.stringify(configuration))
          configurations.push(configuration);
      }
      const window = resolveClosedStoreBusinessDateWindowAcross({
        businessDate: input.businessDate,
        observedAt,
        configurations,
      });
      // The day's governing versions must place the same boundaries the anchor did.
      if (
        window.startsAt !== startsAt ||
        window.endsAt !== endsAt ||
        (await options.authorize(tx, observedAt)) !== true
      )
        return denied();
      return window;
    } catch (error) {
      if (
        error instanceof BusinessDateError &&
        error.code === "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE"
      )
        throw error;
      return denied();
    }
  };
}
