import { expect, it, vi } from "vitest";
import { createContactRetentionDispatcher } from "./pilot-contact-retention.mjs";

function setup(results) {
  let clock = Date.parse("2026-11-20T09:00:00.000Z");
  const tx = { query: vi.fn() };
  const resources = {
    now: () => new Date(clock).toISOString(),
    scope: { brandReference: "brand", storeReference: "store" },
    transactions: { run: vi.fn(async (work) => work(tx)) },
    credentials: { reference: vi.fn(() => "reference") },
    publicProfile: { binding: { validUntil: "2099-01-01T00:00:00.000Z" } },
  };
  const redact = vi.fn(async () => results.shift());
  const dispatcher = createContactRetentionDispatcher({
    resources,
    batchSize: 2,
    redact,
    allowed: () => true,
  });
  return { dispatcher, redact, resources, tx, advance: (ms) => (clock += ms) };
}

it("WP-2423 Q10: removes in bounded batches until a partial batch, then waits a day", async () => {
  const f = setup([{ redacted: 2 }, { redacted: 1 }, { redacted: 0 }]);
  expect(await f.dispatcher.runOnce()).toBe(2);
  expect(f.redact).toHaveBeenCalledWith(f.tx, f.resources.scope, {
    observedAt: "2026-11-20T09:00:00.000Z",
    limit: 2,
    generateRedactionReference: f.resources.credentials.reference,
  });
  // A full batch means more are due: the next poll continues.
  expect(await f.dispatcher.runOnce()).toBe(1);
  // The day's sweep is done: polls before 24 hours do nothing.
  f.advance(23 * 60 * 60 * 1000);
  expect(await f.dispatcher.runOnce()).toBe(0);
  expect(f.redact).toHaveBeenCalledTimes(2);
  f.advance(60 * 60 * 1000);
  expect(await f.dispatcher.runOnce()).toBe(0);
  expect(f.redact).toHaveBeenCalledTimes(3);
  expect(await f.dispatcher.stop()).toBe("drained");
});

it("fails the cycle (health shows it) on a malformed result or outside the pilot binding", async () => {
  const f = setup([{ redacted: 3 }]);
  await expect(f.dispatcher.runOnce()).rejects.toThrow("CONTACT_RETENTION_RESULT_INVALID");
  const closed = createContactRetentionDispatcher({
    resources: f.resources,
    redact: f.redact,
    allowed: () => false,
  });
  await expect(closed.runOnce()).rejects.toThrow("INTERNAL_CONTACT_RETENTION_UNAVAILABLE");
  expect(() => createContactRetentionDispatcher({ resources: f.resources, batchSize: 0 })).toThrow(
    "CONTACT_RETENTION_CONFIG_INVALID",
  );
});

it("retries the same day after a failed batch (nothing was removed)", async () => {
  const f = setup([undefined, { redacted: 0 }]);
  await expect(f.dispatcher.runOnce()).rejects.toThrow();
  expect(await f.dispatcher.runOnce()).toBe(0);
  expect(f.redact).toHaveBeenCalledTimes(2);
});
