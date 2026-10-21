import { afterEach, expect, test } from "vitest";
import process from "node:process";
import { createInternalWorker } from "./pilot-worker.mjs";

const brandReference = "0190fa46-0000-7000-8000-000000000001";
const storeReference = "0190fa46-0000-7000-8000-000000000002";
const original = { node: process.env.NODE_ENV, pilot: process.env.BOP_PILOT_ENVIRONMENT };
const setEnvironment = (node, pilot) => {
  process.env.NODE_ENV = node;
  if (pilot === undefined) delete process.env.BOP_PILOT_ENVIRONMENT;
  else process.env.BOP_PILOT_ENVIRONMENT = pilot;
};
afterEach(() => setEnvironment(original.node, original.pilot));

const workload = () => ({
  start: async () => undefined,
  stop: async () => undefined,
  completion: new Promise(() => undefined),
});

async function composeWorker() {
  const contexts = [];
  let sequence = 0;
  const resources = {
    scope: { brandReference, storeReference },
    credentials: {
      reference: () => "0190fa46-0000-7000-8000-" + (++sequence).toString(16).padStart(12, "0"),
    },
    now: () => "2026-10-15T12:00:00.000Z",
    publicProfile: { binding: { validUntil: "2026-10-20T00:00:00.000Z" } },
    transactions: { run: async (work) => work({}) },
    database: {
      acquire: async () => ({
        query: async (text, values) => {
          if (text.includes("set_config('bop.brand_id'")) contexts.push([...values]);
          return { rowCount: 0, rows: [] };
        },
        release: () => undefined,
      }),
    },
  };
  const registration = {
    consumerName: "ordering.order-status-projection:v1",
    consumerVersion: 1,
    eventType: "OrderCreated",
    schemaVersions: [1],
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "replace_order_status",
    replaySafe: true,
    handler: async () => ({ status: "completed" }),
  };
  const worker = await createInternalWorker(
    resources,
    {},
    {},
    {
      createInternalWorkerServices: async () => [
        { registration, consume: async () => ({ status: "processed" }) },
      ],
      createInternalPaidOutcome: async () => ({}),
      createInternalPaidWithoutFulfillableInventoryWorkload: workload,
      createInternalPickupPaymentExpiryWorkload: workload,
      createInternalContactRetentionWorkload: workload,
      createInternalWebhookEvidenceRetentionWorkload: workload,
      createInternalPickupCapacityScheduleWorkload: workload,
    },
  );
  return { worker, contexts };
}

test("business worker claims its Store and its Brand, and publishes undeployed-consumer events (WP-2423 5e)", async () => {
  setEnvironment("development", undefined);
  const { worker, contexts } = await composeWorker();
  await worker.dispatcher.runOnce();
  expect(contexts).toEqual([
    [brandReference, storeReference],
    [brandReference, ""],
  ]);
  await expect(
    worker.recoveryAdapter.publish({ eventType: "AvailabilityRuleCreated" }, { attemptCount: 1 }),
  ).resolves.toEqual({ status: "acknowledged" });
  await expect(
    worker.recoveryAdapter.publish({ eventType: "RecallInitiated" }, { attemptCount: 1 }),
  ).resolves.toEqual({ status: "failed", errorCode: "TRANSPORT_REJECTED" });
});

test("DEC-PILOT-RUNTIME-ENVIRONMENT: a Pilot Store worker dispatches its own Store's events", async () => {
  setEnvironment("production", "Pilot");
  const { worker, contexts } = await composeWorker();
  await worker.dispatcher.runOnce();
  expect(contexts).toEqual([
    [brandReference, storeReference],
    [brandReference, ""],
  ]);
});

test("a production process that is not a declared Pilot Store dispatches nothing", async () => {
  setEnvironment("production", undefined);
  const { worker, contexts } = await composeWorker();
  await worker.dispatcher.runOnce().catch(() => undefined);
  expect(contexts).toEqual([]);
});
