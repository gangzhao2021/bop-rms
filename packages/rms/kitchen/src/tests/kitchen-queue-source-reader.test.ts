import type { ConsumerTransaction } from "@bop/eventing";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPostgresKitchenQueueSourceReader } from "../infrastructure/persistence/kitchen-queue-source-reader.js";
import type { KitchenTicketEffectValidationPorts } from "../application/ports/kitchen-ticket-ports.js";
import type { KitchenWorkLifecycleEffectValidationPorts } from "../application/kitchen-work-lifecycle-service.js";

const id = (n: number) => `0194a100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function harness(tickets: unknown = []) {
  const authorize = vi.fn(async () => true);
  const query = vi.fn<ConsumerTransaction["query"]>(async <Row>() => ({
    rows: [{ as_of: "2026-09-19T12:00:00.000Z", tickets }] as Row[],
    rowCount: 1,
  }));
  const sha256 = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
  // Empty/error-path cases do not decode owner effects; actual records are exercised in database acceptance.
  const validation = { references: {}, digests: { sha256 } };
  const reader = createPostgresKitchenQueueSourceReader({
    brandReference: id(1),
    storeReference: id(2),
    maxTickets: 2,
    maxItemsPerTicket: 5,
    maxOperationsPerTicket: 20,
    creationValidation: validation as KitchenTicketEffectValidationPorts,
    lifecycleValidation: validation as KitchenWorkLifecycleEffectValidationPorts,
    nextSnapshotReference: () => id(3),
    authorize,
  });
  return {
    reader,
    query,
    authorize,
    transaction: { query: query as ConsumerTransaction["query"] },
  };
}
describe("bounded Kitchen source snapshot", () => {
  it("returns a complete empty snapshot using a single scoped and bounded query", async () => {
    const test = harness();
    expect(await test.reader.read(test.transaction)).toMatchObject({
      tickets: [],
      sourceCheckpointReference: id(3),
      coverageStatus: "CompleteThroughCheckpoint",
    });
    expect(test.query).toHaveBeenCalledTimes(1);
    expect(test.query.mock.calls[0]?.[1]).toEqual([id(1), id(2), 3, 6, 21]);
    expect(test.authorize).toHaveBeenCalledTimes(2);
  });
  it("does not read before authorization", async () => {
    const test = harness();
    test.authorize.mockResolvedValue(false);
    await expect(test.reader.read(test.transaction)).rejects.toMatchObject({
      code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
    });
    expect(test.query).not.toHaveBeenCalled();
  });
  it("rejects authorization revoked during the read", async () => {
    const test = harness();
    test.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(test.reader.read(test.transaction)).rejects.toMatchObject({
      code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each([null, {}, [null], [{}, {}, {}]])(
    "rejects malformed or truncated ticket coverage",
    async (value) => {
      const test = harness(value);
      await expect(test.reader.read(test.transaction)).rejects.toMatchObject({
        code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("does not expose database errors", async () => {
    const test = harness();
    test.query.mockRejectedValue(new Error("private SQL details"));
    await expect(test.reader.read(test.transaction)).rejects.toMatchObject({
      code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE",
    });
    await expect(test.reader.read(test.transaction)).rejects.not.toThrow("private SQL details");
  });
});
