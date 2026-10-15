import { afterEach, beforeEach, expect, test } from "vitest";
import process from "node:process";
import { createInternalWorker } from "./pilot-worker.mjs";

const brandReference = "0190fa46-0000-7000-8000-000000000001";
const storeReference = "0190fa46-0000-7000-8000-000000000002";
const originalEnvironment = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = "development";
});
afterEach(() => {
  process.env.NODE_ENV = originalEnvironment;
});

const workload = () => ({
  start: async () => undefined,
  stop: async () => undefined,
  completion: new Promise(() => undefined),
});

test("business worker claims its Store and its Brand, and publishes undeployed-consumer events (WP-2423 5e)", async () => {
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
    },
  );
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
