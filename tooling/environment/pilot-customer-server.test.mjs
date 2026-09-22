import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInternalCustomerServer } from "./pilot-customer-server.mjs";

afterEach(() => vi.unstubAllEnvs());

test("production refuses before configuration is loaded", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const loadProfile = vi.fn();
  await expect(startInternalCustomerServer({ loadProfile })).rejects.toThrow("INTERNAL_TEST_ONLY");
  expect(loadProfile).not.toHaveBeenCalled();
});

test.each(["simulator", "entry"])(
  "startup failure at %s releases acquired resources",
  async (stage) => {
    vi.stubEnv("NODE_ENV", "development");
    const directory = await mkdtemp(join(tmpdir(), "bop-https-cleanup-"));
    const keyFile = join(directory, "unused-key");
    const resourceClose = vi.fn(async () => undefined);
    const simulatorClose = vi.fn();
    const failure = new Error("STARTUP_UNAVAILABLE");
    try {
      await writeFile(keyFile, "not-a-key", { mode: 0o600 });
      await expect(
        startInternalCustomerServer({
          loadProfile: async () => ({ environment: "InternalTest" }),
          keyFile,
          loadInternalPickupQr: async () => ({}),
          createInternalTestResources: async () => ({ close: resourceClose }),
          createInternalSimulatedProvider: async () => {
            if (stage === "simulator") throw failure;
            return { close: simulatorClose };
          },
          createInternalCustomerEntry: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(resourceClose).toHaveBeenCalledTimes(1);
      expect(simulatorClose).toHaveBeenCalledTimes(stage === "entry" ? 1 : 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
