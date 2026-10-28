import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { expect, it } from "vitest";
import {
  isTransactionConflict,
  withTransactionConflictWait,
} from "./pilot-transaction-conflict-wait.mjs";

const conflict = () =>
  Object.assign(Error("conflict"), { code: "TENANT_DATABASE_TRANSACTION_CONFLICT" });

it("reruns a whole transaction that met a lock conflict, then gives up", async () => {
  const waits = [];
  let attempts = 0;
  const runner = withTransactionConflictWait(
    {
      run: async (work) => {
        attempts += 1;
        if (attempts < 3) throw conflict();
        return work("tx");
      },
    },
    { sleep: async (ms) => void waits.push(ms), random: () => 0.5 },
  );
  expect(await runner.run(async (tx) => tx + "-done")).toBe("tx-done");
  expect(attempts).toBe(3);
  expect(waits).toEqual([200, 400]);
  let tries = 0;
  const failing = withTransactionConflictWait(
    {
      run: async () => {
        tries += 1;
        throw conflict();
      },
    },
    { attempts: 3, sleep: async () => undefined },
  );
  await expect(failing.run(async () => undefined)).rejects.toMatchObject({
    code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
  });
  expect(tries).toBe(3);
});

it("never reruns other failures", async () => {
  let attempts = 0;
  const runner = withTransactionConflictWait({
    run: async () => {
      attempts += 1;
      throw Object.assign(Error("x"), { code: "23514" });
    },
  });
  await expect(runner.run(async () => undefined)).rejects.toMatchObject({ code: "23514" });
  expect(attempts).toBe(1);
  expect(isTransactionConflict({ code: "55P03" })).toBe(true);
  expect(isTransactionConflict({ code: "57014" })).toBe(false);
});

it("every background worker takes the shared background resources (v15 finding f)", () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const workers = readdirSync(directory).filter(
    (file) =>
      (/^pilot-.*-worker\.mjs$/u.test(file) || file === "pilot-order-progress-catch-up.mjs") &&
      readFileSync(directory + file, "utf8").includes("pilot-configured-resources.mjs"),
  );
  expect(workers.length).toBeGreaterThanOrEqual(6);
  for (const file of workers)
    expect([
      file,
      readFileSync(directory + file, "utf8").includes("createConfiguredPilotResources"),
    ]).toEqual([file, false]);
});
