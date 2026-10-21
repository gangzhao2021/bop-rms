import { expect, it } from "vitest";
import {
  currentPilotEnvironment,
  isInternalTest,
  isPilotRuntime,
  matchesPilotEnvironment,
  pilotChildEnvironment,
} from "./pilot-environment.mjs";

const at = (NODE_ENV, BOP_PILOT_ENVIRONMENT) => ({
  env: { NODE_ENV, ...(BOP_PILOT_ENVIRONMENT ? { BOP_PILOT_ENVIRONMENT } : {}) },
});

it("WP-2423 P1b: development is InternalTest; production is Pilot only when declared", () => {
  expect(currentPilotEnvironment(at("development"))).toBe("InternalTest");
  expect(currentPilotEnvironment(at("development", "InternalTest"))).toBe("InternalTest");
  expect(currentPilotEnvironment(at("production", "Pilot"))).toBe("Pilot");
  expect(currentPilotEnvironment({ ...at("test"), test: true })).toBe("InternalTest");
});

it("WP-2423 P1b: refuses every mixed or undeclared combination", () => {
  for (const options of [
    at("production"),
    at("production", "InternalTest"),
    at("development", "Pilot"),
    at("test", "Pilot"),
    at(undefined),
    at("staging"),
    at("test"),
    at("development", "pilot"),
  ])
    expect(() => currentPilotEnvironment(options)).toThrow("PILOT_ENVIRONMENT_INVALID");
});

it("WP-2423 P1b: simulation is InternalTest only; configuration must match the process", () => {
  expect(isInternalTest(at("development"))).toBe(true);
  expect(isInternalTest(at("production", "Pilot"))).toBe(false);
  expect(isPilotRuntime(at("production", "Pilot"))).toBe(true);
  expect(isPilotRuntime(at("production"))).toBe(false);
  expect(matchesPilotEnvironment("Pilot", at("production", "Pilot"))).toBe(true);
  expect(matchesPilotEnvironment("InternalTest", at("production", "Pilot"))).toBe(false);
  expect(matchesPilotEnvironment("Pilot", at("development"))).toBe(false);
});

it("WP-2423 P1b: child services inherit exactly their environment", () => {
  expect(pilotChildEnvironment("InternalTest")).toEqual({ NODE_ENV: "development" });
  expect(pilotChildEnvironment("Pilot")).toEqual({
    NODE_ENV: "production",
    BOP_PILOT_ENVIRONMENT: "Pilot",
  });
  expect(() => pilotChildEnvironment("Staging")).toThrow("PILOT_ENVIRONMENT_INVALID");
});

it("WP-2423 P1b: a Pilot start names every remaining capability gap; InternalTest starts", async () => {
  const { assertPilotReady, pilotCapabilityGaps } = await import("./pilot-environment.mjs");
  expect(assertPilotReady(at("development"))).toBe("InternalTest");
  expect(() => assertPilotReady(at("production", "Pilot"))).toThrow(
    "PILOT_CAPABILITY_MISSING:" + pilotCapabilityGaps.map((gap) => gap.code).join(","),
  );
  expect(pilotCapabilityGaps.map((gap) => gap.code)).toContain("PaymentProvider");
  expect(() => assertPilotReady(at("production"))).toThrow("PILOT_ENVIRONMENT_INVALID");
});

it("DEC-PILOT-SECRETS: Secrets and Tls clear only when checked against this installation's configuration", async () => {
  const { assertPilotReady, checkConfiguredPilotCapabilities, pilotCapabilityGaps } =
    await import("./pilot-environment.mjs");
  const others = pilotCapabilityGaps
    .map((gap) => gap.code)
    .filter((code) => !["Secrets", "Tls"].includes(code));
  expect(() => assertPilotReady({ ...at("production", "Pilot"), met: ["Secrets", "Tls"] })).toThrow(
    "PILOT_CAPABILITY_MISSING:" + others.join(","),
  );
  // Only configurable gaps can be met; a claim for any other code changes nothing.
  expect(() => assertPilotReady({ ...at("production", "Pilot"), met: ["StaffLogin"] })).toThrow(
    "StaffLogin",
  );
  const hosting = { secretsDirectory: "/run/secrets/bop-rms" };
  const complete = await checkConfiguredPilotCapabilities("/runtime", {
    loadHosting: async () => hosting,
    checkSecrets: async () => ({ missing: [], invalid: [] }),
    checkTls: async () => null,
  });
  expect(complete).toEqual({ met: ["Secrets", "Tls"], problems: [] });
  const missing = await checkConfiguredPilotCapabilities("/runtime", {
    loadHosting: async () => hosting,
    checkSecrets: async () => ({ missing: ["guest-session-key"], invalid: [] }),
    checkTls: async () => "certificate-not-trusted",
  });
  expect(missing.met).toEqual([]);
  expect(missing.problems.join(" ")).toContain("guest-session-key");
  expect(missing.problems.join(" ")).toContain("certificate-not-trusted");
  const unconfigured = await checkConfiguredPilotCapabilities("/runtime", {
    loadHosting: async () => ({ secretsDirectory: null }),
    checkSecrets: async () => {
      throw Error("not called");
    },
    checkTls: async () => "customer-origin-not-configured",
  });
  expect(unconfigured.met).toEqual([]);
  const broken = await checkConfiguredPilotCapabilities("/runtime", {
    loadHosting: async () => {
      throw Object.assign(Error("PILOT_HOSTING_CONFIG_INVALID"), { reason: "customerOrigin" });
    },
  });
  expect(broken).toEqual({ met: [], problems: ["hosting.json is unusable (customerOrigin)"] });
});
