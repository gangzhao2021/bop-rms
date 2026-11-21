import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createApplicationDatabase } from "./pilot-connections.mjs";
/** Existing role and private password only; never grants or provisions a database. */
export async function createConfiguredPilotDatabase(directory, service) {
  const installation = await loadPilotInstallation(directory);
  return createApplicationDatabase(service, installation.connection);
}
