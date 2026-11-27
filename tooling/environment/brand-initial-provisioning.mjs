import process from "node:process";
import { join } from "node:path";
import {
  createPrivateInstallationReader,
  parsePrivateInstallationFilename as filename,
} from "./private-installation-files.mjs";
import { pathToFileURL, URL } from "node:url";
import {
  readClosedRecord,
  parseExactHttpsUri,
  parseRawBrowserCredential,
  parsePlatformActorDirectoryConfiguration,
  parseWorkforceAccountBindingConfiguration,
} from "../../packages/bop/identity/src/index.ts";
import { parseBrandInitialProvisioningPlan } from "../../packages/bop/permission/src/index.ts";
import { createAuthenticatedBrandInitialProvisioning } from "../../apps/api/dist/brand-initial-provisioning.js";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createApplicationDatabase } from "./pilot-connections.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { createAdministrationTransactions } from "./administration-transactions.mjs";
import {
  currentPilotEnvironment,
  isPilotRuntime,
  matchesPilotEnvironment,
} from "./pilot-environment.mjs";

const unavailable = () => new Error("INTERNAL_BRAND_INITIAL_PROVISIONING_UNAVAILABLE");
/** Fixed local InternalTest shape (no Brand/Store pilot profile is read):
 * {schemaVersion:1, environment:'InternalTest', database,
 *  operator:{configuration:{environment,issuer,clientId,redirectUri,
 *    allowedPostLoginPaths:['/platform/tenants']},credentialsFile,cookieFile},
 *  workforce:{configuration:{environment,issuer,clientIds},credentialsFile,
 *    relationships:{trustPath,qualifications:[{actorReference,qualificationPath}]}},
 *  approvalFiles:{approvalPath,trustPath},planFile}.
 * Every file reference is a distinct basename in this same private directory.
 * cookieFile is exactly the raw 43-character Platform Session credential, with
 * no JSON, cookie header or trailing newline. Credentials are existing explicit
 * files in the pilot credential loader's format; this entry never provisions
 * or replaces keys. Relationship trust/qualification files are read lazily by
 * their owning private-file/signature/current-withdrawal reader: an original
 * AlreadyApplied receipt does not depend on unused present-day qualification.
 */
