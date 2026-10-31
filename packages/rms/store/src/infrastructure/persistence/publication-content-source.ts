import {
  createStorePublicationSetupBasisVerifier,
  type StorePublicationSetupSnapshotReferences,
} from "./publication-setup-basis.js";
import { parsePublishingCode } from "@bop/publishing";
import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  validateStoreConfigurationForPublication,
  parseStoreAdministrationReference,
  type StoreConfigurationVersion,
} from "../../contracts/store-configuration-administration.js";
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const denied = (): never => {
  throw new Error("STORE_PUBLICATION_CONTENT_UNAVAILABLE");
};
const code = parsePublishingCode;

/** hashContent must use the publication's canonical serialization and digest.
 * Returns verified Store content, NOT proof of a current Publishing/Live Gate.
 */
export function createPostgresStorePublicationContentSource(options: {
  readonly tenantReference?: string;
  readonly setupSnapshotReferences?: StorePublicationSetupSnapshotReferences;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly configurationReference: string;
  authorize(tx: Transaction, at: string): Promise<boolean>;
  hashContent(configuration: StoreConfigurationVersion): string;
}) {
  const verifySetupBasis = createStorePublicationSetupBasisVerifier(options);
  const brand = parseBrandReference(options.brandReference);
  const store = parseStoreReference(options.storeReference);
  const reference = parseStoreAdministrationReference(options.configurationReference);
  return async (tx: Transaction, now: string) => {
    try {
      const at = parseCanonicalInstant(now);
      if ((await options.authorize(tx, at)) !== true) return denied();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query(
        "LOCK TABLE rms_store.store_configuration_version,rms_store.store_configuration_publication_content IN SHARE MODE",
        [],
      );
      const result = await tx.query(
        "SELECT to_jsonb(v) AS base,c.configuration_json,c.content_digest,c.publishing_family_reference,c.configuration_type,c.purpose_code,c.business_day_start_source,c.recorded_at FROM rms_store.store_configuration_version v JOIN rms_store.store_configuration_publication_content c ON c.brand_id=v.brand_id AND c.store_id=v.store_id AND c.configuration_id=v.configuration_id WHERE v.brand_id=$1 AND v.store_id=$2 AND v.configuration_id=$3",
        [brand, store, reference],
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
      const configuration = createStoreConfigurationVersion(row.configuration_json);
      validateStoreConfigurationForPublication(configuration);
      if (
        configuration.brandReference !== brand ||
        configuration.storeReference !== store ||
        configuration.configurationReference !== reference ||
        configuration.effectiveFrom > at ||
        (configuration.effectiveUntil !== null && configuration.effectiveUntil <= at) ||
        configuration.updatedAt > at ||
        configuration.createdAt > at ||
        typeof row.content_digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(row.content_digest) ||
        options.hashContent(configuration) !== row.content_digest
      )
        return denied();
      if (!row.base || typeof row.base !== "object" || Array.isArray(row.base)) return denied();
      const base = row.base as Record<string, unknown>;
      const renamed: Readonly<Record<string, string>> = {
        configurationReference: "configuration_id",
        brandReference: "brand_id",
        storeReference: "store_id",
        source: "configuration_source",
      };
      const times = new Set(["effectiveFrom", "effectiveUntil", "createdAt", "updatedAt"]);
      for (const [key, value] of Object.entries(configuration)) {
        if (key === "weeklySchedule" || key === "exceptions" || key === "setupBasis") continue;
        const column =
          renamed[key] ?? key.replace(/[A-Z]/gu, (letter) => "_" + letter.toLowerCase());
        let stored = base[column];
        if (times.has(key) && stored !== null) {
          if (typeof stored !== "string" || !Number.isFinite(Date.parse(stored))) return denied();
          stored = new Date(stored).toISOString();
        }
        if (JSON.stringify(stored) !== JSON.stringify(value)) return denied();
      }
      await verifySetupBasis(tx, configuration, at);
      const source = row.business_day_start_source;
      if (source !== "PlatformDefault" && source !== "StoreOverride") return denied();
      if (source === "PlatformDefault" && configuration.businessDayStartLocalTime !== "04:00:00")
        return denied();
      if (!(row.recorded_at instanceof Date) || !Number.isFinite(row.recorded_at.getTime()))
        return denied();
      const recordedAt = row.recorded_at.toISOString();
      if (recordedAt > at || recordedAt < configuration.createdAt) return denied();
      const binding = Object.freeze({
        configuration,
        contentDigest: row.content_digest,
        familyReference: parseStoreAdministrationReference(row.publishing_family_reference),
        configurationType: code(row.configuration_type),
        purposeCode: code(row.purpose_code),
        businessDayStartSource: source,
        recordedAt,
      });
      if ((await options.authorize(tx, at)) !== true) return denied();
      return binding;
    } catch {
      return denied();
    }
  };
}
