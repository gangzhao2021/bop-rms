import {
  createStorePublicationSetupBasisVerifier,
  type StorePublicationSetupSnapshotReferences,
} from "./publication-setup-basis.js";
import { parsePublishingCode } from "@bop/publishing";
import { parseBrandReference, parseStoreReference } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  validateStoreConfigurationForPublication,
  parseStoreAdministrationReference,
  type StoreServiceInterval,
} from "../../contracts/store-configuration-administration.js";
import type { StoreConfigurationAdministrationPorts } from "../../application/ports/store-configuration-administration-ports.js";
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
type Commit = Parameters<StoreConfigurationAdministrationPorts["repository"]["commit"]>[0];
const denied = (): never => {
  throw new Error("STORE_PUBLICATION_WRITE_UNAVAILABLE");
};
/** Invoke only within the authoring repository transaction after current Publishing
 * and Live Gate validation. Caller owns rollback, authority fences and Audit append.
 * hashContent uses the same canonical serialization as public publication readers.
 */
export function createPostgresStorePublicationMaterializer(options: {
  readonly tenantReference?: string;
  readonly setupSnapshotReferences?: StorePublicationSetupSnapshotReferences;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly publishingFamilyReference: string;
  readonly configurationType: string;
  readonly purposeCode: string;
  readonly businessDayStartSource: "PlatformDefault" | "StoreOverride";
  nextReference(): string;
  hashContent(value: unknown): string;
  authorize(tx: Transaction, input: Commit): Promise<boolean>;
}) {
  const verifySetupBasis = createStorePublicationSetupBasisVerifier(options);
  const brand = parseBrandReference(options.brandReference);
  const store = parseStoreReference(options.storeReference);
  const family = parseStoreAdministrationReference(options.publishingFamilyReference);
  const type = parsePublishingCode(options.configurationType);
  const purpose = parsePublishingCode(options.purposeCode);
  const source = options.businessDayStartSource;
  if (source !== "PlatformDefault" && source !== "StoreOverride") return denied();
  const digest = (value: unknown) => {
    const result = options.hashContent(value);
    return /^sha256:[0-9a-f]{64}$/u.test(result) ? result : denied();
  };
  const reference = () => parseStoreAdministrationReference(options.nextReference());
  const intervalValues = (value: StoreServiceInterval) => [
    value.startLocalTime,
    value.endLocalTime,
    value.endsNextDay,
    value.serviceModes,
    value.orderCutoffSeconds,
    value.leadTimeSeconds,
    "ConfigurationMetadata",
  ];
  return async (tx: Transaction, input: Commit): Promise<void> => {
    const c = createStoreConfigurationVersion(input.operation.configuration);
    validateStoreConfigurationForPublication(c);
    if (
      input.operation.command !== "Publish" ||
      c.lifecycle !== "Published" ||
      c.brandReference !== brand ||
      c.storeReference !== store ||
      input.operation.brandReference !== brand ||
      input.operation.storeReference !== store ||
      (source === "PlatformDefault" && c.businessDayStartLocalTime !== "04:00:00") ||
      (await options.authorize(tx, input)) !== true
    )
      return denied();
    await verifySetupBasis(tx, c, input.audit.occurredAt);
    const contentDigest = digest(c);
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    await tx.query(
      "INSERT INTO rms_store.store_configuration_version (configuration_id,brand_id,store_id,configuration_version,lifecycle,configuration_source,brand_base_version_reference,default_locale,currency_code,time_zone,business_day_start_local_time,address_reference,contact_reference,receipt_reference,tax_configuration_reference,payment_configuration_reference,capacity_configuration_reference,enabled_service_modes,effective_from,effective_until,supersedes_configuration_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)",
      [
        c.configurationReference,
        c.brandReference,
        c.storeReference,
        c.configurationVersion,
        c.lifecycle,
        c.source,
        c.brandBaseVersionReference,
        c.defaultLocale,
        c.currencyCode,
        c.timeZone,
        c.businessDayStartLocalTime,
        c.addressReference,
        c.contactReference,
        c.receiptReference,
        c.taxConfigurationReference,
        c.paymentConfigurationReference,
        c.capacityConfigurationReference,
        c.enabledServiceModes,
        c.effectiveFrom,
        c.effectiveUntil,
        c.supersedesConfigurationReference,
        c.reasonCode,
        c.authoredByReference,
        c.approvedByReference,
        c.approvalEvidenceReference,
        c.publicationReference,
        c.liveGateEvidenceReference,
        c.createdAt,
        c.updatedAt,
        c.dataClassification,
      ],
    );
    for (const day of c.weeklySchedule) {
      for (const [index, interval] of day.intervals.entries()) {
        await tx.query(
          "INSERT INTO rms_store.store_weekly_service_period (period_id,brand_id,store_id,configuration_id,iso_weekday,sequence_number,start_local_time,end_local_time,ends_next_day,service_modes,order_cutoff_seconds,lead_time_seconds,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [
            reference(),
            brand,
            store,
            c.configurationReference,
            day.isoWeekday,
            index + 1,
            ...intervalValues(interval),
          ],
        );
      }
    }
    for (const exception of c.exceptions) {
      const id = reference();
      await tx.query(
        "INSERT INTO rms_store.store_service_exception (exception_id,brand_id,store_id,configuration_id,local_date,exception_kind,interval_summary_digest,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          brand,
          store,
          c.configurationReference,
          exception.localDate,
          exception.kind,
          digest(exception.intervals),
          "ConfigurationMetadata",
        ],
      );
      await tx.query(
        "INSERT INTO rms_store.store_service_exception_content (brand_id,store_id,exception_id,interval_count,data_classification) VALUES ($1,$2,$3,$4,$5)",
        [brand, store, id, exception.intervals.length, "ConfigurationMetadata"],
      );
      for (const [index, interval] of exception.intervals.entries()) {
        await tx.query(
          "INSERT INTO rms_store.store_service_exception_interval (interval_id,brand_id,store_id,exception_id,sequence_number,start_local_time,end_local_time,ends_next_day,service_modes,order_cutoff_seconds,lead_time_seconds,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [reference(), brand, store, id, index + 1, ...intervalValues(interval)],
        );
      }
    }
    await tx.query(
      "INSERT INTO rms_store.store_configuration_publication_content (brand_id,store_id,configuration_id,publishing_family_reference,configuration_type,purpose_code,content_digest,configuration_json,business_day_start_source,recorded_at,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        brand,
        store,
        c.configurationReference,
        family,
        type,
        purpose,
        contentDigest,
        JSON.stringify(c),
        source,
        input.audit.occurredAt,
        "ConfigurationMetadata",
      ],
    );
    if ((await options.authorize(tx, input)) !== true) return denied();
    await verifySetupBasis(tx, c, input.audit.occurredAt);
  };
}
