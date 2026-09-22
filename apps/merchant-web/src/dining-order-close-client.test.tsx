import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDiningOrderCloseClient } from "./dining-order-close-client.js";
import { DiningOrderCloseAction } from "./DiningOrderCloseAction.js";
import type { DiningProgress } from "./dining-progress-client.js";
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = () => ({
  operationReference: id(1),
  orderReference: id(2),
  expectedOrderVersion: 4,
  expectedClosureVersion: 0,
  reasonCode: "ORDER_COMPLETED",
});
const response = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      status: "AlreadyCommitted",
      closedOrderVersion: 4,
      closureVersion: 1,
      ...extra,
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
it("keeps original intent on unknown-result retry even if caller mutates input", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(response());
  const input = command();
  const op = createDiningOrderCloseClient(fetcher).prepare(input);
  input.expectedOrderVersion = 99;
  await expect(op.execute("A".repeat(43))).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(op.execute("A".repeat(43))).resolves.toMatchObject({
    status: "AlreadyCommitted",
    closureVersion: 1,
  });
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(command()));
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/orders/close");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
});
it.each([
  { expectedClosureVersion: -1 },
  { expectedOrderVersion: 0 },
  { actorReference: id(9) },
  { reasonCode: "bad reason" },
])("rejects invalid/authority-injected command %j", (change) => {
  expect(() => createDiningOrderCloseClient().prepare({ ...command(), ...change })).toThrow();
});
it.each([
  { closureVersion: 2 },
  { closedOrderVersion: 5 },
  { status: "Created" },
  { secret: "private" },
])("treats mismatched success as unknown %j", async (change) => {
  await expect(
    createDiningOrderCloseClient(vi.fn(async () => response(change)))
      .prepare(command())
      .execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it.each([
  [403, "PermissionDenied"],
  [409, "Conflict"],
  [503, "OutcomeUnknown"],
])("handles HTTP %s without echoing its body", async (status, code) => {
  await expect(
    createDiningOrderCloseClient(
      vi.fn(async () => new Response("private", { status: Number(status) })),
    )
      .prepare(command())
      .execute("A".repeat(43)),
  ).rejects.toMatchObject({ code });
});
const view: DiningProgress = {
  orderReference: id(2),
  tableLabel: "T1",
  orderVersion: 3,
  currentOrderVersion: 4,
  sessionVersion: 2,
  diningSessionReference: id(55),
  sessionPhase: "Active",
  tableAssignmentVersion: 1,
  closureStatus: "Open",
  closureVersion: 0,
  phase: "Fulfilled",
  observedAt: "2026-09-20T10:00:00.000Z",
  items: [],
};
const render = (change: Partial<DiningProgress> = {}, locked = false) =>
  renderToStaticMarkup(
    <DiningOrderCloseAction
      view={{ ...view, ...change }}
      csrf={"A".repeat(43)}
      locked={locked}
      onBusy={() => undefined}
      onClosed={() => undefined}
    />,
  );
it("requires confirmation and explains that the session stays open", () => {
  const html = render();
  expect(html).toContain("I confirm this order is complete");
  expect(html).toContain("disabled");
  expect(html).toContain("The dining session stays open.");
});
it.each([{ closureStatus: "Closed" as const }, { phase: "Ready" }])(
  "does not offer closure outside completed Open orders %j",
  (change) => {
    expect(render(change)).toBe("");
  },
);
