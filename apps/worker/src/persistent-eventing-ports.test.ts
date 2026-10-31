import { expect, it, vi } from "vitest";
import { createPersistentEventingPorts } from "./persistent-eventing-ports.js";

it("reauthorizes each operation and never opens a transaction after scope revocation", async () => {
  let allowed = true;
  const tx = { query: vi.fn() };
  const transaction = vi.fn(async (_scope, work) => work(tx));
  const identities = () => {
    throw new Error("identities must not run before authority");
  };
  const ports = createPersistentEventingPorts({
    database: { transaction },
    authorizeScope: async () => allowed,
    now: () => {
      throw new Error("clock must not run before authority");
    },
    random: () => {
      throw new Error("random must not run before authority");
    },
    outboxIdentities: identities,
    consumerIdentities: identities,
  });
  const scope = { brandId: "synthetic-brand", storeId: "synthetic-store" };
  const work = vi.fn(async (received) => {
    expect(received).toBe(tx);
    return "authorized";
  });
  await expect(ports.database.transaction(scope, work)).resolves.toBe("authorized");
  allowed = false;
  await expect(
    ports.dispatch.claim(scope, {
      batchSize: 1,
      leaseDurationSeconds: 30,
      leaseOwner: "worker",
      leaseToken: "synthetic-token",
    }),
  ).rejects.toThrow("EVENTING_SCOPE_UNAUTHORIZED");
  await expect(ports.parkedRetries.schedule(scope, { batchSize: 1 })).rejects.toThrow(
    "EVENTING_SCOPE_UNAUTHORIZED",
  );
  await expect(
    ports.failureRecorder.recordFailure({
      scope,
      attemptNumber: 1,
      consumerName: "synthetic:v1",
      errorCode: "CONSUMER_TEMPORARY_FAILURE",
      eventId: "synthetic-event",
      firstAttemptAt: "2026-09-12T00:00:00.000Z",
    }),
  ).rejects.toThrow("EVENTING_SCOPE_UNAUTHORIZED");
  await expect(ports.consumerRetries.loadEnvelope(scope, "synthetic-event")).rejects.toThrow(
    "EVENTING_SCOPE_UNAUTHORIZED",
  );
  expect(transaction).toHaveBeenCalledOnce();
  expect(tx.query).not.toHaveBeenCalled();
});
