import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPilotStartReadiness } from "./pilot-supervisor.mjs";

afterEach(() => vi.unstubAllEnvs());

const withDirectory = async (work) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bop-start-readiness-")));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("InternalTest starts with nothing configured (simulator, DEMO sign-in, local keys)", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
  await withDirectory(async (directory) => {
    const checkCapabilities = vi.fn();
    await expect(
      checkPilotStartReadiness({
        runtimeDirectory: directory,
        absoluteDirectory: directory,
        checkCapabilities,
      }),
    ).resolves.toBe("InternalTest");
    expect(checkCapabilities).not.toHaveBeenCalled();
  });
});

test("a Pilot Store without configuration names every gap and the hosting problems", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  await withDirectory(async (directory) => {
    const lines = [];
    await expect(
      checkPilotStartReadiness({
        runtimeDirectory: directory,
        absoluteDirectory: directory,
        report: (line) => lines.push(line),
      }),
    ).rejects.toThrow(
      "PILOT_CAPABILITY_MISSING:PaymentProvider,StaffLogin,Secrets,Tls,Installation,PricingCurrencyMetadata",
    );
    expect(lines).toEqual([
      "PILOT_NOT_READY Secrets: no secretsDirectory in hosting.json",
      "PILOT_NOT_READY Tls: customer-origin-not-configured",
      // DEC-PILOT-INSTALLATION: nothing issued yet.
      "PILOT_NOT_READY Installation: not-issued",
    ]);
  });
});

test("met hosting capabilities leave only the remaining gaps", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  await withDirectory(async (directory) => {
    await expect(
      checkPilotStartReadiness({
        runtimeDirectory: directory,
        absoluteDirectory: directory,
        checkCapabilities: async () => ({ met: ["Secrets", "Tls"], problems: [] }),
        report: () => undefined,
      }),
    ).rejects.toThrow(
      "PILOT_CAPABILITY_MISSING:PaymentProvider,StaffLogin,Installation,PricingCurrencyMetadata",
    );
  });
});

test("DEC-PILOT-INSTALLATION: a complete issued installation meets Installation; each problem is named", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  await withDirectory(async (directory) => {
    const lines = [];
    const start = (problems) =>
      checkPilotStartReadiness({
        runtimeDirectory: directory,
        absoluteDirectory: directory,
        checkCapabilities: async () => ({ met: ["Secrets", "Tls"], problems: [] }),
        checkInstallation: async (value) => {
          expect(value).toBe(directory);
          return problems;
        },
        report: (line) => lines.push(line),
      });
    await expect(start([])).rejects.toThrow(
      "PILOT_CAPABILITY_MISSING:PaymentProvider,StaffLogin,PricingCurrencyMetadata",
    );
    expect(lines).toEqual([]);
    await expect(
      start(["Installation: missing internal-test-workflow-Pickup.json"]),
    ).rejects.toThrow(
      "PILOT_CAPABILITY_MISSING:PaymentProvider,StaffLogin,Installation,PricingCurrencyMetadata",
    );
    expect(lines).toEqual([
      "PILOT_NOT_READY Installation: missing internal-test-workflow-Pickup.json",
    ]);
  });
});
