import { canonicalizeRfc8785, sha256Hex } from "../../packages/bop/audit/src/index.ts";
import { createPersistentPublicStoreProfileReader } from "../../apps/api/dist/persistent-public-store-profile.js";
import { createPersistentEntryOperatingReader } from "../../apps/api/dist/persistent-entry-operating.js";
export async function createInternalTestResources({
  createApplicationDatabase,
  createInternalTestCredentials,
  createCustomerRequestAdmission,
  loadProfile,
  loadMenu,
  expectedDatabaseName,
}) {
  const profile = await loadProfile();
  const menu = await loadMenu();
  if (
    [profile, menu].some(
      (value) => value.environment !== "InternalTest" || value.database !== expectedDatabaseName,
    )
  )
    throw new Error("INTERNAL_CONFIGURATION_REQUIRED");
  const credentials = await createInternalTestCredentials(),
    database = await createApplicationDatabase("api");
  try {
    const scope = {
      brandReference: profile.binding.brandReference,
      storeReference: profile.binding.storeReference,
    };
    const transactions = database.transactions({
      brandId: scope.brandReference,
      storeId: scope.storeReference,
    });
    const now = () => new Date().toISOString(),
      hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
    const publicProfile = {
      binding: profile.binding,
      selection: profile.selection,
      authorize: async () => true,
      hashContent: hash,
      hashSnapshot: hash,
      hashPeriod: hash,
      verifyMedia: async () => {
        throw new Error("INTERNAL_TEST_MEDIA_UNAVAILABLE");
      },
      telemetry: { record: () => undefined },
    };
    const operating = {
      ...scope,
      tenantReference: profile.binding.tenantReference,
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
      authorize: async () => true,
      hashContent: hash,
      timeZone: "America/Toronto",
      verifyPauseOperation: async () => {
        throw new Error("INTERNAL_TEST_PAUSE_UNAVAILABLE");
      },
    };
    const requestAdmission = await createCustomerRequestAdmission({ database, scope, now });
    return Object.freeze({
      scope,
      menu,
      now,
      credentials,
      database,
      transactions,
      publicProfile,
      operating,
      requestAdmission,
      stores: createPersistentPublicStoreProfileReader({ ...publicProfile, transactions }),
      operatingReader: (transaction) =>
        createPersistentEntryOperatingReader({
          transaction,
          publicStore: { binding: profile.binding, authorize: publicProfile.authorize },
          operating,
        }),
      close: () => database.close(),
    });
  } catch (error) {
    await database.close();
    throw error;
  }
}
