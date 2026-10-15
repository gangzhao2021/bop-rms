import { describe, expect, it, vi } from "vitest";
import { createPickupProofClient } from "./pickup-proof-client.js";
import type { PickupQueueItem } from "./pickup.js";
const ref = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const item: PickupQueueItem = {
  fulfillmentReference: ref(1),
  orderReference: ref(2),
  publicOrderNumber: null,
  phase: "Ready",
  readyAt: "2026-09-19T00:00:00.000Z",
  proofReadiness: "Ready",
  stagingLocation: null,
  claimStatus: "Unavailable",
  exceptionStatus: "Unavailable",
  packageCount: null,
  allergenCue: "Unavailable",
  execution: {
    aggregateVersion: "3",
    publicOrderReference: null,
    proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-09-20T00:00:00.000Z" },
    items: [
      {
        fulfillmentItemReference: ref(3),
        orderedQuantity: 2,
        readyQuantity: 2,
        handedOverQuantity: 0,
      },
    ],
  },
};
const input = () => ({
  item,
  storeReference: ref(4),
  credential: "123456",
  idempotencyReference: ref(5),
  correlationReference: ref(6),
});
const result = {
  status: "Applied",
  verificationReference: ref(7),
  fulfillmentReference: ref(1),
  expectedAggregateVersion: "3",
  generation: 1,
  grantsCompletionAuthority: false,
};
const response = (value: unknown = result) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const csrf = "A".repeat(43);
describe("Pickup proof immutable intent", () => {
  it("retries the same snapshot only explicitly after response loss and disposes on success", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ ...result, status: "AlreadyApplied" }));
    const source = input(),
      intent = createPickupProofClient(fetcher).prepare(source);
    source.credential = "999999";
    await expect(intent.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(intent.execute(csrf)).resolves.toMatchObject({ grantsCompletionAuthority: false });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).credential).toBe("123456");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    await expect(intent.execute(csrf)).rejects.toMatchObject({ code: "Invalid" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...result, fulfillmentReference: ref(9) },
    { ...result, generation: 2 },
    { ...result, expectedAggregateVersion: "2" },
    { ...result, grantsCompletionAuthority: true },
    { ...result, credential: "123456" },
  ])("keeps mismatched success uncertain", async (value) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value));
    await expect(
      createPickupProofClient(fetcher).prepare(input()).execute(csrf),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  });
  it.each([
    [403, "PermissionDenied", null],
    [409, "Conflict", null],
    // WP-2423 (DEC-PICKUP-COUNTER-CODE): only a recorded wrong code is "Rejected"; an expired or
    // replaced proof is a change to refresh; five wrong codes lock code checks.
    [422, "Rejected", "PICKUP_PROOF_REJECTED"],
    [422, "Conflict", "PICKUP_PROOF_UNAVAILABLE"],
    [422, "Conflict", null],
    [423, "Locked", "PICKUP_PROOF_LOCKED"],
  ])("disposes after terminal status %s (%s)", async (status, code, error) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(error === null ? null : JSON.stringify({ error }), {
        status: Number(status),
      }),
    );
    const intent = createPickupProofClient(fetcher).prepare(input());
    await expect(intent.execute(csrf)).rejects.toMatchObject({ code });
    await expect(intent.execute(csrf)).rejects.toMatchObject({ code: "Invalid" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends the six-digit code without spaces or dashes, and a scanned long code as is", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const opaqueItem = {
      ...item,
      execution: {
        ...(item.execution as NonNullable<PickupQueueItem["execution"]>),
        proof: { kind: "Opaque" as const, generation: 1, expiresAt: "2026-09-20T00:00:00.000Z" },
      },
    };
    for (const [credential, kind, sent] of [
      [" 048 213 ", "HumanCode", "048213"],
      ["048-213", "HumanCode", "048213"],
      ["AbCdEfGhIjKlMnOpQrStUQ", "Opaque", "AbCdEfGhIjKlMnOpQrStUQ"],
    ] as const) {
      fetcher.mockClear();
      await createPickupProofClient(fetcher)
        .prepare({ ...input(), item: opaqueItem, credential })
        .execute(csrf);
      const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      expect(body).toMatchObject({ kind, credential: sent });
    }
    for (const credential of ["04821", "0482134", "AbCdEfGhIjKlMnOpQrStUB", "abc def"])
      expect(() =>
        createPickupProofClient(fetcher).prepare({ ...input(), item: opaqueItem, credential }),
      ).toThrow();
  });
  it("rejects disposed and pre-aborted operations without sending", async () => {
    const fetcher = vi.fn<typeof fetch>(),
      client = createPickupProofClient(fetcher),
      intent = client.prepare(input());
    intent.dispose();
    await expect(intent.execute(csrf)).rejects.toMatchObject({ code: "Invalid" });
    await expect(client.prepare(input()).execute(csrf, AbortSignal.abort())).rejects.toMatchObject({
      code: "Invalid",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks concurrent execution of one intent", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const intent = createPickupProofClient(fetcher).prepare(input()),
      first = intent.execute(csrf);
    await expect(intent.execute(csrf)).rejects.toMatchObject({ code: "Invalid" });
    finish(response());
    await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed input without revealing credentials", () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() =>
      createPickupProofClient(fetcher).prepare({ ...input(), credential: "private text" }),
    ).toThrow("Pickup proof verification could not be confirmed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