export async function runInternalBrandInitialProvisioning(input) {
  let database;
  let outcome;
  let failed = false;
  try {
    const { directory } = readClosedRecord(input, ["directory"]);
    if (!isPilotRuntime({ test: true })) throw unavailable();
    const { read } = await createPrivateInstallationReader(directory);
    // Apply the stronger entry file boundary even to existing shared loaders.
    const installationBytes = await read("installation.json");
    const installation = await loadPilotInstallation(directory);
    if ((await read("installation.json")) !== installationBytes) throw unavailable();
    const config = readClosedRecord(JSON.parse(await read("brand-initial-provisioning.json")), [
      "schemaVersion",
      "environment",
      "database",
      "operator",
      "workforce",
      "approvalFiles",
      "planFile",
    ]);
    if (
      config.schemaVersion !== 1 ||
      !matchesPilotEnvironment(config.environment, { test: true }) ||
      config.database !== installation.database
    )
      throw unavailable();
    const operator = readClosedRecord(config.operator, [
      "configuration",
      "credentialsFile",
      "cookieFile",
    ]);
    const rawOperatorConfiguration = readClosedRecord(operator.configuration, [
      "environment",
      "issuer",
      "clientId",
      "redirectUri",
      "allowedPostLoginPaths",
    ]);
    const operatorDirectory = parsePlatformActorDirectoryConfiguration({
      environment: rawOperatorConfiguration.environment,
      issuer: rawOperatorConfiguration.issuer,
      clientIds: [rawOperatorConfiguration.clientId],
    });
    const redirectUri = parseExactHttpsUri(rawOperatorConfiguration.redirectUri);
    const redirect = new URL(redirectUri);
    if (
      redirectUri !== rawOperatorConfiguration.redirectUri ||
      redirect.pathname !== "/platform/auth/callback" ||
      redirect.search ||
      !Array.isArray(rawOperatorConfiguration.allowedPostLoginPaths) ||
      rawOperatorConfiguration.allowedPostLoginPaths.length !== 1 ||
      rawOperatorConfiguration.allowedPostLoginPaths[0] !== "/platform/tenants"
    )
      throw unavailable();
    const operatorConfiguration = Object.freeze({
      environment: operatorDirectory.environment,
      issuer: operatorDirectory.issuer,
      clientId: operatorDirectory.clientIds[0],
      redirectUri,
      allowedPostLoginPaths: Object.freeze(["/platform/tenants"]),
    });
    const workforce = readClosedRecord(config.workforce, [
      "configuration",
      "credentialsFile",
      "relationships",
    ]);
    const workforceConfiguration = parseWorkforceAccountBindingConfiguration(
      workforce.configuration,
    );
    const relationships = readClosedRecord(workforce.relationships, [
      "trustPath",
      "qualifications",
    ]);
    const approvalFiles = readClosedRecord(config.approvalFiles, ["approvalPath", "trustPath"]);
    const selected = new Set([
      "installation.json",
      "brand-initial-provisioning.json",
      "api-password",
    ]);
    const select = (name) => {
      filename(name);
      if (selected.has(name)) throw unavailable();
      selected.add(name);
      return name;
    };
    const operatorCredentials = select(operator.credentialsFile),
      workforceCredentials = select(workforce.credentialsFile);
    const cookieFile = select(operator.cookieFile),
      planFile = select(config.planFile);
    const approvalPath = select(approvalFiles.approvalPath),
      approvalTrust = select(approvalFiles.trustPath);
    const relationshipTrust = select(relationships.trustPath);
    if (
      !Array.isArray(relationships.qualifications) ||
      relationships.qualifications.length < 1 ||
      relationships.qualifications.length > 20
    )
      throw unavailable();
    const qualifications = relationships.qualifications.map((value) => {
      const item = readClosedRecord(value, ["actorReference", "qualificationPath"]);
      return Object.freeze({
        actorReference: item.actorReference,
        qualificationPath: join(directory, select(item.qualificationPath)),
      });
    });
    const plan = parseBrandInitialProvisioningPlan(JSON.parse(await read(planFile)));
    if (
      qualifications.length !== plan.recipients.length ||
      new Set(qualifications.map((q) => q.actorReference)).size !== qualifications.length ||
      qualifications.some(
        (q) => !plan.recipients.some((r) => r.actorReference === q.actorReference),
      )
    )
      throw unavailable();
    const cookie = parseRawBrowserCredential(await read(cookieFile));
    // The API resolves an immutable original before requesting current recipient
    // qualifications. Do not pre-read those deferred files and accidentally turn
    // their later withdrawal/deletion into an original-recovery dependency.
    for (const name of [
      "installation.json",
      "brand-initial-provisioning.json",
      operatorCredentials,
      workforceCredentials,
      planFile,
      approvalPath,
      approvalTrust,
    ])
      JSON.parse(await read(name));
    const passwordBytes = await read("api-password");
    if (!/^[a-f0-9]{64}$/u.test(passwordBytes)) throw unavailable();
    const loadCredentials = async (name) => {
      const before = await read(name);
      const credentials = await createInternalCredentialLoaders({
        file: join(directory, name),
        loadProfile: installation.loadProfile,
        expectedDatabaseName: installation.database,
      }).createInternalMerchantCredentials();
      if ((await read(name)) !== before) throw unavailable();
      return credentials;
    };
    const operatorCrypto = await loadCredentials(operatorCredentials);
    const workforceCrypto = await loadCredentials(workforceCredentials);
    database = await createApplicationDatabase("api", installation.connection);
    if ((await read("api-password")) !== passwordBytes) throw unavailable();
    const initializer = createAuthenticatedBrandInitialProvisioning({
      transactions: createAdministrationTransactions(database),
      clock: Object.freeze({ now: () => new Date().toISOString() }),
      operator: Object.freeze({ configuration: operatorConfiguration, ...operatorCrypto, cookie }),
      workforce: Object.freeze({
        configuration: workforceConfiguration,
        ...workforceCrypto,
        relationships: Object.freeze({
          trustPath: join(directory, relationshipTrust),
          qualifications: Object.freeze(qualifications),
        }),
      }),
      approvalFiles: Object.freeze({
        approvalPath: join(directory, approvalPath),
        trustPath: join(directory, approvalTrust),
      }),
    });
    const result = await initializer.execute(plan);
    if (
      result?.profile !== "BrandInitialProvisioningResultV1" ||
      !["Applied", "AlreadyApplied"].includes(result.status)
    )
      throw unavailable();
    outcome = Object.freeze({
      environment: currentPilotEnvironment({ test: true }),
      status: result.status,
    });
  } catch {
    failed = true;
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw unavailable();
  return outcome;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--directory") throw unavailable();
    const result = await runInternalBrandInitialProvisioning({ directory: process.argv[3] });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write("INTERNAL_BRAND_INITIAL_PROVISIONING_UNAVAILABLE\n");
    process.exitCode = 1;
  }
}
