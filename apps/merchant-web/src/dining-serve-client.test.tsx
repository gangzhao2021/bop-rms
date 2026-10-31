import { expect, it, vi } from "vitest";
import { createDiningServeClient } from "./dining-serve-client.js";
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = () => ({
  operationReference: id(1),
  orderReference: id(2),
  orderItemReference: id(3),
  quantity: 1,
  expectedOrderVersion: 4,
  expectedItemServiceVersion: 1,
  expectedSessionVersion: 2,
  expectedTableAssignmentVersion: 3,
});
const response = (status = "Created", version = 2) =>
  new Response(JSON.stringify({ status, itemServiceVersion: version }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it("retains identical body and operation across unknown-result retry", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockResolvedValueOnce(response("AlreadyCommitted"));
  const raw = command();
  const operation = createDiningServeClient(fetcher).prepare(raw);
  raw.quantity = 2;
  await expect(operation.execute("A".repeat(43))).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(await operation.execute("A".repeat(43))).toEqual({
    status: "AlreadyCommitted",
    itemServiceVersion: 2,
  });
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).quantity).toBe(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/dining/serve");
});
it.each([
  { quantity: 0 },
  { quantity: 1000 },
  { expectedItemServiceVersion: -1 },
  { expectedSessionVersion: 0 },
  { actorReference: id(9) },
])("rejects invalid or authority-injected command %j", (change) => {
  expect(() => createDiningServeClient().prepare({ ...command(), ...change })).toThrow();
});
it("treats mismatched success version as unknown and permission denial as denied", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response("Created", 3))
    .mockResolvedValueOnce(new Response("private", { status: 403 }));
  const op = createDiningServeClient(fetcher).prepare(command());
  await expect(op.execute("A".repeat(43))).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(op.execute("A".repeat(43))).rejects.toMatchObject({ code: "PermissionDenied" });
});
