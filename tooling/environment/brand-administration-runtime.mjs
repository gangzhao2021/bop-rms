import process from "node:process";
import { createHash, randomBytes, createPrivateKey, X509Certificate } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  readClosedRecord,
  parseExactHttpsUri,
  parseOpaqueUuidV7,
  parseWorkforceAccountBindingConfiguration,
} from "../../packages/bop/identity/src/index.ts";
import { createApiServerRuntime } from "../../apps/api/dist/server.js";
import { HealthReadinessController } from "../../apps/api/dist/health-readiness.js";
import { createMerchantBrandApplication } from "../../apps/api/dist/merchant-brand-application.js";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createApplicationDatabase } from "./pilot-connections.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { createAdministrationTransactions } from "./administration-transactions.mjs";
import {
  createPrivateInstallationReader,
  parsePrivateInstallationFilename,
} from "./private-installation-files.mjs";
import { isPilotRuntime, matchesPilotEnvironment } from "./pilot-environment.mjs";

const unavailable = () => new Error("INTERNAL_BRAND_ADMINISTRATION_UNAVAILABLE");
/** Trusted InternalTest startup only. Files and accounts must already exist.
 * No selected Brand/Store, approval, onboarding, keys or grant is synthesized. */
export async function createInternalBrandAdministrationRuntime(input) {
  let database, serverRuntime, closePromise;
  const close = () => {
    closePromise ??= (async () => {
      if (database) await database.close();
    })();
    return closePromise;
  };
  try {
    const { directory, port } = readClosedRecord(input, ["directory", "port"]);
    if (!isPilotRuntime({ test: true }) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw unavailable();
    const { read } = await createPrivateInstallationReader(directory);
    const installationBytes = await read("installation.json"),
      installation = await loadPilotInstallation(directory);
    if ((await read("installation.json")) !== installationBytes) throw unavailable();
    const rawConfig = JSON.parse(await read("brand-administration.json"));
    const config = readClosedRecord(rawConfig, [
      "schemaVersion",
      "environment",
      "database",
      "exactOrigin",
      "workforce",
      "tls",
      ...(Object.hasOwn(rawConfig, "onboarding") ? ["onboarding"] : []),
    ]);
    if (
      config.schemaVersion !== 1 ||
      !matchesPilotEnvironment(config.environment, { test: true }) ||
      config.database !== installation.database
    )
      throw unavailable();
    const exactOrigin = parseExactHttpsUri(config.exactOrigin),
      origin = new URL(exactOrigin);
    if (
      config.exactOrigin !== origin.origin ||
      exactOrigin !== origin.origin + "/" ||
      !["127.0.0.1", "localhost"].includes(origin.hostname) ||
      Number(origin.port || 443) !== port
    )
      throw unavailable();
    const workforce = readClosedRecord(config.workforce, [
      "environment",
      "issuer",
      "clientId",
      "managedLoginOrigin",
      "clientSecretFile",
      "credentialsFile",
    ]);
    const binding = parseWorkforceAccountBindingConfiguration({
      environment: workforce.environment,
      issuer: workforce.issuer,
      clientIds: [workforce.clientId],
    });
    const managedLogin = new URL(parseExactHttpsUri(workforce.managedLoginOrigin));
    if (
      workforce.managedLoginOrigin !== managedLogin.origin ||
      managedLogin.href !== managedLogin.origin + "/"
    )
      throw unavailable();
    const tls = readClosedRecord(config.tls, ["keyFile", "certificateFile"]);
    const selected = new Set(["installation.json", "brand-administration.json", "api-password"]);
    const select = (value) => {
      const name = parsePrivateInstallationFilename(value);
      if (selected.has(name)) throw unavailable();
      selected.add(name);
      return name;
    };
    const secretFile = select(workforce.clientSecretFile),
      credentialsFile = select(workforce.credentialsFile),
      keyFile = select(tls.keyFile),
      certificateFile = select(tls.certificateFile);
    let onboarding;
    if (Object.hasOwn(config, "onboarding")) {
      const value = readClosedRecord(config.onboarding, [
        "environmentReference",
        "files",
        "acceptanceRoleName",
      ]);
      const files = readClosedRecord(value.files, [
        "planPath",
        "approvalPath",
        "approvalTrustPath",
        "relationshipPath",
        "relationshipTrustPath",
      ]);
      if (
        typeof value.acceptanceRoleName !== "string" ||
        !/^[a-z][a-z0-9_]{0,62}$/u.test(value.acceptanceRoleName)
      )
        throw unavailable();
      onboarding = Object.freeze({
        environmentReference: parseOpaqueUuidV7(
          value.environmentReference,
          "ACTOR_REFERENCE_INVALID",
        ),
        acceptanceRoleName: value.acceptanceRoleName,
        files: Object.freeze(
          Object.fromEntries(
            Object.entries(files).map(([name, file]) => [name, join(directory, select(file))]),
          ),
        ),
      });
      // The owning readers verify signed material and current withdrawal during
      // invitation acceptance. Startup does not turn a file into an approval.
    }
    const clientSecret = await read(secretFile);
    if (!/^[\x21-\x7e]{1,1024}$/u.test(clientSecret)) throw unavailable();
    const key = await read(keyFile),
      cert = await read(certificateFile),
      certificate = new X509Certificate(cert),
      privateKey = createPrivateKey(key);
    const validFrom = Date.parse(certificate.validFrom),
      validTo = Date.parse(certificate.validTo),
      now = Date.now();
    if (
      !certificate.checkPrivateKey(privateKey) ||
      certificate.ca ||
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      validFrom > now ||
      validTo <= now ||
      (origin.hostname === "127.0.0.1"
        ? certificate.checkIP(origin.hostname) !== origin.hostname
        : certificate.checkHost(origin.hostname, { subject: "never" }) !== origin.hostname)
    )
      throw unavailable();
    const credentialsBytes = await read(credentialsFile),
      loader = createInternalCredentialLoaders({
        file: join(directory, credentialsFile),
        loadProfile: installation.loadProfile,
        expectedDatabaseName: installation.database,
      });
    const crypto = await loader.createInternalMerchantCredentials(),
      generators = await loader.createInternalTestCredentials();
    if ((await read(credentialsFile)) !== credentialsBytes) throw unavailable();
    const password = await read("api-password");
    if (!/^[a-f0-9]{64}$/u.test(password)) throw unavailable();
    database = await createApplicationDatabase("api", installation.connection);
    if (
      (await read("api-password")) !== password ||
      (await read("installation.json")) !== installationBytes
    )
      throw unavailable();
    if ((await database.probe()) !== "ready") throw unavailable();
    const brandApplication = await createMerchantBrandApplication({
      directory: fileURLToPath(new URL("../../apps/merchant-web/dist/", import.meta.url)),
      acceptedHost: origin.host,
    });
    const healthReadiness = new HealthReadinessController({
      databaseProbe: () => database.probe(),
    });
    serverRuntime = createApiServerRuntime({
      port,
      host: "127.0.0.1",
      tls: { key, cert },
      brandApplication,
      healthReadiness,
      brandCognitoAdministrationRuntime: {
        ...(onboarding === undefined ? {} : { onboarding }),
        identity: {
          configuration: {
            environment: binding.environment,
            issuer: binding.issuer,
            clientId: binding.clientIds[0],
            clientSecret,
            managedLoginOrigin: managedLogin.origin,
            redirectUri: origin.origin + "/merchant/organization/brands/callback",
            logoutReturnUri: origin.origin + "/app/organization/brands",
          },
          clock: Object.freeze({ now: () => new Date().toISOString() }),
          hasher: crypto.hasher,
          envelopes: crypto.envelopes,
          credentials: Object.freeze({
            generate: () => randomBytes(32).toString("base64url"),
            generateUuidV7: generators.reference,
          }),
          pkce: Object.freeze({
            challenge: (value) => createHash("sha256").update(value).digest("base64url"),
          }),
        },
        transactions: createAdministrationTransactions(database),
        exactOrigin: origin.origin,
        acceptedHost: origin.host,
        catalogSource: Object.freeze({ nextReference: generators.reference }),
      },
    });
    let stopped = false,
      shutdownPromise;
    const shutdown = (signal) => {
      stopped = true;
      shutdownPromise ??= (async () => {
        let failed = false;
        try {
          await serverRuntime.shutdown(signal);
        } catch {
          failed = true;
        }
        try {
          await close();
        } catch {
          failed = true;
        }
        if (failed) throw unavailable();
      })();
      return shutdownPromise;
    };
    return Object.freeze({
      server: serverRuntime.server,
      healthReadiness: serverRuntime.healthReadiness,
      async listen() {
        if (stopped) throw unavailable();
        try {
          await serverRuntime.listen();
        } catch {
          await shutdown("SIGTERM").catch(() => undefined);
          throw unavailable();
        }
      },
      shutdown,
    });
  } catch {
    if (serverRuntime) await serverRuntime.shutdown("SIGTERM").catch(() => undefined);
    await close().catch(() => undefined);
    throw unavailable();
  }
}
/** Existing trusted --configuration process contract. Import has no side effect. */
export async function createRuntime(input) {
  try {
    const { port } = readClosedRecord(input, ["port"]);
    return await createInternalBrandAdministrationRuntime({
      directory: process.env.BOP_BRAND_ADMINISTRATION_DIRECTORY,
      port,
    });
  } catch {
    throw unavailable();
  }
}
