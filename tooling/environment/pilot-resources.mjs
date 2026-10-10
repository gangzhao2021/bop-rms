import { matchesPilotEnvironment } from "./pilot-environment.mjs";
import {
  createBindingAuthorization,
  readStoreOperatingFacts,
  resolveOperatingConfiguration,
  verifyStoreOperating,
} from "./pilot-operating-source.mjs";
import { canonicalizeRfc8785, sha256Hex } from "../../packages/bop/audit/src/index.ts";
import { createPersistentPublicStoreProfileReader } from "../../apps/api/dist/persistent-public-store-profile.js";
import { createPersistentEntryOperatingReader } from "../../apps/api/dist/persistent-entry-operating.js";
import { createMerchantServicePauseProof } from "../../apps/api/dist/merchant-service-pause-proof.js";
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
      (value) =>
        !matchesPilotEnvironment(value.environment) || value.database !== expectedDatabaseName,
    )
  )
    throw new Error("INTERNAL_CONFIGURATION_REQUIRED");
  // WP-2423 StoreOperatingSource: gate codes come from the profile, the time zone from the Store
  // record, authorization from the binding's validity; the published status is read once at start.
  const operatingConfiguration = resolveOperatingConfiguration(profile);
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
    const bindingAuthorization = createBindingAuthorization(profile.binding, now);
    const store = await readStoreOperatingFacts(transactions, scope, now);
    const publicProfile = {
      binding: profile.binding,
      selection: profile.selection,
      authorize: async (_tx, binding, context) =>
        binding?.brandReference === scope.brandReference &&
        binding?.storeReference === scope.storeReference &&
        bindingAuthorization(_tx, context?.evaluatedAt),
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
      requiredLiveGateRequirementCodes: operatingConfiguration.liveGateRequirementCodes,
      authorize: bindingAuthorization,
      hashContent: hash,
      timeZone: store.timeZone,
      verifyPauseOperation: createMerchantServicePauseProof({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: bindingAuthorization,
      }),
    };
    const operatingStatus = await verifyStoreOperating(transactions, operating, now);
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
      store,
      operatingStatus,
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
