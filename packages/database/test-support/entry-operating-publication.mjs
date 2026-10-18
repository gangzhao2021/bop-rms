import { entryTorontoBoundary } from "./entry-toronto-boundary.mjs";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createStoreConfigurationVersion,
  createPostgresStorePublicationAuthorization,
  createPostgresStorePublicationMaterializer,
} from "../../rms/store/src/index.ts";
import { seedStorePublication } from "./store-publication-seed.mjs";

/** Synthetic business approvals/Live Gate facts; actual Publishing and Store owners. */
export async function prepareEntryOperatingPublication({
  admin,
  role,
  binding,
  at,
  currentWindow = false,
}) {
  const id = (n) =>
    n === 90
      ? binding.tenantReference
      : "0190ed19-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = { brandReference: binding.brandReference, storeReference: binding.storeReference };
  const hashContent = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
  const localHour = Number(entryTorontoBoundary(at).localDateTime.slice(11, 13));
  const hour = (value) => String(value % 24).padStart(2, "0") + ":00:00";
  const start = currentWindow ? hour(localHour + 18) : "00:00:00";
  const end = currentWindow ? hour(localHour + 6) : "08:00:00";
  const configuration = createStoreConfigurationVersion({
    ...scope,
    configurationReference: id(1),
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
    weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
      isoWeekday: index + 1,
      intervals: [
        {
          startLocalTime: start,
          endLocalTime: end,
          endsNextDay: end < start,
          serviceModes: ["DineIn", "Pickup"],
          orderCutoffSeconds: 0,
          leadTimeSeconds: 0,
        },
      ],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "SYNTHETIC_ENTRY",
    authoredByReference: id(10),
    approvedByReference: id(11),
    approvalEvidenceReference: id(12),
    publicationReference: id(13),
    liveGateEvidenceReference: id(14),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
  await seedStorePublication(
    admin,
    id,
    configuration,
    hashContent(configuration),
    undefined,
    undefined,
    new Date(Date.parse(at) + 86400000).toISOString(),
  );
  const authorityOptions = {
    ...scope,
    tenantReference: binding.tenantReference,
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
    authorize: async () => true, // Synthetic operator/purpose authority.
    hashContent,
  };
  const authorize = createPostgresStorePublicationAuthorization({
    ...authorityOptions,
    publishingFamilyReference: id(70),
  });
  let sequence = 1000;
  const materialize = createPostgresStorePublicationMaterializer({
    ...scope,
    publishingFamilyReference: id(70),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    businessDayStartSource: "StoreOverride",
    nextReference: () => id(++sequence),
    hashContent,
    authorize: async (tx, input) => {
      await authorize(tx, input.operation.configuration, input.audit.occurredAt);
      return true;
    },
  });
  await admin.query("BEGIN");
  try {
    await materialize(
      { query: (sql, values) => admin.query(sql, [...values]) },
      {
        operation: { ...scope, command: "Publish", configuration },
        audit: { occurredAt: at },
      },
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  const tables = [
    "store_configuration_version",
    "store_configuration_authoring_operation",
    "store_configuration_publication_content",
    "store_weekly_service_period",
    "store_service_exception",
    "store_service_exception_content",
    "store_service_exception_interval",
    "store_configuration_operation",
    "store_service_pause_content",
    "store_service_resume_content",
  ];
  await admin.query(
    "GRANT SELECT,UPDATE ON " +
      tables.map((table) => "rms_store." + table).join(",") +
      " TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,UPDATE ON bop_publishing.live_gate_version,bop_publishing.live_gate_requirement TO " +
      role,
  );
  return {
    ...authorityOptions,
    timeZone: configuration.timeZone,
    verifyPauseOperation: async () => {
      throw new Error("fixture contains no pause history");
    },
  };
}
