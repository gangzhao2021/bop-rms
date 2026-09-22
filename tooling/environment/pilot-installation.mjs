import { open, realpath, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, isAbsolute } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
const unavailable = () => {
  throw new Error("PILOT_INSTALLATION_UNAVAILABLE");
};
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const identifier = (value) => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
export async function loadPilotInstallation(directory) {
  try {
    if (
      !["development", "test"].includes(process.env.NODE_ENV) ||
      !isAbsolute(directory) ||
      (await realpath(directory)) !== directory
    )
      return unavailable();
    const state = await lstat(directory);
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      state.uid !== process.getuid() ||
      (state.mode & 0o777) !== 0o700
    )
      return unavailable();
    const read = async (name) => {
      const file = join(directory, name);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid() ||
          (stat.mode & 0o777) !== 0o600 ||
          stat.size > 1048576
        )
          return unavailable();
        const buffer = Buffer.alloc(1048577);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size > 1048576) return unavailable();
        return JSON.parse(buffer.subarray(0, size).toString("utf8"));
      } finally {
        await handle.close();
      }
    };
    const config = await read("installation.json");
    if (
      !exact(config, ["schemaVersion", "environment", "database", "port", "roles"]) ||
      config.schemaVersion !== 1 ||
      config.environment !== "InternalTest" ||
      !identifier(config.database) ||
      !Number.isSafeInteger(config.port) ||
      config.port < 1 ||
      config.port > 65535 ||
      !exact(config.roles, ["api", "worker"]) ||
      !identifier(config.roles.api) ||
      !identifier(config.roles.worker) ||
      config.roles.api === config.roles.worker
    )
      return unavailable();
    const load = async (name) => {
      try {
        const value = await read(name);
        if (value?.environment !== "InternalTest" || value.database !== config.database)
          return unavailable();
        return value;
      } catch {
        return unavailable();
      }
    };
    return Object.freeze({
      database: config.database,
      connection: Object.freeze({
        host: "127.0.0.1",
        port: config.port,
        database: config.database,
        user: (service) => {
          if (!["api", "worker"].includes(service)) return unavailable();
          return config.roles[service];
        },
        passwordFile: (service) => {
          if (!["api", "worker"].includes(service)) return unavailable();
          return join(directory, service + "-password");
        },
      }),
      loadDiningExceptionWorker: async () => {
        try {
          const value = await load("dining-exception-worker.json");
          const profile = await load("internal-test-profile.json");
          const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          if (
            !exact(value, [
              "schemaVersion",
              "environment",
              "database",
              "providerAccountReference",
              "scope",
            ]) ||
            value.schemaVersion !== 1 ||
            typeof value.providerAccountReference !== "string" ||
            !ref.test(value.providerAccountReference) ||
            !exact(value.scope, ["tenantReference", "brandReference", "storeReference"]) ||
            Object.entries(value.scope).some(
              ([key, reference]) =>
                typeof reference !== "string" ||
                !ref.test(reference) ||
                profile.binding?.[key] !== reference,
            )
          )
            return unavailable();
          return Object.freeze({
            providerAccountReference: value.providerAccountReference,
            scope: Object.freeze({ ...value.scope }),
          });
        } catch {
          return unavailable();
        }
      },
      loadKitchenWorker: async () => {
        try {
          const value = await load("kitchen-queue-worker.json");
          const profile = await load("internal-test-profile.json");
          const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          if (
            !exact(value, [
              "schemaVersion",
              "environment",
              "database",
              "actorReference",
              "scope",
            ]) ||
            value.schemaVersion !== 1 ||
            typeof value.actorReference !== "string" ||
            !ref.test(value.actorReference) ||
            !exact(value.scope, ["tenantReference", "brandReference", "storeReference"]) ||
            Object.entries(value.scope).some(
              ([key, reference]) =>
                typeof reference !== "string" ||
                !ref.test(reference) ||
                profile.binding?.[key] !== reference,
            )
          )
            return unavailable();
          return Object.freeze({
            actorReference: value.actorReference,
            scope: Object.freeze({ ...value.scope }),
          });
        } catch {
          return unavailable();
        }
      },
      loadBusinessWorker: async () => {
        try {
          const value = await load("business-worker.json");
          const profile = await load("internal-test-profile.json");
          const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          if (
            !exact(value, [
              "schemaVersion",
              "environment",
              "database",
              "providerAccountReference",
              "actors",
              "scope",
              ...(Object.hasOwn(value, "workloads") ? ["workloads"] : []),
            ]) ||
            value.schemaVersion !== 1 ||
            (Object.hasOwn(value, "workloads") &&
              (!exact(value.workloads, ["batchCancellation", "compensation"]) ||
                Object.values(value.workloads).some((v) => typeof v !== "boolean"))) ||
            typeof value.providerAccountReference !== "string" ||
            !ref.test(value.providerAccountReference) ||
            !exact(value.actors, ["paidOutcome", "orderCompletion", "kitchenQueue"]) ||
            Object.values(value.actors).some((v) => typeof v !== "string" || !ref.test(v)) ||
            !exact(value.scope, ["tenantReference", "brandReference", "storeReference"]) ||
            Object.entries(value.scope).some(
              ([key, v]) => typeof v !== "string" || !ref.test(v) || profile.binding?.[key] !== v,
            )
          )
            return unavailable();
          return Object.freeze({
            providerAccountReference: value.providerAccountReference,
            actors: Object.freeze({ ...value.actors }),
            workloads: Object.freeze(
              value.workloads
                ? { ...value.workloads }
                : { batchCancellation: false, compensation: false },
            ),
            scope: Object.freeze({ ...value.scope }),
          });
        } catch {
          return unavailable();
        }
      },
      loadWorkflow: async (kind) => {
        try {
          if (!["Pickup", "DineIn", "AdditionalRelease"].includes(kind)) return unavailable();
          const value = await load("internal-test-workflow-" + kind + ".json");
          const profile = await load("internal-test-profile.json");
          if (
            !exact(value.scope, ["tenantReference", "brandReference", "storeReference"]) ||
            Object.entries(value.scope).some(
              ([key, v]) => typeof v !== "string" || profile.binding?.[key] !== v,
            )
          )
            return unavailable();
          return value;
        } catch {
          return unavailable();
        }
      },
      loadCancellationWorkflow: async () => {
        try {
          const value = await load("cancellation-workflow-draft-result.json"),
            profile = await load("internal-test-profile.json");
          if (
            !exact(value.scope, ["tenantReference", "brandReference", "storeReference"]) ||
            Object.entries(value.scope).some(
              ([key, v]) => typeof v !== "string" || profile.binding?.[key] !== v,
            ) ||
            value.definition?.purposeCode !== "InternalTestBatchCancellation"
          )
            return unavailable();
          return value;
        } catch {
          return unavailable();
        }
      },
      loadReceiptTemplate: async () => {
        try {
          const value = await read("internal-test-receipt-template.json");
          const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          if (
            value?.environment !== "InternalTest" ||
            [value.templateReference, value.familyReference, value.versionReference].some(
              (v) => typeof v !== "string" || !ref.test(v),
            )
          )
            return unavailable();
          return value;
        } catch {
          return unavailable();
        }
      },
      loadCustomerRuntime: async () => {
        try {
          const value = await load("customer-runtime.json");
          const profile = await load("internal-test-profile.json");
          const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          if (
            !exact(value, [
              "schemaVersion",
              "environment",
              "database",
              "providerAccountReference",
              "controlReference",
              "cart",
              "scope",
              "diningTableFiles",
            ]) ||
            value.schemaVersion !== 1 ||
            [value.providerAccountReference, value.controlReference].some(
              (v) => typeof v !== "string" || !ref.test(v),
            ) ||
            !exact(value.cart, [
              "policyVersionReference",
              "idleTimeoutSeconds",
              "absoluteTimeoutSeconds",
            ]) ||
            typeof value.cart.policyVersionReference !== "string" ||
            !ref.test(value.cart.policyVersionReference) ||
            !Number.isSafeInteger(value.cart.idleTimeoutSeconds) ||
            value.cart.idleTimeoutSeconds < 1 ||
            !Number.isSafeInteger(value.cart.absoluteTimeoutSeconds) ||
            value.cart.absoluteTimeoutSeconds < value.cart.idleTimeoutSeconds ||
            !exact(value.scope, ["tenantReference", "brandReference", "storeReference"]) ||
            Object.entries(value.scope).some(
              ([key, v]) => typeof v !== "string" || !ref.test(v) || profile.binding?.[key] !== v,
            ) ||
            !Array.isArray(value.diningTableFiles) ||
            value.diningTableFiles.length < 1 ||
            value.diningTableFiles.length > 100 ||
            new Set(value.diningTableFiles).size !== value.diningTableFiles.length ||
            value.diningTableFiles.some(
              (v) =>
                typeof v !== "string" ||
                !/^internal-test-dining-table(?:-[0-9]{2})?\.json$/u.test(v),
            )
          )
            return unavailable();
          return Object.freeze({
            ...value,
            cart: Object.freeze({ ...value.cart }),
            scope: Object.freeze({ ...value.scope }),
            diningTableFiles: Object.freeze([...value.diningTableFiles]),
          });
        } catch {
          return unavailable();
        }
      },
      loadCustomerData: async (name) => {
        try {
          if (
            !["internal-test-inventory.json", "internal-test-merchant.json"].includes(name) &&
            (typeof name !== "string" ||
              !/^internal-test-dining-table(?:-[0-9]{2})?\.json$/u.test(name))
          )
            return unavailable();
          const value = await load(name),
            profile = await load("internal-test-profile.json");
          if (
            ["tenantReference", "brandReference", "storeReference"].some(
              (key) =>
                typeof value.scope?.[key] !== "string" ||
                value.scope[key] !== profile.binding?.[key],
            )
          )
            return unavailable();
          return value;
        } catch {
          return unavailable();
        }
      },
      loadMerchantRuntime: async () => {
        try {
          const value = await load("merchant-runtime.json"),
            profile = await load("internal-test-profile.json");
          const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          if (
            !exact(value, [
              "schemaVersion",
              "environment",
              "database",
              "scope",
              "roleMapping",
              "workstation",
            ]) ||
            value.schemaVersion !== 1 ||
            !exact(value.scope, ["tenantReference", "brandReference", "storeReference"]) ||
            Object.entries(value.scope).some(
              ([key, v]) => typeof v !== "string" || !ref.test(v) || profile.binding?.[key] !== v,
            ) ||
            !exact(value.workstation, ["deviceReference", "pickupLocationReference"]) ||
            Object.values(value.workstation).some((v) => typeof v !== "string" || !ref.test(v)) ||
            !exact(value.roleMapping, ["Manager", "Owner", "Finance"]) ||
            Object.values(value.roleMapping).some(
              (v) =>
                !Array.isArray(v) ||
                v.length > 100 ||
                new Set(v).size !== v.length ||
                v.some(
                  (code) =>
                    typeof code !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(code),
                ),
            )
          )
            return unavailable();
          return Object.freeze({
            ...value,
            scope: Object.freeze({ ...value.scope }),
            workstation: Object.freeze({ ...value.workstation }),
            roleMapping: Object.freeze(
              Object.fromEntries(
                Object.entries(value.roleMapping).map(([key, list]) => [
                  key,
                  Object.freeze([...list]),
                ]),
              ),
            ),
          });
        } catch {
          return unavailable();
        }
      },
      loadTaskQueue: async () => {
        try {
          const value = await load("internal-test-task-queue.json"),
            profile = await load("internal-test-profile.json");
          if (
            ["tenantReference", "brandReference", "storeReference"].some(
              (key) => typeof value[key] !== "string" || value[key] !== profile.binding?.[key],
            )
          )
            return unavailable();
          return value;
        } catch {
          return unavailable();
        }
      },
      loadDailySettlementCoverage: async () => {
        const value = await load("daily-settlement-coverage.json"),
          profile = await load("internal-test-profile.json");
        if (
          !exact(value, ["schemaVersion", "environment", "database", "scope", "firstWindow"]) ||
          value.schemaVersion !== 1 ||
          !exact(value.scope, ["tenantReference", "brandReference", "storeReference"]) ||
          Object.entries(value.scope).some(
            ([key, reference]) => reference !== profile.binding?.[key],
          ) ||
          !exact(value.firstWindow, [
            "businessDate",
            "startsAt",
            "endsAt",
            "configurationReference",
            "configurationVersion",
            "contentDigest",
          ]) ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(value.firstWindow.businessDate) ||
          !Number.isSafeInteger(value.firstWindow.configurationVersion) ||
          value.firstWindow.configurationVersion < 1 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            value.firstWindow.configurationReference,
          ) ||
          !/^sha256:[a-f0-9]{64}$/u.test(value.firstWindow.contentDigest) ||
          [value.firstWindow.startsAt, value.firstWindow.endsAt].some(
            (at) =>
              typeof at !== "string" ||
              !Number.isFinite(Date.parse(at)) ||
              new Date(at).toISOString() !== at,
          ) ||
          value.firstWindow.startsAt >= value.firstWindow.endsAt
        )
          return unavailable();
        return Object.freeze({
          scope: Object.freeze({ ...value.scope }),
          firstWindow: Object.freeze({ ...value.firstWindow }),
        });
      },
      loadProfile: () => load("internal-test-profile.json"),
      loadMenu: () => load("internal-test-menu.json"),
    });
  } catch {
    return unavailable();
  }
}
