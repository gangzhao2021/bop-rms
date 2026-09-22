import { join } from "node:path";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createApplicationDatabase } from "./pilot-connections.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { createCustomerRequestAdmission } from "./pilot-customer-admission.mjs";
import { createInternalTestResources } from "./pilot-resources.mjs";
/** Loads existing scoped configuration. Never provisions secrets, roles or business facts. */
export async function createConfiguredPilotResources(directory) {
  const installation = await loadPilotInstallation(directory);
  const credentials = createInternalCredentialLoaders({
    file: join(directory, "internal-test-keys.json"),
    loadProfile: installation.loadProfile,
    expectedDatabaseName: installation.database,
  });
  return createInternalTestResources({
    createApplicationDatabase: (service) =>
      createApplicationDatabase(service, installation.connection),
    createInternalTestCredentials: credentials.createInternalTestCredentials,
    createCustomerRequestAdmission: (options) =>
      createCustomerRequestAdmission(options, { file: join(directory, "guest-abuse-pepper") }),
    loadProfile: installation.loadProfile,
    loadMenu: installation.loadMenu,
    expectedDatabaseName: installation.database,
  });
}
