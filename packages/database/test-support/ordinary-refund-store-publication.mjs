import { seedStorePublication } from "./store-publication-seed.mjs";
import { createStoreConfigurationVersion } from "../../rms/store/src/index.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createMerchantOrdinaryRefundBusinessDate } from "../../../apps/api/src/merchant-ordinary-refund-business-date.ts";

/** Synthetic Store configuration, actual published owner records/proof. */
export async function seedOrdinaryRefundStorePublication({ client, scope, firstCapturedAt }) {
  const id = (n) =>
    n === 90
      ? scope.tenantReference
      : "01909973-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const at = new Date(Date.parse(firstCapturedAt) - 3600000).toISOString();
  const configuration = createStoreConfigurationVersion({
    configurationReference: id(1),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    configurationVersion: 1,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: id(5),
    contactReference: id(6),
    receiptReference: id(7),
    taxConfigurationReference: id(8),
    paymentConfigurationReference: id(9),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({
      isoWeekday: i + 1,
      intervals:
        i === 0
          ? [
              {
                startLocalTime: "09:00:00",
                endLocalTime: "22:00:00",
                endsNextDay: false,
                serviceModes: ["DineIn", "Pickup"],
                orderCutoffSeconds: 900,
                leadTimeSeconds: 1200,
              },
            ]
          : [],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "PILOT_CONFIGURATION",
    authoredByReference: id(10),
    approvedByReference: id(11),
    approvalEvidenceReference: id(12),
    publicationReference: id(13),
    liveGateEvidenceReference: id(14),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
  const row = {
    configuration_id: id(1),
    brand_id: scope.brandReference,
    store_id: scope.storeReference,
    configuration_version: 1,
    lifecycle: "Published",
    configuration_source: "StoreOverride",
    brand_base_version_reference: id(4),
    default_locale: "en-CA",
    currency_code: "CAD",
    time_zone: "America/Toronto",
    business_day_start_local_time: "04:00:00",
    address_reference: id(5),
    contact_reference: id(6),
    receipt_reference: id(7),
    tax_configuration_reference: id(8),
    payment_configuration_reference: id(9),
    capacity_configuration_reference: null,
    enabled_service_modes: ["DineIn", "Pickup"],
    effective_from: at,
    effective_until: null,
    supersedes_configuration_reference: null,
    reason_code: "PILOT_CONFIGURATION",
    authored_by_reference: id(10),
    approved_by_reference: id(11),
    approval_evidence_reference: id(12),
    publication_reference: id(13),
    live_gate_evidence_reference: id(14),
    created_at: at,
    updated_at: at,
    data_classification: "ConfigurationMetadata",
  };
  await client.query(
    "INSERT INTO rms_store.store_configuration_version SELECT * FROM jsonb_populate_record(NULL::rms_store.store_configuration_version,$1::jsonb)",
    [JSON.stringify(row)],
  );
  await client.query(
    "INSERT INTO rms_store.store_weekly_service_period VALUES($1,$2,$3,$4,1,1,'09:00:00','22:00:00',false,ARRAY['DineIn','Pickup'],900,1200,'ConfigurationMetadata')",
    [id(20), scope.brandReference, scope.storeReference, id(1)],
  );
  const digest = "sha256:" + sha256Hex(canonicalizeRfc8785(configuration));
  await client.query(
    "INSERT INTO rms_store.store_configuration_publication_content VALUES ($1,$2,$3,$4,'STORE_CONFIGURATION','STORE_CONFIGURATION',$5,$6,'StoreOverride',$7,'ConfigurationMetadata')",
    [scope.brandReference, scope.storeReference, id(1), id(70), digest, configuration, at],
  );
  await seedStorePublication(
    client,
    id,
    configuration,
    digest,
    undefined,
    undefined,
    new Date(Date.parse(at) + 2 * 86400000).toISOString(),
  );
  const storeOptions = {
    ...scope,
    timeZone: "America/Toronto",
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
    authorize: async () => true,
  };
  return { storeOptions, businessDate: createMerchantOrdinaryRefundBusinessDate(storeOptions) };
}
