import { expect, it, vi } from "vitest";
import { createWebhookEvidenceRetentionDispatcher } from "./pilot-webhook-evidence-retention.mjs";

function setup(results) {
  let clock = Date.parse("2026-11-20T09:00:00.000Z");
  const tx = { query: vi.fn() };
  const resources = {
    now: () => new Date(clock).toISOString(),
    scope: { brandReference: "brand", storeReference: "store", extra: "not passed" },
    transactions: { run: vi.fn(async (work) => work(tx)) },
    publicProfile: { binding: { validUntil: "2099-01-01T00:00:00.000Z" } },
  };
  const purge = vi.fn(async () => results.shift());
  const dispatcher = createWebhookEvidenceRetentionDispatcher({
    resources,
    batchSize: 2,
    purge,
    allowed: () => true,
  });
  return { dispatcher, purge, resources, tx, advance: (ms) => (clock += ms) };
}

it("DEC-STRIPE-PILOT-WIRING: deletes expired raw webhook evidence in bounded batches, then waits a day", async () => {
  const f = setup([{ purged: 2 }, { purged: 1 }, { purged: 0 }]);
  expect(await f.dispatcher.runOnce()).toBe(2);
  expect(f.purge).toHaveBeenCalledWith(
    f.tx,
    { brandReference: "brand", storeReference: "store" },
    { observedAt: "2026-11-20T09:00:00.000Z", limit: 2 },
  );
  // A full batch means more are due: the next poll continues.
  expect(await f.dispatcher.runOnce()).toBe(1);
  // The day's sweep is done: polls before 24 hours do nothing.
  f.advance(23 * 60 * 60 * 1000);
  expect(await f.dispatcher.runOnce()).toBe(0);
  expect(f.purge).toHaveBeenCalledTimes(2);
  f.advance(60 * 60 * 1000);
  expect(await f.dispatcher.runOnce()).toBe(0);
  expect(f.purge).toHaveBeenCalledTimes(3);
  expect(await f.dispatcher.stop()).toBe("drained");
});

it("fails the cycle (health shows it) on a malformed result, outside the binding or a bad batch size", async () => {
  const f = setup([{ purged: 3 }]);
  await expect(f.dispatcher.runOnce()).rejects.toThrow("WEBHOOK_EVIDENCE_RETENTION_RESULT_INVALID");
  const closed = createWebhookEvidenceRetentionDispatcher({
    resources: f.resources,
    purge: f.purge,
    allowed: () => false,
  });
  await expect(closed.runOnce()).rejects.toThrow("WEBHOOK_EVIDENCE_RETENTION_UNAVAILABLE");
  for (const batchSize of [0, 501, 1.5])
    expect(() =>
      createWebhookEvidenceRetentionDispatcher({ resources: f.resources, batchSize }),
    ).toThrow("WEBHOOK_EVIDENCE_RETENTION_CONFIG_INVALID");
});

it("retries the same day after a failed batch (nothing was deleted)", async () => {
  const f = setup([undefined, { purged: 0 }]);
  await expect(f.dispatcher.runOnce()).rejects.toThrow();
  expect(await f.dispatcher.runOnce()).toBe(0);
  expect(f.purge).toHaveBeenCalledTimes(2);
});
