import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDiningServeClient } from "./dining-serve-client.js";
import { DiningServeAction } from "./DiningServeAction.js";
import { parseDiningProgress } from "./dining-progress-client.js";
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
const view = () =>
  parseDiningProgress(
    {
      orderReference: id(2),
      orderVersion: 4,
      sessionVersion: 2,
      diningSessionReference: id(55),
      sessionPhase: "Active",
      tableAssignmentVersion: 3,
      closureStatus: "Open",
      closureVersion: 0,
      currentOrderVersion: 4,
      tableLabel: "T1",
      phase: "Ready",
      observedAt: "2026-09-20T11:00:00.000Z",
      items: [
        {
          orderItemReference: id(3),
          orderBatchReference: id(4),
          displayName: "Meal",
          batchSequence: 2,
          itemOrdinal: 1,
          phase: "Ready",
          orderedQuantity: 2,
          deliveredQuantity: 1,
          remainingQuantity: 1,
          itemServiceVersion: 1,
        },
      ],
    },
    id(2),
  );
it("requires quantity/table confirmation and only renders for remaining Ready work", () => {
  const current = view();
  const item = current.items[0];
  if (!item) throw new Error("fixture item missing");
  const render = (entry: typeof item) =>
    renderToStaticMarkup(
      <DiningServeAction
        view={current}
        item={entry}
        csrf={"A".repeat(43)}
        locked={false}
        onBusy={() => undefined}
        onServed={() => undefined}
      />,
    );
  const html = render(item);
  expect(html).toContain("delivered to table T1");
  expect(html).toContain("Confirm served quantity");
  expect(html).toContain("disabled");
  expect(render({ ...item, phase: "Fulfilled", remainingQuantity: 0 })).toBe("");
  expect(render({ ...item, phase: "InProgress" })).toBe("");
});

it("never offers serving for a closed order even if stale item data remains Ready", () => {
  const current = { ...view(), closureStatus: "Closed" as const, closureVersion: 1 };
  const item = current.items[0];
  if (!item) throw new Error("fixture item missing");
  expect(
    renderToStaticMarkup(
      <DiningServeAction
        view={current}
        item={item}
        csrf={"A".repeat(43)}
        locked={false}
        onBusy={() => undefined}
        onServed={() => undefined}
      />,
    ),
  ).toBe("");
});
