import console from "node:console";
import process from "node:process";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createConfiguredPilotResources } from "./pilot-configured-resources.mjs";
import { composeCustomerDependencies } from "./pilot-customer-composition.mjs";
import { composeConfiguredMerchant } from "./pilot-merchant-composition.mjs";
import { createInternalQrLoaders } from "./pilot-qr.mjs";
import { startInternalCustomerServer } from "./pilot-customer-server.mjs";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
export function parsePilotHttpsArguments(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string")
    throw Error("PILOT_HTTPS_ARGUMENT_INVALID");
  return parsePilotRuntimeDirectory(args[0]);
}
export async function startConfiguredPilotHttps(
  directory,
  {
    loadInstallation = loadPilotInstallation,
    createResources = createConfiguredPilotResources,
    composeCustomer = composeCustomerDependencies,
    composeMerchant = composeConfiguredMerchant,
    createQr = createInternalQrLoaders,
    startServer = startInternalCustomerServer,
  } = {},
) {
  const installation = await loadInstallation(directory),
    customerConfig = await installation.loadCustomerRuntime(),
    merchantConfig = await installation.loadMerchantRuntime();
  if (
    Object.entries(customerConfig.scope).some(([key, value]) => merchantConfig.scope[key] !== value)
  )
    throw Error("PILOT_HTTPS_SCOPE_CHANGED");
  const customer = composeCustomer(directory, installation, customerConfig);
  const merchant = composeMerchant(
    directory,
    installation,
    merchantConfig,
    customerConfig,
    customer,
  );
  const qr = createQr({
    file: path.join(directory, "internal-test-qr-key.pem"),
    loadProfile: installation.loadProfile,
    expectedDatabaseName: installation.database,
  });
  const diningEntries = await Promise.all(
    customerConfig.diningTableFiles.map(async (name, index) => {
      const table = await installation.loadCustomerData(name);
      return {
        selector: "table-" + (index + 1),
        label: table.label,
        loadQr: async () => qr.loadInternalDiningQr(await installation.loadProfile(), table),
      };
    }),
  );
  return startServer({
    ...customer,
    createInternalMerchant: merchant,
    loadInternalPickupQr: qr.loadInternalPickupQr,
    diningEntries,
    loadProfile: installation.loadProfile,
    keyFile: path.join(directory, "customer-tls-key.pem"),
    certificateFile: path.join(directory, "customer-tls-cert.pem"),
    createInternalTestResources: async () => {
      const r = await createResources(directory);
      if (
        Object.entries(customerConfig.scope).some(
          ([key, value]) => r.publicProfile.binding[key] !== value,
        )
      ) {
        await r.close();
        throw Error("PILOT_HTTPS_SCOPE_CHANGED");
      }
      return r;
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.NODE_ENV !== "development") throw Error("PILOT_HTTPS_ENVIRONMENT_INVALID");
    const dir = path.join(
      fileURLToPath(new URL("../../", import.meta.url)),
      parsePilotHttpsArguments(process.argv.slice(2)),
    );
    await startConfiguredPilotHttps(dir);
  } catch {
    console.error("PILOT_HTTPS_START_UNAVAILABLE");
    process.exitCode = 1;
  }
}
